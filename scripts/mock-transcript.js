// 截图 / 样式检查用的示例状态（仅开发模式，由 scripts/screenshot.cjs 注入页面执行）
// 直接改 store，不经过后端：只为了让界面处于有内容的状态，便于肉眼与截图检查。
(() => {
	const store = window.__floworkStore;
	const t = Date.now();
	const usage = (i, o) => ({ input: i, output: o, cacheRead: 0, cacheWrite: 0, totalTokens: i + o, cost: { total: (i * 0.27 + o * 1.1) / 1e6 } });
	const a = (content, u, stop = "toolUse", entryId) => ({ role: "assistant", content, provider: "deepseek", model: "deepseek-v4-pro", stopReason: stop, usage: u, timestamp: t, entryId });
	const tr = (id, name, text, details) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, isError: false, timestamp: t });

	const cwd = store.getState().cwd || "E:\\code\\ai-work\\FloWork";
	const demo = { id: "demo-project", path: cwd, name: "FloWork", groupId: null, pinned: true, order: 0, addedAt: t, lastOpenedAt: t };
	const second = { id: "demo-pi", path: "E:\\code\\oss\\pi-mono", name: "pi-mono", groupId: "demo-group", pinned: false, order: 0, addedAt: t, lastOpenedAt: t };

	const diff =
		"@@ -8,6 +8,8 @@ export function relativeTime(ms: number): string {\n" +
		"   const diff = Date.now() - ms;\n" +
		"-  if (diff < minute) return \"刚刚\";\n" +
		"+  if (diff < 0) return new Date(ms).toLocaleString();\n" +
		"+  if (diff < minute) return \"刚刚\";\n" +
		"   if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;\n" +
		"   if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;";

	store.setState({
		view: "chat",
		activeProjectId: demo.id,
		cwd,
		handleId: "demo-handle",
		connecting: false,
		projects: {
			projects: [demo, second],
			groups: [{ id: "demo-group", name: "客户项目", collapsed: false, order: 0 }],
		},
		expanded: { [demo.id]: true },
		projectSessions: {
			[demo.id]: [
				{ path: "s1", id: "s1", cwd, name: "修复 relativeTime 的边界问题", firstMessage: "看一下 format.ts", messageCount: 6, created: t, modified: t },
				{ path: "s2", id: "s2", cwd, name: "侧边栏拖拽顺序", firstMessage: "拖拽后顺序会乱", messageCount: 14, created: t, modified: t - 7200_000 },
			],
			[second.id]: [{ path: "s3", id: "s3", cwd: second.path, name: "pi 1.1.0 适配", firstMessage: "升级 pi", messageCount: 9, created: t, modified: t - 86400_000 }],
		},
		models: [{ provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 128000 }],
		state: {
			sessionId: "demo",
			sessionFile: "s1",
			cwd,
			sessionName: "修复 relativeTime 的边界问题",
			model: { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 128000 },
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
			isStreaming: false,
			messageCount: 6,
		},
		messages: [
			{ role: "user", content: [{ type: "text", text: "看一下 src/renderer/src/lib/format.ts，relativeTime 对未来时间的处理有问题，帮我修一下并跑一下类型检查" }], timestamp: t, entryId: "n1" },
			a(
				[
					{ type: "thinking", thinking: "先读文件，确认 relativeTime 的实现。\n未来时间 diff 为负数，会落到“刚刚”分支。" },
					{ type: "text", text: "我先看一下当前实现。" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: `${cwd}\\src\\renderer\\src\\lib\\format.ts` } },
				],
				usage(5200, 120),
				"toolUse",
				"n2",
			),
			tr(
				"c1",
				"read",
				"export function relativeTime(ms: number): string {\n  const diff = Date.now() - ms;\n  ...\n}\n".repeat(12),
			),
			a(
				[
					{ type: "text", text: "问题确认：`diff` 为负数时会直接返回 **“刚刚”**。我加一个未来时间的分支：" },
					{ type: "toolCall", id: "c2", name: "edit", arguments: { path: `${cwd}\\src\\renderer\\src\\lib\\format.ts` } },
				],
				usage(6100, 260),
				"toolUse",
				"n3",
			),
			tr("c2", "edit", "Successfully replaced 1 block", { diff }),
			a([{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "npm run typecheck" } }], usage(6500, 40), "toolUse", "n4"),
			tr("c3", "bash", "> flowork@0.1.0 typecheck\n> tsc --noEmit -p tsconfig.node.json\n> tsc --noEmit -p tsconfig.web.json\n"),
			a(
				[
					{
						type: "text",
						text: "已修复，类型检查通过。\n\n## 改动\n\n- `relativeTime` 遇到**未来时间**时返回完整日期，不再显示“刚刚”\n- 其他分支保持不变\n\n```ts\nif (diff < 0) return new Date(ms).toLocaleString();\n```",
					},
				],
				usage(6900, 180),
				"stop",
				"c4",
			),
		],
		toolRuns: {
			c1: { status: "done", toolName: "read", durationMs: 320 },
			c2: { status: "done", toolName: "edit", durationMs: 480 },
			c3: { status: "done", toolName: "bash", durationMs: 3200 },
		},
		streaming: null,
		isRunning: false,
		pendingApprovals: [],

		// 会话树示例：主干 12 条 + 一个被放弃的分支（4 条）+ 当前分支（4 条，leaf 在末尾），
		// 用于检查会话树窄轨的形态（最亮 = 屏幕上可见、淡亮 = 当前分支、最暗 = 其他分支）。
		// 消息的 entryId 指向其中几条节点，其余节点不会随滚动变亮，仅用于截图检查。
		tree: demoTree(),
		leafId: "c4",
	});

	function demoTree() {
		let seq = 0;
		const treeNode = (id, parentId, role, preview, children = []) => ({
			id,
			parentId,
			entryType: "message",
			role,
			preview,
			timestamp: new Date(t - (40 - seq++) * 60_000).toISOString(),
			children,
		});
		const labels = [
			["user", "看一下 src/renderer/src/lib/format.ts，relativeTime 对未来时间的处理有问题"],
			["assistant", "我先读一下文件，确认 diff 的计算方式。"],
			["user", "未来时间会显示成“刚刚”，不对。"],
			["assistant", "确认了：diff 为负数时会落到“刚刚”分支。"],
			["user", "那就加一个未来时间分支。"],
			["assistant", "加 `if (diff < 0)` 返回完整日期。"],
			["user", "调用方会不会依赖这个字符串格式？"],
			["assistant", "只有侧边栏列表在用，不依赖格式。"],
			["user", "好，那就这么改。"],
			["assistant", "已改，跑一下类型检查。"],
			["user", "顺便看下还有哪里用到 relativeTime。"],
			["assistant", "只有两处，都是展示用途。"],
		];
		let root = null;
		let prev = null;
		for (let i = 0; i < labels.length; i++) {
			const [role, preview] = labels[i];
			const node = treeNode(`n${i + 1}`, i === 0 ? null : `n${i}`, role, preview);
			if (prev) prev.children.push(node);
			else root = node;
			prev = node;
		}
		const abandoned = treeNode("b1", "n12", "user", "换个思路：不改成完整日期，直接返回“N 天后”", [
			treeNode("b2", "b1", "assistant", "那要额外处理跨月与跨年，我先看调用方…", [
				treeNode("b3", "b2", "user", "算了，先别动调用方", [treeNode("b4", "b3", "assistant", "好，那我先只改 relativeTime 自身。")]),
			]),
		]);
		const current = treeNode("c1", "n12", "user", "还是只加未来时间分支吧", [
			treeNode("c2", "c1", "assistant", "明白，只加 `diff < 0` 分支，不动其他逻辑。", [
				treeNode("c3", "c2", "user", "顺便跑一下类型检查", [treeNode("c4", "c3", "assistant", "类型检查通过，改动收敛到一个分支。")]),
			]),
		]);
		prev.children.push(abandoned, current);
		return [root];
	}
})();
