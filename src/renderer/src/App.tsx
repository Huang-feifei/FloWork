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
import { DiscoverDialog } from "./components/sidebar/DiscoverDialog";
import { RemoteProjectDialog } from "./components/sidebar/RemoteProjectDialog";
import { HostKeyDialog } from "./components/sidebar/HostKeyDialog";
import { StatusBar } from "./components/StatusBar";
import { TerminalView } from "./components/terminal/TerminalView";
import { TitleBar } from "./components/TitleBar";
import { WelcomeView } from "./components/welcome/WelcomeView";
import { RightPanel } from "./components/panels/RightPanel";

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
		<div className="flex flex-1 items-center justify-center bg-bg p-8">
			<div className="w-full max-w-[560px] text-center">
				<div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-[20px] bg-primary-soft text-[26px] leading-none text-primary">✻</div>
				<h1 className="mb-3 text-[32px] font-semibold tracking-tight">{hasProjects ? "选择一个项目" : "导入你的第一个项目"}</h1>
				<p className="mb-8 text-[17px] leading-relaxed text-muted">
					{hasProjects
						? "在左侧点击项目即可打开；多个项目可以同时运行任务。"
						: "导入项目文件夹，FloWork 会在其中运行 pi，读写代码、执行命令。可以一次导入多个。"}
				</p>
				<div className="flex flex-wrap justify-center gap-3">
					<Button
						variant="primary"
						onClick={() => void importProjects()}
					>
						导入文件夹
					</Button>
					<Button onClick={() => setRemoteOpen(true)}>添加远程项目</Button>
					<Button onClick={() => setDiscoverOpen(true)}>从已有会话发现</Button>
					<Button onClick={() => setView("settings", "custom")}>配置模型</Button>
				</div>
			</div>
		</div>
	);
}

export function App() {
	const view = useApp((s) => s.view);
	const activeProjectId = useApp((s) => s.activeProjectId);
	const sidebarOpen = useApp((s) => s.sidebarOpen);
	const rightPanel = useApp((s) => s.rightPanel);
	const terminalPanelOpen = useApp((s) => s.terminalPanel);
	const [databaseOpened, setDatabaseOpened] = useState(view === "database");
	useEffect(() => { if (view === "database") setDatabaseOpened(true); }, [view]);

	useEffect(() => {
		void useApp.getState().init();
	}, []);

	return (
		<div className="relative h-full overflow-hidden font-sans text-[13px] text-fg antialiased">
			{/* 窗口背景，与系统材质和截图保持一致 */}
			<div className="fw-wallpaper absolute inset-0" />

			{/* 整个窗口一层毛玻璃（见 .fw-shell）：各区域再用不同透明度叠出层次；图片模式下关掉，否则壁纸会被糊成色斑 */}
			<div className="fw-shell relative flex h-full flex-col">
				<TitleBar />

				{view === "welcome" ? (
					<div className="min-h-0 flex-1">
						<WelcomeView />
					</div>
				) : (
					<>
						<div className="flex min-h-0 flex-1">
							<ActivityBar />
							{sidebarOpen && view !== "database" && <Sidebar />}
							{/* 底部面板位于会话内容之下、状态栏之上，与设计稿的层次一致 */}
							<div className="flex min-w-0 flex-1 flex-col">
								<main className="relative flex min-h-0 flex-1 flex-col">
									{(databaseOpened || view === "database") && (
										<div className={view === "database" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
											<Suspense fallback={<ViewFallback />}>
												<DatabaseView />
											</Suspense>
										</div>
									)}
									{view === "settings" ? (
										<Suspense fallback={<ViewFallback />}>
											<SettingsView />
										</Suspense>
									) : view === "database" ? (
										null
									) : view === "imagegen" ? (
										<Suspense fallback={<ViewFallback />}>
											<ImageStudio />
										</Suspense>
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
									<Notices />
								</main>
								<BottomPanelSlot open={terminalPanelOpen} />
							</div>
						</div>
						<StatusBar />
					</>
				)}

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
