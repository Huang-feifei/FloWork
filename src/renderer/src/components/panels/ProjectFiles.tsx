/** 项目文件：工作区目录树，按目录懒加载；.gitignore 命中的条目置灰 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceEntry } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { collectSessionFiles } from "../../lib/session-files";
import { useFileSearch } from "../../lib/useFileSearch";
import { SearchResultLabel } from "./SearchResultRow";
import { useApp } from "../../store";
import { askConfirm } from "../ConfirmDialog";
import { askText } from "../PromptDialog";
import { Menu, type MenuItem } from "../sidebar/Menu";

function formatSize(n: number | undefined): string {
	if (n === undefined) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectFiles() {
	const cwd = useApp((s) => s.cwd);
	const filesVersion = useApp((s) => s.filesVersion);
	const messages = useApp((s) => s.messages);
	const preview = useApp((s) => s.preview);
	const { openPreview, refreshFiles, insertIntoPrompt } = useApp.getState();
	const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
	const [error, setError] = useState<string | null>(null);
	const [showIgnored, setShowIgnored] = useState(false);
	const [filter, setFilter] = useState("");
	const search = useFileSearch(filter);
	const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry | null } | null>(null);
	const isDesktop = useApp((s) => s.info?.shell === "electron");
	const isRemote = useApp((s) => !!s.projects.projects.find((p) => p.id === s.activeProjectId)?.hostId);
	const { pushNotice } = useApp.getState();

	// ----- 文件操作（右键菜单） -----

	const createEntry = async (dir: string, type: "file" | "dir") => {
		if (!cwd) return;
		const name = (
			await askText({
				title: type === "file" ? "新建文件" : "新建文件夹",
				placeholder: type === "file" ? "文件名，例如 index.ts" : "文件夹名",
			})
		)?.trim();
		if (!name) return;
		const path = dir ? `${dir}/${name}` : name;
		try {
			await api.createWorkspaceEntry(cwd, path, type);
			if (dir) setExpanded((prev) => new Set(prev).add(dir));
			refreshFiles();
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const renameEntry = async (entry: WorkspaceEntry) => {
		if (!cwd) return;
		const name = (await askText({ title: "重命名", defaultValue: entry.name }))?.trim();
		if (!name || name === entry.name) return;
		try {
			await api.renameWorkspaceEntry(cwd, entry.path, name);
			refreshFiles();
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const moveEntry = async (entry: WorkspaceEntry) => {
		if (!cwd) return;
		const target = await askText({
			title: `移动「${entry.name}」到目录`,
			placeholder: "工作区内的相对路径，留空表示根目录",
			allowEmpty: true,
		});
		if (target === null) return;
		try {
			const result = await api.moveWorkspaceEntry(cwd, entry.path, target.trim());
			pushNotice("info", `已移动到 ${result.path}`);
			refreshFiles();
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const removeEntry = async (entry: WorkspaceEntry) => {
		if (!cwd) return;
		const ok = await askConfirm({
			title: "删除",
			message: `删除${entry.type === "dir" ? "文件夹" : "文件"}「${entry.name}」？\n${
				isRemote ? "这是远程文件，删除后无法恢复。" : isDesktop ? "会移入系统回收站，可从回收站恢复。" : "此操作不可恢复。"
			}`,
			confirmLabel: "删除",
			danger: true,
		});
		if (!ok) return;
		try {
			const result = await api.deleteWorkspaceEntry(cwd, entry.path);
			pushNotice("info", result.trashed ? `已移入回收站：${entry.path}` : `已删除：${entry.path}`);
			refreshFiles();
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const copyPath = (path: string, absolute: boolean) => {
		const text = absolute && cwd ? `${cwd}/${path}` : path;
		void navigator.clipboard.writeText(text).then(
			() => pushNotice("info", `已复制：${text}`),
			() => pushNotice("error", "复制失败"),
		);
	};

	const runShell = async (action: (root: string, path: string) => Promise<unknown>, path: string, label: string) => {
		if (!cwd) return;
		try {
			await action(cwd, path);
		} catch (e) {
			pushNotice("error", `${label}失败：${errorText(e)}`);
		}
	};

	/** 本会话修改过的文件，在树中标注 */
	const changed = useMemo(() => {
		const map = new Map<string, "created" | "modified">();
		for (const f of collectSessionFiles(messages, cwd)) {
			if (f.changes.some((c) => !c.isError)) map.set(f.path.toLowerCase(), f.created ? "created" : "modified");
		}
		return map;
	}, [messages, cwd]);

	const load = useCallback(
		async (dir: string) => {
			if (!cwd) return;
			try {
				const listing = await api.listWorkspace(cwd, dir || undefined);
				setChildren((prev) => ({ ...prev, [dir]: listing.entries }));
				setError(null);
			} catch (e) {
				setError(errorText(e));
			}
		},
		[cwd],
	);

	// 工作区切换时重置
	useEffect(() => {
		setChildren({});
		setExpanded(new Set([""]));
	}, [cwd]);

	// 文件可能变化时，重新加载所有已展开的目录
	// biome-ignore lint/correctness/useExhaustiveDependencies: filesVersion 只用于触发刷新
	useEffect(() => {
		for (const dir of expanded) void load(dir);
	}, [filesVersion, load]);

	const toggle = (dir: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(dir)) next.delete(dir);
			else {
				next.add(dir);
				if (!children[dir]) void load(dir);
			}
			return next;
		});
	};

	const renderDir = (dir: string, depth: number): React.ReactNode => {
		const entries = (children[dir] ?? []).filter((e) => showIgnored || !e.ignored);
		return entries.map((entry) => {
			const isOpen = expanded.has(entry.path);
			const mark = changed.get(entry.path.toLowerCase());
			const active = preview === entry.path;
			return (
				<div key={entry.path}>
					<div
						onContextMenu={(e) => {
							e.preventDefault();
							setMenu({ x: e.clientX, y: e.clientY, entry });
						}}
						className={`group flex items-center gap-1 py-[3px] pr-2 ${active ? "bg-accent-soft" : "hover:bg-panel-2"} ${
							entry.ignored ? "text-muted/70" : ""
						}`}
						style={{ paddingLeft: 8 + depth * 14 }}
					>
						<button
							type="button"
							onClick={() => (entry.type === "dir" ? toggle(entry.path) : openPreview(entry.path))}
							className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
							title={entry.path}
						>
							<span className="w-3 shrink-0 text-center text-[10px] text-muted">
								{entry.type === "dir" ? (isOpen ? "▾" : "▸") : ""}
							</span>
							<span className="shrink-0 text-[12px]">{entry.type === "dir" ? (isOpen ? "📂" : "📁") : "📄"}</span>
							<span className={`truncate ${mark ? (mark === "created" ? "text-ok" : "text-warn") : ""}`}>{entry.name}</span>
							{mark && (
								<span className={`shrink-0 text-[10px] font-bold ${mark === "created" ? "text-ok" : "text-warn"}`}>
									{mark === "created" ? "A" : "M"}
								</span>
							)}
						</button>
						<span className="shrink-0 text-[10px] text-muted group-hover:hidden">
							{entry.type === "file" ? formatSize(entry.size) : ""}
						</span>
						<button
							type="button"
							onClick={() => insertIntoPrompt(entry.path)}
							title="把路径引用到输入框"
							className="hidden shrink-0 rounded px-1 text-[11px] text-accent hover:bg-accent-soft group-hover:block"
						>
							引用
						</button>
					</div>
					{entry.type === "dir" && isOpen && (
						<div>
							{children[entry.path] === undefined ? (
								<div className="py-0.5 text-muted" style={{ paddingLeft: 28 + depth * 14 }}>
									加载中…
								</div>
							) : (
								renderDir(entry.path, depth + 1)
							)}
						</div>
					)}
				</div>
			);
		});
	};

	const menuItems: MenuItem[] = (() => {
		const entry = menu?.entry ?? null;
		const dir = entry ? (entry.type === "dir" ? entry.path : null) : "";
		const items: MenuItem[] = [];
		if (entry) {
			items.push({ label: "引用到 Agent", onClick: () => insertIntoPrompt(entry.path) });
			items.push({ label: "复制相对路径", onClick: () => copyPath(entry.path, false) });
			items.push({ label: "复制绝对路径", onClick: () => copyPath(entry.path, true) });
			if (isDesktop && !isRemote) items.push({ label: "在文件夹中显示", onClick: () => void runShell(api.revealWorkspaceEntry, entry.path, "定位") });
			items.push({ separator: true, label: "" });
		}
		if (dir !== null) {
			if (isDesktop && !isRemote) items.push({ label: "在终端中打开此文件夹", onClick: () => void runShell(api.openTerminalAt, dir, "打开终端") });
			items.push({ label: "新建文件", onClick: () => void createEntry(dir, "file") });
			items.push({ label: "新建文件夹", onClick: () => void createEntry(dir, "dir") });
		}
		if (entry) {
			items.push({ separator: true, label: "" });
			items.push({ label: "移动到…", onClick: () => void moveEntry(entry) });
			items.push({ label: "重命名", onClick: () => void renameEntry(entry) });
			items.push({ separator: true, label: "" });
			items.push({ label: "删除", danger: true, onClick: () => void removeEntry(entry) });
		}
		return items;
	})();

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
				<input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="搜索整个项目（Ctrl+P）"
					onKeyDown={(e) => {
						if (e.key === "Escape") setFilter("");
						if (e.key === "Enter" && search.result?.matches[0]) openPreview(search.result.matches[0].path);
					}}
					className="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-0.5 text-[12px] outline-none focus:border-accent"
				/>
				<button
					type="button"
					onClick={() => setShowIgnored(!showIgnored)}
					title="显示被 .gitignore 忽略的文件"
					className={`rounded px-1.5 text-[11px] ${showIgnored ? "bg-accent-soft text-accent" : "text-muted hover:text-fg"}`}
				>
					忽略项
				</button>
				<button type="button" onClick={refreshFiles} title="刷新" className="text-muted hover:text-fg">
					↻
				</button>
			</div>
			<div
				onContextMenu={(e) => {
					// 空白处右键：针对工作区根目录
					if (e.target === e.currentTarget) {
						e.preventDefault();
						setMenu({ x: e.clientX, y: e.clientY, entry: null });
					}
				}}
				className="term min-h-0 flex-1 overflow-y-auto py-1 text-[12px] leading-5"
			>
				{error && <div className="px-3 py-1 text-err">{error}</div>}
				{filter.trim() ? (
					<>
						{search.error && <div className="px-3 py-1 text-err">{search.error}</div>}
						{search.result?.matches.map((m) => {
							const mark = changed.get(m.path.toLowerCase());
							return (
								<div
									key={m.path}
									className={`group flex items-center gap-1 py-[3px] pr-2 pl-3 ${preview === m.path ? "bg-accent-soft" : "hover:bg-panel-2"}`}
								>
									<button
										type="button"
										onClick={() => openPreview(m.path)}
										className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
										title={m.path}
									>
										<span className="shrink-0 text-[12px]">📄</span>
										<SearchResultLabel path={m.path} query={filter} />
										{mark && (
											<span className={`shrink-0 text-[10px] font-bold ${mark === "created" ? "text-ok" : "text-warn"}`}>
												{mark === "created" ? "A" : "M"}
											</span>
										)}
									</button>
									<button
										type="button"
										onClick={() => insertIntoPrompt(m.path)}
										title="把路径引用到输入框"
										className="hidden shrink-0 rounded px-1 text-[11px] text-accent hover:bg-accent-soft group-hover:block"
									>
										引用
									</button>
								</div>
							);
						})}
						{search.result && search.result.matches.length === 0 && <div className="px-3 text-muted">没有匹配的文件</div>}
						{search.result && (
							<div className="px-3 pt-2 text-[11px] text-muted">
								在 {search.result.total} 个文件中搜索（不含被忽略的目录）{search.result.truncated ? "，文件过多，只索引了一部分" : ""}
							</div>
						)}
					</>
				) : children[""] === undefined && !error ? (
					<div className="px-3 text-muted">加载中…</div>
				) : (
					renderDir("", 0)
				)}
			</div>
			{menu && <Menu items={menuItems} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
		</div>
	);
}
