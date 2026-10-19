/**
 * 把会话消息按「轮次」切开：一条用户消息 + 其后到下一轮用户消息之前的全部消息（含工具结果）。
 * 供会话记录里的每轮汇总条（改动文件、耗时、操作按钮）使用。
 */
import type { ChatMessage } from "@shared/protocol";
import { collectSessionFiles, type SessionFile } from "./session-files";

export type UserMessage = Extract<ChatMessage, { role: "user" }>;

export interface Turn {
	/** 用户消息在 messages 中的下标 */
	startIndex: number;
	/** 本轮最后一条消息的下标（含 toolResult） */
	endIndex: number;
	/** 本轮最后一条会单独成行的消息下标（toolResult 不单独成行），汇总条挂在这里之后 */
	lastRowIndex: number;
	user: UserMessage;
	/** 本轮的全部消息（用户消息本身 + 助手 / 工具结果 / note） */
	messages: ChatMessage[];
	/** 本轮最后一条助手消息的时间戳，用来算耗时 */
	endTimestamp: number;
}

export function buildTurns(messages: readonly ChatMessage[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | null = null;
	messages.forEach((m, index) => {
		if (m.role === "user") {
			current = {
				startIndex: index,
				endIndex: index,
				lastRowIndex: index,
				user: m,
				messages: [m],
				endTimestamp: m.timestamp,
			};
			turns.push(current);
			return;
		}
		if (!current) return;
		current.endIndex = index;
		current.messages.push(m);
		if (m.role !== "toolResult") current.lastRowIndex = index;
		if (m.role === "assistant") current.endTimestamp = m.timestamp;
	});
	return turns;
}

/** 耗时的紧凑写法：5m 6s / 12s / 1h 3m */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/** 本轮汇总条的稳定 key：优先用用户消息的会话树条目 id */
export function turnKey(turn: Turn): string {
	return turn.user.entryId ?? `i${turn.startIndex}`;
}

/** 本轮修改过的文件（只算成功的 write / edit），用于决定是否显示汇总条与文件 chip */
export function turnChangedFiles(turn: Turn, cwd: string | null): SessionFile[] {
	return collectSessionFiles(turn.messages, cwd).filter((f) => f.changes.some((c) => !c.isError));
}
