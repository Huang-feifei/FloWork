/**
 * 命令面板（Ctrl+K）：一个输入框同时搜文件、会话与命令。
 *   proj…   搜文件（模糊匹配，Alt+Enter 把路径引用到输入框）
 *   > cmd   只搜命令
 *   # sess  只搜会话
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFileSearch } from "../../lib/useFileSearch";
import { useBrowserOcclusion } from "../../lib/browser";
import { relativeTime } from "../../lib/format";
import { projectName, useApp } from "../../store";
import { Icon, type IconName } from "../Icon";

interface Item {
	icon: IconName;
	label: string;
	hint?: string;
	key?: string;
	/** 标签中需要高亮的部分（按前缀匹配的字符） */
	highlight?: string;
	run: (alt: boolean) => void;
}

interface Group {
	title: string;
	items: Item[];
}

export function CommandPalette() {
	const open = useApp((s) => s.palette.open);
	useBrowserOcclusion(open);
	const mode = useApp((s) => s.palette.mode);
	const cwd = useApp((s) => s.cwd);
	const projects = useApp((s) => s.projects.projects);
	const projectSessions = useApp((s) => s.projectSessions);
	const foldProcess = useApp((s) => s.foldProcess);
	const [text, setText] = useState("");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	// 面板打开时清空查询
	useEffect(() => {
		if (open) {
			setText("");
			setActive(0);
		}
	}, [open]);

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	// 前缀决定搜索范围：# 会话、> 命令，其余情况三类都搜
	const prefix = text.slice(0, 1);
	const query = (prefix === ">" || prefix === "#" ? text.slice(1) : text).trim();
	const search = useMemo(() => {
		if (prefix === ">") return "commands" as const;
		if (prefix === "#") return "sessions" as const;
		return mode === "commands" ? ("commands" as const) : ("all" as const);
	}, [prefix, mode]);

	const { result } = useFileSearch(search === "all" ? query : "", 12);

	const groups = useMemo<Group[]>(() => {
		const s = useApp.getState();
		const q = query.toLowerCase();
		const hit = (text: string) => !q || text.toLowerCase().includes(q);

		const commands: Item[] = (
			[
				{ icon: "square-pen", label: "新建会话", key: "Ctrl+N", when: s.activeProjectId !== null, run: () => void s.newSession() },
				{ icon: "git-compare", label: "审查本会话的修改", key: "Ctrl+Shift+D", when: s.activeProjectId !== null, run: () => s.setView("review") },
				{ icon: "folder-plus", label: "导入项目文件夹…", key: "Ctrl+O", when: true, run: () => void s.importProjects() },
				{ icon: "server", label: "添加远程项目（SSH）…", when: true, run: () => s.setRemoteOpen(true) },
				{ icon: "search", label: "快速打开文件…", key: "Ctrl+P", when: s.activeProjectId !== null, run: () => s.setQuickOpen(true) },
				{ icon: "cpu", label: "切换模型…", key: "Ctrl+M", when: s.activeProjectId !== null, run: () => s.setView("settings", "providers") },
				{ icon: "square-terminal", label: "切换终端面板", key: "Ctrl+`", when: true, run: () => s.setTerminalPanel(!s.terminalPanel) },
				{ icon: "database", label: "打开数据库工作台", when: true, run: () => s.setView("database") },
				{ icon: "settings", label: "打开设置", when: true, run: () => s.setView("settings") },
				{ icon: "messages", label: "回到会话", when: true, run: () => s.setView("chat") },
				{ icon: "globe", label: "打开内置浏览器", when: true, run: () => { s.setView("chat"); s.setRightPanel("browser"); } },
				{ icon: "files", label: "显示项目文件", when: true, run: () => s.setRightPanel("files") },
				{ icon: "panel-right", label: "切换右侧面板", key: "Ctrl+Alt+B", when: true, run: () => s.setRightPanel(s.rightPanel ? null : "session") },
				{ icon: "list-tree", label: "切换会话树轨道", when: true, run: () => s.toggleRail() },
				{ icon: "message-square", label: "查看更新内容", when: true, run: () => s.setUpdatedTo(s.info?.version ?? null) },
				{
					icon: "folder-open",
					label: "打开服务器目录",
					when: !!s.projects.projects.find((p) => p.id === s.activeProjectId)?.hostId,
					run: () => s.setRightPanel("server"),
				},
				{
					icon: foldProcess ? "chevron-down" : "chevron-right",
					label: foldProcess ? "展开思考与工具调用" : "折叠思考与工具调用",
					when: s.activeProjectId !== null,
					run: () => s.toggleFoldProcess(),
				},
				{
					icon: "chevron-up",
					label: "折叠全部会话",
					when: projects.length > 0,
					run: () => {
						const { toggleExpanded, expanded } = useApp.getState();
						for (const p of projects) if (expanded[p.id]) toggleExpanded(p.id, false);
					},
				},
			] as Array<Omit<Item, "run"> & { when: boolean; run: () => void }>
		)
			.filter((c) => c.when && hit(c.label))
			.map((c) => ({ ...c, run: () => c.run() }));

		const sessions: Item[] = projects
			.flatMap((p) => (projectSessions[p.id] ?? []).map((session) => ({ p, session })))
			.filter(({ session }) => hit(session.name || session.firstMessage))
			.slice(0, 10)
			.map(({ p, session }) => ({
				icon: "message-square" as const,
				label: session.name || session.firstMessage || "（空会话）",
				hint: `${projectName(p)} · ${relativeTime(session.modified)}`,
				run: () => void useApp.getState().openProject(p.id, session.path),
			}));

		const files: Item[] = (result?.matches ?? []).map((m) => ({
			icon: "file-code" as const,
			label: m.path.split("/").pop() ?? m.path,
			hint: m.path.slice(0, m.path.lastIndexOf("/")),
			highlight: query,
			run: (alt: boolean) => (alt ? useApp.getState().insertIntoPrompt(m.path) : useApp.getState().openPreview(m.path)),
		}));

		const out: Group[] = [];
		if (search !== "sessions" && (search === "commands" || sessions.length === 0 || query.length === 0 || files.length === 0) && commands.length > 0)
			out.push({ title: "命令", items: commands });
		if (search !== "commands" && sessions.length > 0) out.push({ title: "会话", items: sessions });
		if (search !== "commands" && files.length > 0) out.push({ title: "文件", items: files });
		return out;
	}, [query, search, projects, projectSessions, result, foldProcess]);

	const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
	const current = Math.min(active, Math.max(0, flat.length - 1));

	useEffect(() => setActive(0), [text]);

	if (!open) return null;

	const close = () => useApp.getState().setPalette(false);
	const choose = (item: Item, alt = false) => {
		close();
		item.run(alt);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 点击遮罩关闭
		<div
			className="fixed inset-0 z-50 bg-scrim"
			onMouseDown={close}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: 阻止冒泡到遮罩 */}
			<div
				className="fw-float absolute top-2 left-1/2 w-[640px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-[22px]"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
					<span className="text-[15px] leading-none text-primary">›</span>
					<input
						ref={inputRef}
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								close();
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								setActive((a) => Math.min(a + 1, flat.length - 1));
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setActive((a) => Math.max(a - 1, 0));
							} else if (e.key === "Enter" && flat[current]) {
								e.preventDefault();
								choose(flat[current], e.altKey);
							}
						}}
						placeholder="搜索文件、会话、命令；> 命令，# 会话"
						className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
					/>
					<span className="text-[11px] text-faint">{flat.length} 项</span>
				</div>

				<div className="max-h-[480px] overflow-y-auto py-1">
					{flat.length === 0 && <div className="px-3 py-2 text-[13px] text-faint">{query ? "没有匹配项" : "输入关键词开始搜索"}</div>}
					{groups.map((g) => (
						<div key={g.title}>
							<div className="flex h-7 items-end px-4 pb-1 text-[11.5px] font-semibold text-faint">{g.title}</div>
							{g.items.map((it) => {
								const i = flat.indexOf(it);
								const on = i === current;
								return (
									<button
										type="button"
										key={`${g.title}-${it.label}-${it.hint ?? ""}`}
										onMouseEnter={() => setActive(i)}
										onClick={(e) => choose(it, e.altKey)}
										className={`relative flex h-9 w-full items-center gap-2.5 rounded-[10px] px-4 text-left ${on ? "bg-primary-soft" : "hover:bg-panel-2"}`}
									>
										<Icon
											name={it.icon}
											className={`size-4 ${on ? "text-primary" : "text-faint"}`}
										/>
										<span className={`min-w-0 truncate text-[13.5px] ${on ? "font-medium text-primary" : ""}`}>{it.label}</span>
										{it.hint && <span className="min-w-0 truncate font-mono text-[11.5px] text-faint">{it.hint}</span>}
										{it.key && <span className="ml-auto font-mono text-[11px] text-faint">{it.key}</span>}
										{on && !it.key && <span className="ml-auto font-mono text-[11px] text-primary">↵ 打开</span>}
									</button>
								);
							})}
						</div>
					))}
				</div>

				<div className="flex h-8 items-center gap-4 border-t border-border px-4 font-mono text-[11px] text-faint">
					<span>↑↓ 选择</span>
					<span>↵ 打开</span>
					<span>alt+↵ 引用到输入框</span>
					<span className="ml-auto">&gt; 命令 · # 会话</span>
				</div>
			</div>
		</div>
	);
}
