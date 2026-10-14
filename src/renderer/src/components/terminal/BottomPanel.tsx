/**
 * 底部面板：终端 / 输出 / pi 日志三个页签。
 *
 * 终端页签是真正的交互式 shell（见 TerminalPanel.tsx），另外两个页签只读会话状态。
 */
import { useMemo, useRef } from "react";
import { type BottomTab, useApp } from "../../store";
import { Icon } from "../Icon";
import { TerminalTab } from "./TerminalPanel";

const TABS: Array<{ id: BottomTab; label: string }> = [
	{ id: "terminal", label: "终端" },
	{ id: "output", label: "输出" },
	{ id: "logs", label: "pi 日志" },
];

/** 输出：本会话里 pi 执行过的工具与它们的耗时 */
function OutputTab() {
	const toolRuns = useApp((s) => s.toolRuns);
	const messages = useApp((s) => s.messages);
	const clearHint = useRef(false);

	// 从消息中取工具调用的参数摘要，作为输出的可读标签
	const labels = useMemo(() => {
		const map = new Map<string, string>();
		for (const m of messages) {
			if (m.role !== "assistant") continue;
			for (const b of m.content) {
				if (b.type !== "toolCall") continue;
				const args = b.arguments as Record<string, unknown>;
				const key = ["path", "file_path", "command", "pattern"].find((k) => typeof args[k] === "string");
				map.set(b.id, key ? String(args[key]) : JSON.stringify(args).slice(0, 80));
			}
		}
		return map;
	}, [messages]);

	const runs = Object.entries(toolRuns).filter(([id]) => labels.has(id));
	clearHint.current = runs.length === 0;

	return (
		<div className="term min-h-0 flex-1 overflow-y-auto px-4 pb-3 text-[12.5px] leading-[1.8]">
			{runs.length === 0 && <div className="text-faint">本会话还没有执行过工具。pi 运行命令与读写文件时会显示在这里。</div>}
			{runs.map(([id, run]) => (
				<div key={id} className="grid grid-cols-[1.2rem_1fr_auto] gap-x-2">
					<span className={run.status === "error" ? "text-err" : run.status === "running" ? "text-warn" : "text-ok"}>
						{run.status === "error" ? "✗" : run.status === "running" ? "●" : "✓"}
					</span>
					<span className="min-w-0 truncate">
						<span className="text-fg/85">{run.toolName}</span>
						<span className="text-faint"> </span>
						<span className="text-muted">{labels.get(id)}</span>
					</span>
					<span className="text-faint tabular-nums">{run.durationMs !== undefined ? `${(run.durationMs / 1000).toFixed(1)}s` : "…"}</span>
				</div>
			))}
		</div>
	);
}

/** pi 日志：运行时、配置目录、会话文件与最近的提示 */
function LogsTab() {
	const info = useApp((s) => s.info);
	const connection = useApp((s) => s.connection);
	const state = useApp((s) => s.state);
	const notices = useApp((s) => s.notices);
	const projects = useApp((s) => s.projects.projects);
	const activeId = useApp((s) => s.activeProjectId);
	const background = useApp((s) => s.background);
	const project = projects.find((p) => p.id === activeId);

	const rows: Array<[string, string]> = [
		["后端", connection === "open" ? "已连接" : connection === "connecting" ? "连接中…" : "已断开"],
		["外壳", info?.shell === "web" ? "网页版（WebSocket）" : "桌面版（Electron IPC）"],
		["Node", info?.versions.node ?? "…"],
		["Electron", info?.versions.electron ?? "—"],
		["pi", info?.versions.pi ?? "1.1.0"],
		["配置目录", info?.agentDir ?? "…"],
		["当前项目", project?.path ?? "—"],
		["会话文件", state?.sessionFile ?? "—"],
		["后台项目", Object.keys(background).length > 0 ? Object.keys(background).length + " 个" : "—"],
	];

	return (
		<div className="term min-h-0 flex-1 overflow-y-auto px-4 pb-3 text-[12.5px] leading-[1.8]">
			{rows.map(([k, v]) => (
				<div
					key={k}
					className="grid grid-cols-[7rem_1fr] gap-x-2"
				>
					<span className="text-faint">{k}</span>
					<span className="min-w-0 truncate text-fg/85">{v}</span>
				</div>
			))}
			{notices.length > 0 && (
				<>
					<div className="mt-2 text-faint">最近提示</div>
					{notices.map((n) => (
						<div
							key={n.id}
							className={n.level === "error" ? "text-err" : n.level === "warning" ? "text-warn" : "text-muted"}
						>
							[{n.level}] {n.text}
						</div>
					))}
				</>
			)}
		</div>
	);
}

export function BottomPanel() {
	const open = useApp((s) => s.terminalPanel);
	const tab = useApp((s) => s.panelTab);
	const toolRuns = useApp((s) => s.toolRuns);
	const { setPanelTab, setTerminalPanel } = useApp.getState();
	const running = Object.values(toolRuns).some((r) => r.status === "running");

	if (!open) return null;

	return (
		<section className="flex h-[250px] shrink-0 flex-col border-t border-border bg-bg">
			<div className="flex h-8 shrink-0 items-stretch gap-1 border-b border-border px-2 font-mono text-[11px]">
				{TABS.map((t) => (
					<button
						type="button"
						key={t.id}
						onClick={() => setPanelTab(t.id)}
						className={`relative flex items-center px-2 tracking-[0.04em] ${t.id === tab ? "text-fg" : "text-faint hover:text-muted"}`}
					>
						{t.label}
						{t.id === tab && <span className="absolute inset-x-2 bottom-0 h-px bg-accent" />}
					</button>
				))}
				<div className="flex-1" />
				<span className="flex items-center gap-1.5 px-2 text-muted">
					<span className={`size-1.5 rounded-full ${running ? "bg-accent" : "bg-ok"}`} />
					{running ? "工具执行中" : "空闲"}
				</span>
				<button
					type="button"
					title="收起（Ctrl+`）"
					onClick={() => setTerminalPanel(false)}
					className="flex w-6 items-center justify-center text-muted hover:text-fg"
				>
					<Icon
						name="chevron-down"
						className="size-3.5"
					/>
				</button>
			</div>

			{tab === "terminal" && <TerminalTab />}
			{tab === "output" && <OutputTab />}
			{tab === "logs" && <LogsTab />}
		</section>
	);
}
