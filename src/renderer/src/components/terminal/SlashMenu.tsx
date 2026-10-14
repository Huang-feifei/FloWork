/**
 * 斜杠命令补全：输入框以 / 开头且尚未输入空格时，列出技能（/skill:名称）、提示模板与扩展命令。
 * ↑↓ 选择，Tab / Enter 补全，Esc 关闭。
 */
import { useEffect, useMemo, useState } from "react";
import type { SlashCommand } from "@shared/protocol";
import { api } from "../../api/client";
import { useApp } from "../../store";
import { useBrowserOcclusion } from "../../lib/browser";

const SOURCE_LABEL: Record<SlashCommand["source"], string> = { skill: "技能", prompt: "模板", extension: "扩展" };

/** 当前项目可用的斜杠命令；资源变化或切换项目时重新读取 */
export function useSlashCommands(): SlashCommand[] {
	const handleId = useApp((s) => s.handleId);
	const version = useApp((s) => s.resourcesVersion);
	const [commands, setCommands] = useState<SlashCommand[]>([]);
	useEffect(() => {
		if (!handleId) {
			setCommands([]);
			return;
		}
		let cancelled = false;
		api.session(handleId, { type: "get_commands" }).then(
			(list) => !cancelled && setCommands(list),
			() => !cancelled && setCommands([]),
		);
		return () => {
			cancelled = true;
		};
	}, [handleId, version]);
	return commands;
}

export interface SlashMenuState {
	open: boolean;
	matches: SlashCommand[];
	active: number;
	setActive: (i: number) => void;
	dismiss: () => void;
}

/** 根据输入框文本计算菜单状态 */
export function useSlashMenu(text: string): SlashMenuState {
	const commands = useSlashCommands();
	const [active, setActive] = useState(0);
	const [dismissedFor, setDismissedFor] = useState<string | null>(null);
	const query = /^\/(\S*)$/.exec(text)?.[1];

	const matches = useMemo(() => {
		if (query === undefined) return [];
		const q = query.toLowerCase();
		return commands
			.filter((c) => c.name.toLowerCase().includes(q) || (q.length > 0 && c.description?.toLowerCase().includes(q)))
			.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
			.slice(0, 12);
	}, [commands, query]);

	useEffect(() => setActive(0), [query]);

	return {
		open: query !== undefined && matches.length > 0 && dismissedFor !== text,
		matches,
		active: Math.min(active, Math.max(0, matches.length - 1)),
		setActive,
		dismiss: () => setDismissedFor(text),
	};
}

export function SlashMenu({ menu, onPick }: { menu: SlashMenuState; onPick: (c: SlashCommand) => void }) {
	useBrowserOcclusion(menu.open);
	if (!menu.open) return null;
	return (
		<div className="fw-float absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-lg border border-border-strong">
			<div className="border-b border-border px-3 py-1 text-[11px] text-muted">斜杠命令 · ↑↓ 选择 · Tab / Enter 补全 · Esc 关闭</div>
			<div className="term max-h-72 overflow-y-auto py-1 text-[12.5px]">
				{menu.matches.map((c, i) => (
					<button
						type="button"
						key={`${c.source}:${c.name}`}
						onMouseEnter={() => menu.setActive(i)}
						onMouseDown={(e) => {
							e.preventDefault();
							onPick(c);
						}}
						className={`flex w-full items-baseline gap-3 px-3 py-1 text-left ${i === menu.active ? "bg-accent-soft" : ""}`}
					>
						<span className="shrink-0 font-bold text-accent">/{c.name}</span>
						<span className="min-w-0 flex-1 truncate text-muted">{c.description}</span>
						<span className="shrink-0 text-[10.5px] text-muted">{SOURCE_LABEL[c.source]}</span>
					</button>
				))}
			</div>
		</div>
	);
}
