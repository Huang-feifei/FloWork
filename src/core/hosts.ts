/**
 * SSH 主机注册表：保存在 ~/.flowork/hosts.json。
 *
 * 只记录连接参数，不保存会话。口令以明文存放（与 auth.json 的现状一致），
 * 因此界面会提示优先使用密钥或 ssh-agent。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SshHost, SshHostInput } from "@shared/protocol";
import { getFloworkDataDir } from "./paths";

interface StoredState {
	version: 1;
	hosts: SshHost[];
}

/** 去掉用户可能误填的空白与协议前缀（例如从 ssh:// 或 scp 命令里粘过来） */
function cleanHost(raw: string): string {
	return raw.trim().replace(/^ssh:\/\//i, "").replace(/\/+$/, "");
}

function normalizeInput(input: SshHostInput): SshHostInput {
	const host = cleanHost(input.host);
	if (!host) throw new Error("请填写主机地址");
	if (/[@\s]/.test(host)) throw new Error("主机地址里不要带 user@ 或空格，请填到「用户名」一栏");
	const port = input.port ? Number(input.port) : undefined;
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("端口需在 1-65535 之间");
	const auth = input.auth ?? "agent";
	if (auth === "key" && !input.keyPath?.trim()) throw new Error("请选择私钥文件");
	return {
		...input,
		host,
		port,
		user: input.user?.trim() || undefined,
		name: input.name?.trim() || undefined,
		keyPath: auth === "key" ? input.keyPath?.trim() : undefined,
		password: auth === "password" ? input.password : undefined,
		defaultPath: input.defaultPath?.trim() || undefined,
	};
}

export class HostStore {
	private state: StoredState | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly file = join(getFloworkDataDir(), "hosts.json")) {}

	private async load(): Promise<StoredState> {
		if (this.state) return this.state;
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoredState>;
			this.state = { version: 1, hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [] };
		} catch {
			this.state = { version: 1, hosts: [] };
		}
		return this.state;
	}

	private async persist(): Promise<void> {
		if (!this.state) return;
		await mkdir(getFloworkDataDir(), { recursive: true });
		const tmp = `${this.file}.tmp`;
		await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
		await rename(tmp, this.file);
	}

	private mutate<T>(fn: (state: StoredState) => T): Promise<T> {
		const run = this.queue.then(async () => {
			const state = await this.load();
			const result = fn(state);
			await this.persist();
			return result;
		});
		this.queue = run.catch(() => undefined);
		return run;
	}

	async list(): Promise<SshHost[]> {
		return (await this.load()).hosts.map((h) => ({ ...h }));
	}

	async get(id: string): Promise<SshHost | undefined> {
		const host = (await this.load()).hosts.find((h) => h.id === id);
		return host ? { ...host } : undefined;
	}

	/** 取主机并确保存在，找不到时抛出可读错误 */
	async require(id: string): Promise<SshHost> {
		const host = await this.get(id);
		if (!host) throw new Error("主机不存在，可能已被删除");
		return host;
	}

	add(input: SshHostInput) {
		return this.mutate((state) => {
			const host: SshHost = { id: randomUUID(), createdAt: Date.now(), ...normalizeInput(input) };
			state.hosts.push(host);
			return host;
		});
	}

	update(id: string, patch: Partial<SshHostInput>) {
		return this.mutate((state) => {
			const host = state.hosts.find((h) => h.id === id);
			if (!host) throw new Error("主机不存在");
			const merged = normalizeInput({ ...host, ...patch } as SshHostInput);
			Object.assign(host, merged);
			return { ...host };
		});
	}

	remove(id: string) {
		return this.mutate((state) => {
			state.hosts = state.hosts.filter((h) => h.id !== id);
		});
	}

	/** 连接测试后记录探测到的平台 */
	setPlatform(id: string, platform: SshHost["platform"]) {
		return this.mutate((state) => {
			const host = state.hosts.find((h) => h.id === id);
			if (host) host.platform = platform;
		});
	}
}
