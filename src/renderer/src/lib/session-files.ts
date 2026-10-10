/**
 * 从会话消息中汇总“本会话涉及的文件”：read / write / edit 工具调用及其结果。
 * bash 等命令对文件的改动无法从参数得知，不在此列。
 */
import type { ChatMessage } from "@shared/protocol";

export interface SessionFileChange {
	tool: "write" | "edit";
	diff?: string;
	created: boolean;
	isError: boolean;
}

export interface SessionFile {
	/** 相对工作区的路径（工作区外的文件为绝对路径） */
	path: string;
	reads: number;
	changes: SessionFileChange[];
	created: boolean;
	added: number;
	removed: number;
	/** 最后一次涉及该文件的消息序号，用于排序 */
	lastIndex: number;
}

export function toRelative(path: string, cwd: string | null): string {
	const norm = path.replaceAll("\\", "/").replace(/^@/, "");
	if (!cwd) return norm;
	const base = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
	if (norm.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return norm.slice(base.length + 1);
	return norm.replace(/^\.\//, "");
}

export function isInsideWorkspace(relPath: string): boolean {
	return !/^([a-zA-Z]:|\/|~|\.\.)/.test(relPath);
}

function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export function collectSessionFiles(messages: ChatMessage[], cwd: string | null): SessionFile[] {
	const calls = new Map<string, { name: string; path: string; index: number }>();
	const files = new Map<string, SessionFile>();
	const fileFor = (path: string, index: number) => {
		let f = files.get(path.toLowerCase());
		if (!f) {
			f = { path, reads: 0, changes: [], created: false, added: 0, removed: 0, lastIndex: index };
			files.set(path.toLowerCase(), f);
		}
		f.lastIndex = Math.max(f.lastIndex, index);
		return f;
	};

	messages.forEach((m, index) => {
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type !== "toolCall" || !["read", "write", "edit"].includes(block.name)) continue;
				const raw = block.arguments.path ?? block.arguments.file_path;
				if (typeof raw === "string" && raw) calls.set(block.id, { name: block.name, path: toRelative(raw, cwd), index });
			}
		} else if (m.role === "toolResult") {
			const call = calls.get(m.toolCallId);
			if (!call) return;
			const f = fileFor(call.path, index);
			if (call.name === "read") {
				if (!m.isError) f.reads++;
				return;
			}
			const details = (m.details ?? {}) as { diff?: unknown; created?: unknown };
			const diff = typeof details.diff === "string" ? details.diff : undefined;
			const created = details.created === true;
			f.changes.push({ tool: call.name as "write" | "edit", diff, created, isError: m.isError });
			if (!m.isError) {
				if (created && f.changes.filter((c) => !c.isError).length === 1) f.created = true;
				if (diff) {
					const s = diffStats(diff);
					f.added += s.added;
					f.removed += s.removed;
				}
			}
		}
	});

	return [...files.values()].sort((a, b) => b.lastIndex - a.lastIndex);
}
