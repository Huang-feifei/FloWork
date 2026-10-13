/** 窗口底部状态栏：连接状态、当前目录、分支、后台任务与 token 用量 */
import { useMemo } from "react";
import { formatTokens } from "../lib/format";
import { projectName, useApp, waitingCount } from "../store";
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

	return (
		<>
			{totals.input + totals.output > 0 && (
				<span
					className="tabular-nums"
					title="累计输入 / 输出 token 与费用"
				>
					↑{formatTokens(totals.input)} ↓{formatTokens(totals.output)}
					{totals.cost > 0 ? ` $${totals.cost.toFixed(3)}` : ""}
				</span>
			)}
			{contextPct !== null && (
				<span
					className="flex items-center gap-1.5"
					title="最近一次请求占用的上下文窗口"
				>
					ctx
					<span className="h-1 w-12 overflow-hidden rounded-full bg-panel-2">
						<span
							className={`block h-full ${contextPct >= 80 ? "bg-warn" : "bg-accent"}`}
							style={{ width: `${contextPct}%` }}
						/>
					</span>
					<span className="tabular-nums">{contextPct}%</span>
				</span>
			)}
		</>
	);
}

export function StatusBar() {
	const info = useApp((s) => s.info);
	const connection = useApp((s) => s.connection);
	const cwd = useApp((s) => s.cwd);
	const view = useApp((s) => s.view);
	const background = useApp((s) => s.background);
	const pending = useApp((s) => waitingCount(s));
	const extStatus = useApp((s) => s.extStatus);
	const project = useApp((s) => s.projects.projects.find((p) => p.id === s.activeProjectId) ?? null);
	const node = info?.versions.node;

	const backgroundRunning = Object.values(background).filter((s) => s.isRunning).length;
	const backgroundWaiting = Object.values(background).reduce((n, s) => n + waitingCount(s), 0);
	const workers = backgroundRunning + (cwd ? 1 : 0);
	const waiting = pending + backgroundWaiting;

	return (
		<footer className="flex h-[22px] shrink-0 items-center border-t border-border bg-chrome font-mono text-[11px] text-muted select-none">
			<span className="flex h-full items-center gap-1 bg-accent px-2.5 font-semibold text-accent-foreground">
				✻ <span className="tabular-nums">{connection === "open" ? `v${info?.version ?? "…"}` : "离线"}</span>
			</span>
			{project && (
				<span
					className="flex items-center gap-1 px-2.5"
					title={project.path}
				>
					<Icon
						name="folder"
						className="size-3"
					/>
					{projectName(project)}
				</span>
			)}
			<span
				className="flex items-center gap-1.5 px-2.5"
				title="已打开会话的项目数"
			>
				<span className={`size-1.5 rounded-full ${connection === "open" ? "bg-ok" : "bg-warn"}`} />
				{workers} workers
			</span>
			{waiting > 0 && (
				<span className="flex items-center gap-1 px-2.5 text-warn">
					<Icon
						name="shield-alert"
						className="size-3"
					/>
					{waiting} 待确认
				</span>
			)}
			<div className="flex-1" />
			{view === "chat" &&
				Object.entries(extStatus).map(([key, text]) => (
					<span
						key={key}
						className="max-w-64 truncate px-2.5"
						title={`扩展状态 · ${key}：${text}`}
					>
						{text}
					</span>
				))}
			{view === "chat" && <Usage />}
			{node && <span className="px-2.5">node {node}</span>}
			<span className="px-2.5">{info?.shell === "web" ? "网页版" : "桌面版"}</span>
		</footer>
	);
}
