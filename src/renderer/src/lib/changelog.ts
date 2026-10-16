/**
 * 更新日志：直接读仓库根目录的 CHANGELOG.md（Vite 的 ?raw 内联成字符串），按版本切分。
 * 版本变化时弹窗显示当前版本的条目，见 components/UpdateDialog.tsx。
 */
import raw from "../../../../CHANGELOG.md?raw";

export interface ChangelogEntry {
	version: string;
	date: string;
	items: string[];
}

/** 解析形如 `## 1.0.2 — 2026-10-16` 的标题与其下的 `- ` 条目 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
	const entries: ChangelogEntry[] = [];
	let current: ChangelogEntry | null = null;
	for (const line of markdown.split(/\r?\n/)) {
		const trimmed = line.trim();
		const heading = /^##\s+(\S+?)(?:\s+—\s+(.+))?$/.exec(trimmed);
		if (heading) {
			current = { version: heading[1] ?? "", date: (heading[2] ?? "").trim(), items: [] };
			entries.push(current);
			continue;
		}
		const item = /^[-*]\s+(.+)$/.exec(trimmed);
		if (item && current) current.items.push(item[1] ?? "");
	}
	return entries;
}

export const CHANGELOG = parseChangelog(raw);

export function changelogFor(version: string): ChangelogEntry | undefined {
	return CHANGELOG.find((entry) => entry.version === version);
}
