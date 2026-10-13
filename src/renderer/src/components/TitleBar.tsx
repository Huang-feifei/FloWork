/**
 * 自绘窗口标题栏（桌面版 titleBarStyle: hidden）：
 * 品牌、应用菜单、命令搜索、布局开关，Windows / Linux 上还有自绘的窗口按钮。整条栏为拖拽区。
 */
import { useEffect, useState } from "react";
import { displayUserText } from "@shared/skill-text";
import { isDesktop, isMac } from "../lib/desktop";
import { projectName, useApp } from "../store";
import { Icon, type IconName } from "./Icon";
import { Menu, type MenuItem } from "./sidebar/Menu";

const MENUS = ["文件", "编辑", "视图", "会话", "终端", "帮助"] as const;
type MenuName = (typeof MENUS)[number];

function LayoutToggle({ icon, label, on, onClick }: { icon: IconName; label: string; on: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			title={label}
			onClick={onClick}
			className={`flex size-6 items-center justify-center rounded hover:bg-panel-2 ${on ? "text-fg" : "text-faint hover:text-fg"}`}
		>
			<Icon
				name={icon}
				className="size-3.5"
			/>
		</button>
	);
}

function WindowButton({ icon, title, close, onClick }: { icon: IconName; title: string; close?: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			className={`flex w-[46px] items-center justify-center text-muted hover:text-fg ${close ? "hover:bg-win-close hover:text-white" : "hover:bg-panel-2"}`}
		>
			<Icon
				name={icon}
				className={icon === "square" ? "size-3" : "size-4"}
			/>
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

	if (view === "settings") return <span className="truncate text-muted">设置</span>;
	if (view === "review") return <span className="truncate text-muted">审查本会话的修改</span>;
	if (!projectTitle) return null;
	return (
		<span className="flex min-w-0 items-center gap-1.5 text-muted">
			<span className="shrink-0 text-fg/80">{projectTitle}</span>
			<span className="text-faint">/</span>
			<span className="truncate">{sessionTitle || "新会话"}</span>
		</span>
	);
}

export function TitleBar() {
	const sidebarOpen = useApp((s) => s.sidebarOpen);
	const rightPanel = useApp((s) => s.rightPanel);
	const terminalPanel = useApp((s) => s.terminalPanel);
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const [open, setOpen] = useState<{ name: MenuName; x: number; y: number } | null>(null);

	const menuItems = (name: MenuName): MenuItem[] => {
		const s = useApp.getState();
		switch (name) {
			case "文件":
				return [
					{ label: "导入项目文件夹…", hint: isMac ? "⌘O" : "Ctrl+O", onClick: () => void s.importProjects() },
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
					{ label: rightPanel ? "收起右侧面板" : "显示右侧面板", onClick: () => s.setRightPanel(rightPanel ? null : "session") },
					{ label: terminalPanel ? "收起终端" : "显示终端", hint: "Ctrl+`", onClick: () => s.setTerminalPanel(!terminalPanel) },
				];
			case "会话":
				return [
					{ label: "新建会话", hint: isMac ? "⌘N" : "Ctrl+N", disabled: !hasProject, onClick: () => void s.newSession() },
					{ separator: true, label: "" },
					{ label: "审查本会话的修改", disabled: !hasProject, onClick: () => s.setView("review") },
					{ label: "会话树", disabled: !hasProject, onClick: () => s.setRightPanel("tree") },
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
					{ label: "环境自检与发现项目…", onClick: () => s.setView("welcome") },
				];
		}
	};

	// 全局快捷键：Ctrl+B 项目栏、Ctrl+K 命令面板、Ctrl+` 终端、Ctrl+N 新会话，Esc 关闭面板
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const s = useApp.getState();
			if (e.key === "Escape" && s.palette.open) {
				s.setPalette(false);
				return;
			}
			if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
			const key = e.key.toLowerCase();
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
		<header className="app-drag relative flex h-9 shrink-0 items-center border-b border-border bg-chrome pl-3 font-mono text-[12px] select-none">
			<button
				type="button"
				onClick={() => useApp.getState().setView(useApp.getState().projects.projects.length === 0 ? "welcome" : "chat")}
				title="工作台"
				className="flex items-center gap-1.5 pr-4"
			>
				<span className="text-[15px] leading-none text-accent">✻</span>
				<span className="font-semibold text-fg">flowork</span>
			</button>

			<nav className="flex items-center">
				{MENUS.map((m) => (
					<button
						type="button"
						key={m}
						onClick={(e) => {
							const rect = e.currentTarget.getBoundingClientRect();
							setOpen(open?.name === m ? null : { name: m, x: rect.left, y: rect.bottom });
						}}
						className={`rounded px-2 py-0.5 font-sans text-[12.5px] hover:bg-panel-2 hover:text-fg ${open?.name === m ? "bg-panel-2 text-fg" : "text-muted"}`}
					>
						{m}
					</button>
				))}
			</nav>

			<div className="flex flex-1 justify-center px-6">
				<button
					type="button"
					onClick={() => useApp.getState().setPalette(true)}
					title="搜索文件、会话、命令"
					className="flex h-6 w-[min(460px,40vw)] items-center gap-2 rounded border border-border bg-panel px-2 text-muted hover:border-border-strong"
				>
					<Icon
						name="search"
						className="size-3.5 text-faint"
					/>
					<span className="flex-1 truncate text-left">FloWork — 搜索文件、会话、命令</span>
					<span className="text-[11px] text-faint">{isMac ? "⌘K" : "Ctrl+K"}</span>
				</button>
			</div>

			<div className="flex items-center gap-0.5 pr-2">
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
					icon="panel-right"
					label="右侧面板 Ctrl+Alt+B"
					on={rightPanel !== null}
					onClick={() => useApp.getState().setRightPanel(rightPanel ? null : "session")}
				/>
			</div>

			{isDesktop && !isMac && (
				<div className="flex h-full items-stretch">
					<WindowButton
						icon="minus"
						title="最小化"
						onClick={() => void window.floworkWindow?.minimize()}
					/>
					<WindowButton
						icon="square"
						title="最大化"
						onClick={() => void window.floworkWindow?.toggleMaximize()}
					/>
					<WindowButton
						icon="x"
						title="关闭"
						close
						onClick={() => void window.floworkWindow?.close()}
					/>
				</div>
			)}

			{open && (
				<Menu
					items={menuItems(open.name)}
					position={{ x: open.x, y: open.y }}
					onClose={() => setOpen(null)}
				/>
			)}
		</header>
	);
}
