/**
 * 开发辅助：对正在运行的本地后端做一次端到端会话测试（会真实调用模型）。
 *
 *   node scripts/e2e-session.mjs <工作目录> <provider/model> <审批策略 allow|deny|deny-bash> "<提示词>" ["<提示词2>" ...]
 *
 * 每个提示词等待 agent_settled 后再发送下一个；审批请求按策略自动应答。
 * 结束时打印工具调用摘要与会话树。
 */
import WebSocket from "ws";

const [cwd, modelRef, policy, ...prompts] = process.argv.slice(2);
const [provider, ...rest] = modelRef.split("/");
const modelId = rest.join("/");
const port = Number(process.env.FLOWORK_PORT ?? 17321);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });

let seq = 0;
const pending = new Map();
let settled;
let handleId;
const log = [];

function call(method, params) {
	const id = String(++seq);
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const session = (command) => call("session.send", { handleId, command });

ws.on("message", (data) => {
	const frame = JSON.parse(String(data));
	if (frame.id) {
		const p = pending.get(frame.id);
		pending.delete(frame.id);
		if (frame.ok) p?.resolve(frame.result);
		else p?.reject(new Error(frame.error));
		return;
	}
	const push = frame.push;
	if (push.type !== "session_event" || push.handleId !== handleId) return;
	const e = push.event;
	switch (e.type) {
		case "approval_request": {
			const decision = policy === "allow" ? "allow" : policy === "deny-bash" && e.toolName !== "bash" ? "allow" : "deny";
			log.push(`审批 ${e.toolName} → ${decision}`);
			void session({ type: "respond_approval", toolCallId: e.toolCallId, decision });
			break;
		}
		case "tool_execution_end": {
			const details = e.result.details ?? {};
			const text = e.result.content.map((c) => c.text ?? "").join("").replace(/\s+/g, " ").slice(0, 120);
			log.push(
				`工具 ${e.toolName} ${e.isError ? "失败" : "成功"}${details.diff ? `，diff ${details.diff.split("\n").length} 行${details.created ? "（新建）" : ""}` : ""}：${text}`,
			);
			break;
		}
		case "message_end":
			if (e.message.role === "assistant") {
				const text = e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("").replace(/\s+/g, " ");
				if (text) log.push(`回复：${text.slice(0, 160)}`);
				if (e.message.stopReason === "error") log.push(`错误：${e.message.errorMessage}`);
			}
			break;
		case "notice":
			log.push(`[${e.level}] ${e.text}`);
			break;
		case "agent_settled":
			settled?.();
			break;
	}
});

ws.on("open", async () => {
	try {
		const opened = await call("session.open", { cwd, approvalMode: "ask_writes" });
		handleId = opened.handleId;
		await session({ type: "set_model", provider, modelId });
		for (const message of prompts) {
			log.push(`\n❯ ${message}`);
			const done = new Promise((r) => {
				settled = r;
			});
			await session({ type: "prompt", message });
			await done;
		}
		const count = (nodes) => nodes.reduce((n, x) => n + 1 + count(x.children), 0);
		const findFirstUser = (nodes) => {
			for (const n of nodes) {
				if (n.role === "user") return n;
				const found = findFirstUser(n.children);
				if (found) return found;
			}
		};
		const branchPoints = (nodes) => nodes.reduce((n, x) => n + (x.children.length > 1 ? 1 : 0) + branchPoints(x.children), 0);
		// E2E_BRANCH：回到第一条用户消息之前，发送另一条消息形成分支；再从第一条用户消息分叉出新会话
		if (process.env.E2E_BRANCH) {
			const before = await session({ type: "get_tree" });
			const first = findFirstUser(before.tree);
			const nav = await session({ type: "navigate_tree", entryId: first.id });
			log.push(`\n回溯到第一条用户消息：cancelled=${nav.cancelled}，返回原文「${(nav.editorText ?? "").slice(0, 30)}…」`);
			const msgs = await session({ type: "get_messages" });
			log.push(`回溯后上下文消息数：${msgs.length}`);
			const done = new Promise((r) => {
				settled = r;
			});
			log.push(`❯ ${process.env.E2E_BRANCH}`);
			await session({ type: "prompt", message: process.env.E2E_BRANCH });
			await done;
			const after = await session({ type: "get_tree" });
			log.push(`分支点数量：${branchPoints(after.tree)}`);
			const stateBefore = await session({ type: "get_state" });
			const forked = await session({ type: "fork", entryId: first.id, position: "before" });
			log.push(
				`分叉：cancelled=${forked.cancelled}，新会话文件不同=${forked.state.sessionFile !== stateBefore.sessionFile}，返回原文「${(forked.editorText ?? "").slice(0, 30)}…」`,
			);
		}
		const { tree, leafId } = await session({ type: "get_tree" });
		log.push(`\n会话树：${count(tree)} 个条目，leaf=${leafId}`);
		const state = await session({ type: "get_state" });
		log.push(`会话文件：${state.sessionFile}`);
		console.log(log.join("\n"));
		await call("session.close", { handleId });
		ws.close();
	} catch (error) {
		console.log(log.join("\n"));
		console.error("E2E 失败：", error.message);
		process.exit(1);
	}
});
