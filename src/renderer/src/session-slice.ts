/**
 * 单个项目的会话状态切片，以及把会话事件归约到切片上的纯函数。
 * 当前项目的切片字段直接展开在 store 顶层（组件按原样读取），后台项目的切片保存在 store.background 中，
 * 两者用同一个 reduceEvent 处理事件，保证后台运行时状态照常累积。
 */
import type {
	ApprovalRisk,
	ChatMessage,
	ContentBlock,
	ExtUIRequest,
	ModelInfo,
	SessionEvent,
	SessionState,
	SessionTreeNode,
} from "@shared/protocol";

export interface ToolRun {
	status: "running" | "done" | "error";
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: { content: ContentBlock[]; details?: unknown };
	durationMs?: number;
}

export interface PendingApproval {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** 运维会话：命令风险评估 */
	risk?: ApprovalRisk;
}

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export interface SessionSlice {
	cwd: string | null;
	handleId: string | null;
	state: SessionState | null;
	messages: ChatMessage[];
	/** 正在流式生成的 assistant 消息 */
	streaming: AssistantMessage | null;
	/** 工具调用参数的原始 JSON 增量（流式期间） */
	toolArgsText: Record<string, string>;
	toolRuns: Record<string, ToolRun>;
	isRunning: boolean;
	models: ModelInfo[];
	connecting: boolean;
	/** 等待用户确认的工具调用，按到达顺序 */
	pendingApprovals: PendingApproval[];
	tree: SessionTreeNode[];
	leafId: string | null;
	/** 正在预览的文件（相对工作区的路径） */
	preview: string | null;
	/** 第三方扩展发起、等待用户应答的对话框，按到达顺序 */
	extDialogs: ExtUIRequest[];
	/** 扩展通过 ctx.ui.setStatus 设置的状态文字 */
	extStatus: Record<string, string>;
	/** 扩展通过 ctx.ui.setWidget 设置的文本块 */
	extWidgets: Record<string, ExtWidget>;
}

export interface ExtWidget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

/** 需要用户处理的项目数：工具审批 + 扩展对话框 */
export function waitingCount(s: Pick<SessionSlice, "pendingApprovals" | "extDialogs">): number {
	return s.pendingApprovals.length + s.extDialogs.length;
}

export const SLICE_KEYS = [
	"cwd",
	"handleId",
	"state",
	"messages",
	"streaming",
	"toolArgsText",
	"toolRuns",
	"isRunning",
	"models",
	"connecting",
	"pendingApprovals",
	"tree",
	"leafId",
	"preview",
	"extDialogs",
	"extStatus",
	"extWidgets",
] as const satisfies ReadonlyArray<keyof SessionSlice>;

export function emptySlice(cwd: string | null = null): SessionSlice {
	return {
		cwd,
		handleId: null,
		state: null,
		messages: [],
		streaming: null,
		toolArgsText: {},
		toolRuns: {},
		isRunning: false,
		models: [],
		connecting: false,
		pendingApprovals: [],
		tree: [],
		leafId: null,
		preview: null,
		extDialogs: [],
		extStatus: {},
		extWidgets: {},
	};
}

export function pickSlice(source: SessionSlice): SessionSlice {
	const out = {} as Record<string, unknown>;
	for (const key of SLICE_KEYS) out[key] = source[key];
	return out as unknown as SessionSlice;
}

/** 把事件归约成切片的增量；不含副作用（刷新列表、提示等由调用方处理） */
export function reduceEvent(s: SessionSlice, event: SessionEvent): Partial<SessionSlice> | null {
	switch (event.type) {
		case "agent_start":
			return { isRunning: true };
		case "agent_settled":
			return { isRunning: false, pendingApprovals: [] };
		case "message_start":
			return event.message.role === "assistant" ? { streaming: { ...event.message, content: [] } } : null;
		case "block_start": {
			if (!s.streaming) return null;
			const content = [...s.streaming.content];
			content[event.contentIndex] =
				event.kind === "text"
					? { type: "text", text: "" }
					: event.kind === "thinking"
						? { type: "thinking", thinking: "" }
						: { type: "toolCall", id: event.toolCallId ?? "", name: event.toolName ?? "", arguments: {} };
			return { streaming: { ...s.streaming, content } };
		}
		case "block_delta": {
			if (!s.streaming) return null;
			const content = [...s.streaming.content];
			const block = content[event.contentIndex];
			if (block?.type === "text") content[event.contentIndex] = { ...block, text: block.text + event.delta };
			else if (block?.type === "thinking") content[event.contentIndex] = { ...block, thinking: block.thinking + event.delta };
			else if (block?.type === "toolCall")
				return { toolArgsText: { ...s.toolArgsText, [block.id]: (s.toolArgsText[block.id] ?? "") + event.delta } };
			return { streaming: { ...s.streaming, content } };
		}
		case "block_end": {
			if (!s.streaming) return null;
			const content = [...s.streaming.content];
			content[event.contentIndex] = event.block;
			return { streaming: { ...s.streaming, content } };
		}
		case "message_end":
			return {
				messages: [...s.messages, event.message],
				streaming: event.message.role === "assistant" ? null : s.streaming,
			};
		case "tool_execution_start":
			return {
				toolRuns: { ...s.toolRuns, [event.toolCallId]: { status: "running", toolName: event.toolName, args: event.args } },
			};
		case "tool_execution_update": {
			const run = s.toolRuns[event.toolCallId];
			return run ? { toolRuns: { ...s.toolRuns, [event.toolCallId]: { ...run, partialResult: event.partialResult } } } : null;
		}
		case "tool_execution_end":
			return {
				toolRuns: {
					...s.toolRuns,
					[event.toolCallId]: {
						...s.toolRuns[event.toolCallId],
						toolName: event.toolName,
						status: event.isError ? "error" : "done",
						result: event.result,
						durationMs: event.durationMs,
					},
				},
			};
		case "session_info_changed":
			return s.state ? { state: { ...s.state, sessionName: event.name } } : null;
		case "thinking_level_changed":
			return s.state ? { state: { ...s.state, thinkingLevel: event.level } } : null;
		case "approval_request":
			return {
				pendingApprovals: [
					...s.pendingApprovals.filter((p) => p.toolCallId !== event.toolCallId),
					{ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, risk: event.risk },
				],
			};
		case "approval_resolved":
			return { pendingApprovals: s.pendingApprovals.filter((p) => p.toolCallId !== event.toolCallId) };
		case "ext_ui_request":
			return { extDialogs: [...s.extDialogs.filter((d) => d.id !== event.request.id), event.request] };
		case "ext_ui_closed":
			return { extDialogs: s.extDialogs.filter((d) => d.id !== event.id) };
		case "ext_status": {
			const { [event.key]: _, ...rest } = s.extStatus;
			return { extStatus: event.text ? { ...rest, [event.key]: event.text } : rest };
		}
		case "ext_widget": {
			const { [event.key]: _, ...rest } = s.extWidgets;
			return { extWidgets: event.lines ? { ...rest, [event.key]: { lines: event.lines, placement: event.placement } } : rest };
		}
		case "queue_update":
			return s.state ? { state: { ...s.state, queue: { steering: [...event.steering], followUp: [...event.followUp] } } } : null;
		case "session_changed":
		case "ext_editor_text":
		case "notice":
			return null;
	}
}
