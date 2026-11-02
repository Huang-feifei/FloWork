import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { collectSessionFiles } from "../../lib/session-files";
import { type RightPanel as Panel, useApp } from "../../store";
import { BrowserPanel } from "../browser/BrowserPanel";
import { Icon } from "../Icon";
import { Segmented } from "../ui";
import { ExecutionTreePanel } from "./ExecutionTreePanel";
import { ProjectFiles } from "./ProjectFiles";
import { ServerFiles } from "./ServerFiles";
import { ServerStatus } from "./ServerStatus";
import { SessionFiles } from "./SessionFiles";

export const PANEL_TABS: Array<{ id: Panel; label: string; hint: string; remoteOnly?: boolean }> = [
	{ id: "files", label: "项目文件", hint: "浏览工作区目录" },
	{ id: "execution", label: "执行树", hint: "查看任务执行进度树、工具链与每步输出" },
	{ id: "session", label: "会话文件", hint: "本会话读取和修改过的文件" },
	{ id: "browser", label: "内置浏览器", hint: "在聊天旁浏览网页、预览本地 HTML（桌面版）" },
	{ id: "server", label: "服务器目录", hint: "浏览服务器上的任意目录、上传下载", remoteOnly: true },
	{ id: "services", label: "服务状态", hint: "远端主机的负载、服务与端口（只读）", remoteOnly: true },
];

/** 300px 宽的面板里放不下完整页签名，分段控件用短名，完整名字放 title */
const SHORT: Record<string, string> = {
	files: "项目",
	execution: "执行树",
	server: "目录",
	services: "服务",
	session: "会话",
	browser: "内置浏览器",
};

export function useChangedCount(): number {
	const messages = useApp((s) => s.messages);
	const cwd = useApp((s) => s.cwd);
	return useMemo(
		() => collectSessionFiles(messages, cwd).filter((f) => f.changes.some((c) => !c.isError)).length,
		[messages, cwd],
	);
}

const WIDTH_KEY = "flowork.browserRatio";
const storedRatio = Number(localStorage.getItem(WIDTH_KEY));
const initialRatio = Number.isFinite(storedRatio) && storedRatio >= 0.25 && storedRatio <= 0.65 ? storedRatio : 0.48;

function browserWidth(available: number, ratio: number): number {
	const max = Math.min(available * 0.65, Math.max(0, available - 380));
	const min = Math.min(360, available * 0.45, max);
	return Math.round(Math.max(min, Math.min(max, available * ratio)));
}

export function RightPanel() {
	const panel = useApp((s) => s.rightPanel);
	const setRightPanel = useApp((s) => s.setRightPanel);
	const isRemote = useApp((s) => !!s.projects.projects.find((p) => p.id === s.activeProjectId)?.hostId);
	const tabs = PANEL_TABS.filter((t) => !t.remoteOnly || isRemote);
	// 本地项目里如果存着「服务器目录」，回退到项目文件
	const active = (panel === "server" || panel === "services") && !isRemote ? "files" : panel;
	const changedCount = useChangedCount();
	const ref = useRef<HTMLElement>(null);
	const [available, setAvailable] = useState(0);
	const [ratio, setRatio] = useState(initialRatio);
	const drag = useRef<{ x: number; width: number; available: number } | null>(null);
	const width = browserWidth(available, ratio);

	useLayoutEffect(() => {
		const parent = ref.current?.parentElement;
		if (!parent) return;
		const measure = () => setAvailable(parent.getBoundingClientRect().width);
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		measure();
		return () => observer.disconnect();
	}, [panel]);

	if (!panel) return null;
	const isBrowser = panel === "browser";

	return (
		<aside ref={ref} className="relative flex shrink-0 flex-col overflow-hidden border-l border-border bg-sidebar"
			style={{ width: isBrowser ? (available ? width : "48%") : 300 }}>
			{isBrowser && <div role="separator" aria-label="调整浏览器宽度" aria-orientation="vertical" tabIndex={0}
				aria-valuemin={Math.round(Math.min(360, available * 0.45))} aria-valuemax={Math.round(Math.max(0, available - 380))} aria-valuenow={width}
				className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-primary/40 focus:bg-primary/40 focus:outline-none"
				onPointerDown={(event) => {
					drag.current = { x: event.clientX, width, available };
					event.currentTarget.setPointerCapture(event.pointerId);
					event.preventDefault();
				}}
				onPointerMove={(event) => {
					const start = drag.current;
					if (!start || !start.available) return;
					setRatio(Math.max(0.25, Math.min(0.65, (start.width + start.x - event.clientX) / start.available)));
				}}
				onPointerUp={(event) => {
					drag.current = null;
					event.currentTarget.releasePointerCapture(event.pointerId);
					localStorage.setItem(WIDTH_KEY, String(ratio));
				}}
				onPointerCancel={() => { drag.current = null; }}
				onKeyDown={(event) => {
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
					event.preventDefault();
					const next = Math.max(0.25, Math.min(0.65, ratio + (event.key === "ArrowLeft" ? 0.02 : -0.02)));
					setRatio(next);
					localStorage.setItem(WIDTH_KEY, String(next));
				}} />}
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
				<div className="fw-seg-scroll min-w-0 flex-1">
					<Segmented
						items={tabs.map((t) => ({
							id: t.id,
							label: t.id === "session" && changedCount > 0 ? `${SHORT[t.id] ?? t.label} ${changedCount}` : (SHORT[t.id] ?? t.label),
							title: t.hint,
						}))}
						active={active ?? ""}
						onChange={(id) => setRightPanel(id as Panel)}
					/>
				</div>
				<button
					type="button"
					onClick={() => setRightPanel(null)}
					title="收起"
					className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-fg"
				>
					<Icon name="x" className="size-3.5" />
				</button>
			</div>
			{active === "files" && <ProjectFiles />}
			{active === "execution" && <ExecutionTreePanel />}
			{active === "server" && isRemote && <ServerFiles />}
			{active === "services" && isRemote && <ServerStatus />}
			{active === "session" && <SessionFiles />}
			{isBrowser && <BrowserPanel />}
		</aside>
	);
}
