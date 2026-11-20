import { lazy, Suspense, useEffect, useState } from "react";
import { useApp } from "./store";
import { Notices } from "./components/Notices";
import { AuthDialog } from "./components/settings/AuthDialog";
import { Button } from "./components/ui";
import { ActivityBar } from "./components/ActivityBar";
import { CommandPalette } from "./components/palette/CommandPalette";
import { PromptDialog } from "./components/PromptDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Sidebar } from "./components/Sidebar";
import { UpdateDialog } from "./components/UpdateDialog";
import { AppUpdateNotice } from "./components/AppUpdateNotice";
import { DiscoverDialog } from "./components/sidebar/DiscoverDialog";
import { RemoteProjectDialog } from "./components/sidebar/RemoteProjectDialog";
import { HostKeyDialog } from "./components/sidebar/HostKeyDialog";
import { StatusBar } from "./components/StatusBar";
import { TerminalView } from "./components/terminal/TerminalView";
import { TitleBar } from "./components/TitleBar";
import { WelcomeView } from "./components/welcome/WelcomeView";
import { RightPanel } from "./components/panels/RightPanel";
import { WorkbenchEmpty } from "./components/PageHeading";

// 设置、数据库、图片和评审不是首屏必需内容，按需加载，避免把它们的依赖带进启动 chunk。
const SettingsView = lazy(() => import("./components/settings/SettingsView").then((m) => ({ default: m.SettingsView })));
const DatabaseView = lazy(() => import("./components/database/DatabaseView").then((m) => ({ default: m.DatabaseView })));
const ImageStudio = lazy(() => import("./components/imagegen/ImageStudio").then((m) => ({ default: m.ImageStudio })));
const ImageLibrary = lazy(() => import("./components/imagegen/ImageLibrary").then((m) => ({ default: m.ImageLibrary })));
const ReviewView = lazy(() => import("./components/review/ReviewView").then((m) => ({ default: m.ReviewView })));
const BottomPanel = lazy(() => import("./components/terminal/BottomPanel").then((m) => ({ default: m.BottomPanel })));

function ViewFallback() {
	return <div className="flex min-h-0 flex-1 items-center justify-center bg-bg text-[13px] text-faint">加载中…</div>;
}

function BottomPanelSlot({ open }: { open: boolean }) {
	if (!open) return null;
	return (
		<Suspense fallback={<div className="flex h-[280px] shrink-0 items-center justify-center border-t border-border bg-bg text-[13px] text-faint">加载中…</div>}>
			<BottomPanel />
		</Suspense>
	);
}

function EmptyState() {
	const { importProjects, setView, setDiscoverOpen, setRemoteOpen } = useApp.getState();
	const hasProjects = useApp((s) => s.projects.projects.length > 0);
	return (
		<WorkbenchEmpty
			icon="folder-open"
			title={hasProjects ? "从一个项目开始" : "导入你的第一个项目"}
			detail={hasProjects ? "从项目栏打开已有项目，或导入新的工作目录。" : "选择一个本地文件夹，把代码、会话和修改记录放进同一个工作台。"}
			actions={<>
				<Button variant="primary" onClick={() => void importProjects()}>导入文件夹</Button>
				<Button onClick={() => setRemoteOpen(true)}>添加远程项目</Button>
				<Button variant="ghost" onClick={() => setDiscoverOpen(true)}>发现已有项目</Button>
				<Button variant="ghost" onClick={() => setView("settings", "custom")}>配置模型</Button>
			</>}
		/>
	);
}

export function App() {
	const view = useApp((s) => s.view);
	const activeProjectId = useApp((s) => s.activeProjectId);
	const sidebarOpen = useApp((s) => s.sidebarOpen);
	const rightPanel = useApp((s) => s.rightPanel);
	const terminalPanelOpen = useApp((s) => s.terminalPanel);
	const [databaseOpened, setDatabaseOpened] = useState(view === "database");
	const [studioOpened, setStudioOpened] = useState(view === "imagegen");
	const hasWorkspaceSidebar = view !== "settings" && view !== "database" && view !== "imagegen";
	useEffect(() => {
		if (view === "database") setDatabaseOpened(true);
		if (view === "imagegen") setStudioOpened(true);
	}, [view]);

	useEffect(() => {
		void useApp.getState().init();
	}, []);

	return (
		<div className="relative h-full overflow-hidden font-sans text-[13px] text-fg antialiased">
			{/* 窗口背景，与系统材质和截图保持一致 */}
			<div className="fw-wallpaper absolute inset-0" />

			<div className="fw-shell fw-workbench relative flex h-full flex-col">
				<TitleBar />

				{view === "welcome" ? (
					<div className="fw-welcome-frame min-h-0 flex-1">
						<WelcomeView />
						<AppUpdateNotice welcome />
					</div>
				) : (
					<>
						<div className="fw-workspace-frame flex min-h-0 flex-1">
							<ActivityBar />
							{sidebarOpen && hasWorkspaceSidebar && <Sidebar />}
							<div className="fw-workspace-body flex min-w-0 flex-1 flex-col">
								<main className="relative flex min-h-0 flex-1 flex-col" data-view={view}>
									{(databaseOpened || view === "database") && (
										<div className={view === "database" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
											<Suspense fallback={<ViewFallback />}>
												<DatabaseView />
											</Suspense>
										</div>
									)}
									{(studioOpened || view === "imagegen") && (
										<div className={view === "imagegen" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
											<Suspense fallback={<ViewFallback />}>
												<ImageStudio active={view === "imagegen"} />
											</Suspense>
										</div>
									)}
									{view === "settings" ? (
										<Suspense fallback={<ViewFallback />}>
											<SettingsView />
										</Suspense>
									) : view === "database" || view === "imagegen" ? (
										null
									) : view === "gallery" ? (
										<Suspense fallback={<ViewFallback />}>
											<ImageLibrary />
										</Suspense>
									) : view === "review" ? (
										<Suspense fallback={<ViewFallback />}>
											<ReviewView />
										</Suspense>
									) : activeProjectId ? (
										// 远程项目同样是对话区：AI 的工具通过 SSH 在服务器上执行（运维会话）
										<TerminalView />
									) : (
										<div className="flex min-h-0 flex-1">
											<div className="flex min-w-0 flex-1"><EmptyState /></div>
											{rightPanel === "browser" && <RightPanel />}
										</div>
									)}
								</main>
								<BottomPanelSlot open={terminalPanelOpen} />
							</div>
						</div>
						<StatusBar />
					</>
				)}

				<Notices />
				<DiscoverDialog />
				<RemoteProjectDialog />
				<HostKeyDialog />
				<AuthDialog />
				<PromptDialog />
				<UpdateDialog />
				<ConfirmDialog />
				<CommandPalette />
			</div>
		</div>
	);
}
