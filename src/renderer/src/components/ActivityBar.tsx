/** 最左侧活动栏：上组切换主视图（会话 / 修改），下组打开工具（项目文件 / 终端 / 远程 SSH），底部为设置。
 *  Apple 体系：选中态是圆角软底 + 唯一的蓝色图标，不再用左侧竖条；待确认角标用琥珀色。 */
import { Icon } from "./Icon";
import { useApp, waitingCount } from "../store";

function ActivityItem({ icon, label, active, badge, onClick }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; active: boolean; badge?: string; onClick: () => void }) {
	return (
		<button
			type="button"
			title={label}
			onClick={onClick}
			className={`relative flex size-[var(--activity-item)] items-center justify-center rounded-[10px] ${
				active ? "bg-panel-2 text-primary" : "text-faint hover:bg-highlight hover:text-muted"
			}`}
		>
			<Icon name={icon} className="size-[var(--activity-icon)]" />
			{badge && (
				<span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-semibold text-warn-foreground">
					{badge}
				</span>
			)}
		</button>
	);
}

export function ActivityBar() {
	const view = useApp((s) => s.view);
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const terminalPanel = useApp((s) => s.terminalPanel);
	const waiting = useApp((s) => waitingCount(s));
	const rightPanel = useApp((s) => s.rightPanel);
	const remoteOpen = useApp((s) => s.remoteOpen);
	const { setView, setRightPanel, setTerminalPanel, setRemoteOpen } = useApp.getState();
	const inChat = view === "chat";

	return (
		<nav className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-chrome py-2">
			<ActivityItem
				icon="messages"
				label="会话"
				active={inChat && rightPanel !== "session"}
				onClick={() => setView("chat")}
			/>
			<ActivityItem
				icon="git-compare"
				label="本会话的修改"
				active={view === "review"}
				badge={waiting > 0 ? String(waiting) : undefined}
				onClick={() => setView("review")}
			/>
			<ActivityItem
				icon="sparkles"
				label="图片生成"
				active={view === "imagegen"}
				onClick={() => setView("imagegen")}
			/>
			<ActivityItem
				icon="image"
				label="图片库"
				active={view === "gallery"}
				onClick={() => setView("gallery")}
			/>
			<ActivityItem icon="database" label="数据库" active={view === "database"} onClick={() => setView("database")} />
			{/* 上面切换主视图，下面打开工具面板 / 对话框 */}
			<div className="my-1.5 h-px w-6 bg-border" />
			<ActivityItem
				icon={hasProject ? "files" : "folder"}
				label="项目文件"
				active={inChat && rightPanel === "files"}
				onClick={() => (inChat && rightPanel === "files" ? setRightPanel(null) : setRightPanel("files"))}
			/>
			<ActivityItem
				icon="square-terminal"
				label="终端"
				active={terminalPanel}
				onClick={() => setTerminalPanel(!terminalPanel)}
			/>
			<ActivityItem
				icon="server"
				label="远程主机（SSH）"
				active={remoteOpen}
				onClick={() => setRemoteOpen(true)}
			/>
			<div className="flex-1" />
			<ActivityItem
				icon="settings"
				label="设置"
				active={view === "settings"}
				onClick={() => setView("settings")}
			/>
		</nav>
	);
}
