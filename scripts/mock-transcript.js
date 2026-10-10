// 截图用的示例会话（仅开发模式，由 scripts/screenshot.cjs 注入页面执行）
(() => {
	const store = window.__floworkStore;
	const t = Date.now();
	const usage = (i, o) => ({ input: i, output: o, cacheRead: 0, cacheWrite: 0, totalTokens: i + o, cost: { total: (i * 0.27 + o * 1.1) / 1e6 } });
	const a = (content, u, stop = "toolUse") => ({ role: "assistant", content, provider: "deepseek", model: "deepseek-v4-pro", stopReason: stop, usage: u, timestamp: t });
	const tr = (id, name, text, details) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, isError: false, timestamp: t });
	const cwd = store.getState().cwd || "E:\\code\\ai-work\\FloWork";
	store.setState({
		models: [{ provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 128000 }],
		state: { ...(store.getState().state || {}), sessionId: "demo", cwd, sessionName: "修复 relativeTime 的边界问题", model: { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 128000 }, thinkingLevel: "medium", availableThinkingLevels: ["off", "low", "medium", "high"], isStreaming: false, messageCount: 6 },
		messages: [
			{ role: "user", content: [{ type: "text", text: "看一下 src/renderer/src/lib/format.ts，relativeTime 对未来时间的处理有问题，帮我修一下并跑一下类型检查" }], timestamp: t },
			a([
				{ type: "thinking", thinking: "先读文件，确认 relativeTime 的实现。\n未来时间 diff 为负数，会落到 “刚刚” 分支。" },
				{ type: "text", text: "我先看一下当前实现。" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: `${cwd}\\src\\renderer\\src\\lib\\format.ts` } },
			], usage(5200, 120)),
			tr("c1", "read", "export function basename(path: string): string {\n  ...\n}\n\nexport function relativeTime(ms: number): string {\n  const diff = Date.now() - ms;\n  ...\n}\n" + "// ...\n".repeat(20)),
			a([
				{ type: "text", text: "问题确认：`diff` 为负数时会直接返回 **“刚刚”**。我加一个未来时间的分支：" },
				{ type: "toolCall", id: "c2", name: "edit", arguments: { path: `${cwd}\\src\\renderer\\src\\lib\\format.ts` } },
			], usage(6100, 260)),
			tr("c2", "edit", "Successfully replaced 1 block", { diff: "  8 export function relativeTime(ms: number): string {\n  9 \tconst diff = Date.now() - ms;\n-10 \tif (diff < minute) return \"刚刚\";\n+10 \tif (diff < 0) return new Date(ms).toLocaleString();\n+11 \tif (diff < minute) return \"刚刚\";\n 12 \tif (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;" }),
			a([
				{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "npm run typecheck" } },
			], usage(6500, 40)),
			tr("c3", "bash", "> flowork@0.1.0 typecheck\n> npm run typecheck:node && npm run typecheck:web\n\n> flowork@0.1.0 typecheck:node\n> tsc --noEmit -p tsconfig.node.json\n\n> flowork@0.1.0 typecheck:web\n> tsc --noEmit -p tsconfig.web.json\n"),
			a([
				{ type: "text", text: "已修复，类型检查通过。\n\n## 改动\n\n- `relativeTime` 遇到**未来时间**时返回完整日期，不再显示“刚刚”\n- 其他分支保持不变\n\n| 输入 | 之前 | 现在 |\n| --- | --- | --- |\n| 1 分钟后 | 刚刚 | 2026/10/9 10:21 |\n\n```ts\nif (diff < 0) return new Date(ms).toLocaleString();\n```" },
			], usage(6900, 180), "stop"),
		],
		toolRuns: {},
		streaming: null,
		isRunning: false,
		connecting: false,
	});
})();
