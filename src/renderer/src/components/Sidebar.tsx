import { useState } from "react";
import { api, errorText } from "../api/client";
import { useApp } from "../store";
import { Menu } from "./sidebar/Menu";
import { ProjectTree } from "./sidebar/ProjectTree";

export function Sidebar() {
	const view = useApp((s) => s.view);
	const info = useApp((s) => s.info);
	const connection = useApp((s) => s.connection);
	const { importProjects, setView, setDiscoverOpen, pushNotice } = useApp.getState();
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

	return (
		<aside className="flex w-[272px] shrink-0 flex-col border-r border-border bg-sidebar">
			<div className="flex items-center gap-2 px-4 pt-4 pb-3">
				<span className="flex size-6 items-center justify-center rounded-md bg-accent font-mono text-xs text-white">✻</span>
				<span className="text-[15px] font-semibold tracking-tight">FloWork</span>
				{info && <span className="text-[11px] text-muted">{info.shell === "web" ? "网页版" : "桌面版"}</span>}
				<div className="flex-1" />
				{connection !== "open" && (
					<span className="flex items-center gap-1 text-[11px] text-warn">
						<span className="size-1.5 rounded-full bg-warn" />
						{connection === "connecting" ? "连接中" : "已断开"}
					</span>
				)}
			</div>

			<div className="flex items-center gap-1 px-4 pb-1">
				<span className="flex-1 text-[11px] font-medium tracking-wide text-muted">项目</span>
				<button
					type="button"
					onClick={() => void importProjects()}
					title="导入文件夹（可多选）"
					className="rounded px-1.5 text-[15px] leading-5 text-muted hover:bg-panel-2 hover:text-fg"
				>
					+
				</button>
				<button
					type="button"
					onClick={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						setMenu({ x: rect.left - 120, y: rect.bottom + 4 });
					}}
					title="更多"
					className="rounded px-1.5 leading-5 text-muted hover:bg-panel-2 hover:text-fg"
				>
					⋯
				</button>
			</div>

			<nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				<ProjectTree />
			</nav>

			<div className="border-t border-border p-3">
				<button
					type="button"
					onClick={() => setView(view === "settings" ? "chat" : "settings")}
					className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] ${
						view === "settings" ? "bg-panel font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)]" : "hover:bg-panel-2"
					}`}
				>
					<span className="text-muted">⚙</span> 设置
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
							onClick: () => {
								const name = window.prompt("分组名称", "");
								if (name?.trim()) void api.projects.groupCreate(name).catch((e: unknown) => pushNotice("error", errorText(e)));
							},
						},
					]}
				/>
			)}
		</aside>
	);
}
