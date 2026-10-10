/**
 * 界面状态。当前阶段：一个工作区对应一个 session worker，
 * “新会话 / 切换历史会话”在同一个 worker 内通过 new_session / switch_session 完成。
 */
import { create } from "zustand";
import type {
	AppInfo,
	BackendPush,
	ChatMessage,
	ContentBlock,
	ModelInfo,
	SessionEvent,
	SessionState,
	SessionSummary,
	ThinkingLevel,
} from "@shared/protocol";
import { api, errorText } from "./api/client";
import type { ConnectionStatus } from "./api/transport";
import { rememberCwd } from "./lib/recent";

export interface ToolRun {
	status: "running" | "done" | "error";
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: { content: ContentBlock[]; details?: unknown };
	durationMs?: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

export type View = "chat" | "settings";
export type SettingsTab = "providers" | "custom" | "preferences" | "raw";

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

interface AppState {
	info: AppInfo | null;
	connection: ConnectionStatus;
	view: View;
	settingsTab: SettingsTab;
	/** 配置变更计数，设置页据此刷新 */
	configVersion: number;
	folderPickerOpen: boolean;

	cwd: string | null;
	sessions: SessionSummary[];
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
	notices: Notice[];
	connecting: boolean;

	init(): Promise<void>;
	setView(view: View, tab?: SettingsTab): void;
	openFolderPicker(): Promise<void>;
	closeFolderPicker(): void;
	selectWorkspace(cwd: string): Promise<void>;
	refreshSessions(): Promise<void>;
	loadModels(): Promise<void>;
	newSession(): Promise<void>;
	switchSession(path: string): Promise<void>;
	sendPrompt(text: string): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelInfo): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	pushNotice(level: Notice["level"], text: string): void;
	dismissNotice(id: number): void;
	applyPush(push: BackendPush): void;
	applyEvent(event: SessionEvent): void;
}

const LAST_CWD_KEY = "flowork.lastCwd";
let noticeSeq = 0;
let initialized = false;

export const useApp = create<AppState>()((set, get) => {
	async function sessionCall<T>(fn: (handleId: string) => Promise<T>): Promise<T | undefined> {
		const { handleId } = get();
		if (!handleId) return undefined;
		try {
			return await fn(handleId);
		} catch (error) {
			get().pushNotice("error", errorText(error));
			return undefined;
		}
	}

	async function reloadMessages(state?: SessionState): Promise<void> {
		const messages = await sessionCall((h) => api.session(h, { type: "get_messages" }));
		set({
			messages: messages ?? [],
			streaming: null,
			toolArgsText: {},
			toolRuns: {},
			...(state ? { state } : {}),
		});
	}

	return {
		info: null,
		connection: "connecting",
		view: "chat",
		settingsTab: "providers",
		configVersion: 0,
		folderPickerOpen: false,
		cwd: null,
		sessions: [],
		handleId: null,
		state: null,
		messages: [],
		streaming: null,
		toolArgsText: {},
		toolRuns: {},
		isRunning: false,
		models: [],
		notices: [],
		connecting: false,

		async init() {
			if (initialized) return;
			initialized = true;
			api.onPush((push) => get().applyPush(push));
			let everOpened = false;
			api.onStatus((connection) => {
				set({ connection });
				// 网页版断线重连后，后端已关闭旧会话，需要重新打开工作区
				if (connection === "open" && everOpened && get().cwd) void get().selectWorkspace(get().cwd as string);
				if (connection === "open") everOpened = true;
			});
			try {
				const info = await api.info();
				set({ info, connection: "open" });
				everOpened = true;
			} catch (error) {
				get().pushNotice("error", `无法连接本地后端：${errorText(error)}`);
				return;
			}
			const last = localStorage.getItem(LAST_CWD_KEY);
			if (last) await get().selectWorkspace(last);
		},

		setView(view, tab) {
			set(tab ? { view, settingsTab: tab } : { view });
		},

		async openFolderPicker() {
			if (get().info?.nativeDialogs) {
				const dir = await api.pickFolder().catch(() => null);
				if (dir) await get().selectWorkspace(dir);
			} else {
				set({ folderPickerOpen: true });
			}
		},

		closeFolderPicker() {
			set({ folderPickerOpen: false });
		},

		async selectWorkspace(cwd) {
			const previous = get().handleId;
			set({
				cwd,
				view: "chat",
				folderPickerOpen: false,
				connecting: true,
				handleId: null,
				state: null,
				messages: [],
				streaming: null,
				models: [],
				isRunning: false,
			});
			localStorage.setItem(LAST_CWD_KEY, cwd);
			rememberCwd(cwd);
			rememberCwd(cwd);
			if (previous) void api.closeSession(previous).catch(() => undefined);
			try {
				const { handleId, state } = await api.openSession(cwd);
				set({ handleId, state, connecting: false });
				await Promise.all([reloadMessages(), get().loadModels(), get().refreshSessions()]);
			} catch (error) {
				set({ connecting: false });
				get().pushNotice("error", `打开工作区失败：${errorText(error)}`);
			}
		},

		async refreshSessions() {
			const { cwd } = get();
			if (!cwd) return;
			try {
				set({ sessions: await api.service({ type: "list_sessions", cwd }) });
			} catch (error) {
				get().pushNotice("error", `读取会话列表失败：${errorText(error)}`);
			}
		},

		async loadModels() {
			const models = await sessionCall((h) => api.session(h, { type: "get_available_models" }));
			set({ models: models ?? [] });
		},

		async newSession() {
			const state = await sessionCall((h) => api.session(h, { type: "new_session" }));
			if (state) await reloadMessages(state);
			set({ view: "chat" });
			await get().refreshSessions();
		},

		async switchSession(path) {
			const state = await sessionCall((h) => api.session(h, { type: "switch_session", sessionPath: path }));
			if (state) await reloadMessages(state);
			set({ view: "chat" });
		},

		async sendPrompt(text) {
			const message = text.trim();
			if (!message) return;
			await sessionCall((h) => api.session(h, { type: "prompt", message }));
		},

		async abort() {
			await sessionCall((h) => api.session(h, { type: "abort" }));
		},

		async setModel(model) {
			const state = await sessionCall((h) =>
				api.session(h, { type: "set_model", provider: model.provider, modelId: model.id }),
			);
			if (state) set({ state });
		},

		async setThinkingLevel(level) {
			const state = await sessionCall((h) => api.session(h, { type: "set_thinking_level", level }));
			if (state) set({ state });
		},

		pushNotice(level, text) {
			const id = ++noticeSeq;
			set((s) => ({ notices: [...s.notices.slice(-4), { id, level, text }] }));
			if (level !== "error") setTimeout(() => get().dismissNotice(id), 6000);
		},

		dismissNotice(id) {
			set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
		},

		applyPush(push) {
			switch (push.type) {
				case "session_event":
					if (push.handleId === get().handleId) get().applyEvent(push.event);
					return;
				case "session_exit":
					if (push.handleId !== get().handleId) return;
					set({ handleId: null, isRunning: false });
					get().pushNotice("error", `pi worker 已退出（code ${push.code}），请重新打开工作区`);
					return;
				case "config_changed": {
					set((s) => ({ configVersion: s.configVersion + 1 }));
					void get().loadModels();
					const handleId = get().handleId;
					if (handleId) void api.session(handleId, { type: "get_state" }).then((state) => set({ state }));
					return;
				}
				case "auth":
					// 由 authStore 处理
					return;
			}
		},

		applyEvent(event) {
			switch (event.type) {
				case "agent_start":
					set({ isRunning: true });
					return;
				case "agent_settled":
					set({ isRunning: false });
					void get().refreshSessions();
					return;
				case "message_start":
					if (event.message.role === "assistant") set({ streaming: { ...event.message, content: [] } });
					return;
				case "block_start":
					set((s) => {
						if (!s.streaming) return s;
						const content = [...s.streaming.content];
						content[event.contentIndex] =
							event.kind === "text"
								? { type: "text", text: "" }
								: event.kind === "thinking"
									? { type: "thinking", thinking: "" }
									: { type: "toolCall", id: event.toolCallId ?? "", name: event.toolName ?? "", arguments: {} };
						return { streaming: { ...s.streaming, content } };
					});
					return;
				case "block_delta":
					set((s) => {
						if (!s.streaming) return s;
						const content = [...s.streaming.content];
						const block = content[event.contentIndex];
						if (block?.type === "text") content[event.contentIndex] = { ...block, text: block.text + event.delta };
						else if (block?.type === "thinking")
							content[event.contentIndex] = { ...block, thinking: block.thinking + event.delta };
						else if (block?.type === "toolCall")
							return {
								toolArgsText: { ...s.toolArgsText, [block.id]: (s.toolArgsText[block.id] ?? "") + event.delta },
							};
						return { streaming: { ...s.streaming, content } };
					});
					return;
				case "block_end":
					set((s) => {
						if (!s.streaming) return s;
						const content = [...s.streaming.content];
						content[event.contentIndex] = event.block;
						return { streaming: { ...s.streaming, content } };
					});
					return;
				case "message_end":
					set((s) => ({
						messages: [...s.messages, event.message],
						streaming: event.message.role === "assistant" ? null : s.streaming,
					}));
					return;
				case "tool_execution_start":
					set((s) => ({
						toolRuns: {
							...s.toolRuns,
							[event.toolCallId]: { status: "running", toolName: event.toolName, args: event.args },
						},
					}));
					return;
				case "tool_execution_update":
					set((s) => {
						const run = s.toolRuns[event.toolCallId];
						if (!run) return s;
						return { toolRuns: { ...s.toolRuns, [event.toolCallId]: { ...run, partialResult: event.partialResult } } };
					});
					return;
				case "tool_execution_end":
					set((s) => ({
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
					}));
					return;
				case "session_info_changed":
					set((s) => (s.state ? { state: { ...s.state, sessionName: event.name } } : s));
					void get().refreshSessions();
					return;
				case "thinking_level_changed":
					set((s) => (s.state ? { state: { ...s.state, thinkingLevel: event.level } } : s));
					return;
				case "session_changed":
					void reloadMessages(event.state);
					return;
				case "notice":
					get().pushNotice(event.level, event.text);
					return;
				case "queue_update":
					return;
			}
		},
	};
});

// 开发模式下暴露 store，便于截图脚本注入示例数据检查样式
if (import.meta.env.DEV) (window as unknown as { __floworkStore: typeof useApp }).__floworkStore = useApp;
