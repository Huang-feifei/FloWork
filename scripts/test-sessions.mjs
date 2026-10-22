import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backendRuntime } from "./runtime.mjs";
import { connect, startIsolatedBackend } from "./lib/isolated-backend.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");

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

		// 长会话回归：线性链 >1300 层时，Electron utilityProcess 会把嵌套过深的消息静默投递成
		// null（不报错），主进程读 message.kind 就抛未捕获异常。因此 get_tree 必须下发扁平条目，
		// 由渲染层用 parentId 还原成树（见 worker/adapter.ts 的 toTree、renderer 的 buildTree）。
		const deepCount = 1400;
		const deepManager = SessionManager.create(project);
		for (let i = 0; i < deepCount; i += 1) deepManager.appendMessage({ role: "user", content: [{ type: "text", text: `deep ${i}` }], timestamp: Date.now() });
		const deepFixture = { path: deepManager.getSessionFile(), id: deepManager.getSessionId(), cwd: project };
		const deepOpened = await open(deepFixture);
		const deepTree = (await client.send(deepOpened.handleId, { type: "get_tree" })).tree;
		assert.ok(deepTree.length > 1300, `get_tree 必须返回全部条目（得到 ${deepTree.length}）`);
		assert.ok(deepTree.every((node) => Array.isArray(node.children) && node.children.length === 0), "会话树必须扁平化下发，否则深链会被 Electron 置为 null");
		const deepById = new Map(deepTree.map((node) => [node.id, node]));
		let deepest = 0;
		for (const node of deepTree) {
			let depth = 0;
			let cursor = node;
			while (cursor?.parentId && deepById.has(cursor.parentId)) { depth += 1; cursor = deepById.get(cursor.parentId); }
			if (depth > deepest) deepest = depth;
		}
		assert.equal(deepest, deepTree.length - 1, "扁平列表必须能用 parentId 还原出完整单链");
		await close(deepOpened.handleId);
		report("长会话（>1300 层）get_tree 扁平化：深嵌套不置空、链路完整");
	} finally {
		for (const handleId of active) await client.call("session.close", { handleId }).catch(() => undefined);
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length > 0) throw new Error("用法：node scripts/test-sessions.mjs（先 npm run build && npm run build:test）");
	const runtime = await backendRuntime();
	if (runtime.command !== process.execPath || runtime.env.ELECTRON_RUN_AS_NODE && process.env.ELECTRON_RUN_AS_NODE !== "1") {
		const child = childProcess.spawn(runtime.command, [script, ...args], { cwd: root, stdio: "inherit", env: { ...process.env, ...runtime.env } });
		process.exitCode = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolve(code ?? 1));
		});
		return;
	}
	let backend;
	let client;
	let observer;
	let shutdownRequested = false;
	const controller = new AbortController();
	const stop = () => {
		shutdownRequested = true;
		controller.abort();
	};
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
	try {
		backend = await startIsolatedBackend({ label: "sessions" });
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const data = createFixtures(SessionManager, backend.root, backend.agentDir);
		let endpoint;
		try {
			endpoint = await backend.waitReady({ signal: controller.signal });
		} catch (error) {
			if (shutdownRequested) return;
			throw error;
		}
		client = await connect(endpoint);
		observer = await connect(endpoint);
		await runChecks(client, observer, SessionManager, data);
		console.log("SESSION REGRESSION OK（隔离 Electron IPC；未调用模型）");
	} finally {
		for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
		await observer?.close();
		await client?.close();
		await backend?.stop();
	}
}

await main().catch((error) => {
	console.error(`SESSION REGRESSION FAILED\n${error.stack ?? error}`);
	process.exitCode = 1;
});
