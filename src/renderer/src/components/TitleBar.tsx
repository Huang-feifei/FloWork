/**
 * 自绘窗口标题栏（桌面版 titleBarStyle: hidden）：
 * 左侧应用菜单按钮（文件 / 编辑 / 视图 / 会话 / 终端 / 帮助 六个菜单都收在这个按钮里，
 * 不再在窗口里排成一排 Windows 式菜单条），中间是窗口标题（当前项目 / 会话），
 * 右侧是布局开关与系统风格的窗口按钮（macOS 用系统自带红绿灯）。
 */
import { useEffect, useState } from "react";
import { displayUserText } from "@shared/skill-text";
import { isMac } from "../lib/desktop";
import { projectName, useApp } from "../store";
import { Icon, type IconName } from "./Icon";
import { Menu, type MenuItem } from "./sidebar/Menu";

const MENUS = ["文件", "编辑", "视图", "会话", "终端", "帮助"] as const;
type MenuName = (typeof MENUS)[number];

/**
 * Windows 风格窗口按钮：贴窗口右上角，宽 46px、满高（与系统按钮一致），
 * 命中区比之前 20px 的圆点大一个量级；关闭键悬停变红。
 */
function WindowButton({ icon, title, close, onClick }: { icon: IconName; title: string; close?: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			className={`app-no-drag flex w-[46px] shrink-0 items-center justify-center self-stretch text-muted hover:text-fg ${
				close ? "hover:bg-win-close hover:text-white" : "hover:bg-panel-2"
			}`}
		>
			<Icon
				name={icon}
				className={icon === "square" ? "size-3" : "size-4"}
			/>
		</button>
	);
}

function LayoutToggle({ icon, label, on, onClick }: { icon: IconName; label: string; on: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			title={label}
			onClick={onClick}
			className={`flex size-7 items-center justify-center rounded-full hover:bg-panel-2 ${
				on ? "text-fg" : "text-faint hover:text-fg"
			}`}
		>
			<Icon name={icon} className="size-4" />
		</button>
	);
}

function Location() {
	const view = useApp((s) => s.view);
	const projectTitle = useApp((s) => {
		const p = s.projects.projects.find((x) => x.id === s.activeProjectId);
		return p ? projectName(p) : null;
	});
	const sessionTitle = useApp((s) => {
		if (s.state?.sessionName) return s.state.sessionName;
		const first = s.messages.find((m) => m.role === "user");
		return first?.role === "user" ? displayUserText(first.content.map((b) => (b.type === "text" ? b.text : "")).join("")).slice(0, 60) : "";
	});

	if (view === "settings") return <span className="truncate text-[13px] font-medium text-fg">设置</span>;
	if (view === "review") return <span className="truncate text-[13px] font-medium text-fg">审查本会话的修改</span>;
	if (!projectTitle) return <span className="truncate text-[13px] font-medium text-fg">FloWork</span>;
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<span className="shrink-0 text-[13px] font-medium text-fg">{projectTitle}</span>
			<span className="text-faint">/</span>
			<span className="truncate text-[13px] text-muted">{sessionTitle || "新会话"}</span>
		</span>
	);
}

export function TitleBar() {
	const sidebarOpen = useApp((s) => s.sidebarOpen);
	const rightPanel = useApp((s) => s.rightPanel);
	const railVisible = useApp((s) => s.railVisible);
	const terminalPanel = useApp((s) => s.terminalPanel);
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const [open, setOpen] = useState<{ name: MenuName | "root"; x: number; y: number } | null>(null);

	const menuItems = (name: MenuName): MenuItem[] => {
		const s = useApp.getState();
		switch (name) {
			case "文件":
				return [
					{ label: "导入项目文件夹…", hint: isMac ? "⌘O" : "Ctrl+O", onClick: () => void s.importProjects() },
					{ label: "添加远程项目（SSH）…", onClick: () => s.setRemoteOpen(true) },
					{ label: "从已有会话发现项目…", onClick: () => s.setDiscoverOpen(true) },
					{ separator: true, label: "" },
					{ label: "设置", hint: isMac ? "⌘," : "Ctrl+,", onClick: () => s.setView("settings") },
				];
			case "编辑":
				return [
					{ label: "快速打开文件…", hint: isMac ? "⌘P" : "Ctrl+P", onClick: () => s.setQuickOpen(true) },
					{ label: "命令面板…", hint: isMac ? "⌘K" : "Ctrl+K", onClick: () => s.setPalette(true) },
				];
			case "视图":
				return [
					{ label: sidebarOpen ? "隐藏项目栏" : "显示项目栏", hint: isMac ? "⌘B" : "Ctrl+B", onClick: () => s.toggleSidebar() },
					{ label: rightPanel ? "收起右侧面板" : "显示右侧面板", hint: isMac ? "⌘⌥B" : "Ctrl+Alt+B", onClick: () => s.setRightPanel(rightPanel ? null : "session") },
					{ label: "数据库工作台", onClick: () => s.setView("database") },
					{ label: "打开内置浏览器", onClick: () => { s.setView("chat"); s.setRightPanel("browser"); } },
				];
			case "会话":
				return [
					{ label: "新建会话", hint: isMac ? "⌘N" : "Ctrl+N", disabled: !hasProject, onClick: () => void s.newSession() },
					{ separator: true, label: "" },
					{ label: "审查本会话的修改", disabled: !hasProject, onClick: () => s.setView("review") },
					{
						label: s.foldProcess ? "展开思考与工具调用" : "折叠思考与工具调用",
						disabled: !hasProject,
						onClick: () => s.toggleFoldProcess(),
					},
					{ label: railVisible ? "隐藏会话树轨道" : "显示会话树轨道", disabled: !hasProject, onClick: () => s.toggleRail() },
				];
			case "终端":
				return [
					{ label: terminalPanel ? "收起终端面板" : "打开终端面板", hint: "Ctrl+`", onClick: () => s.setTerminalPanel(!terminalPanel) },
					{
						label: "输出",
						onClick: () => {
							s.setPanelTab("output");
							s.setTerminalPanel(true);
						},
					},
					{
						label: "pi 日志",
						onClick: () => {
							s.setPanelTab("logs");
							s.setTerminalPanel(true);
						},
					},
				];
			case "帮助":
				return [
					{ label: "命令与快捷键…", hint: isMac ? "⌘K" : "Ctrl+K", onClick: () => s.setPalette(true, "commands") },
					{ label: "查看更新内容", onClick: () => s.setUpdatedTo(s.info?.version ?? null) },
					{ label: "环境自检与发现项目…", onClick: () => s.setView("welcome") },
				];
		}
	};

	// 全局快捷键：Ctrl+B 项目栏、Ctrl+Alt+B 右侧面板、Ctrl+K 命令面板、Ctrl+` 终端、Ctrl+N 新会话、
	// Ctrl+M 模型设置、Ctrl+Shift+D 审查修改，Esc 关闭面板（与命令面板里展示的快捷键保持一致）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const s = useApp.getState();
			if (e.key === "Escape" && s.palette.open) {
				s.setPalette(false);
				return;
			}
			if (!(e.ctrlKey || e.metaKey)) return;
			const key = e.key.toLowerCase();
			// Ctrl+Shift+D：审查本会话的修改
			if (e.shiftKey) {
				if (!e.altKey && e.code === "KeyD" && s.activeProjectId) {
					e.preventDefault();
					s.setView("review");
				}
				return;
			}
			// Ctrl+Alt+B：右侧面板（用 code 判断，避免 Alt 在部分布局下改变 key）
			if (e.altKey) {
				if (e.code === "KeyB") {
					e.preventDefault();
					s.setRightPanel(s.rightPanel ? null : "session");
				}
				return;
			}
			if (key === "b") {
				e.preventDefault();
				s.toggleSidebar();
			} else if (key === "k") {
				e.preventDefault();
				s.setPalette(!s.palette.open);
			} else if (e.key === "`") {
				e.preventDefault();
				s.setTerminalPanel(!s.terminalPanel);
			} else if (key === "n") {
				e.preventDefault();
				if (s.activeProjectId) void s.newSession();
			} else if (key === "m") {
				e.preventDefault();
				if (s.activeProjectId) s.setView("settings", "custom");
			} else if (key === "o") {
				e.preventDefault();
				void s.importProjects();
			} else if (e.key === ",") {
				e.preventDefault();
				s.setView("settings");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<header className="relative flex h-11 shrink-0 items-center gap-3 border-b border-border bg-chrome px-4 select-none">
			<button
				type="button"
				title={`应用菜单：${MENUS.join(" / ")}`}
				onClick={(e) => {
					const rect = e.currentTarget.getBoundingClientRect();
					setOpen(open?.name === "root" ? null : { name: "root", x: rect.left, y: rect.bottom });
				}}
				className={`flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-panel-2 hover:text-fg ${
					open?.name === "root" ? "bg-panel-2 text-fg" : "text-muted"
				}`}
			>
				<Icon name="menu" className="size-4" />
			</button>

			{/*
			 * 可拖拽区只给标题左右两块空白：实测把 drag 放在整条 header 上时，
			 * 靠左的按钮即使计算样式是 no-drag，真实鼠标点击仍会被拖拽区吃掉（不进渲染进程）。
			 * 因此所有按钮一律不落在拖拽区里。
			 */}
			<div className="app-drag min-w-0 flex-1 self-stretch" />

			{/* 窗口标题：靠左右两块等宽拖拽区夹在中间 */}
			<button
				type="button"
				title="工作台"
				onClick={() => useApp.getState().setView(useApp.getState().projects.projects.length === 0 ? "welcome" : "chat")}
				className="flex max-w-[420px] min-w-0 shrink-0 items-center gap-1.5"
			>
				<span className="shrink-0 text-[13px] leading-none text-primary">✻</span>
				<Location />
			</button>

			<div className="app-drag min-w-0 flex-1 self-stretch" />

			<div className="flex items-center gap-0.5">
				<LayoutToggle
					icon="panel-left"
					label={`项目栏（${isMac ? "⌘B" : "Ctrl+B"}）`}
					on={sidebarOpen}
					onClick={() => useApp.getState().toggleSidebar()}
				/>
				<LayoutToggle
					icon="panel-bottom"
					label="终端 Ctrl+`"
					on={terminalPanel}
					onClick={() => useApp.getState().setTerminalPanel(!terminalPanel)}
				/>
				<LayoutToggle
					icon="globe"
					label="打开内置浏览器"
					on={rightPanel === "browser"}
					onClick={() => { useApp.getState().setView("chat"); useApp.getState().setRightPanel("browser"); }}
				/>
				<LayoutToggle
					icon="panel-right"
					label={`右侧面板（${isMac ? "⌘⌥B" : "Ctrl+Alt+B"}）`}
					on={rightPanel !== null}
					onClick={() => useApp.getState().setRightPanel(rightPanel ? null : "session")}
				/>
			</div>

			{/* Windows / Linux：系统风格的窗口按钮，贴右上角；macOS 用系统自带的红绿灯 */}
			{!isMac && (
				<div className="-mr-4 flex shrink-0 items-stretch self-stretch">
					<WindowButton icon="minus" title="最小化" onClick={() => void window.floworkWindow.minimize()} />
					<WindowButton icon="square" title="最大化" onClick={() => void window.floworkWindow.toggleMaximize()} />
					<WindowButton icon="x" title="关闭" close onClick={() => void window.floworkWindow.close()} />
				</div>
			)}

			{open &&
				(open.name === "root" ? (
					<Menu
						items={MENUS.map((m) => ({ label: m, onClick: () => setOpen({ name: m, x: open.x, y: open.y }) }))}
						position={{ x: open.x, y: open.y }}
						onClose={() => setOpen(null)}
					/>
				) : (
					<Menu items={menuItems(open.name)} position={{ x: open.x, y: open.y }} onClose={() => setOpen(null)} />
				))}
		</header>
	);
}
