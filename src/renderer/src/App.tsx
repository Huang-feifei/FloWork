import { useEffect } from "react";
import { useApp } from "./store";
import { FolderPicker } from "./components/FolderPicker";
import { Notices } from "./components/Notices";
import { AuthDialog } from "./components/settings/AuthDialog";
import { Button } from "./components/ui";
import { ActivityBar } from "./components/ActivityBar";
import { CommandPalette } from "./components/palette/CommandPalette";
import { PromptDialog } from "./components/PromptDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ReviewView } from "./components/review/ReviewView";
import { SettingsView } from "./components/settings/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { DiscoverDialog } from "./components/sidebar/DiscoverDialog";
import { RemoteProjectDialog } from "./components/sidebar/RemoteProjectDialog";
import { HostKeyDialog } from "./components/sidebar/HostKeyDialog";
import { StatusBar } from "./components/StatusBar";
import { BottomPanel } from "./components/terminal/BottomPanel";
import { TerminalView } from "./components/terminal/TerminalView";
import { TitleBar } from "./components/TitleBar";
import { WelcomeView } from "./components/welcome/WelcomeView";
import { RightPanel } from "./components/panels/RightPanel";

function EmptyState() {
	const { importProjects, setView, setDiscoverOpen, setRemoteOpen } = useApp.getState();
	const hasProjects = useApp((s) => s.projects.projects.length > 0);
	return (
		<div className="flex flex-1 items-center justify-center p-8">
			<div className="w-full max-w-lg text-center">
				<div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-accent-soft font-mono text-xl text-accent">✻</div>
				<h1 className="mb-2 text-2xl font-semibold tracking-tight">{hasProjects ? "选择一个项目" : "导入你的第一个项目"}</h1>
				<p className="mb-6 text-muted">
					{hasProjects
						? "在左侧点击项目即可打开；多个项目可以同时运行任务。"
						: "导入项目文件夹，FloWork 会在其中运行 pi，读写代码、执行命令。可以一次导入多个。"}
				</p>
				<div className="flex flex-wrap justify-center gap-2">
					<Button
						variant="primary"
						onClick={() => void importProjects()}
					>
						导入文件夹
					</Button>
					<Button onClick={() => setRemoteOpen(true)}>添加远程项目</Button>
					<Button onClick={() => setDiscoverOpen(true)}>从已有会话发现</Button>
					<Button onClick={() => setView("settings", "providers")}>配置模型</Button>
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

	useEffect(() => {
		void useApp.getState().init();
	}, []);

	return (
		<div className="relative h-full overflow-hidden font-sans text-[13px] text-fg antialiased">
			{/* 窗口背后的桌面：桌面版由系统材质（Acrylic / vibrancy）透出，网页版用这一层模拟 */}
			<div className="fw-wallpaper absolute inset-0" />

			{/* 整个窗口是一层模糊：各区域再用不同透明度叠出层次 */}
			<div className="relative flex h-full flex-col backdrop-blur-[40px] backdrop-saturate-150">
				<TitleBar />

				{view === "welcome" ? (
					<div className="min-h-0 flex-1">
						<WelcomeView />
					</div>
				) : (
					<>
						<div className="flex min-h-0 flex-1">
							<ActivityBar />
							{sidebarOpen && <Sidebar />}
							{/* 底部面板位于会话内容之下、状态栏之上，与设计稿的层次一致 */}
							<div className="flex min-w-0 flex-1 flex-col">
								<main className="relative flex min-h-0 flex-1 flex-col">
									{view === "settings" ? (
										<SettingsView />
									) : view === "review" ? (
										<ReviewView />
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
								<BottomPanel />
							</div>
						</div>
						<StatusBar />
					</>
				)}

				<FolderPicker />
				<DiscoverDialog />
				<RemoteProjectDialog />
				<HostKeyDialog />
				<AuthDialog />
				<PromptDialog />
				<ConfirmDialog />
				<CommandPalette />
			</div>
		</div>
	);
}
