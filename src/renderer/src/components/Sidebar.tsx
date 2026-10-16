/** 侧栏：项目分组树（含会话），等宽小标题，状态用文字标签 */
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, errorText } from "../api/client";
import { useApp } from "../store";
import { Icon } from "./Icon";
import { askText } from "./PromptDialog";
import { Menu } from "./sidebar/Menu";
import { ProjectTree } from "./sidebar/ProjectTree";
import { ResizeHandle, usePersistentWidth } from "./ResizeHandle";

export function Sidebar() {
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const canNewSession = useApp((s) => s.handleId !== null && hasProject);
	const { importProjects, setView, setDiscoverOpen, setRemoteOpen, pushNotice, newSession } = useApp.getState();
	const projectIds = useApp(useShallow((s) => s.projects.projects.map((p) => p.id)));
	const expandedCount = useApp((s) => projectIds.filter((id) => s.expanded[id]).length);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const width = usePersistentWidth("flowork.sidebarWidth", 260, 200, 520);

	/** 一键折叠 / 展开所有项目的会话列表 */
	const setAllExpanded = (open: boolean) => {
		const { toggleExpanded, expanded } = useApp.getState();
		for (const id of projectIds) if (!!expanded[id] !== open) toggleExpanded(id, open);
	};

	return (
		<aside
			className="relative flex shrink-0 flex-col border-r border-border bg-sidebar"
			style={{ width: width.width }}
		>
			<ResizeHandle
				state={width}
				edge="right"
				label="调整项目栏宽度"
			/>
			<div className="flex h-9 shrink-0 items-center gap-0.5 pr-1.5 pl-3">
				<span className="flex-1 font-mono text-[11px] font-semibold tracking-[0.08em] text-muted">项目</span>
				<button
					type="button"
					disabled={!canNewSession}
					onClick={() => {
						setView("chat");
						void newSession();
					}}
					title="新会话 Ctrl+N"
					className="flex size-6 items-center justify-center rounded text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
				>
					<Icon
						name="square-pen"
						className="size-3.5"
					/>
				</button>
				<button
					type="button"
					onClick={() => void importProjects()}
					title="导入文件夹（可多选）"
					className="flex size-6 items-center justify-center rounded text-muted hover:bg-panel-2 hover:text-fg"
				>
					<Icon
						name="folder-plus"
						className="size-3.5"
					/>
				</button>
				<button
					type="button"
					onClick={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						setMenu({ x: rect.left - 120, y: rect.bottom + 4 });
					}}
					title="更多"
					className="flex size-6 items-center justify-center rounded text-muted hover:bg-panel-2 hover:text-fg"
				>
					<Icon
						name="ellipsis"
						className="size-3.5"
					/>
				</button>
			</div>

			<nav className="min-h-0 flex-1 overflow-y-auto pb-3">
				<ProjectTree />
			</nav>

			{menu && (
				<Menu
					position={menu}
					onClose={() => setMenu(null)}
					items={[
						{ label: "导入文件夹…", onClick: () => void importProjects() },
						{ label: "添加远程项目（SSH）…", onClick: () => setRemoteOpen(true) },
						{ label: "从已有会话发现项目…", onClick: () => setDiscoverOpen(true) },
						{ separator: true, label: "" },
						{
							label: "折叠全部会话",
							disabled: expandedCount === 0,
							onClick: () => setAllExpanded(false),
						},
						{
							label: "展开全部会话",
							disabled: projectIds.length === 0 || expandedCount >= projectIds.length,
							onClick: () => setAllExpanded(true),
						},
						{ separator: true, label: "" },
						{
							label: "新建分组…",
							onClick: async () => {
								const name = await askText({ title: "新建分组", placeholder: "分组名称" });
								if (name?.trim()) void api.projects.groupCreate(name.trim()).catch((e: unknown) => pushNotice("error", errorText(e)));
							},
						},
					]}
				/>
			)}
		</aside>
	);
}
