/**
 * 开发辅助：在隔离后端（out/ 下的临时数据目录与空闲端口，不碰 ~/.flowork）测试第三方扩展的 ctx.ui（不调用模型）。
 * 在临时项目里放一个注册 /ask 命令的扩展，依次触发 select / confirm / input / editor、超时、
 * setStatus / setWidget / setEditorText / notify，以及在 withSession 中弹出对话框；结束时随隔离后端一起清理。
 *   node scripts/test-ext-ui.mjs（需先 npm run build && npm run build:test）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, createChecks, startIsolatedBackend } from "./lib/isolated-backend.mjs";

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
	pi.registerCommand("ask-switch", {
		description: "新建会话时未应答的对话框应被取消",
		handler: async (_args, ctx) => {
			// 故意不 await：让对话框处于未应答状态时再新建会话
			const first = ctx.ui.select("切换会话前的选择", ["staging", "production"]);
			await ctx.newSession({
				withSession: async (next) => {
					next.ui.notify("ask-switch:first:" + ((await first) ?? "cancelled"), "info");
					await next.ui.confirm("切换后的确认", "继续？");
					await next.ui.input("切换后的输入");
					next.ui.notify("ask-switch:done", "info");
				},
			});
		},
	});
}
`;

async function main(checks) {
	const backend = await startIsolatedBackend({ label: "extui" });
	const base = join(backend.root, "fixtures");
	const project = join(base, "proj");
	mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(project, ".pi", "extensions", "ask.js"), EXTENSION);
	let client;
	let handleId;
	/** 已被 nextEvent 消费到的位置：事件可能在上一步的应答返回前就已到达 */
	let cursor = 0;
	/** 当前测试会话的会话事件（push.handleId === handleId） */
	const isEvent = (push, pred) => push.type === "session_event" && push.handleId === handleId && pred(push.event);
	/** 从游标处开始等待满足条件的下一个事件 */
	const nextEvent = (pred, timeoutMs = 8000) => {
		const hit = client.pushes.findIndex((push, index) => index >= cursor && isEvent(push, pred));
		if (hit >= 0) {
			cursor = hit + 1;
			return Promise.resolve(client.pushes[hit].event);
		}
		return client.waitPush((push, index) => index >= cursor && isEvent(push, pred), cursor, "等待事件", timeoutMs).then((push) => {
			cursor = client.pushes.indexOf(push) + 1;
			return push.event;
		});
	};
	const dialog = (method) => nextEvent((e) => e.type === "ext_ui_request" && e.request.method === method);
	const send = (command) => client.call("session.send", { handleId, command });
	try {
		client = await connect(await backend.waitReady());

		const opened = await client.call("session.open", { cwd: project });
		handleId = opened.handleId;
		await send({ type: "set_project_trust", trusted: true });
		const cmds = await send({ type: "get_commands" });
		checks.check("信任后扩展命令 /ask 可用", cmds.some((c) => c.name === "ask"));

		const run = send({ type: "prompt", message: "/ask" });

		const sel = await dialog("select");
		checks.check("select：收到标题与选项", sel.request.title === "选择部署环境" && sel.request.options?.join() === "staging,production");
		await send({ type: "respond_ext_ui", id: sel.request.id, value: "production" });

		const conf = await dialog("confirm");
		checks.check("confirm：正文包含上一步的选择", conf.request.message === "部署到 production？");
		await send({ type: "respond_ext_ui", id: conf.request.id, confirmed: true });

		const inp = await dialog("input");
		checks.check("input：带占位提示", inp.request.placeholder === "例如 1.2.3");
		await send({ type: "respond_ext_ui", id: inp.request.id, value: "1.2.3" });

		const edt = await dialog("editor");
		checks.check("editor：带初始内容", edt.request.prefill === "- 修复\n");
		await send({ type: "respond_ext_ui", id: edt.request.id, value: "- 修复登录\n- 新增导出" });

		const timed = await dialog("select");
		checks.check("超时对话框带 timeoutMs", timed.request.timeoutMs === 1200);
		const closed = await nextEvent((e) => e.type === "ext_ui_closed" && e.id === timed.request.id, 4000);
		checks.check("超时后自动关闭", !!closed);

		const cancel = await dialog("input");
		await send({ type: "respond_ext_ui", id: cancel.request.id, cancelled: true });

		const notice = await nextEvent((e) => e.type === "notice" && e.text.startsWith("{"));
		const result = JSON.parse(notice.text);
		checks.check(
			"扩展拿到全部应答",
			result.env === "production" && result.ok === true && result.version === "1.2.3" && result.notes === "- 修复登录\n- 新增导出",
		);
		checks.check("超时与取消返回 undefined", result.timed === null && result.cancelled === null);
		checks.check("theme 着色方法原样返回文字", result.colored === "彩色文字");
		checks.check("setStatus 推送", client.pushes.some((push) => isEvent(push, (e) => e.type === "ext_status" && e.key === "deploy" && e.text === "已部署 production")));
		checks.check(
			"setWidget 推送（默认在输入框上方）",
			client.pushes.some((push) => isEvent(push, (e) => e.type === "ext_widget" && e.lines?.[1] === "production 1.2.3" && e.placement === "aboveEditor")),
		);
		checks.check("setEditorText 推送", client.pushes.some((push) => isEvent(push, (e) => e.type === "ext_editor_text" && e.text === "/ask 再来一次")));
		const done = await run;
		checks.check("命令结束后 prompt 返回 handled", done.disposition === "handled");

		// 扩展命令替换会话后，新会话的 ctx.ui 仍然可用
		const before = opened.state.sessionId;
		const run2 = send({ type: "prompt", message: "/ask-new" });
		const changed = await nextEvent((e) => e.type === "session_changed");
		checks.check("扩展新建会话后界面收到 session_changed", changed.state.sessionId !== before);
		const c2 = await dialog("confirm");
		await send({ type: "respond_ext_ui", id: c2.request.id, confirmed: true });
		const n2 = await nextEvent((e) => e.type === "notice" && e.text.startsWith("new-session-confirm:"));
		checks.check("withSession 中的对话框正常应答", n2.text === "new-session-confirm:true");
		await run2;

		// 界面侧直接发 new_session：扩展正在等待 select 对话框时替换会话
		const run3 = send({ type: "prompt", message: "/ask" });
		run3.catch(() => undefined); // 会话替换时该调用可能被拒绝，避免未处理拒绝直接终止进程
		const pendingSel = await dialog("select");
		const sessionBefore = (await send({ type: "get_state" })).sessionId;
		const from = client.pushes.length;
		await send({ type: "new_session" });
		// 两条断言都用固定起点查找，避免先等其中一条时把另一条吞掉
		const closed3 = await client
			.waitPush((push, index) => index >= from && isEvent(push, (e) => e.type === "ext_ui_closed" && e.id === pendingSel.request.id), from, "新建会话时的 ext_ui_closed", 8000)
			.then(() => true, () => false);
		const switched = await client
			.waitPush((push, index) => index >= from && isEvent(push, (e) => e.type === "session_changed"), from, "新建会话时的 session_changed", 8000)
			.then((push) => push.event, () => null);
		checks.check("界面新建会话后收到 session_changed 且会话已替换", !!switched && switched.state.sessionId !== sessionBefore);
		checks.check("新建会话时未应答的对话框被关闭", closed3);
		// 第一个对话框被取消后命令继续，后续对话框逐个取消
		for (const method of ["confirm", "input", "editor", "select", "input"]) {
			const d = await dialog(method).catch(() => null);
			if (!d) break;
			if (d) await send({ type: "respond_ext_ui", id: d.request.id, cancelled: true });
		}
		await run3;

		// 扩展内 ctx.newSession：同一行为的另一条触发路径
		const run4 = send({ type: "prompt", message: "/ask-switch" });
		run4.catch(() => undefined);
		const pendingSel2 = await dialog("select");
		const closed4 = await nextEvent((e) => e.type === "ext_ui_closed" && e.id === pendingSel2.request.id, 8000)
			.then(() => true, () => false);
		checks.check("扩展内新建会话时未应答的对话框被关闭", closed4);
		const first = await nextEvent((e) => e.type === "notice" && e.text.startsWith("ask-switch:first:"), 8000);
		checks.check("被取消的对话框返回 undefined", first.text === "ask-switch:first:cancelled");
		for (const method of ["confirm", "input"]) {
			const d = await dialog(method).catch(() => null);
			if (!d) break;
			if (d) await send({ type: "respond_ext_ui", id: d.request.id, cancelled: true });
		}
		await run4;
	} finally {
		if (handleId && client) {
			await send({ type: "set_project_trust", trusted: false }).catch(() => undefined);
			await client.call("session.close", { handleId }).catch(() => undefined);
		}
		await client?.close();
		await backend.stop();
	}
}

const checks = createChecks();
await main(checks).then(
	() => checks.finish("EXT UI REGRESSION OK（隔离后端；未调用模型）"),
	(error) => {
		console.error(`EXT UI REGRESSION FAILED\n${error?.stack ?? error}`);
		process.exitCode = 1;
	},
);
