/** 隔离 Electron 后端回归：真实 utilityProcess worker + 父子进程 IPC，无应用 HTTP/WebSocket 服务。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import electronPath from "electron";
import { root } from "../runtime.mjs";

export const TIMEOUT_MS = 45_000;
export function deadline(promise, label, ms = TIMEOUT_MS) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms); }),
	]).finally(() => clearTimeout(timer));
}

class Client {
	constructor(host, id) {
		this.host = host;
		this.id = id;
		this.pushes = [];
		this.listeners = new Set();
		this.closed = false;
	}
	push(value) {
		this.pushes.push(value);
		for (const listener of [...this.listeners]) listener();
	}
	call(method, params) {
		if (this.closed) return Promise.reject(new Error("IPC 客户端已关闭"));
		return this.host.rpc("request", { clientId: this.id, method, params });
	}
	send(handleId, command) { return this.call("session.send", { handleId, command }); }
	waitPush(predicate, from = 0, label = "推送", timeoutMs = TIMEOUT_MS) {
		let listener;
		const result = new Promise((resolve) => {
			listener = () => {
				const index = this.pushes.findIndex((push, i) => i >= from && predicate(push, i));
				if (index >= 0) resolve(this.pushes[index]);
			};
			this.listeners.add(listener);
			listener();
		});
		return deadline(result, label, timeoutMs).finally(() => this.listeners.delete(listener));
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		this.host.clients.delete(this.id);
		await this.host.rpc("close", { clientId: this.id });
	}
}

/** 创建独立逻辑客户端，保留原有跨客户端 owner、广播和断开清理测试。 */
export async function connect(endpoint) {
	await endpoint.ready;
	const id = randomUUID();
	const client = new Client(endpoint, id);
	endpoint.clients.set(id, client);
	try { await endpoint.rpc("connect", { clientId: id }); return client; }
	catch (error) { endpoint.clients.delete(id); throw error; }
}

export async function startIsolatedBackend({ label = "isolated", extraEnv = {} } = {}) {
	const entry = join(root, "out/test-support/electron-test-host.cjs");
	assert.ok(existsSync(entry) && existsSync(join(root, "out/main/pi-worker.js")), "缺少桌面回归构建产物；请先 npm run build && npm run build:test");
	mkdirSync(join(root, "out"), { recursive: true });
	const base = mkdtempSync(join(root, "out", `test-${label}-`));
	const dataDir = join(base, "data"), agentDir = join(base, "agent");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	Object.assign(process.env, { FLOWORK_DATA_DIR: dataDir, FLOWORK_PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1" });
	const env = { ...process.env, ...extraEnv };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = spawn(electronPath, [entry], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"], env });
	const pending = new Map(), clients = new Map();
	let output = "", exitResult, resolveReady, rejectReady;
	const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	ready.catch(() => undefined);
	const fail = (error) => {
		rejectReady(error);
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
		output = (output + chunk.toString()).slice(-16_000);
		process.stdout.write(chunk);
	});
	const exited = new Promise((resolve, reject) => {
		child.once("error", (error) => { fail(error); reject(error); });
		child.once("exit", (code, signal) => {
			exitResult = { code, signal };
			fail(new Error(`Electron 测试进程已退出：${JSON.stringify(exitResult)}\n${output}`));
			resolve(exitResult);
		});
	});
	exited.catch(() => undefined);
	child.on("message", (payload) => {
		try {
			const frame = JSON.parse(payload);
			if (frame.ready) { resolveReady(); return; }
			if (frame.push) { for (const client of clients.values()) client.push(frame.push); return; }
			const request = pending.get(frame.id);
			if (!request) return;
			pending.delete(frame.id);
			frame.ok ? request.resolve(frame.result) : request.reject(new Error(frame.error));
		} catch (error) { fail(error); }
	});
	const endpoint = {
		ready, clients,
		rpc(kind, params = {}) {
			if (exitResult || !child.connected) return Promise.reject(new Error("Electron IPC 已断开"));
			const id = randomUUID();
			const result = new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				child.send(JSON.stringify({ id, kind, ...params }), (error) => {
					if (error) { pending.delete(id); reject(error); }
				});
			});
			return deadline(result, `${kind} ${params.method ?? ""}`).finally(() => pending.delete(id));
		},
	};
	const waitReady = async ({ timeoutMs = TIMEOUT_MS, signal } = {}) => {
		if (signal?.aborted) throw new Error("等待 Electron 时被中断");
		let abort;
		try {
			await deadline(signal ? Promise.race([ready, new Promise((_, reject) => {
				abort = () => reject(new Error("等待 Electron 时被中断"));
				signal.addEventListener("abort", abort, { once: true });
			})]) : ready, "Electron 启动", timeoutMs);
			return endpoint;
		} finally { if (abort) signal.removeEventListener("abort", abort); }
	};
	let stopped = false, cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		cleaned = true;
	};
	const onExit = () => {
		if (cleaned) return;
		if (child.exitCode === null && child.signalCode === null) child.kill();
		// 未确认退出时不删除活动文件。
		if (exitResult) cleanup();
	};
	process.once("exit", onExit);
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		if (!exitResult && child.connected) child.send(JSON.stringify({ kind: "shutdown" }));
		let result;
		try { result = await deadline(exited, "隔离 Electron 退出", 20_000); }
		catch (error) {
			child.kill();
			await deadline(exited, "强制退出 Electron", 5000);
			throw error;
		} finally {
			if (exitResult) { cleanup(); process.off("exit", onExit); console.log(`CLEANED ${base}`); }
		}
		assert.equal(result.code, 0, `Electron 退出异常：${JSON.stringify(result)}\n${output}`);
	};
	return { endpoint, root: base, dataDir, agentDir, child, exited, output: () => output, waitReady, stop };
}

export function createChecks() {
	let failed = 0;
	return {
		check(label, condition) {
			if (!condition) failed++;
			console.log(`${condition ? "✓" : "✗"} ${label}`);
			return !!condition;
		},
		get failed() { return failed; },
		finish(summary) {
			if (failed > 0) { console.error(`${failed} 项断言失败`); process.exitCode = 1; return false; }
			console.log(summary); return true;
		},
	};
}
