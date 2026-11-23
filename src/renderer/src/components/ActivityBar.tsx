import { Icon, type IconName } from "./Icon";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { useApp } from "../store";

type Section = "main" | "tools" | "settings";
type Item = {
	icon: IconName;
	label: string;
	active?: boolean;
	disabled?: boolean;
	short?: string;
	onClick: () => void;
};

function ActivityItem({ icon, label, short, active, disabled, onClick }: Item) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className="fw-rail-item"
		>
			<Icon name={icon} className="size-[var(--activity-icon)] shrink-0" />
			<span>{short ?? label}</span>
		</button>
	);
}

export function ActivityBar() {
	const view = useApp((s) => s.view);
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const rightPanel = useApp((s) => s.rightPanel);
	const remoteOpen = useApp((s) => s.remoteOpen);
	const { setView, setRightPanel, openRightPanel, setRemoteOpen } = useApp.getState();
	const inChat = view === "chat";
	const items: Record<Section, Item[]> = {
		main: [
			{ icon: "messages", label: "会话", active: inChat, onClick: () => setView("chat") },
		],
		tools: [
			{ icon: "sparkles", label: "图片生成", short: "生图", active: view === "imagegen", onClick: () => setView("imagegen") },
			{ icon: "image", label: "图片库", active: view === "gallery", onClick: () => setView("gallery") },
			{ icon: "database", label: "数据库", active: view === "database", onClick: () => setView("database") },
			{ icon: "files", label: "项目文件", short: "文件", active: hasProject && inChat && rightPanel === "files", disabled: !hasProject, onClick: () => inChat && rightPanel === "files" ? setRightPanel(null) : openRightPanel("files") },
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
			<AppUpdateNotice />
			{render("settings")}
		</nav>
	);
}
