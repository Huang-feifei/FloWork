/** 计划工作流回归：真实 SDK 会话 + 工具钩子/UI，应答均在隔离目录内，不调用模型或外网。 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "out"), { recursive: true });
const base = mkdtempSync(join(root, "out", "test-planning-"));
const env = { ...process.env };
const hosts = [];
try {
	const agentDir = join(base, "agent");
	const cwd = join(base, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	Object.assign(process.env, { FLOWORK_DATA_DIR: join(base, "data"), FLOWORK_PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1" });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [] }));
	const bundle = join(base, "planning.mjs");
	await build({
		stdin: { contents: 'export * from "./src/worker/session-host.ts"; export * from "./src/worker/planning.ts"; export * from "./src/renderer/src/session-slice.ts";', resolveDir: root, loader: "ts" },
		bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "silent", tsconfig: join(root, "tsconfig.node.json"),
	});
	const { SessionHost, restoredWorkMode, allowedInPlan, WORK_MODE_ENTRY, reduceEvent, emptySlice } = await import(pathToFileURL(bundle).href);
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const fixture = (label) => {
		const manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: `${label}: first`, timestamp: Date.now() });
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "nested", name: "codemode", arguments: {} }], api: "openai-completions", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		assert.ok(existsSync(manager.getSessionFile()));
		return manager.getSessionFile();
	};
	const events = [];
	const host = new SessionHost((event) => events.push(event), "auto");
	hosts.push(host);
	const file = fixture("planning");
	await host.init(cwd, file);
	for (const name of ["read", "grep", "find", "ls", "ask_user", "submit_plan"]) {
		assert.ok(host.session.getActiveToolNames().includes(name), `${name} 对模型实际可用`);
	}
	const send = (command) => host.handle(command);
	let seq = 0;
	const runner = () => host.session.extensionRunner;
	const callEvent = (name, input = {}) => runner().emitToolCall({ type: "tool_call", toolCallId: `test-${++seq}`, toolName: name, input });
	const tool = (name, params, signal) => {
		const id = `test-${++seq}`;
		return runner().getToolDefinition(name).execute(id, params, signal, undefined, runner().createToolContext(id, signal));
	};
	const request = async (from, method) => {
		for (let i = 0; i < 100; i++) {
			const event = events.slice(from).find((e) => e.type === "ext_ui_request" && e.request.method === method);
			if (event) return event.request;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`没有收到 ${method} 对话框`);
	};
	const respond = (req, response) => send({ type: "respond_ext_ui", id: req.id, ...response });

	assert.equal((await send({ type: "get_state" })).workMode, "execute");
	await send({ type: "set_work_mode", mode: "plan" });
	assert.ok(events.some((e) => e.type === "work_mode_changed" && e.mode === "plan"));
	await assert.rejects(send({ type: "set_work_mode", mode: "invalid" }), /无效/);
	for (const name of ["write", "edit", "bash", "powershell", "codemode", "mcp_write", "unknown"]) {
		assert.equal(allowedInPlan(name), false);
		assert.equal((await callEvent(name)).block, true, `${name} 在自动审批下仍被拦截`);
	}
	for (const name of ["read", "grep", "find", "ls", "ask_user", "submit_plan"]) assert.equal(await callEvent(name), undefined);
	const context = runner().createToolContext("nested", undefined);
	const target = join(cwd, "must-not-exist.txt");
	const blocked = await context.executeTool("write", { path: target, content: "blocked" });
	assert.equal(blocked.isError, true, "嵌套写入同样被钩子拦截");
	assert.match(JSON.stringify(blocked), /计划模式禁止/, "确实由计划策略阻止，而非 SDK 前置错误");
	assert.equal(existsSync(target), false);
	const read = await context.executeTool("read", { path: file });
	assert.notEqual(read.isError, true, `只读工具可以真实执行：${JSON.stringify(read)}`);
	await assert.rejects(runner().emitUserBash({ type: "user_bash", command: "echo blocked", cwd, excludeFromContext: false }), /计划模式禁止 Shell/);
	// grep/find 的 SDK 实现可能下载 rg/fd，隔离回归只执行纯本地的 ls/read。
	const listed = await context.executeTool("ls", { path: cwd });
	assert.notEqual(listed.isError, true, `专用目录工具可执行：${JSON.stringify(listed)}`);
	console.log("✓ 计划限制优先于自动审批，拦截 Shell、未知工具和嵌套写入，只读工具可执行");

	await send({ type: "set_approval_mode", mode: "ask_all" });
	assert.equal(await callEvent("ask_user"), undefined, "提问无需重复工具审批");
	let from = events.length;
	let pending = tool("ask_user", { question: "选择实现方案？", options: ["方案 A", "方案 B"] });
	let req = await request(from, "select");
	assert.equal(req.purpose, "question");
	await respond(req, { value: "方案 B" });
	assert.equal((await pending).details.answer, "方案 B");
	from = events.length;
	pending = tool("ask_user", { question: "选择方案？", options: ["方案 A"] });
	req = await request(from, "select");
	await respond(req, { value: req.options.at(-1) });
	req = await request(from, "input");
	await respond(req, { value: "  自定义方案  " });
	assert.equal((await pending).details.answer, "自定义方案");
	from = events.length;
	pending = tool("ask_user", { question: "自由输入？" });
	req = await request(from, "input");
	await respond(req, { cancelled: true });
	assert.equal((await pending).details.answer, null);
	console.log("✓ 选项、自定义回答和取消均返回正确结果，决策工具不重复审批");

	from = events.length;
	pending = tool("submit_plan", { plan: "## 计划\n1. 修改页面\n2. 运行验证" });
	req = await request(from, "confirm");
	assert.equal(req.purpose, "plan");
	assert.match(req.message, /修改页面/);
	assert.match(req.confirmLabel, /确认计划并执行/);
	assert.equal((await send({ type: "get_state" })).workMode, "plan");
	await assert.rejects(send({ type: "set_work_mode", mode: "execute" }), /当前运行/);
	await respond(req, { confirmed: false });
	assert.equal((await pending).details.accepted, false);
	assert.equal((await send({ type: "get_state" })).workMode, "plan");
	assert.equal((await callEvent("write")).block, true);

	from = events.length;
	const abort = new AbortController();
	pending = tool("submit_plan", { plan: "将被中断的计划" }, abort.signal);
	req = await request(from, "confirm");
	abort.abort();
	assert.equal((await pending).details.accepted, false);
	await respond(req, { confirmed: true });
	assert.equal((await send({ type: "get_state" })).workMode, "plan", "中断后的迟到确认无效");
	console.log("✓ 拒绝、取消和中断不授权执行，迟到的确认不会绕过限制");

	from = events.length;
	pending = tool("submit_plan", { plan: "已确认的计划" });
	req = await request(from, "confirm");
	await respond(req, { confirmed: true });
	assert.equal((await pending).details.accepted, true);
	assert.equal((await send({ type: "get_state" })).workMode, "execute");
	const promptContext = await runner().emitContext([]);
	assert.ok(JSON.stringify(promptContext).includes("执行模式"), "同一轮后续模型请求使用最新模式");
	const approvalFrom = events.length;
	const gated = callEvent("write", { path: target, content: "allowed" });
	const approval = events.slice(approvalFrom).find((e) => e.type === "approval_request");
	assert.ok(approval, "确认计划后原 ask_all 审批仍然生效");
	await send({ type: "respond_approval", toolCallId: approval.toolCallId, decision: "allow" });
	assert.equal(await gated, undefined);
	await send({ type: "set_approval_mode", mode: "auto" });
	const written = await runner().createToolContext("after-accept", undefined).executeTool("write", { path: target, content: "allowed" });
	assert.notEqual(written.isError, true);
	assert.equal(readFileSync(target, "utf8"), "allowed");
	await assert.rejects(tool("submit_plan", { plan: "不能在执行模式重复提交" }), /计划模式/);
	console.log("✓ 明确批准后才能真实写入，原有审批设置仍然有效");

	await send({ type: "set_work_mode", mode: "plan" });
	const other = new SessionHost(() => {}, "auto");
	hosts.push(other);
	await other.init(cwd, fixture("other"));
	assert.equal((await other.handle({ type: "get_state" })).workMode, "execute");
	assert.equal((await send({ type: "get_state" })).workMode, "plan");
	await host.dispose();
	const reopened = new SessionHost(() => {}, "auto");
	hosts.push(reopened);
	await reopened.init(cwd, file);
	assert.equal((await reopened.handle({ type: "get_state" })).workMode, "plan", "关闭重开后恢复模式");

	// 切换会话必须取消旧计划：旧工具结束和迟到应答都不能授权新会话。
	const oldFile = other.session.sessionFile;
	await other.handle({ type: "set_work_mode", mode: "plan" });
	const otherRunner = other.session.extensionRunner;
	const review = otherRunner.getToolDefinition("submit_plan").execute("switch-test", { plan: "旧会话的计划" }, undefined, undefined, otherRunner.createToolContext("switch-test", undefined));
	await other.handle({ type: "new_session" });
	assert.equal((await review).details.accepted, false);
	assert.equal((await other.handle({ type: "get_state" })).workMode, "execute", "新会话默认执行模式");
	await other.handle({ type: "switch_session", sessionPath: oldFile });
	assert.equal((await other.handle({ type: "get_state" })).workMode, "plan");
	console.log("✓ 模式按会话隔离并持久化，新建/切换会话取消未应答的旧计划");

	const entry = (mode) => ({ type: "custom", customType: WORK_MODE_ENTRY, data: { mode } });
	assert.equal(restoredWorkMode([entry("plan"), entry("execute")]), "execute");
	assert.equal(restoredWorkMode([entry("plan")]), "plan", "从活动分支恢复，不读取被抛弃分支");
	const slice = { ...emptySlice(), state: { workMode: "plan" } };
	assert.equal(reduceEvent(slice, { type: "work_mode_changed", mode: "execute" }).state.workMode, "execute");
	assert.equal(slice.state.workMode, "plan", "归约器不修改原状态，后台会话可独立归约");
	console.log("PLANNING REGRESSION OK（未调用模型；未访问真实用户配置）");
} finally {
	for (const host of hosts) await host.dispose().catch(() => undefined);
	for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
	Object.assign(process.env, env);
	rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
