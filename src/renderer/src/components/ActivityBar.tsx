import { Icon, type IconName } from "./Icon";
import { useApp, waitingCount } from "../store";

type Section = "main" | "tools" | "settings";
type Item = {
	icon: IconName;
	label: string;
	active?: boolean;
	short?: string;
	badge?: number;
	onClick: () => void;
};

function ActivityItem({ icon, label, short, active, badge, onClick }: Item) {
	return (
		<button
			type="button"
			title={label}
			aria-label={badge ? `${label}，${badge} 项待确认` : label}
			aria-pressed={active}
			onClick={onClick}
			className="fw-rail-item"
		>
			<Icon name={icon} className="size-[var(--activity-icon)] shrink-0" />
			<span>{short ?? label}</span>
			{!!badge && (
				<span className="fw-rail-badge">
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
	const items: Record<Section, Item[]> = {
		main: [
			{ icon: "messages", label: "会话", active: inChat, onClick: () => setView("chat") },
			{ icon: "git-compare", label: "本会话的修改", short: "审查", active: view === "review", badge: waiting, onClick: () => setView("review") },
		],
		tools: [
			{ icon: "sparkles", label: "图片生成", short: "生图", active: view === "imagegen", onClick: () => setView("imagegen") },
			{ icon: "image", label: "图片库", active: view === "gallery", onClick: () => setView("gallery") },
			{ icon: "database", label: "数据库", active: view === "database", onClick: () => setView("database") },
			{ icon: hasProject ? "files" : "folder", label: "项目文件", short: "文件", active: inChat && rightPanel === "files", onClick: () => setRightPanel(inChat && rightPanel === "files" ? null : "files") },
			{ icon: "square-terminal", label: "终端", active: terminalPanel, onClick: () => setTerminalPanel(!terminalPanel) },
			{ icon: "server", label: "远程主机（SSH）", short: "远程", active: remoteOpen, onClick: () => setRemoteOpen(true) },
		],
		settings: [{ icon: "settings", label: "设置", active: view === "settings", onClick: () => setView("settings") }],
	};
	const render = (group: Section) => items[group].map((item) => <ActivityItem key={item.label} {...item} />);
	return (
		<nav aria-label="工作台导航" className="fw-app-rail">
			{render("main")}
			<div className="fw-rail-separator" />
			{render("tools")}
			<div className="flex-1" />
			{render("settings")}
		</nav>
	);
}
