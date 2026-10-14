/**
 * 开发辅助测试共用：在 out/ 下启动一个隔离的网页版后端（临时数据目录 + 空闲端口 + IPC 优雅关闭），
 * 并提供与 test-sessions.mjs 一致的 WebSocket 客户端与断言计数。
 *
 * 调用方固定骨架（见 scripts/test-*.mjs）：
 *   const checks = createChecks();
 *   if (!installRelayFromEnv()) {
 *     await main(checks).then(
 *       () => checks.finish("XXX REGRESSION OK"),
 *       (error) => { console.error(`XXX REGRESSION FAILED\n${error?.stack ?? error}`); process.exitCode = 1; },
 *     );
 *   }
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { root } from "../web-build-options.mjs";

/** 单次等待的默认上限 */
export const TIMEOUT_MS = 45_000;
/** wrapper 通过 IPC 请求隔离 server 关闭的消息字段 */
const SHUTDOWN_MESSAGE = "floworkSessionsShutdown";
/** 子进程输出保留的尾部长度，出错时用于诊断 */
const OUTPUT_TAIL = 16_000;

export function deadline(promise, label, ms = TIMEOUT_MS) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export async function freePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return port;
}

/**
 * 在 `--import` 注入的子进程里安装信号转发（由 startIsolatedBackend 使用）：
 * - wrapper：拦截 start-web 启动真实 server 的 spawn，注入 relay 并转发关闭消息；
 * - server：收到关闭消息后给自己发 SIGTERM，交给 start-web 优雅关闭（Windows 下 kill 不是优雅关闭）。
 * 返回 true 表示当前进程是注入的 relay，调用方不应继续跑测试主体。
 */
export function installRelayFromEnv() {
	const role = process.env.FLOWORK_SESSIONS_TEST_RELAY;
	if (!role) return false;
	delete process.env.FLOWORK_SESSIONS_TEST_RELAY;
	const entry = process.env.FLOWORK_TEST_RELAY_ENTRY;
	if (role === "server") {
		// 去掉 --import，避免 start-web 启动的 server 再次注入
		const index = process.execArgv.indexOf("--import");
		if (index !== -1 && process.execArgv[index + 1] === entry) process.execArgv.splice(index, 2);
		process.on("message", (message) => {
			if (message?.[SHUTDOWN_MESSAGE]) process.emit("SIGTERM");
		});
		return true;
	}
	const originalSpawn = childProcess.spawn;
	let server;
	childProcess.spawn = (command, args, options) => {
		server = originalSpawn(command, ["--import", entry, ...args], {
			...options,
			stdio: ["inherit", "inherit", "inherit", "ipc"],
			env: { ...options.env, FLOWORK_SESSIONS_TEST_RELAY: "server" },
		});
		return server;
	};
	syncBuiltinESMExports();
	process.on("message", (message) => {
		if (message?.[SHUTDOWN_MESSAGE] && server?.connected) server.send(message);
	});
	return true;
}

class Client {
	constructor(socket) {
		this.socket = socket;
		this.sequence = 0;
		this.pending = new Map();
		this.pushes = [];
		this.listeners = new Set();
		socket.on("message", (data) => {
			try {
				const frame = JSON.parse(String(data));
				if (frame.push) {
					this.pushes.push(frame.push);
					for (const listener of [...this.listeners]) listener();
				} else {
					const pending = this.pending.get(frame.id);
					if (!pending) return;
					this.pending.delete(frame.id);
					frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error));
				}
			} catch (error) {
				this.fail(error);
			}
		});
		socket.on("error", (error) => this.fail(error));
		socket.on("close", () => this.fail(new Error("WebSocket 已关闭")));
	}

	fail(error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	call(method, params) {
		const id = String(++this.sequence);
		const result = new Promise((resolve, reject) => {
			if (this.socket.readyState !== WebSocket.OPEN) return reject(new Error("WebSocket 未连接"));
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }), (error) => {
				if (error) {
					this.pending.delete(id);
					reject(error);
				}
			});
		});
		return deadline(result, method).finally(() => this.pending.delete(id));
	}

	send(handleId, command) {
		return this.call("session.send", { handleId, command });
	}

	/** predicate(push, index)：index 为 pushes 中的下标，便于按游标推进 */
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
		if (this.socket.readyState === WebSocket.CLOSED) return;
		const closed = new Promise((resolve) => this.socket.once("close", resolve));
		this.socket.close();
		try {
			await deadline(closed, "WebSocket 关闭", 3000);
		} catch {
			this.socket.terminate();
			await deadline(closed, "WebSocket terminate", 3000);
		}
	}
}

export async function connect(url) {
	const socket = new WebSocket(url.replace(/^http/, "ws") + "ws", { origin: url.slice(0, -1) });
	const client = new Client(socket);
	try {
		await deadline(new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		}), "WebSocket 连接", 2000);
		return client;
	} catch (error) {
		socket.terminate();
		throw error;
	}
}

/**
 * 启动隔离后端：out/ 下新建临时根目录，数据目录与 pi 配置目录都指向它，选空闲端口，
 * 用 `--import` 注入 relay 以便 IPC 优雅关闭。当前进程的 FLOWORK_* 环境变量也会被改写，
 * 使测试里直接 import 的 SDK 落在同一隔离目录。
 */
export async function startIsolatedBackend({ port, label = "isolated", extraEnv = {}, entry } = {}) {
	assert.ok(existsSync(join(root, "out/web/server/index.js")), "缺少构建产物 out/web/server/index.js；请先 npm run build:web");
	mkdirSync(join(root, "out"), { recursive: true });
	// 先算出 relay 入口（调用方脚本本身），避免参数非法时留下临时目录
	const entryPath = entry ?? process.argv[1];
	assert.ok(entryPath, "startIsolatedBackend 需要由脚本文件调用，或显式传入 entry");
	const entryUrl = pathToFileURL(resolve(entryPath)).href;
	const base = mkdtempSync(join(root, "out", `test-${label}-`));
	const dataDir = join(base, "data");
	const agentDir = join(base, "agent");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	Object.assign(process.env, {
		FLOWORK_DATA_DIR: dataDir,
		FLOWORK_PI_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1",
	});
	const chosenPort = port ?? await freePort();
	const url = `http://127.0.0.1:${chosenPort}/`;
	const child = childProcess.spawn(process.execPath, ["--import", entryUrl, join(root, "scripts/start-web.mjs")], {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		env: {
			...process.env,
			FLOWORK_PORT: String(chosenPort),
			FLOWORK_SESSIONS_TEST_RELAY: "wrapper",
			FLOWORK_TEST_RELAY_ENTRY: entryUrl,
			...extraEnv,
		},
	});
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
		output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
		process.stdout.write(chunk);
	});
	let exitResult;
	const exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			exitResult = { code, signal };
			resolve(exitResult);
		});
	});
	exited.catch(() => undefined);

	/** 轮询到后端可连接；signal 中断时抛出 AbortError，供调用方区分 Ctrl-C */
	const waitReady = async ({ timeoutMs = TIMEOUT_MS, signal } = {}) => {
		const start = Date.now();
		for (;;) {
			if (exitResult) throw new Error(`隔离 server 提前退出：${JSON.stringify(exitResult)}\n${output}`);
			if (signal?.aborted) {
				const error = new Error("等待隔离 server 启动时被中断");
				error.name = "AbortError";
				throw error;
			}
			try {
				const probe = await connect(url);
				await probe.close();
				return url;
			} catch (error) {
				if (Date.now() - start > timeoutMs) throw new Error(`隔离 server 启动失败：${error.message}\n${output}`);
				await sleep(150, undefined, { signal });
			}
		}
	};

	let stopped = false;
	let cleaned = false;
	/** 确认子进程退出后才清理临时目录；退出码非 0 视为失败 */
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		let confirmed = false;
		try {
			if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ [SHUTDOWN_MESSAGE]: true });
			const result = await deadline(exited, "隔离 server 与 start-web 子进程退出", 20_000);
			confirmed = true;
			assert.equal(result.code, 0, `隔离 server 退出异常：${JSON.stringify(result)}\n${output}`);
		} finally {
			if (confirmed) {
				rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
				cleaned = true;
				console.log(`CLEANED ${base}`);
			} else console.error(`未确认子进程退出，保留隔离目录避免清理活动文件：${base}`);
		}
	};

	// 兜底：进程异常退出（未捕获异常 / 未处理拒绝）时也要收掉子进程与临时目录，避免留下孤儿 server
	process.once("exit", () => {
		if (cleaned) return;
		if (child.exitCode === null && child.signalCode === null) child.kill();
		rmSync(base, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
		process.stderr.write(`异常退出，已清理隔离目录：${base}\n`);
	});

	return { url, port: chosenPort, root: base, dataDir, agentDir, child, exited, output: () => output, waitReady, stop };
}

/** 断言计数：逐条打印 ✓/✗，失败累计，finish() 统一决定退出码 */
export function createChecks() {
	let failed = 0;
	return {
		check(label, condition) {
			if (condition) {
				console.log(`✓ ${label}`);
				return true;
			}
			failed++;
			console.log(`✗ ${label}`);
			return false;
		},
		get failed() {
			return failed;
		},
		/** 全部通过打印总结行；否则打印失败项数并置 process.exitCode = 1 */
		finish(summary) {
			if (failed > 0) {
				console.error(`${failed} 项断言失败`);
				process.exitCode = 1;
				return false;
			}
			console.log(summary);
			return true;
		},
	};
}
