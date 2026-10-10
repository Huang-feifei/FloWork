/**
 * pi → FloWork 数据适配层。
 *
 * pi 的类型与事件只在本文件被解读；升级 pi 时优先检查这里。
 */
import type { AgentSession, AgentSessionEvent, SessionTreeNode as PiTreeNode } from "@earendil-works/pi-coding-agent";
import type {
	ChatMessage,
	ContentBlock,
	ModelInfo,
	SessionEvent,
	SessionState,
	SessionTreeNode,
	StopReason,
	ThinkingLevel,
	Usage,
} from "@shared/protocol";

// pi 的消息是可扩展联合类型，这里按需读取字段，避免与其内部类型强绑定。
type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord {
	return value !== null && typeof value === "object" ? (value as LooseRecord) : {};
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function toContentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const blocks: ContentBlock[] = [];
	for (const raw of content) {
		const b = asRecord(raw);
		switch (b.type) {
			case "text":
				blocks.push({ type: "text", text: str(b.text) });
				break;
			case "thinking":
				blocks.push({ type: "thinking", thinking: str(b.thinking), redacted: b.redacted === true });
				break;
			case "toolCall":
				blocks.push({
					type: "toolCall",
					id: str(b.id),
					name: str(b.name),
					arguments: asRecord(b.arguments),
				});
				break;
			case "image":
				blocks.push({ type: "image", mimeType: str(b.mimeType), data: str(b.data) });
				break;
		}
	}
	return blocks;
}

function toUsage(value: unknown): Usage | undefined {
	const u = asRecord(value);
	if (typeof u.totalTokens !== "number") return undefined;
	const cost = asRecord(u.cost);
	return {
		input: Number(u.input ?? 0),
		output: Number(u.output ?? 0),
		cacheRead: Number(u.cacheRead ?? 0),
		cacheWrite: Number(u.cacheWrite ?? 0),
		totalTokens: u.totalTokens,
		cost: { total: Number(cost.total ?? 0) },
	};
}

/** 把 pi 的 AgentMessage 转成界面使用的 ChatMessage；system 消息返回 undefined */
export function toChatMessage(raw: unknown): ChatMessage | undefined {
	const m = asRecord(raw);
	const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.now();
	switch (m.role) {
		case "system":
			return undefined;
		case "user":
			return { role: "user", content: toContentBlocks(m.content), timestamp };
		case "assistant":
			return {
				role: "assistant",
				content: toContentBlocks(m.content),
				provider: str(m.provider),
				model: str(m.model),
				stopReason: str(m.stopReason, "stop") as StopReason,
				errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
				usage: toUsage(m.usage),
				timestamp,
			};
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: str(m.toolCallId),
				toolName: str(m.toolName),
				content: toContentBlocks(m.content),
				details: m.details,
				isError: m.isError === true,
				timestamp,
			};
		case "bashExecution":
			return { role: "note", kind: "bash", text: `$ ${str(m.command)}\n${str(m.output)}`, timestamp };
		case "branchSummary":
			return { role: "note", kind: "branchSummary", text: str(m.summary), timestamp };
		case "compactionSummary":
			return { role: "note", kind: "compactionSummary", text: str(m.summary), timestamp };
		case "custom": {
			if (m.display === false) return undefined;
			const text = toContentBlocks(m.content)
				.map((b) => (b.type === "text" ? b.text : ""))
				.join("");
			return { role: "note", kind: `custom:${str(m.customType)}`, text, timestamp };
		}
		default:
			return { role: "note", kind: str(m.role, "unknown"), text: "", timestamp };
	}
}

export function toModelInfo(raw: unknown): ModelInfo | undefined {
	const m = asRecord(raw);
	const provider = str(m.provider);
	const id = str(m.id);
	// 未配置模型时 pi 会给出 provider/id 均为 "unknown" 的占位对象
	if (!provider || !id || provider === "unknown") return undefined;
	const cost = asRecord(m.cost);
	return {
		provider,
		id,
		name: str(m.name, id),
		reasoning: m.reasoning === true,
		contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
		maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
		cost:
			typeof cost.input === "number"
				? {
						input: Number(cost.input),
						output: Number(cost.output ?? 0),
						cacheRead: Number(cost.cacheRead ?? 0),
						cacheWrite: Number(cost.cacheWrite ?? 0),
					}
				: undefined,
	};
}

export function toSessionState(session: AgentSession): SessionState {
	return {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		cwd: session.sessionManager.getCwd(),
		model: toModelInfo(session.model),
		thinkingLevel: session.thinkingLevel as ThinkingLevel,
		availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
		isStreaming: session.isStreaming,
		messageCount: session.messages.length,
	};
}

function entryPreview(entry: LooseRecord): { role?: string; preview: string } {
	if (entry.type === "message") {
		const msg = toChatMessage(entry.message);
		if (!msg) return { role: "system", preview: "" };
		if (msg.role === "note") return { role: msg.kind, preview: msg.text.slice(0, 120) };
		const text = msg.content
			.map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `${b.name}(…)` : ""))
			.join(" ")
			.trim();
		return { role: msg.role, preview: text.slice(0, 120) };
	}
	if (entry.type === "model_change") return { preview: `模型 → ${str(entry.provider)}/${str(entry.modelId)}` };
	if (entry.type === "thinking_level_change") return { preview: `思考等级 → ${str(entry.thinkingLevel)}` };
	if (entry.type === "branch_summary") return { preview: str(entry.summary).slice(0, 120) };
	if (entry.type === "compaction") return { preview: "上下文压缩" };
	return { preview: str(entry.type) };
}

export function toTree(nodes: readonly PiTreeNode[]): SessionTreeNode[] {
	return nodes.map((node) => {
		const entry = asRecord(node.entry);
		const { role, preview } = entryPreview(entry);
		return {
			id: str(entry.id),
			parentId: typeof entry.parentId === "string" ? entry.parentId : null,
			entryType: str(entry.type),
			role,
			preview,
			label: node.label,
			timestamp: str(entry.timestamp),
			children: toTree(node.children),
		};
	});
}

/**
 * 把 SDK 的 AgentSessionEvent 转成 FloWork 事件。
 * 与 pi 的 RPC 线上格式一样，流式更新只传 delta，不传累计快照。
 */
export function toSessionEvents(event: AgentSessionEvent): SessionEvent[] {
	const e = event as unknown as LooseRecord;
	switch (event.type) {
		case "agent_start":
			return [{ type: "agent_start" }];
		case "agent_settled":
			return [{ type: "agent_settled", aborted: e.aborted === true }];
		case "message_start":
		case "message_end": {
			const message = toChatMessage(e.message);
			return message ? [{ type: event.type, message }] : [];
		}
		case "message_update": {
			const ame = asRecord(e.assistantMessageEvent);
			const contentIndex = Number(ame.contentIndex ?? 0);
			switch (ame.type) {
				case "text_start":
					return [{ type: "block_start", contentIndex, kind: "text" }];
				case "thinking_start":
					return [{ type: "block_start", contentIndex, kind: "thinking" }];
				case "toolcall_start": {
					const partial = asRecord(ame.partial);
					const block = Array.isArray(partial.content) ? asRecord(partial.content[contentIndex]) : {};
					return [
						{
							type: "block_start",
							contentIndex,
							kind: "toolCall",
							toolCallId: str(block.id),
							toolName: str(block.name),
						},
					];
				}
				case "text_delta":
					return [{ type: "block_delta", contentIndex, kind: "text", delta: str(ame.delta) }];
				case "thinking_delta":
					return [{ type: "block_delta", contentIndex, kind: "thinking", delta: str(ame.delta) }];
				case "toolcall_delta":
					return [{ type: "block_delta", contentIndex, kind: "toolCall", delta: str(ame.delta) }];
				case "text_end":
					return [{ type: "block_end", contentIndex, block: { type: "text", text: str(ame.content) } }];
				case "thinking_end":
					return [{ type: "block_end", contentIndex, block: { type: "thinking", thinking: str(ame.content) } }];
				case "toolcall_end": {
					const [block] = toContentBlocks([ame.toolCall]);
					return block ? [{ type: "block_end", contentIndex, block }] : [];
				}
				default:
					return [];
			}
		}
		case "tool_execution_start":
			return [
				{ type: "tool_execution_start", toolCallId: str(e.toolCallId), toolName: str(e.toolName), args: e.args },
			];
		case "tool_execution_update":
			return [{ type: "tool_execution_update", toolCallId: str(e.toolCallId), partialResult: e.partialResult }];
		case "tool_execution_end": {
			const result = asRecord(e.result);
			return [
				{
					type: "tool_execution_end",
					toolCallId: str(e.toolCallId),
					toolName: str(e.toolName),
					result: { content: toContentBlocks(result.content), details: result.details },
					isError: e.isError === true,
					durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined,
				},
			];
		}
		case "queue_update":
			return [
				{
					type: "queue_update",
					steering: [...((e.steering as string[]) ?? [])],
					followUp: [...((e.followUp as string[]) ?? [])],
				},
			];
		case "session_info_changed":
			return [{ type: "session_info_changed", name: typeof e.name === "string" ? e.name : undefined }];
		case "thinking_level_changed":
			return [{ type: "thinking_level_changed", level: str(e.level) as ThinkingLevel }];
		case "compaction_start":
			return [{ type: "notice", level: "info", text: `正在压缩上下文（${str(e.reason)}）…` }];
		case "compaction_end":
			return [
				{
					type: "notice",
					level: e.errorMessage ? "error" : "info",
					text: e.errorMessage ? `上下文压缩失败：${str(e.errorMessage)}` : "上下文压缩完成",
				},
			];
		case "auto_retry_start":
			return [
				{
					type: "notice",
					level: "warning",
					text: `请求失败，${Math.round(Number(e.delayMs) / 1000)} 秒后重试（${String(e.attempt)}/${String(e.maxAttempts)}）：${str(e.errorMessage)}`,
				},
			];
		case "auto_retry_end":
			return e.success === true
				? []
				: [{ type: "notice", level: "error", text: `重试失败：${str(e.finalError)}` }];
		default:
			return [];
	}
}
