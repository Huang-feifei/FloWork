import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { collectSessionFiles } from "../../lib/session-files";
import { type RightPanel as Panel, useApp } from "../../store";
import { BrowserPanel } from "../browser/BrowserPanel";
import { ProjectFiles } from "./ProjectFiles";
import { SessionFiles } from "./SessionFiles";
import { SessionTree } from "./SessionTree";

export const PANEL_TABS: Array<{ id: Panel; label: string; hint: string }> = [
	{ id: "files", label: "项目文件", hint: "浏览工作区目录" },
	{ id: "session", label: "会话文件", hint: "本会话读取和修改过的文件" },
	{ id: "tree", label: "会话树", hint: "回到任意节点、分叉" },
	{ id: "browser", label: "浏览器", hint: "在聊天旁浏览网页（桌面版）" },
];

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
				className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-accent/40 focus:bg-accent/40 focus:outline-none"
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
			<div className="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-border px-1 pl-2">
				{PANEL_TABS.map((t) => (
					<button type="button" key={t.id} onClick={() => setRightPanel(t.id)} title={t.hint}
						className={`relative min-w-0 truncate rounded-md px-2 py-1 text-xs ${t.id === panel ? "bg-panel-2 font-medium text-fg" : "text-muted hover:text-fg"}`}>
						{t.label}
						{t.id === "session" && changedCount > 0 && <span className="ml-1 text-warn">{changedCount}</span>}
					</button>
				))}
				<div className="flex-1" />
				<button type="button" onClick={() => setRightPanel(null)} title="收起" className="shrink-0 px-1.5 text-muted hover:text-fg">✕</button>
			</div>
			{panel === "files" && <ProjectFiles />}
			{panel === "session" && <SessionFiles />}
			{panel === "tree" && <SessionTree />}
			{isBrowser && <BrowserPanel />}
		</aside>
	);
}
