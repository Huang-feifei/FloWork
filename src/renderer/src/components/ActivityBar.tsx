/** 最左侧活动栏：上组切换主视图（会话 / 修改），下组打开工具（项目文件 / 终端 / 远程 SSH），底部为设置 */
import { Icon } from "./Icon";
import { useApp, waitingCount } from "../store";

function ActivityItem({ icon, label, active, badge, onClick }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; active: boolean; badge?: string; onClick: () => void }) {
	return (
		<button
			type="button"
			title={label}
			onClick={onClick}
			className={`relative flex h-11 w-full items-center justify-center ${active ? "text-fg" : "text-faint hover:text-muted"}`}
		>
			{active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-accent" />}
			<Icon
				name={icon}
				className="size-5"
			/>
			{badge && (
				<span className="absolute top-1.5 right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9.5px] font-bold text-accent-foreground">
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
		<nav className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-chrome">
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
			{/* 上面切换主视图，下面打开工具面板 / 对话框 */}
			<div className="my-1 h-px w-6 bg-border" />
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
