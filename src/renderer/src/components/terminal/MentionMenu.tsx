/**
 * @ 上下文与文件引用补全：
 * 输入框输入 @ 后唤起，支持快速模糊匹配项目文件、Git 变更、会话文件等。
 * ↑↓ 选择，Tab / Enter 补全，Esc 关闭。
 */
import { useEffect, useMemo, useState } from "react";
import { useFileSearch } from "../../lib/useFileSearch";
import { useBrowserOcclusion } from "../../lib/browser";
import { useApp } from "../../store";
import { collectSessionFiles } from "../../lib/session-files";
import { Icon, type IconName } from "../Icon";
import { SearchResultLabel } from "../panels/SearchResultRow";

export interface MentionItem {
	id: string;
	kind: "file" | "git" | "session";
	label: string;
	description?: string;
	icon: IconName;
	/** 插入到输入框的具体文本内容 */
	insertText: string;
}

export interface MentionMenuState {
	open: boolean;
	query: string;
	atIndex: number;
	items: MentionItem[];
	active: number;
	setActive: (i: number) => void;
	dismiss: () => void;
}

/** 检测光标前是否正在输入 @ 标签，提取 query 与起始下标 */
export function extractMentionQuery(text: string, cursor: number): { query: string; atIndex: number } | null {
	const before = text.slice(0, cursor);
	// 匹配以空白字符开头或行首的 @xxx，且后面没有其他空格
	const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
	if (!match) return null;
	const atOffset = match[0].indexOf("@");
	const atIndex = match.index + atOffset;
	return {
		query: match[1] ?? "",
		atIndex,
	};
}

export function useMentionMenu(text: string, cursor: number): MentionMenuState {
	const [active, setActive] = useState(0);
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);
	const messages = useApp((s) => s.messages);
	const cwd = useApp((s) => s.cwd);

	const parsed = useMemo(() => extractMentionQuery(text, cursor), [text, cursor]);
	const query = parsed?.query ?? "";
	const atIndex = parsed?.atIndex ?? -1;

	// 文件搜索结果
	const { result } = useFileSearch(parsed ? query : "", 30);
	const fileMatches = result?.matches ?? [];

	// 本会话改动过的文件
	const sessionFiles = useMemo(() => {
		if (!parsed) return [];
		return collectSessionFiles(messages, cwd).map((f) => f.path);
	}, [messages, cwd, parsed]);

	// 组合候选列表
	const items: MentionItem[] = useMemo(() => {
		if (!parsed) return [];
		const list: MentionItem[] = [];
		const q = query.toLowerCase();

		// 特殊快捷项
		if ("git".includes(q) || "changes".includes(q) || q === "") {
			list.push({
				id: "special-git",
				kind: "git",
				label: "@git",
				description: "当前 Git 未提交的代码改动与状态",
				icon: "git-compare",
				insertText: "@git",
			});
		}

		if (sessionFiles.length > 0 && ("session".includes(q) || "recent".includes(q) || q === "")) {
			list.push({
				id: "special-session",
				kind: "session",
				label: "@session",
				description: `本会话涉及的 ${sessionFiles.length} 个文件`,
				icon: "list-checks",
				insertText: sessionFiles.map((p) => `@${p}`).join(" "),
			});
		}

		// 工作区匹配的文件
		for (const m of fileMatches) {
			list.push({
				id: `file-${m.path}`,
				kind: "file",
				label: m.path,
				icon: "file-code",
				insertText: `@${m.path}`,
			});
		}

		return list.slice(0, 20);
	}, [parsed, query, fileMatches, sessionFiles]);

	const key = parsed ? `${atIndex}:${query}` : null;
	useEffect(() => setActive(0), [query]);

	const open = parsed !== null && items.length > 0 && dismissedKey !== key;

	return {
		open,
		query,
		atIndex,
		items,
		active: Math.min(active, Math.max(0, items.length - 1)),
		setActive,
		dismiss: () => setDismissedKey(key),
	};
}

export function MentionMenu({
	menu,
	onPick,
}: {
	menu: MentionMenuState;
	onPick: (item: MentionItem) => void;
}) {
	useBrowserOcclusion(menu.open);
	if (!menu.open) return null;

	return (
		<div className="fw-float absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-2xl border border-border/80 bg-panel-1/95 shadow-xl backdrop-blur-md">
			<div className="flex items-center justify-between border-b border-border/70 px-4 py-2 text-[11.5px] text-muted">
				<span className="flex items-center gap-1.5 font-medium text-primary">
					<Icon name="at-sign" className="size-3.5" />
					引用文件或上下文
				</span>
				<span>↑↓ 选择 · Tab / Enter 补全 · Esc 关闭</span>
			</div>
			<div className="term max-h-72 overflow-y-auto py-1 text-[12.5px]">
				{menu.items.map((item, i) => (
					<button
						type="button"
						key={item.id}
						onMouseEnter={() => menu.setActive(i)}
						onMouseDown={(e) => {
							e.preventDefault();
							onPick(item);
						}}
						className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
							i === menu.active ? "bg-primary-soft text-fg" : "text-fg/90 hover:bg-panel-2/60"
						}`}
					>
						<span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-panel-2 text-muted">
							<Icon name={item.icon} className="size-3.5 text-primary" />
						</span>
						<div className="min-w-0 flex-1">
							{item.kind === "file" ? (
								<SearchResultLabel path={item.label} query={menu.query} />
							) : (
								<span className="font-medium text-primary">{item.label}</span>
							)}
							{item.description && (
								<div className="truncate text-[11px] text-muted">{item.description}</div>
							)}
						</div>
						{item.kind === "file" && (
							<span className="shrink-0 text-[10.5px] text-faint">文件</span>
						)}
					</button>
				))}
			</div>
		</div>
	);
}
