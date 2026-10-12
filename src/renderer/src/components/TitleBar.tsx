/**
 * 窗口标题栏：品牌、当前位置、快速打开、布局开关。
 * 桌面版窗口无系统标题栏（titleBarStyle: hidden），这一条即拖拽区；
 * 右侧为 Windows 系统窗口按钮（titleBarOverlay）预留空间，macOS 左侧为红绿灯预留空间。
 * 网页版同样显示，只是没有窗口按钮。
 */
import { useEffect } from "react";
import { basename } from "../lib/format";
import { isDesktop, isMac } from "../lib/desktop";
import { projectName, useApp } from "../store";
import { Icon, type IconName } from "./Icon";
import { displayUserText } from "@shared/skill-text";

function ToggleButton({ icon, title, on, onClick }: { icon: IconName; title: string; on: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			className={`flex size-7 items-center justify-center rounded-md hover:bg-black/5 ${on ? "text-fg" : "text-faint hover:text-fg"}`}
		>
			<Icon name={icon} />
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
	const view = useApp((s) => s.view);
	const cwd = useApp((s) => s.cwd);
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const sidebarOpen = useApp((s) => s.sidebarOpen);
	const rightPanel = useApp((s) => s.rightPanel);
	const { toggleSidebar, setRightPanel, setQuickOpen } = useApp.getState();
	const showPanelToggle = view === "chat" && hasProject;

	// Ctrl+B 切换左侧项目栏
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
				e.preventDefault();
				useApp.getState().toggleSidebar();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<header
			className={`app-drag grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 bg-chrome text-[13px] select-none ${
				isDesktop && isMac ? "pl-[78px]" : "pl-3"
			}`}
			// 为 Windows 窗口按钮（Window Controls Overlay）留出空间；网页版下为 0
			style={{ paddingRight: "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))" }}
		>
			<div className="flex min-w-0 items-center gap-3">
				<span className="flex shrink-0 items-center gap-2">
					<span className="flex size-5 items-center justify-center rounded-[5px] bg-accent font-mono text-[11px] text-white">✻</span>
					<span className="font-semibold tracking-tight">FloWork</span>
				</span>
				<Location />
			</div>

			<button
				type="button"
				disabled={!cwd}
				onClick={() => setQuickOpen(true)}
				title={cwd ? `在 ${basename(cwd)} 中搜索文件` : "先打开一个项目"}
				className="flex h-7 w-[min(420px,36vw)] items-center gap-2 rounded-md bg-panel/70 px-2.5 text-muted hover:bg-panel disabled:opacity-50 disabled:hover:bg-panel/70"
			>
				<Icon
					name="search"
					className="size-3.5"
				/>
				<span className="flex-1 truncate text-left">搜索文件</span>
				<kbd className="font-mono text-[11px] text-faint">{isMac ? "⌘P" : "Ctrl P"}</kbd>
			</button>

			<div className="flex items-center justify-end gap-0.5 pr-2">
				<ToggleButton
					icon="panel-left"
					title={`项目栏（${isMac ? "⌘B" : "Ctrl+B"}）`}
					on={sidebarOpen}
					onClick={toggleSidebar}
				/>
				{showPanelToggle && (
					<ToggleButton
						icon="panel-right"
						title="文件与会话树面板"
						on={rightPanel !== null}
						onClick={() => setRightPanel(rightPanel ? null : "session")}
					/>
				)}
			</div>
		</header>
	);
}
