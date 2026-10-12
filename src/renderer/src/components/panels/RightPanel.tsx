/** 右侧面板：项目文件 / 会话文件 / 会话树 */
import { useMemo } from "react";
import { collectSessionFiles } from "../../lib/session-files";
import { type RightPanel as Panel, useApp } from "../../store";
import { ProjectFiles } from "./ProjectFiles";
import { SessionFiles } from "./SessionFiles";
import { SessionTree } from "./SessionTree";

export const PANEL_TABS: Array<{ id: Panel; label: string; hint: string }> = [
	{ id: "files", label: "项目文件", hint: "浏览工作区目录" },
	{ id: "session", label: "会话文件", hint: "本会话读取和修改过的文件" },
	{ id: "tree", label: "会话树", hint: "回到任意节点、分叉" },
];

export function useChangedCount(): number {
	const messages = useApp((s) => s.messages);
	const cwd = useApp((s) => s.cwd);
	return useMemo(
		() => collectSessionFiles(messages, cwd).filter((f) => f.changes.some((c) => !c.isError)).length,
		[messages, cwd],
	);
}

export function RightPanel() {
	const panel = useApp((s) => s.rightPanel);
	const setRightPanel = useApp((s) => s.setRightPanel);
	const changedCount = useChangedCount();
	if (!panel) return null;

	return (
		<aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-border bg-panel">
			<div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2 text-xs">
				{PANEL_TABS.map((t) => (
					<button
						type="button"
						key={t.id}
						onClick={() => setRightPanel(t.id)}
						title={t.hint}
						className={`rounded-md px-2 py-1 ${t.id === panel ? "bg-panel-2 font-medium text-fg" : "text-muted hover:text-fg"}`}
					>
						{t.label}
						{t.id === "session" && changedCount > 0 && <span className="ml-1 text-warn">{changedCount}</span>}
					</button>
				))}
				<div className="flex-1" />
				<button type="button" onClick={() => setRightPanel(null)} title="收起" className="px-1.5 text-muted hover:text-fg">
					✕
				</button>
			</div>
			{panel === "files" && <ProjectFiles />}
			{panel === "session" && <SessionFiles />}
			{panel === "tree" && <SessionTree />}
		</aside>
	);
}
