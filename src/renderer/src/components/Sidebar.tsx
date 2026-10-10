import { basename, relativeTime } from "../lib/format";
import { useApp } from "../store";

export function Sidebar() {
	const cwd = useApp((s) => s.cwd);
	const sessions = useApp((s) => s.sessions);
	const activeFile = useApp((s) => s.state?.sessionFile);
	const view = useApp((s) => s.view);
	const info = useApp((s) => s.info);
	const connection = useApp((s) => s.connection);
	const { openFolderPicker, newSession, switchSession, setView } = useApp.getState();

	return (
		<aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
			<div className="flex items-center gap-2 px-4 pt-4 pb-4">
				<span className="flex size-6 items-center justify-center rounded-md bg-accent font-mono text-xs text-white">✻</span>
				<span className="text-[15px] font-semibold tracking-tight">FloWork</span>
				{info && <span className="text-[11px] text-muted">{info.shell === "web" ? "网页版" : "桌面版"}</span>}
				<div className="flex-1" />
				{connection !== "open" && (
					<span className="flex items-center gap-1 text-[11px] text-warn">
						<span className="size-1.5 rounded-full bg-warn" />
						{connection === "connecting" ? "连接中" : "已断开"}
					</span>
				)}
			</div>

			<div className="px-3">
				<button
					type="button"
					onClick={() => void openFolderPicker()}
					title={cwd ?? "选择工作区"}
					className="group flex w-full items-center gap-2.5 rounded-lg border border-border bg-panel px-3 py-2 text-left shadow-[0_1px_1px_rgba(0,0,0,0.03)] hover:border-border-strong"
				>
					<span className="text-muted">⌂</span>
					<div className="min-w-0 flex-1">
						<div className="truncate text-[13px] font-medium">{cwd ? basename(cwd) : "选择工作区"}</div>
						{cwd && <div className="truncate text-[11px] text-muted">{cwd}</div>}
					</div>
					<span className="text-xs text-muted group-hover:text-fg">⇅</span>
				</button>

				<button
					type="button"
					disabled={!cwd}
					onClick={() => void newSession()}
					className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-fg hover:bg-panel-2 disabled:opacity-40"
				>
					<span className="text-base leading-none text-accent">+</span> 新会话
				</button>
			</div>

			<div className="mt-3 px-5 pb-1 text-[11px] font-medium tracking-wide text-muted">最近会话</div>
			<nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
				{sessions.length === 0 && <div className="px-2 py-2 text-xs text-muted">{cwd ? "还没有会话" : "先选择工作区"}</div>}
				{sessions.map((s) => {
					const active = s.path === activeFile && view === "chat";
					return (
						<button
							type="button"
							key={s.path}
							onClick={() => void switchSession(s.path)}
							className={`mb-0.5 block w-full rounded-lg px-3 py-1.5 text-left ${
								active ? "bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.05)]" : "hover:bg-panel-2"
							}`}
						>
							<div className={`truncate text-[13px] ${active ? "font-medium" : ""}`}>
								{s.name || s.firstMessage || "（空会话）"}
							</div>
							<div className="text-[11px] text-muted">
								{relativeTime(s.modified)} · {s.messageCount} 条
							</div>
						</button>
					);
				})}
			</nav>

			<div className="border-t border-border p-3">
				<button
					type="button"
					onClick={() => setView(view === "settings" ? "chat" : "settings")}
					className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] ${
						view === "settings" ? "bg-panel font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)]" : "hover:bg-panel-2"
					}`}
				>
					<span className="text-muted">⚙</span> 设置
				</button>
			</div>
		</aside>
	);
}
