import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { backendRuntime } from "./web-build-options.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const timeoutMs = 45_000;

function installSignalRelay(role) {
	delete process.env.FLOWORK_SESSIONS_TEST_RELAY;
	if (role === "server") {
		const preload = process.execArgv.indexOf("--import");
		if (preload !== -1 && process.execArgv[preload + 1] === pathToFileURL(script).href) process.execArgv.splice(preload, 2);
		process.on("message", (message) => {
			if (message?.floworkSessionsShutdown) process.emit("SIGTERM");
		});
		return;
	}
	const originalSpawn = childProcess.spawn;
	let server;
	childProcess.spawn = (command, args, options) => {
		server = originalSpawn(command, ["--import", pathToFileURL(script).href, ...args], {
			...options,
			stdio: ["inherit", "inherit", "inherit", "ipc"],
			env: { ...options.env, FLOWORK_SESSIONS_TEST_RELAY: "server" },
		});
		return server;
	};
	syncBuiltinESMExports();
	process.on("message", (message) => {
		if (message?.floworkSessionsShutdown && server?.connected) server.send(message);
	});
}

function deadline(promise, label, ms = timeoutMs) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

async function freePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return port;
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

	waitPush(predicate, from = 0, label = "推送") {
		let listener;
		const result = new Promise((resolve) => {
			listener = () => {
				const found = this.pushes.slice(from).find(predicate);
				if (found) resolve(found);
			};
			this.listeners.add(listener);
			listener();
		});
		return deadline(result, label).finally(() => this.listeners.delete(listener));
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

async function connect(url) {
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

function createFixtures(SessionManager, base, agentDir) {
	const project = join(base, "project");
	const otherProject = join(base, "other-project");
	mkdirSync(project, { recursive: true });
	mkdirSync(otherProject, { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [], skills: [], prompts: [], extensions: [] })}\n`);
	writeFileSync(join(agentDir, "extensions", "session-wait.js"), `
export default function (pi) {
  pi.registerCommand("flowork-wait", {
    description: "Isolated session mutation regression: wait without calling a model",
    handler: async (args, ctx) => {
      if (args.trim() === "confirm") await ctx.ui.confirm("Session regression", "Waiting for confirmation");
      else await ctx.ui.input("Session regression", "Waiting for input");
      ctx.ui.notify("flowork-wait-complete", "info");
    },
  });
}
`);
	const make = (label, cwd = project, sessionDir) => {
		const manager = SessionManager.create(cwd, sessionDir);
		const first = manager.appendMessage({ role: "user", content: [{ type: "text", text: `${label}: first message` }], timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: [{ type: "text", text: `${label}: original branch` }], timestamp: Date.now() });
		manager.branch(first);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: `${label}: alternate branch` }], timestamp: Date.now() });
		const path = manager.getSessionFile();
		assert.ok(path && existsSync(path), "SDK 必须持久化 fixture");
		return { path, id: manager.getSessionId(), cwd, firstMessage: `${label}: first message` };
	};
	const fixtures = Object.fromEntries(["history", "current", "background", "unopened", "parent", "waitResponse", "waitAbort", "duplicate", "race"].map((label) => [label, make(label)]));
	const fork = SessionManager.forkFrom(fixtures.parent.path, project);
	fork.appendMessage({ role: "user", content: [{ type: "text", text: "child remains readable after parent deletion" }], timestamp: Date.now() });
	fixtures.child = { path: fork.getSessionFile(), id: fork.getSessionId(), cwd: project };
	assert.equal(fork.getHeader().parentSession, fixtures.parent.path);
	fixtures.outside = make("outside", project, join(base, "outside-sessions"));
	fixtures.other = make("other", otherProject);
	fixtures.invalid = join(dirname(fixtures.history.path), "not-a-session.jsonl");
	writeFileSync(fixtures.invalid, '{"type":"not-a-session","text":"must survive"}\n');
	fixtures.missing = join(dirname(fixtures.history.path), "missing.jsonl");
	return { fixtures, project, otherProject };
}

function diskIdentity(SessionManager, path) {
	const manager = SessionManager.open(path);
	return {
		id: manager.getSessionId(),
		header: manager.getHeader(),
		entries: manager.getEntries().filter((entry) => entry.type !== "session_info"),
	};
}

function treeMessages(tree) {
	return tree.flatMap((node) => [
		...(node.entryType === "message" ? [{ id: node.id, parentId: node.parentId, role: node.role, preview: node.preview }] : []),
		...treeMessages(node.children),
	]).sort((a, b) => a.id.localeCompare(b.id));
}

async function runChecks(client, observer, SessionManager, data) {
	const { fixtures: f, project, otherProject } = data;
	const active = new Set();
	const list = () => client.call("service.send", { type: "list_sessions", cwd: project });
	const summary = async (path) => (await list()).find((session) => session.path === path);
	const open = async (fixture) => {
		const result = await client.call("session.open", { cwd: fixture.cwd, sessionPath: fixture.path });
		active.add(result.handleId);
		assert.equal(result.state.sessionId, fixture.id);
		assert.equal(result.state.sessionFile, fixture.path);
		return result;
	};
	const mutation = async (method, fixture, name) => {
		const from = client.pushes.length;
		const observedFrom = observer.pushes.length;
		assert.equal(await client.call(method, { cwd: fixture.cwd, path: fixture.path, ...(name === undefined ? {} : { name }) }), null, `${method} 必须返回 null`);
		const changed = (push) => push.type === "sessions_changed" && push.cwd === fixture.cwd;
		await Promise.all([
			client.waitPush(changed, from, `${method} sessions_changed`),
			observer.waitPush(changed, observedFrom, `${method} 跨连接推送`),
		]);
	};
	const exit = async (handleId, from) => {
		const push = await client.waitPush((push) => push.type === "session_exit" && push.handleId === handleId, from, "正常 session_exit");
		assert.equal(push.expected, true, "正常关闭/删除必须 expected=true");
		assert.equal(push.code, 0, "正常 worker 应以 code=0 退出");
		active.delete(handleId);
		await assert.rejects(client.send(handleId, { type: "get_state" }), /.+/, "旧 handle 必须不可用");
	};
	const close = async (handleId) => {
		const from = client.pushes.length;
		assert.equal(await client.call("session.close", { handleId }), null);
		await exit(handleId, from);
	};
	const remove = async (fixture, handleId) => {
		const from = client.pushes.length;
		await mutation("sessions.delete", fixture);
		if (handleId) await exit(handleId, from);
		assert.equal(existsSync(fixture.path), false, "删除必须移除文件");
		assert.equal(await summary(fixture.path), undefined, "删除必须移除历史列表项");
		await assert.rejects(client.call("session.open", { cwd: fixture.cwd, sessionPath: fixture.path }), /.+/, "删除后的路径不能复活");
		assert.equal(existsSync(fixture.path), false, "失败的 open 不能重新创建文件");
	};
	const report = (label) => console.log(`PASS ${label}`);

	try {
		const info = await client.call("app.info");
		assert.equal(resolve(info.agentDir), resolve(process.env.FLOWORK_PI_AGENT_DIR));
		const identity = diskIdentity(SessionManager, f.history.path);
		const defaultSummary = await summary(f.history.path);
		assert.equal(defaultSummary.firstMessage, f.history.firstMessage);
		await mutation("sessions.rename", f.history, "  历史会话 / renamed  ");
		assert.equal((await summary(f.history.path)).name, "历史会话 / renamed");
		assert.deepEqual(diskIdentity(SessionManager, f.history.path), identity, "历史重命名不能改变消息树、header 或 sessionID");
		const historical = await open(f.history);
		assert.equal(historical.state.sessionName, "历史会话 / renamed");
		await close(historical.handleId);
		await mutation("sessions.rename", f.history, "   ");
		const reset = await summary(f.history.path);
		assert.ok(!reset.name, "空白名称应恢复默认标题");
		assert.equal(reset.firstMessage, defaultSummary.firstMessage);
		const resetOpened = await open(f.history);
		assert.ok(!resetOpened.state.sessionName);
		await close(resetOpened.handleId);
		report("历史 rename、trim、空名恢复默认、重开持久化与数据不变");

		const current = await open(f.current);
		const background = await open(f.background);
		for (const [fixture, opened, name] of [[f.current, current, "当前 renamed"], [f.background, background, "后台 renamed"]]) {
			const before = {
				identity: diskIdentity(SessionManager, fixture.path),
				messages: await client.send(opened.handleId, { type: "get_messages" }),
				tree: treeMessages((await client.send(opened.handleId, { type: "get_tree" })).tree),
			};
			const from = client.pushes.length;
			await mutation("sessions.rename", fixture, name);
			await client.waitPush((push) => push.type === "session_event" && push.handleId === opened.handleId && push.event.type === "session_info_changed" && push.event.name === name, from, "owner 名称事件");
			const state = await client.send(opened.handleId, { type: "get_state" });
			assert.equal(state.sessionName, name);
			assert.equal(state.sessionId, fixture.id);
			assert.equal(state.sessionFile, fixture.path);
			assert.deepEqual(await client.send(opened.handleId, { type: "get_messages" }), before.messages);
			assert.deepEqual(treeMessages((await client.send(opened.handleId, { type: "get_tree" })).tree), before.tree);
			assert.deepEqual(diskIdentity(SessionManager, fixture.path), before.identity);
			assert.ok(!client.pushes.slice(from).some((push) => push.type === "session_event" && push.event.type === "session_changed"), "rename 不得切换任何会话");
		}
		assert.equal((await client.send(current.handleId, { type: "get_state" })).sessionId, f.current.id);
		assert.equal((await client.send(background.handleId, { type: "get_state" })).sessionId, f.background.id);
		await close(background.handleId);
		const reopenedBackground = await open(f.background);
		assert.equal(reopenedBackground.state.sessionName, "后台 renamed");
		report("current/background owner rename、不切换、消息树/sessionID不变与重开持久化");

		await remove(f.unopened);
		await remove(f.background, reopenedBackground.handleId);
		assert.equal((await client.send(current.handleId, { type: "get_state" })).sessionId, f.current.id);
		await remove(f.current, current.handleId);
		report("未打开/current idle/background idle 删除、expected exit 与其他 owner 保留");

		const childIdentity = diskIdentity(SessionManager, f.child.path);
		await remove(f.parent);
		assert.deepEqual(diskIdentity(SessionManager, f.child.path), childIdentity);
		assert.equal((await summary(f.child.path)).parentSessionPath, f.parent.path);
		const child = await open(f.child);
		assert.ok((await client.send(child.handleId, { type: "get_messages" })).some((message) => message.content?.some((block) => block.text === "child remains readable after parent deletion")));
		await close(child.handleId);
		report("父删除后 fork 子文件、parent 引用与消息仍可读");

		const invalidTargets = [
			{ label: "路径越界", cwd: project, path: f.outside.path },
			{ label: "cwd 不匹配", cwd: otherProject, path: f.history.path },
			{ label: "missing", cwd: project, path: f.missing },
			{ label: "非 session JSONL", cwd: project, path: f.invalid },
		];
		for (const target of invalidTargets) {
			const before = existsSync(target.path) ? readFileSync(target.path, "utf8") : undefined;
			for (const method of ["sessions.rename", "sessions.delete"]) {
				await assert.rejects(client.call(method, { cwd: target.cwd, path: target.path, name: "must-not-write" }), /.+/, `${target.label}: ${method}`);
				assert.equal(existsSync(target.path) ? readFileSync(target.path, "utf8") : undefined, before);
			}
		}
		const historyBytes = readFileSync(f.history.path, "utf8");
		for (const type of ["rename_session", "delete_session"]) {
			await assert.rejects(client.call("service.send", { type, cwd: project, path: f.history.path, name: "bypass" }), /.+/, "service.send 不得绕过 owner 管理");
			assert.equal(readFileSync(f.history.path, "utf8"), historyBytes);
		}
		report("路径越界/cwd/missing/非session拒绝、service.send绕过拒绝且文件未改");

		for (const [fixture, method, resolution] of [[f.waitResponse, "confirm", "response"], [f.waitAbort, "input", "abort"]]) {
			const opened = await open(fixture);
			const commands = await client.send(opened.handleId, { type: "get_commands" });
			assert.ok(commands.some((command) => command.name === "flowork-wait"), "隔离用户级扩展应无需项目信任即可加载");
			assert.notEqual(opened.state.trust?.state, "trusted", "测试不得信任项目配置");
			const from = client.pushes.length;
			const run = client.send(opened.handleId, { type: "prompt", message: `/flowork-wait ${method}` });
			run.catch(() => undefined);
			const dialog = await client.waitPush((push) => push.type === "session_event" && push.handleId === opened.handleId && push.event.type === "ext_ui_request" && push.event.request.method === method, from, "等待 UI 请求");
			const before = readFileSync(fixture.path, "utf8");
			await assert.rejects(client.call("sessions.delete", { cwd: project, path: fixture.path }), /.+/, "等待 UI 时即使非 streaming 也必须拒绝删除");
			assert.equal(readFileSync(fixture.path, "utf8"), before);
			assert.equal((await client.send(opened.handleId, { type: "get_state" })).sessionId, fixture.id);
			if (resolution === "response") await client.send(opened.handleId, { type: "respond_ext_ui", id: dialog.event.request.id, confirmed: true });
			else await client.send(opened.handleId, { type: "abort" });
			await client.waitPush((push) => push.type === "session_event" && push.handleId === opened.handleId && push.event.type === "ext_ui_closed" && push.event.id === dialog.event.request.id, from, "UI 请求结束");
			await client.waitPush((push) => push.type === "session_event" && push.handleId === opened.handleId && push.event.type === "notice" && push.event.text === "flowork-wait-complete", from, "等待命令结束");
			assert.equal((await run).disposition, "handled");
			await remove(fixture, opened.handleId);
		}
		report("等待 confirm/input busy拒绝删除，应答/abort结束后可删除（不调用模型）");

		const duplicate = await open(f.duplicate);
		await assert.rejects(client.call("session.open", { cwd: project, sessionPath: f.duplicate.path }), /.+/, "重复 open 必须拒绝");
		await assert.rejects(observer.call("session.open", { cwd: project, sessionPath: f.duplicate.path }), /.+/, "另一连接不得重复占用同一会话");
		await close(duplicate.handleId);
		const concurrent = await Promise.allSettled([
			client.call("session.open", { cwd: project, sessionPath: f.duplicate.path }),
			observer.call("session.open", { cwd: project, sessionPath: f.duplicate.path }),
		]);
		assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1, "并发 open 只能有一个 owner");
		const winnerIndex = concurrent.findIndex((result) => result.status === "fulfilled");
		const winnerClient = winnerIndex === 0 ? client : observer;
		const winner = concurrent[winnerIndex].value;
		const from = client.pushes.length;
		await winnerClient.call("session.close", { handleId: winner.handleId });
		await exit(winner.handleId, from);
		report("同连接/跨连接重复open和并发open单owner");

		const raceFrom = client.pushes.length;
		const raced = await Promise.allSettled([
			client.call("session.open", { cwd: project, sessionPath: f.race.path }),
			client.call("sessions.delete", { cwd: project, path: f.race.path }),
		]);
		assert.equal(raced[1].status, "fulfilled", "idle open/delete竞态删除应成功");
		assert.equal(raced[1].value, null);
		await client.waitPush((push) => push.type === "sessions_changed" && push.cwd === project, raceFrom, "竞态删除列表推送");
		if (raced[0].status === "fulfilled") await exit(raced[0].value.handleId, raceFrom);
		assert.equal(existsSync(f.race.path), false, "竞态最终文件必须不存在");
		assert.equal(await summary(f.race.path), undefined);
		await assert.rejects(client.call("session.open", { cwd: project, sessionPath: f.race.path }), /.+/);
		assert.equal(existsSync(f.race.path), false);
		report("open/delete竞态无复活、无存活owner并推送sessions_changed");
	} finally {
		for (const handleId of active) await client.call("session.close", { handleId }).catch(() => undefined);
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--serve")) throw new Error("用法：node scripts/test-sessions.mjs [--serve]（先 npm run build:web）");
	const runtime = await backendRuntime();
	if (runtime.command !== process.execPath || runtime.env.ELECTRON_RUN_AS_NODE && process.env.ELECTRON_RUN_AS_NODE !== "1") {
		const child = childProcess.spawn(runtime.command, [script, ...args], { cwd: root, stdio: "inherit", env: { ...process.env, ...runtime.env } });
		process.exitCode = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolve(code ?? 1));
		});
		return;
	}
	assert.ok(existsSync(join(root, "out/web/server/index.js")), "缺少构建产物；请先 npm run build:web");
	mkdirSync(join(root, "out"), { recursive: true });
	const base = mkdtempSync(join(root, "out", "test-sessions-"));
	const agentDir = join(base, "agent");
	const dataDir = join(base, "data");
	Object.assign(process.env, {
		FLOWORK_DATA_DIR: dataDir,
		FLOWORK_PI_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1",
	});
	let child;
	let exited;
	let client;
	let observer;
	let shutdownRequested = false;
	let signalResolve;
	const interrupted = new Promise((resolve) => { signalResolve = resolve; });
	const stop = () => {
		shutdownRequested = true;
		signalResolve();
	};
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
	try {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const data = createFixtures(SessionManager, base, agentDir);
		const port = await freePort();
		const url = `http://127.0.0.1:${port}/`;
		child = childProcess.spawn(process.execPath, ["--import", pathToFileURL(script).href, join(root, "scripts/start-web.mjs")], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: { ...process.env, FLOWORK_PORT: String(port), FLOWORK_SESSIONS_TEST_RELAY: "wrapper" },
		});
		let output = "";
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
			output = (output + chunk.toString()).slice(-16000);
			process.stdout.write(chunk);
		});
		let exitResult;
		exited = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => {
				exitResult = { code, signal };
				resolve(exitResult);
			});
		});
		exited.catch(() => undefined);
		const start = Date.now();
		while (!client) {
			if (exitResult) throw new Error(`隔离 server 提前退出：${JSON.stringify(exitResult)}\n${output}`);
			if (shutdownRequested) return;
			try { client = await connect(url); } catch (error) {
				if (Date.now() - start > timeoutMs) throw new Error(`隔离 server 启动失败：${error.message}\n${output}`);
				await sleep(150);
			}
		}
		observer = await connect(url);
		if (args.includes("--serve")) {
			await client.call("projects.add", { paths: [data.project, data.otherProject] });
			console.log(`\nSESSION UI URL: ${url}\nSESSION FIXTURE ROOT: ${base}\nPROJECT: ${data.project}\nSIGINT/SIGTERM 后关闭隔离 server，再清理 fixtures。`);
			await Promise.race([
				interrupted,
				exited.then((result) => { throw new Error(`server 意外退出：${JSON.stringify(result)}`); }),
			]);
		} else {
			await runChecks(client, observer, SessionManager, data);
			console.log("SESSION REGRESSION OK（隔离真实 WebSocket；未调用模型）");
		}
	} finally {
		await observer?.close();
		await client?.close();
		let confirmed = !child;
		try {
			if (child && child.exitCode === null && child.signalCode === null && child.connected) {
				child.send({ floworkSessionsShutdown: true });
			}
			if (exited) {
				const result = await deadline(exited, "server 与 start-web 子进程退出", 20_000);
				confirmed = true;
				assert.equal(result.code, 0, `隔离 server 退出异常：${JSON.stringify(result)}`);
			}
		} finally {
			for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
			if (confirmed) {
				rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
				console.log(`CLEANED ${base}`);
			} else console.error(`未确认子进程退出，保留隔离目录避免清理活动文件：${base}`);
		}
	}
}

const relay = process.env.FLOWORK_SESSIONS_TEST_RELAY;
if (relay) installSignalRelay(relay);
else await main().catch((error) => {
	console.error(`SESSION REGRESSION FAILED\n${error.stack ?? error}`);
	process.exitCode = 1;
});
