/** 数据库注册表及隔离执行器；与 Pi 内核无关，桌面/Web 共用。 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { DatabaseBrowseParams, DatabaseConnection, DatabaseHistory, DatabaseInput, DatabaseMethods, DatabaseQueryParams, DatabaseResult, DatabaseSavedQuery } from "@shared/database";
import { inspectSql } from "@shared/database-sql";
import type { HostStore, SecretCodec } from "./hosts";
import { getFloworkDataDir } from "./paths";
import { DATABASE_RUNNER } from "./database-runner";
import { hostKeyChangedError, sshEnv, sshTunnelArgs } from "./ssh";
import { isHostKeyChangedError } from "./host-key";

type StoredConnection = Omit<DatabaseConnection, "hasPassword"> & { password?: string; passwordEnc?: string };
interface State { version: 1; connections: StoredConnection[]; history: DatabaseHistory[]; saved: DatabaseSavedQuery[] }
const empty = (): State => ({ version: 1, connections: [], history: [], saved: [] });
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
function normalize(input: DatabaseInput): DatabaseInput {
	if (!input || !["sqlite", "postgres", "mysql"].includes(input.kind) || typeof input.readOnly !== "boolean") throw new Error("无效的数据库连接配置");
	const text = (value: unknown, max = 512): string => { if (value === undefined) return ""; if (typeof value !== "string" || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error("连接字段包含无效字符或过长"); return value.trim(); };
	const kind = input.kind;
	const name = text(input.name, 100);
	if (input.password !== undefined && (typeof input.password !== "string" || input.password.length > 8192)) throw new Error("密码格式无效");
	if (kind === "sqlite") {
		const file = text(input.file, 4096);
		if (!isAbsolute(file) || file === ":memory:") throw new Error("请选择已存在的 SQLite 文件（绝对路径）");
		if (input.sshHostId) throw new Error("SQLite 仅支持本机文件；远程数据库请使用 PostgreSQL 或 MySQL");
		return { kind, name: name || file.split(/[\\/]/).at(-1)!, file, readOnly: input.readOnly };
	}
	const host = text(input.host), database = text(input.database), user = text(input.user);
	if (!/^[A-Za-z0-9_.:[\]-]+$/.test(host) || host.startsWith("-")) throw new Error("请填写有效的数据库主机名或 IP，不要带协议和端口");
	const port = input.port ?? (kind === "postgres" ? 5432 : 3306);
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !database || !user) throw new Error("请填写数据库、用户名和有效端口（1–65535）");
	const sshHostId = text(input.sshHostId, 128) || undefined;
	return { kind, name: name || `${user}@${host}`, host: host.replace(/^\[|\]$/g, ""), port, database, user, password: input.password, sshHostId, readOnly: input.readOnly, tls: input.tls === true };
}
function publicConnection(c: StoredConnection): DatabaseConnection {
	const { password, passwordEnc, ...rest } = c;
	return { ...rest, hasPassword: !!(password || passwordEnc) };
}

export class DatabaseManager {
	private queue: Promise<unknown> = Promise.resolve();
	private operations = new Map<string, AbortController>();
	private approvals = new Map<string, { client: string; digest: string; expires: number }>();
	constructor(private hosts: HostStore, private secrets?: SecretCodec, private file = join(getFloworkDataDir(), "databases.json"), private timeoutMs = 30_000) {}
	private async load(): Promise<State> {
		try {
			const s = JSON.parse(await readFile(this.file, "utf8")) as State;
			if (s.version !== 1 || !Array.isArray(s.connections) || !Array.isArray(s.history) || !Array.isArray(s.saved)) throw new Error("无效结构");
			return s;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
			throw new Error(`数据库配置无法读取，请备份并修复 ${this.file}：${message(e)}`);
		}
	}
	private async mutate<T>(fn: (s: State) => T): Promise<T> {
		const task = this.queue.then(async () => {
			const s = await this.load(); const result = fn(s);
			await mkdir(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${randomUUID()}.tmp`;
			try { await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 }); await rename(tmp, this.file); }
			finally { await rm(tmp, { force: true }).catch(() => undefined); }
			return result;
		});
		this.queue = task.catch(() => undefined); return task;
	}
	private canEncrypt(): boolean { try { return !!this.secrets?.available(); } catch { return false; } }
	private encode(input: DatabaseInput, old?: StoredConnection): StoredConnection {
		const { password, ...safe } = normalize(input);
		const c: StoredConnection = { ...safe, id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? Date.now() };
		if (c.kind !== "sqlite") {
			if (password === undefined && old?.kind === c.kind) { c.password = old.password; c.passwordEnc = old.passwordEnc; }
			else if (password) { if (this.canEncrypt()) c.passwordEnc = this.secrets!.encrypt(password); else c.password = password; }
		}
		// 将旧的明文凭据迁移到系统密钥保护（若当前外壳支持）。
		if (c.password && this.canEncrypt()) { c.passwordEnc = this.secrets!.encrypt(c.password); delete c.password; }
		return c;
	}
	private decode(c: StoredConnection): DatabaseInput {
		let password = c.password;
		if (c.passwordEnc) {
			if (!this.canEncrypt()) throw new Error("数据库密码由桌面版系统加密保存，当前环境无法解密；请在编辑连接中重新填写");
			try { password = this.secrets!.decrypt(c.passwordEnc); } catch { throw new Error("数据库密码无法解密，请编辑连接并重新填写"); }
		}
		return { ...normalize(c), password };
	}
	private async require(id: string): Promise<StoredConnection> {
		const c = (await this.load()).connections.find(c => c.id === id);
		if (!c) throw new Error("数据库连接不存在，可能已删除"); return c;
	}
	private digest(c: StoredConnection, sql: string): string { return createHash("sha256").update(JSON.stringify(c)).update(sql).digest("hex"); }
	async list(): Promise<DatabaseConnection[]> { await this.queue; return (await this.load()).connections.map(publicConnection); }
	async save(id: string | undefined, input: DatabaseInput): Promise<DatabaseConnection> {
		const normalized = normalize(input);
		if (normalized.sshHostId) await this.hosts.require(normalized.sshHostId);
		if (normalized.kind === "sqlite" && !(await stat(normalized.file!)).isFile()) throw new Error("SQLite 路径不是文件");
		return this.mutate(s => {
			const old = id ? s.connections.find(c => c.id === id) : undefined;
			if (id && !old) throw new Error("数据库连接不存在");
			const c = this.encode(normalized, old);
			s.connections = [...s.connections.filter(v => v.id !== c.id), c]; return publicConnection(c);
		});
	}
	async remove(id: string): Promise<null> {
		await this.mutate(s => { s.connections = s.connections.filter(c => c.id !== id); s.history = s.history.filter(h => h.connectionId !== id); s.saved = s.saved.filter(h => h.connectionId !== id); }); return null;
	}
	cancel(client: string): null { this.operations.get(client)?.abort(); return null; }
	releaseClient(client: string): void { this.cancel(client); for (const [token, approval] of this.approvals) if (approval.client === client) this.approvals.delete(token); }
	dispose(): void { for (const op of this.operations.values()) op.abort(); this.approvals.clear(); }
	private async operation<T>(client: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.operations.has(client)) throw new Error("已有数据库操作正在执行，请等待或取消");
		const controller = new AbortController(); this.operations.set(client, controller);
		try { return await task(controller.signal); } finally { this.operations.delete(client); }
	}
	private async tunnel(c: DatabaseInput, signal: AbortSignal): Promise<{ connection: DatabaseInput; close: () => void }> {
		if (!c.sshHostId) return { connection: c, close: () => {} };
		const host = await this.hosts.require(c.sshHostId);
		if (signal.aborted) throw new Error("数据库操作已取消");
		const port = await new Promise<number>((resolve, reject) => {
			const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(e => e ? reject(e) : resolve(port)); });
		});
		const { command, args } = sshTunnelArgs(host, port, c.host!, c.port!);
		const child = spawn(command, args, { env: sshEnv(host), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "", failure: Error | undefined, exited = false;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", b => { stderr = (stderr + b).slice(-8192); });
		child.on("error", e => { failure = e; }); child.on("exit", () => { exited = true; });
		const abort = () => { child.kill(); }; signal.addEventListener("abort", abort, { once: true });
		const close = () => { signal.removeEventListener("abort", abort); child.kill(); };
		try {
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				if (signal.aborted) throw new Error("数据库操作已取消");
				if (failure || exited) { if (isHostKeyChangedError(stderr)) throw hostKeyChangedError(host, stderr); throw failure ?? new Error(`SSH 隧道失败：${stderr.trim()}`); }
				const ready = await new Promise<boolean>(resolve => { const socket = createConnection({ host: "127.0.0.1", port }); const done = (ok: boolean) => { socket.destroy(); resolve(ok); }; socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.setTimeout(200, () => done(false)); });
				if (ready) return { connection: { ...c, host: "127.0.0.1", port }, close };
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error("SSH 隧道连接超时");
		} catch (e) { close(); throw e; }
	}
	private async execute<T>(connection: DatabaseInput, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<T> {
		if (connection.kind === "sqlite" && !(await stat(connection.file!)).isFile()) throw new Error("SQLite 文件不存在");
		const tunnel = await this.tunnel(connection, signal);
		try {
			if (signal.aborted) throw new Error("数据库操作已取消");
			return await new Promise<T>((resolve, reject) => {
				const child = spawn(process.execPath, ["--no-warnings", "-e", DATABASE_RUNNER], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
				let output = "", stderr = "", settled = false;
				const finish = (error?: Error, result?: T) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); child.kill(); if (error) reject(error); else resolve(result!); };
				const abort = () => finish(new Error("数据库操作已取消；已发送的写操作可能已经生效，请核对数据库后再重试"));
				const timer = setTimeout(() => finish(new Error(`数据库操作超时（${this.timeoutMs / 1000} 秒）；写操作请先核对是否已生效，不要自动重试`)), this.timeoutMs);
				signal.addEventListener("abort", abort, { once: true });
				child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
				child.stdout.on("data", b => { output += b; if (output.length > 16 * 1024 * 1024) finish(new Error("数据库结果超出传输限制")); });
				child.stderr.on("data", b => { stderr = (stderr + b).slice(-4096); });
				child.on("error", e => finish(e)); child.stdin.on("error", () => {});
				child.on("close", () => { if (settled) return; try { const r = JSON.parse(output); finish(r.error ? new Error(r.error) : undefined, r.result); } catch { finish(new Error(`数据库执行进程异常退出：${stderr || "无有效结果"}`)); } });
				child.stdin.end(JSON.stringify({ ...args, action, connection: { ...tunnel.connection, tlsServername: connection.host }, moduleBase: import.meta.url }));
			});
		} finally { tunnel.close(); }
	}
	async test(id: string | undefined, input: DatabaseInput, client: string): Promise<{ durationMs: number }> {
		const c = this.decode(this.encode(input, id ? await this.require(id) : undefined));
		return this.operation(client, signal => this.execute(c, "test", { readOnly: true }, signal));
	}
	async tables(id: string, client: string): Promise<DatabaseMethods["database.tables"]["result"]> {
		const c = this.decode(await this.require(id)); return this.operation(client, signal => this.execute(c, "tables", { readOnly: true }, signal));
	}
	async browse(p: DatabaseBrowseParams, client: string): Promise<DatabaseMethods["database.browse"]["result"]> {
		const c = this.decode(await this.require(p.connectionId));
		if (!p.table || typeof p.table.name !== "string" || typeof p.table.schema !== "string" || /[\x00-\x1f]/.test(p.table.name + p.table.schema) || p.table.name.length > 512 || p.table.schema.length > 512) throw new Error("无效的表名");
		const page = p.page ?? 1, pageSize = p.pageSize ?? 50;
		if (!Number.isInteger(page) || page < 1 || page > 1_000_000 || ![25, 50, 100, 250].includes(pageSize)) throw new Error("无效的分页参数");
		const filter = p.filter?.trim() ?? "";
		if (filter) { const check = inspectSql(`SELECT 1 WHERE (${filter}\n)`); if (!check.readOnly || filter.includes(";")) throw new Error("筛选仅允许单条只读表达式"); }
		return this.operation(client, signal => this.execute(c, "browse", { ...p, page, pageSize, filter, readOnly: true }, signal));
	}
	async prepareWrite(p: { connectionId: string; sql: string }, client: string): Promise<{ token: string }> {
		inspectSql(p.sql); const c = await this.require(p.connectionId);
		if (c.readOnly) throw new Error("这是只读连接；如确需写入，请编辑连接并关闭只读，再逐次确认");
		for (const [key, a] of this.approvals) if (a.expires < Date.now() || a.client === client) this.approvals.delete(key);
		if (this.approvals.size > 1000) throw new Error("待确认操作过多，请稍后重试");
		const token = randomUUID(); this.approvals.set(token, { client, digest: this.digest(c, p.sql), expires: Date.now() + 120_000 }); return { token };
	}
	async query(p: DatabaseQueryParams, client: string): Promise<DatabaseResult> {
		const checked = inspectSql(p.sql), stored = await this.require(p.connectionId), connection = this.decode(stored);
		if (!checked.readOnly) {
			if (connection.readOnly) throw new Error("只读连接不能执行写操作，请编辑连接后再确认执行");
			const approval = this.approvals.get(p.confirmationToken ?? ""); this.approvals.delete(p.confirmationToken ?? "");
			if (!approval || approval.client !== client || approval.expires < Date.now() || approval.digest !== this.digest(stored, p.sql)) throw new Error("写操作需要重新确认（确认仅适用于当前连接与这条 SQL）");
		}
		const started = Date.now();
		return this.operation(client, async signal => {
			let result: DatabaseResult | undefined, error: unknown;
			try { result = await this.execute(connection, "query", { sql: checked.sql, readOnly: checked.readOnly }, signal); }
			catch (e) { error = e; }
			// 记录失败不应把已提交的写操作伪装成执行失败，从而导致用户重复提交。
			await this.mutate(s => { s.history.unshift({ id: randomUUID(), connectionId: stored.id, sql: p.sql, createdAt: started, durationMs: Date.now() - started, ok: !error, ...(error ? { error: message(error).slice(0, 1000) } : {}) }); s.history = s.history.slice(0, 500); }).catch(() => undefined);
			if (error) throw error; return result!;
		});
	}
	async history(id: string): Promise<DatabaseHistory[]> { await this.queue; await this.require(id); return (await this.load()).history.filter(h => h.connectionId === id).slice(0, 100); }
	async clearHistory(id: string): Promise<null> { await this.mutate(s => { s.history = s.history.filter(h => h.connectionId !== id); }); return null; }
	async saved(id: string): Promise<DatabaseSavedQuery[]> { await this.queue; await this.require(id); return (await this.load()).saved.filter(h => h.connectionId === id); }
	async saveQuery(connectionId: string, name: string, sql: string): Promise<DatabaseSavedQuery> {
		await this.require(connectionId); inspectSql(sql);
		if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("请填写查询名称（最多 100 字符）");
		return this.mutate(s => { if (s.saved.length >= 500) throw new Error("最多保存 500 条收藏查询"); const q = { id: randomUUID(), connectionId, name: name.trim(), sql, createdAt: Date.now() }; s.saved.push(q); return q; });
	}
	async removeQuery(id: string): Promise<null> { await this.mutate(s => { s.saved = s.saved.filter(q => q.id !== id); }); return null; }
}
