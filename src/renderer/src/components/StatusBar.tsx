/** 窗口底部状态栏：连接状态、当前目录、token 用量与上下文占用 */
import { useMemo } from "react";
import { formatTokens } from "../lib/format";
import { useApp } from "../store";
import { Icon } from "./Icon";

function Usage() {
	const state = useApp((s) => s.state);
	const messages = useApp((s) => s.messages);

	const totals = useMemo(() => {
		let input = 0;
		let output = 0;
		let cost = 0;
		let lastContext = 0;
		for (const m of messages) {
			if (m.role !== "assistant" || !m.usage) continue;
			input += m.usage.input + m.usage.cacheRead;
			output += m.usage.output;
			cost += m.usage.cost.total;
			if (m.usage.totalTokens > 0) lastContext = m.usage.totalTokens;
		}
		return { input, output, cost, lastContext };
	}, [messages]);

	const contextWindow = state?.model?.contextWindow;
	const contextPct = contextWindow && totals.lastContext ? Math.min(100, Math.round((totals.lastContext / contextWindow) * 100)) : null;
	if (totals.input + totals.output === 0) return null;

	return (
		<>
			<span
				className="font-mono tabular-nums"
				title="累计输入 / 输出 token 与费用"
			>
				↑{formatTokens(totals.input)} ↓{formatTokens(totals.output)}
				{totals.cost > 0 ? ` · $${totals.cost.toFixed(3)}` : ""}
			</span>
			{contextPct !== null && (
				<span
					className="flex items-center gap-1.5"
					title="最近一次请求占用的上下文窗口"
				>
					上下文
					<span className="h-1 w-14 overflow-hidden rounded-full bg-black/10">
						<span
							className={`block h-full ${contextPct >= 80 ? "bg-warn" : "bg-accent"}`}
							style={{ width: `${contextPct}%` }}
						/>
					</span>
					<span className="font-mono tabular-nums">{contextPct}%</span>
				</span>
			)}
		</>
	);
}

export function StatusBar() {
	const connection = useApp((s) => s.connection);
	const info = useApp((s) => s.info);
	const cwd = useApp((s) => s.cwd);
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const view = useApp((s) => s.view);

	return (
		<footer className="flex h-6 shrink-0 items-center gap-4 bg-chrome px-3 text-[11.5px] whitespace-nowrap text-muted select-none">
			<span className="flex items-center gap-1.5">
				<span className={`size-1.5 rounded-full ${connection === "open" ? "bg-ok" : "bg-warn"}`} />
				{connection === "open" ? "已连接" : connection === "connecting" ? "连接中…" : "后端已断开"}
			</span>
			{hasProject && cwd && (
				<span
					className="flex min-w-0 items-center gap-1 truncate"
					title={cwd}
				>
					<Icon
						name="terminal"
						className="size-3.5"
					/>
					<span className="truncate">{cwd}</span>
				</span>
			)}
			<div className="flex-1" />
			{hasProject && view === "chat" && <Usage />}
			{info && <span>{info.shell === "web" ? "网页版" : "桌面版"} {info.version}</span>}
		</footer>
	);
}
