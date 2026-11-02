/**
 * 把一轮会话消息整理为结构化的交互内容流：
 * - 连续的思考与工具调用跨多条 assistant 消息聚合为单个「任务执行进度树（ExecutionTree）」
 * - 助手的 Markdown 正文独立为文本块
 * - 系统 note 独立为通知块
 *
 * 彻底消除历史记录里零碎分散的独立胶囊与悬空圆点。
 */
import type { ChatMessage, ContentBlock, StopReason } from "@shared/protocol";

export interface ThinkingExecutionStep {
	id: string;
	kind: "thinking";
	thinkingText: string;
	live?: boolean;
}

export interface ToolExecutionStep {
	id: string;
	kind: "tool";
	toolCall: Extract<ContentBlock, { type: "toolCall" }>;
	toolResult?: { content: ContentBlock[]; details?: unknown; isError: boolean };
	live?: boolean;
}

export type ExecutionStep = ThinkingExecutionStep | ToolExecutionStep;

export interface ExecutionTreeGroup {
	id: string;
	steps: ExecutionStep[];
	live?: boolean;
}

export type TurnContentBlock =
	| {
			type: "execution";
			group: ExecutionTreeGroup;
	  }
	| {
			type: "text";
			id: string;
			text: string;
			live?: boolean;
			stopReason?: StopReason;
			errorMessage?: string;
	  }
	| {
			type: "note";
			id: string;
			kind: string;
			text: string;
	  };

export type ToolResultMap = Map<string, { content: ContentBlock[]; details?: unknown; isError: boolean }>;

/**
 * 把本轮（Turn）的消息列表（不含开头的 user 消息，可附带末尾的 streaming 消息）
 * 聚合为展示用的块列表。
 */
export function buildTurnFlowBlocks(
	messages: readonly ChatMessage[],
	toolResults: ToolResultMap,
	streaming: Extract<ChatMessage, { role: "assistant" }> | null = null,
): TurnContentBlock[] {
	const blocks: TurnContentBlock[] = [];
	let currentExecution: ExecutionTreeGroup | null = null;
	let thinkingSeq = 0;

	const ensureExecution = (idPrefix: string, live = false): ExecutionTreeGroup => {
		if (currentExecution) {
			if (live) currentExecution.live = true;
			return currentExecution;
		}
		const group: ExecutionTreeGroup = {
			id: `exec-${idPrefix}`,
			steps: [],
			live,
		};
		currentExecution = group;
		blocks.push({ type: "execution", group });
		return group;
	};

	const flushExecution = () => {
		currentExecution = null;
	};

	// 依次遍历已有消息
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || msg.role === "user" || msg.role === "toolResult") continue;

		if (msg.role === "note") {
			flushExecution();
			blocks.push({
				type: "note",
				id: msg.entryId ?? `note-${i}`,
				kind: msg.kind,
				text: msg.text,
			});
			continue;
		}

		if (msg.role === "assistant") {
			const content = msg.content ?? [];
			for (let bIdx = 0; bIdx < content.length; bIdx++) {
				const block = content[bIdx];
				if (!block) continue;

				if (block.type === "thinking") {
					if (block.thinking.trim().length > 0) {
						const exec = ensureExecution(msg.entryId ?? `m${i}-b${bIdx}`);
						exec.steps.push({
							id: `thinking-${++thinkingSeq}`,
							kind: "thinking",
							thinkingText: block.thinking,
						});
					}
					continue;
				}

				if (block.type === "toolCall") {
					const exec = ensureExecution(block.id || `call-${i}-${bIdx}`);
					exec.steps.push({
						id: block.id,
						kind: "tool",
						toolCall: block,
						toolResult: toolResults.get(block.id),
					});
					continue;
				}

				if (block.type === "text") {
					if (block.text.trim().length > 0) {
						flushExecution();
						blocks.push({
							type: "text",
							id: msg.entryId ?? `text-${i}-${bIdx}`,
							text: block.text,
							stopReason: msg.stopReason,
							errorMessage: msg.errorMessage,
						});
					}
				}
			}

			// 如果这条 assistant 消息带错误或异常终止，且最后不是文本块，挂出错误提示
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				const last = blocks[blocks.length - 1];
				if (!last || last.type !== "text") {
					flushExecution();
					blocks.push({
						type: "text",
						id: `stop-${i}`,
						text: "",
						stopReason: msg.stopReason,
						errorMessage: msg.errorMessage,
					});
				}
			}
		}
	}

	// 处理正在流式输出的 assistant 消息
	if (streaming) {
		const content = streaming.content ?? [];
		for (let bIdx = 0; bIdx < content.length; bIdx++) {
			const block = content[bIdx];
			if (!block) continue;

			if (block.type === "thinking") {
				const exec = ensureExecution(`streaming-think-${bIdx}`, true);
				exec.steps.push({
					id: `streaming-thinking-${bIdx}`,
					kind: "thinking",
					thinkingText: block.thinking,
					live: true,
				});
				continue;
			}

			if (block.type === "toolCall") {
				const exec = ensureExecution(block.id || `streaming-call-${bIdx}`, true);
				exec.steps.push({
					id: block.id,
					kind: "tool",
					toolCall: block,
					toolResult: toolResults.get(block.id),
					live: true,
				});
				continue;
			}

			if (block.type === "text") {
				if (block.text.length > 0) {
					flushExecution();
					blocks.push({
						type: "text",
						id: `streaming-text-${bIdx}`,
						text: block.text,
						live: true,
					});
				}
			}
		}
	}

	return blocks;
}
