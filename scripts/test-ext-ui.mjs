/**
 * 开发辅助：对运行中的后端测试第三方扩展的 ctx.ui（不调用模型）。
 * 在临时项目里放一个注册 /ask 命令的扩展，依次触发 select / confirm / input / editor、超时、
 * setStatus / setWidget / setEditorText / notify，以及在 withSession 中弹出对话框；结束时清理临时数据。
 *   node scripts/test-ext-ui.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const port = Number(process.env.FLOWORK_PORT ?? 17321);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
let seq = 0;
const pending = new Map();
/** 当前测试会话收到的事件 */
const events = [];
const waiters = [];
let handleId;
ws.on("message", (data) => {
	const f = JSON.parse(String(data));
	if (f.push?.type === "session_event" && f.push.handleId === handleId) {
		events.push(f.push.event);
		for (const w of [...waiters]) w();
		return;
	}
	if (!f.id) return;
	const p = pending.get(f.id);
	pending.delete(f.id);
	f.ok ? p.resolve(f.result) : p.reject(new Error(f.error));
});
const call = (method, params) =>
	new Promise((resolve, reject) => {
		const id = String(++seq);
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
const send = (command) => call("session.send", { handleId, command });
let failed = 0;
const check = (label, cond) => {
	if (!cond) failed++;
	console.log(`${cond ? "✓" : "✗"} ${label}`);
};
/** 已被 nextEvent 消费到的位置：事件可能在上一步的应答返回前就已到达 */
let cursor = 0;
/** 从游标处开始等待满足条件的下一个事件 */
const nextEvent = (pred, timeoutMs = 8000) =>
	new Promise((resolve, reject) => {
		const tryFind = () => {
			const offset = events.slice(cursor).findIndex(pred);
			if (offset < 0) return false;
			const hit = events[cursor + offset];
			cursor += offset + 1;
			clearTimeout(timer);
			const i = waiters.indexOf(tryFind);
			if (i >= 0) waiters.splice(i, 1);
			resolve(hit);
			return true;
		};
		const timer = setTimeout(() => {
			const i = waiters.indexOf(tryFind);
			if (i >= 0) waiters.splice(i, 1);
			reject(new Error("等待事件超时"));
		}, timeoutMs);
		if (!tryFind()) waiters.push(tryFind);
	});
const dialog = (method) => nextEvent((e) => e.type === "ext_ui_request" && e.request.method === method);

const EXTENSION = `
export default function (pi) {
	pi.registerCommand("ask", {
		description: "FloWork 对话框测试",
		handler: async (_args, ctx) => {
			const env = await ctx.ui.select("选择部署环境", ["staging", "production"]);
			const ok = await ctx.ui.confirm("确认部署", "部署到 " + env + "？");
			const version = await ctx.ui.input("版本号", "例如 1.2.3");
			const notes = await ctx.ui.editor("发布说明", "- 修复\\n");
			const timed = await ctx.ui.select("会超时的选择", ["a", "b"], { timeout: 1200 });
			const cancelled = await ctx.ui.input("将被取消的输入");
			const colored = ctx.ui.theme.fg("accent", "彩色文字");
			ctx.ui.setStatus("deploy", "已部署 " + env);
			ctx.ui.setWidget("deploy", ["部署记录", env + " " + version]);
			ctx.ui.setEditorText("/ask 再来一次");
			ctx.ui.notify(JSON.stringify({ env, ok, version, notes, timed: timed ?? null, cancelled: cancelled ?? null, colored }), "info");
		},
	});
	pi.registerCommand("ask-new", {
		description: "新会话中弹出确认",
		handler: async (_args, ctx) => {
			await ctx.newSession({
				withSession: async (next) => {
					const yes = await next.ui.confirm("新会话", "新会话里的确认");
					next.ui.notify("new-session-confirm:" + yes, "info");
				},
			});
		},
	});
}
`;

ws.on("open", async () => {
	const base = join(tmpdir(), `flowork-extui-test-${Date.now()}`);
	const project = join(base, "proj");
	mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(project, ".pi", "extensions", "ask.js"), EXTENSION);
	try {
		const opened = await call("session.open", { cwd: project });
		handleId = opened.handleId;
		await send({ type: "set_project_trust", trusted: true });
		const cmds = await send({ type: "get_commands" });
		check("信任后扩展命令 /ask 可用", cmds.some((c) => c.name === "ask"));

		const run = send({ type: "prompt", message: "/ask" });

		const sel = await dialog("select");
		check("select：收到标题与选项", sel.request.title === "选择部署环境" && sel.request.options?.join() === "staging,production");
		await send({ type: "respond_ext_ui", id: sel.request.id, value: "production" });

		const conf = await dialog("confirm");
		check("confirm：正文包含上一步的选择", conf.request.message === "部署到 production？");
		await send({ type: "respond_ext_ui", id: conf.request.id, confirmed: true });

		const inp = await dialog("input");
		check("input：带占位提示", inp.request.placeholder === "例如 1.2.3");
		await send({ type: "respond_ext_ui", id: inp.request.id, value: "1.2.3" });

		const edt = await dialog("editor");
		check("editor：带初始内容", edt.request.prefill === "- 修复\n");
		await send({ type: "respond_ext_ui", id: edt.request.id, value: "- 修复登录\n- 新增导出" });

		const timed = await dialog("select");
		check("超时对话框带 timeoutMs", timed.request.timeoutMs === 1200);
		const closed = await nextEvent((e) => e.type === "ext_ui_closed" && e.id === timed.request.id, 4000);
		check("超时后自动关闭", !!closed);

		const cancel = await dialog("input");
		await send({ type: "respond_ext_ui", id: cancel.request.id, cancelled: true });

		const notice = await nextEvent((e) => e.type === "notice" && e.text.startsWith("{"));
		const result = JSON.parse(notice.text);
		check(
			"扩展拿到全部应答",
			result.env === "production" && result.ok === true && result.version === "1.2.3" && result.notes === "- 修复登录\n- 新增导出",
		);
		check("超时与取消返回 undefined", result.timed === null && result.cancelled === null);
		check("theme 着色方法原样返回文字", result.colored === "彩色文字");
		check("setStatus 推送", events.some((e) => e.type === "ext_status" && e.key === "deploy" && e.text === "已部署 production"));
		check(
			"setWidget 推送（默认在输入框上方）",
			events.some((e) => e.type === "ext_widget" && e.lines?.[1] === "production 1.2.3" && e.placement === "aboveEditor"),
		);
		check("setEditorText 推送", events.some((e) => e.type === "ext_editor_text" && e.text === "/ask 再来一次"));
		const done = await run;
		check("命令结束后 prompt 返回 handled", done.disposition === "handled");

		// 扩展命令替换会话后，新会话的 ctx.ui 仍然可用
		const before = opened.state.sessionId;
		const run2 = send({ type: "prompt", message: "/ask-new" });
		const changed = await nextEvent((e) => e.type === "session_changed");
		check("扩展新建会话后界面收到 session_changed", changed.state.sessionId !== before);
		const c2 = await dialog("confirm");
		await send({ type: "respond_ext_ui", id: c2.request.id, confirmed: true });
		const n2 = await nextEvent((e) => e.type === "notice" && e.text.startsWith("new-session-confirm:"));
		check("withSession 中的对话框正常应答", n2.text === "new-session-confirm:true");
		await run2;

		// 切换会话时，未应答的对话框被取消
		const run3 = send({ type: "prompt", message: "/ask" });
		const pendingSel = await dialog("select");
		cursor = events.length;
		await send({ type: "new_session" });
		const closed3 = events.some((e) => e.type === "ext_ui_closed" && e.id === pendingSel.request.id);
		check("新建会话时未应答的对话框被关闭", closed3);
		// 第一个对话框被取消后命令继续，后续对话框逐个取消
		for (const method of ["confirm", "input", "editor", "select", "input"]) {
			const d = await dialog(method).catch(() => null);
			if (!d) break;
			if (d) await send({ type: "respond_ext_ui", id: d.request.id, cancelled: true });
		}
		await run3;
	} catch (e) {
		failed++;
		console.error("测试失败：", e.message);
	} finally {
		if (handleId) {
			await send({ type: "set_project_trust", trusted: false }).catch(() => undefined);
			await call("session.close", { handleId }).catch(() => undefined);
		}
		rmSync(base, { recursive: true, force: true });
		const agentDir = process.env.FLOWORK_PI_AGENT_DIR || join(homedir(), ".flowork", "agent");
		const tag = base.split(/[\\/]/).pop();
		const sessDir = join(agentDir, "sessions");
		if (existsSync(sessDir)) for (const d of readdirSync(sessDir)) if (d.includes(tag)) rmSync(join(sessDir, d), { recursive: true, force: true });
		const trustFile = join(agentDir, "trust.json");
		if (existsSync(trustFile)) {
			const t = JSON.parse(readFileSync(trustFile, "utf8"));
			for (const k of Object.keys(t)) if (k.includes(tag)) delete t[k];
			writeFileSync(trustFile, `${JSON.stringify(t, null, 2)}\n`);
		}
		ws.close();
		console.log(failed ? `有 ${failed} 项失败` : "全部通过", `；已清理 ${base}`);
	}
});
