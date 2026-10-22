/** 可控 worker 替身：覆盖超时、心跳、取消、发送异常、迟到响应与协调队列恢复，不启动模型。 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "out"), { recursive: true });
const work = mkdtempSync(join(root, "out/test-worker-manager-"));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const policy = { requestMs: 40, operationMs: 90, packageMs: 180, heartbeatMs: 10 };
class FakeWorker {
	messages = []; killed = 0; ping = true; autoExit = true; throwSend = false;
	postMessage(m) {
		if (m.kind === "init") queueMicrotask(() => this.emit({ kind: "ready", state: { sessionId: "fixture", cwd: m.init.cwd } }));
		if (m.kind === "shutdown") queueMicrotask(() => this.exit?.(0));
		if (m.kind !== "command") return;
		if (this.throwSend) throw new Error("post failed");
		this.messages.push(m);
		if (m.command.type === "ping" && this.ping) queueMicrotask(() => this.reply(m, "pong"));
		if (m.command.type === "validate_session") queueMicrotask(() => this.reply(m, { path: m.command.path }));
	}
	onMessage(fn) { this.emit = fn; }
	onSpawn(fn) { queueMicrotask(fn); }
	onExit(fn) { this.exit = fn; }
	kill() { this.killed++; if (this.autoExit) queueMicrotask(() => this.exit?.(1)); }
	reply(m, data) { this.emit({ kind: "response", id: m.id, ok: true, data }); }
	last(type) { return this.messages.findLast(m => m.command.type === type); }
}
try {
	const outfile = join(work, "manager.mjs");
	await build({ entryPoints: [join(root, "src/core/worker-manager.ts")], outfile, bundle: true, platform: "node", format: "esm", packages: "external", tsconfig: join(root, "tsconfig.node.json"), logLevel: "silent" });
	const { WorkerClient, WorkerManager } = await import(pathToFileURL(outfile).href);
	const start = async () => {
		const proc = new FakeWorker();
		const { client } = await WorkerClient.start(() => proc, { role: "session", cwd: work }, {}, policy);
		return { proc, client };
	};
	{
		const { proc, client } = await start();
		const result = client.send({ type: "get_state" }); const req = proc.last("get_state");
		const rejected = assert.rejects(result, /请求超时.*get_state.*不会自动重试/);
		await rejected;
		assert.equal(proc.killed, 1); assert.equal(client.pending.size, 0);
		proc.reply(req, "late"); assert.equal(client.pending.size, 0);
		await assert.rejects(client.send({ type: "get_state" }), /退出|超时/);
		assert.equal(proc.messages.filter(m => m.command.type === "get_state").length, 1);
	}
	{
		const { proc, client } = await start();
		const controller = new AbortController(); controller.abort();
		await assert.rejects(client.send({ type: "set_label", entryId: "x", label: "x" }, { signal: controller.signal }), /未发送/);
		assert.equal(proc.messages.length, 0); assert.equal(proc.killed, 0);
		const active = new AbortController();
		const result = client.send({ type: "install_package", cwd: work, source: "fixture", scope: "user" }, { signal: active.signal });
		const rejected = assert.rejects(result, /已取消.*不会自动重试/); active.abort(); await rejected;
		assert.equal(proc.killed, 1); assert.equal(client.pending.size, 0);
	}
	{
		const { proc, client } = await start();
		proc.throwSend = true;
		await assert.rejects(client.send({ type: "get_state" }), /post failed/);
		assert.equal(client.pending.size, 0); assert.equal(proc.killed, 1);
	}
	{
		const { proc, client } = await start();
		const result = client.send({ type: "navigate_tree", entryId: "a" });
		proc.emit({ kind: "event", event: { type: "ext_ui_request", request: { id: "dialog", method: "confirm", title: "waiting", startedAt: Date.now() } } });
		await sleep(120);
		assert.equal(proc.killed, 0, "等待真实用户输入不算超时");
		assert.ok(proc.last("ping"), "等待交互时仍探测 worker 存活");
		proc.emit({ kind: "event", event: { type: "ext_ui_closed", id: "dialog" } });
		proc.reply(proc.last("navigate_tree"), "ok"); assert.equal(await result, "ok");
		await sleep(100); assert.equal(proc.killed, 0, "完成后清除请求与心跳定时器");
		assert.equal(client.pending.size, 0); await client.shutdown();
	}
	{
		const { proc, client } = await start();
		const result = client.send({ type: "prompt", message: "fixture" });
		await sleep(110); assert.equal(proc.killed, 0, "长任务不按普通查询时限中断");
		const aborted = client.send({ type: "abort" });
		proc.reply(proc.last("abort"), null); await aborted;
		proc.reply(proc.last("prompt"), { disposition: "handled" }); await result; await client.shutdown();
	}
	{
		const { proc, client } = await start();
		const prompt = client.send({ type: "prompt", message: "fixture" });
		const promptRejected = assert.rejects(prompt, /请求超时.*abort/);
		proc.emit({ kind: "event", event: { type: "ext_ui_request", request: { id: "waiting", method: "confirm", title: "waiting", startedAt: Date.now() } } });
		await assert.rejects(client.send({ type: "abort" }), /请求超时.*abort/, "取消自身不能因人工等待而暂停时限");
		await promptRejected; assert.equal(proc.killed, 1);
	}
	{
		const { proc, client } = await start();
		const result = client.send({ type: "navigate_tree", entryId: "a", summarize: true });
		await sleep(110); assert.equal(proc.killed, 0, "树导航的模型摘要不按普通操作总时限中断");
		proc.reply(proc.last("navigate_tree"), {}); await result; await client.shutdown();
	}
	{
		const { proc, client } = await start();
		const result = client.send({ type: "auth_login", provider: "fixture", method: "oauth", flowId: "f" });
		const rejected = assert.rejects(result, /请求超时.*auth_login/);
		client.post({ kind: "auth_cancel", flowId: "f" });
		await rejected;
		assert.equal(proc.killed, 1, "活着但不响应取消的 OAuth 也必须能收敛");
		assert.equal(client.pending.size, 0);
	}
	{
		const { proc, client } = await start(); proc.ping = false;
		const result = client.send({ type: "auth_login", provider: "fixture", method: "oauth", flowId: "f" });
		proc.emit({ kind: "auth", event: { kind: "prompt", flowId: "f", promptId: "p", prompt: { type: "text", message: "waiting" } } });
		await assert.rejects(result, /请求超时.*ping/, "等待用户时真正失联的 worker 仍会被检测");
		assert.equal(proc.killed, 1); assert.equal(client.pending.size, 0);
	}
	{
		const procs = [];
		const manager = new WorkerManager(() => { const p = new FakeWorker(); procs.push(p); return p; }, undefined, policy);
		const opened = await manager.openSession({ cwd: work }, { onEvent() {}, onExit() {} });
		const first = procs[0]; first.autoExit = false;
		const stuck = manager.sendToSession(opened.handleId, { type: "new_session" });
		const rejected = assert.rejects(stuck, /请求超时.*new_session/);
		const queued = manager.openSession({ cwd: work }, { onEvent() {}, onExit() {} });
		await rejected; await queued;
		assert.equal(procs.length, 2, "超时后协调队列可继续执行");
		assert.equal(manager.getSession(opened.handleId).hasExited, false, "kill 不等于已确认 exit，原会话仍保留");
		first.exit(1);
		assert.throws(() => manager.getSession(opened.handleId), /不存在/);
		await manager.shutdownAll();
	}
	{
		const procs = [];
		const manager = new WorkerManager(() => { const p = new FakeWorker(); procs.push(p); return p; }, undefined, policy);
		const opened = await manager.openSession({ cwd: work }, { onEvent() {}, onExit() {} });
		const first = procs[0]; first.autoExit = false;
		const old = join(work, "old.jsonl"); const target = join(work, "target.jsonl");
		first.emit({ kind: "event", event: { type: "session_changed", state: { sessionId: "old", sessionFile: old, cwd: work } } });
		await assert.rejects(manager.sendToSession(opened.handleId, { type: "switch_session", sessionPath: target }), /请求超时/);
		await assert.rejects(manager.openSession({ cwd: work, sessionPath: old }, { onEvent() {}, onExit() {} }), /已打开/);
		await assert.rejects(manager.openSession({ cwd: work, sessionPath: target }, { onEvent() {}, onExit() {} }), /已打开/);
		first.emit({ kind: "event", event: { type: "session_changed", state: { sessionId: "target", sessionFile: target, cwd: work } } });
		await assert.rejects(manager.openSession({ cwd: work, sessionPath: old }, { onEvent() {}, onExit() {} }), /已打开/, "迟到的换记录事件不能解锁旧文件");
		first.exit(1); await manager.shutdownAll();
	}
	console.log("WORKER MANAGER REGRESSION OK（超时 / 取消 / 心跳 / 人工交互 / 不重试 / 保锁 / 队列恢复）");
} finally { rmSync(work, { recursive: true, force: true }); }
