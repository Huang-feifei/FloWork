import { useEffect } from "react";
import { FolderPicker } from "./components/FolderPicker";
import { Notices } from "./components/Notices";
import { AuthDialog } from "./components/settings/AuthDialog";
import { SettingsView } from "./components/settings/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { DiscoverDialog } from "./components/sidebar/DiscoverDialog";
import { TerminalView } from "./components/terminal/TerminalView";
import { Button } from "./components/ui";
import { useApp } from "./store";

function EmptyState() {
	const { importProjects, setView, setDiscoverOpen } = useApp.getState();
	const hasProjects = useApp((s) => s.projects.projects.length > 0);
	return (
		<div className="flex flex-1 items-center justify-center p-8">
			<div className="w-full max-w-lg text-center">
				<div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-accent-soft font-mono text-xl text-accent">
					✻
				</div>
				<h1 className="mb-2 text-2xl font-semibold tracking-tight">{hasProjects ? "选择一个项目" : "导入你的第一个项目"}</h1>
				<p className="mb-6 text-muted">
					{hasProjects
						? "在左侧点击项目即可打开；多个项目可以同时运行任务。"
						: "导入项目文件夹，FloWork 会在其中运行 pi，读写代码、执行命令。可以一次导入多个。"}
				</p>
				<div className="flex justify-center gap-2">
					<Button variant="primary" onClick={() => void importProjects()}>
						导入文件夹
					</Button>
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

	useEffect(() => {
		void useApp.getState().init();
	}, []);

	return (
		<div className="flex h-full">
			<Sidebar />
			<main className="relative flex min-w-0 flex-1 flex-col">
				{view === "settings" ? <SettingsView /> : activeProjectId ? <TerminalView /> : <EmptyState />}
				<Notices />
			</main>
			<FolderPicker />
			<DiscoverDialog />
			<AuthDialog />
		</div>
	);
}
