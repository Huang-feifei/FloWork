import { useState } from "react";
import { api, errorText } from "../api/client";
import { useApp } from "../store";
import { Icon } from "./Icon";
import { askText } from "./PromptDialog";
import { Menu } from "./sidebar/Menu";
import { ProjectTree } from "./sidebar/ProjectTree";

/** 选中 / 主按钮的浮起效果 */
const raised = "bg-panel shadow-[0_1px_2px_rgba(60,40,20,0.08)]";

export function Sidebar() {
	const view = useApp((s) => s.view);
	const canNewSession = useApp((s) => s.handleId !== null && s.activeProjectId !== null);
	const { importProjects, setView, setDiscoverOpen, pushNotice, newSession } = useApp.getState();
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

	return (
		<aside className="flex w-[264px] shrink-0 flex-col bg-sidebar">
			<div className="flex gap-1.5 px-3 pt-3 pb-2">
				<button
					type="button"
					disabled={!canNewSession}
					onClick={() => {
						setView("chat");
						void newSession();
					}}
					title="在当前项目中新建会话"
					className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium ${raised} hover:bg-white disabled:opacity-50`}
				>
					<Icon
						name="square-pen"
						className="size-4 text-accent"
					/>
					新会话
				</button>
				<button
					type="button"
					onClick={() => void importProjects()}
					title="导入文件夹（可多选）"
					className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-black/[0.05] hover:text-fg"
				>
					<Icon name="folder-plus" />
				</button>
			</div>

			<div className="flex h-7 items-center pt-1 pr-2 pl-4">
				<span className="flex-1 text-[11px] font-medium tracking-wide text-faint">项目</span>
				<button
					type="button"
					onClick={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						setMenu({ x: rect.left - 120, y: rect.bottom + 4 });
					}}
					title="更多"
					className="flex size-6 items-center justify-center rounded text-muted hover:bg-black/[0.05] hover:text-fg"
				>
					<Icon name="ellipsis" />
				</button>
			</div>

			<nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				<ProjectTree />
			</nav>

			<div className="px-3 pt-1 pb-3">
				<button
					type="button"
					onClick={() => setView(view === "settings" ? "chat" : "settings")}
					className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] ${
						view === "settings" ? `${raised} font-medium` : "text-muted hover:bg-black/[0.04] hover:text-fg"
					}`}
				>
					<Icon name="settings" />
					设置
				</button>
			</div>

			{menu && (
				<Menu
					position={menu}
					onClose={() => setMenu(null)}
					items={[
						{ label: "导入文件夹…", onClick: () => void importProjects() },
						{ label: "从已有会话发现项目…", onClick: () => setDiscoverOpen(true) },
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
