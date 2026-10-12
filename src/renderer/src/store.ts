/**
 * 界面状态。
 *
 * - 项目：侧边栏中导入的工作区，列表由后端保存（~/.flowork/projects.json）。
 * - 每个打开过的项目有自己的 session worker 与会话状态切片（见 session-slice.ts）。
 *   当前项目的切片字段展开在 store 顶层；切换项目时把它移入 background，后台项目的任务继续运行、事件照常累积。
 * - 同一项目内的“新会话 / 切换历史会话”在同一个 worker 内通过 new_session / switch_session 完成。
 */
import { create } from "zustand";
import {
	type AppInfo,
	type ApprovalDecision,
	type ApprovalMode,
	type BackendPush,
	DEFAULT_APPROVAL_MODE,
	type ModelInfo,
	type Project,
	type ProjectsState,
	type SessionEvent,
	type SessionState,
	type SessionSummary,
	type ThinkingLevel,
} from "@shared/protocol";
import { api, errorText } from "./api/client";
import type { ConnectionStatus } from "./api/transport";
import { getRecentCwds } from "./lib/recent";
import { emptySlice, pickSlice, reduceEvent, type SessionSlice } from "./session-slice";

export type { PendingApproval, ToolRun } from "./session-slice";

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

export type View = "chat" | "settings";
export type RightPanel = "files" | "session" | "tree";
export type SettingsTab = "providers" | "custom" | "resources" | "preferences" | "raw";

/** 侧边栏显示的项目运行状态 */
export interface ProjectStatus {
	open: boolean;
	running: boolean;
	waiting: number;
	/** 后台任务已完成但还没查看 */
	unread: boolean;
}

interface AppState extends SessionSlice {
	info: AppInfo | null;
	connection: ConnectionStatus;
	view: View;
	settingsTab: SettingsTab;
	/** 配置变更计数，设置页据此刷新 */
	configVersion: number;
	/** 网页版文件夹选择器；mode = add 时导入为项目 */
	folderPicker: { open: boolean };
	discoverOpen: boolean;

	projects: ProjectsState;
	activeProjectId: string | null;
	/** 后台项目的会话切片 */
	background: Record<string, SessionSlice>;
	/** 各项目的会话列表（展开时加载） */
	projectSessions: Record<string, SessionSummary[]>;
	expanded: Record<string, boolean>;
	unread: Record<string, boolean>;

	notices: Notice[];
	approvalMode: ApprovalMode;
	/** 需要填入输入框的文本（回溯 / 分叉时返回的原消息）；seq 变化时输入框读取 */
	draft: { text: string; seq: number; append?: boolean };
	/** 右侧面板：项目文件 / 会话文件 / 会话树；null 表示收起 */
	rightPanel: RightPanel | null;
	/** 左侧项目栏是否展开（Ctrl+B） */
	sidebarOpen: boolean;
	/** Ctrl+P 快速打开文件弹窗 */
	quickOpen: boolean;
	/** 工作区文件可能变化时递增，文件面板据此刷新 */
	filesVersion: number;
	/** 技能 / 扩展可能变化时递增，斜杠命令与资源页据此刷新 */
	resourcesVersion: number;

	init(): Promise<void>;
	setView(view: View, tab?: SettingsTab): void;

	// 项目
	importProjects(): Promise<void>;
	closeFolderPicker(): void;
	addProjects(paths: string[], open?: boolean): Promise<void>;
	setDiscoverOpen(open: boolean): void;
	openProject(projectId: string, sessionPath?: string): Promise<void>;
	/** 停止项目的 pi 进程；当前项目会被关闭回到空白页 */
	stopProject(projectId: string): Promise<void>;
	removeProject(projectId: string): Promise<void>;
	toggleExpanded(projectId: string, expanded?: boolean): void;
	refreshProjectSessions(projectId: string): Promise<void>;
	projectStatus(projectId: string): ProjectStatus;
	newSessionIn(projectId: string): Promise<void>;

	// 当前项目的会话
	refreshSessions(): Promise<void>;
	loadModels(): Promise<void>;
	newSession(): Promise<void>;
	switchSession(path: string): Promise<void>;
	sendPrompt(text: string): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelInfo): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	setApprovalMode(mode: ApprovalMode): Promise<void>;
	respondApproval(toolCallId: string, decision: ApprovalDecision): Promise<void>;
	setRightPanel(panel: RightPanel | null): void;
	toggleSidebar(): void;
	setQuickOpen(open: boolean): void;
	openPreview(path: string | null): void;
	/** 把文本追加到输入框（例如引用文件路径） */
	insertIntoPrompt(text: string): void;
	refreshFiles(): void;
	loadTree(): Promise<void>;
	navigateTo(entryId: string): Promise<void>;
	forkFrom(entryId: string, position: "before" | "at"): Promise<void>;
	setLabel(entryId: string, label: string): Promise<void>;

	pushNotice(level: Notice["level"], text: string): void;
	dismissNotice(id: number): void;
	applyPush(push: BackendPush): void;
}

const LAST_PROJECT_KEY = "flowork.lastProject";
const LEGACY_LAST_CWD_KEY = "flowork.lastCwd";
const APPROVAL_KEY = "flowork.approvalMode";
const PANEL_KEY = "flowork.rightPanel";
const SIDEBAR_KEY = "flowork.sidebarOpen";
const EXPANDED_KEY = "flowork.expandedProjects";

function storedPanel(): RightPanel | null {
	const v = localStorage.getItem(PANEL_KEY);
	return v === "files" || v === "session" || v === "tree" ? v : null;
}

function storedApprovalMode(): ApprovalMode {
	const v = localStorage.getItem(APPROVAL_KEY);
	return v === "auto" || v === "ask_writes" || v === "ask_all" ? v : DEFAULT_APPROVAL_MODE;
}

function storedExpanded(): Record<string, boolean> {
	try {
		const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}") as unknown;
		return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
	} catch {
		return {};
	}
}

export function projectName(p: Project): string {
	return p.name || p.path.split(/[\\/]/).filter(Boolean).pop() || p.path;
}

let noticeSeq = 0;
let initialized = false;

export const useApp = create<AppState>()((set, get) => {
	// ----- 切片读写：当前项目在顶层，其他在 background -----

	function sliceOf(pid: string): SessionSlice | undefined {
		if (pid === get().activeProjectId) return pickSlice(get());
		return get().background[pid];
	}

	function patchSlice(pid: string, patch: Partial<SessionSlice> | ((s: SessionSlice) => Partial<SessionSlice> | null)) {
		set((st) => {
			if (pid === st.activeProjectId) {
				const p = typeof patch === "function" ? patch(pickSlice(st)) : patch;
				return p ?? st;
			}
			const current = st.background[pid];
			if (!current) return st;
			const p = typeof patch === "function" ? patch(current) : patch;
			return p ? { background: { ...st.background, [pid]: { ...current, ...p } } } : st;
		});
	}

	function projectByHandle(handleId: string): string | undefined {
		if (get().handleId === handleId) return get().activeProjectId ?? undefined;
		return Object.entries(get().background).find(([, s]) => s.handleId === handleId)?.[0];
	}

	function project(pid: string): Project | undefined {
		return get().projects.projects.find((p) => p.id === pid);
	}

	async function call<T>(pid: string, fn: (handleId: string) => Promise<T>): Promise<T | undefined> {
		const handleId = sliceOf(pid)?.handleId;
		if (!handleId) return undefined;
		try {
			return await fn(handleId);
		} catch (error) {
			get().pushNotice("error", errorText(error));
			return undefined;
		}
	}

	/** 对当前项目执行会话命令 */
	function active<T>(fn: (handleId: string) => Promise<T>): Promise<T | undefined> {
		const pid = get().activeProjectId;
		return pid ? call(pid, fn) : Promise.resolve(undefined);
	}

	async function reloadMessages(pid: string, state?: SessionState): Promise<void> {
		const messages = await call(pid, (h) => api.session(h, { type: "get_messages" }));
		patchSlice(pid, {
			messages: messages ?? [],
			streaming: null,
			toolArgsText: {},
			toolRuns: {},
			pendingApprovals: [],
			...(state ? { state } : {}),
		});
		if (pid === get().activeProjectId && get().rightPanel === "tree") void get().loadTree();
	}

	async function loadModelsFor(pid: string): Promise<void> {
		const models = await call(pid, (h) => api.session(h, { type: "get_available_models" }));
		patchSlice(pid, { models: models ?? [] });
	}

	function handleEvent(pid: string, event: SessionEvent): void {
		const isActive = pid === get().activeProjectId;
		patchSlice(pid, (s) => reduceEvent(s, event));
		const name = project(pid) ? projectName(project(pid) as Project) : "后台项目";
		switch (event.type) {
			case "agent_settled":
				void get().refreshProjectSessions(pid);
				if (isActive) {
					if (get().rightPanel === "tree") void get().loadTree();
					get().refreshFiles();
				} else {
					set((st) => ({ unread: { ...st.unread, [pid]: true } }));
					get().pushNotice("info", `「${name}」的任务已${event.aborted ? "中断" : "完成"}`);
				}
				return;
			case "tool_execution_end":
				if (isActive && ["write", "edit", "bash", "powershell"].includes(event.toolName)) get().refreshFiles();
				return;
			case "session_info_changed":
				void get().refreshProjectSessions(pid);
				return;
			case "session_changed":
				void reloadMessages(pid, event.state);
				if (isActive) set((st) => ({ resourcesVersion: st.resourcesVersion + 1 }));
				return;
			case "notice":
				if (isActive) get().pushNotice(event.level, event.text);
				else if (event.level === "error") get().pushNotice("error", `「${name}」${event.text}`);
				return;
			case "approval_request":
				if (!isActive) get().pushNotice("warning", `「${name}」正在等待你确认 ${event.toolName}`);
				return;
		}
	}

	return {
		...emptySlice(),
		info: null,
		connection: "connecting",
		view: "chat",
		settingsTab: "providers",
		configVersion: 0,
		folderPicker: { open: false },
		discoverOpen: false,
		projects: { projects: [], groups: [] },
		activeProjectId: null,
		background: {},
		projectSessions: {},
		expanded: storedExpanded(),
		unread: {},
		notices: [],
		approvalMode: storedApprovalMode(),
		draft: { text: "", seq: 0 },
		rightPanel: storedPanel(),
		sidebarOpen: localStorage.getItem(SIDEBAR_KEY) !== "0",
		quickOpen: false,
		filesVersion: 0,
		resourcesVersion: 0,

		async init() {
			if (initialized) return;
			initialized = true;
			api.onPush((push) => get().applyPush(push));
			let everOpened = false;
			api.onStatus((connection) => {
				set({ connection });
				// 网页版断线重连后，后端已关闭所有会话：清空后台项目，重新打开当前项目
				if (connection === "open" && everOpened) {
					const pid = get().activeProjectId;
					set({ background: {}, ...emptySlice() , activeProjectId: null });
					if (pid) void get().openProject(pid);
				}
				if (connection === "open") everOpened = true;
			});
			try {
				const [info, projects] = await Promise.all([api.info(), api.projects.get()]);
				set({ info, projects, connection: "open" });
				everOpened = true;
			} catch (error) {
				get().pushNotice("error", `无法连接本地后端：${errorText(error)}`);
				return;
			}
			// 从旧版本的“最近工作区”迁移为项目
			if (get().projects.projects.length === 0) {
				const legacy = [localStorage.getItem(LEGACY_LAST_CWD_KEY), ...getRecentCwds()].filter((p): p is string => !!p);
				if (legacy.length > 0) {
					const r = await api.projects.add([...new Set(legacy)]).catch(() => null);
					if (r) set({ projects: r.state });
				}
			}
			const { projects } = get().projects;
			const lastId = localStorage.getItem(LAST_PROJECT_KEY);
			const legacyCwd = localStorage.getItem(LEGACY_LAST_CWD_KEY);
			const last =
				projects.find((p) => p.id === lastId) ??
				(legacyCwd ? projects.find((p) => p.path.toLowerCase() === legacyCwd.toLowerCase()) : undefined);
			if (last && !last.missing) await get().openProject(last.id);
			for (const [id, open] of Object.entries(get().expanded)) if (open) void get().refreshProjectSessions(id);
		},

		setView(view, tab) {
			set(tab ? { view, settingsTab: tab } : { view });
		},

		// ----- 项目 -----

		async importProjects() {
			if (get().info?.nativeDialogs) {
				const dirs = await api.pickFolders().catch(() => []);
				if (dirs.length > 0) await get().addProjects(dirs, true);
			} else {
				set({ folderPicker: { open: true } });
			}
		},

		closeFolderPicker() {
			set({ folderPicker: { open: false } });
		},

		async addProjects(paths, open = true) {
			try {
				const r = await api.projects.add(paths);
				set({ projects: r.state, folderPicker: { open: false } });
				const existing = r.skipped
					.map((p) => r.state.projects.find((x) => x.path.toLowerCase() === p.toLowerCase().replace(/[\\/]+$/, "")))
					.filter((p): p is Project => !!p);
				if (r.added.length > 0) get().pushNotice("info", `已导入 ${r.added.length} 个项目`);
				const skippedNew = r.skipped.length - existing.length;
				if (skippedNew > 0) get().pushNotice("warning", `${skippedNew} 个路径不存在或不是文件夹，已跳过`);
				const target = r.added[0] ?? existing[0];
				if (open && target) await get().openProject(target.id);
			} catch (error) {
				get().pushNotice("error", `导入失败：${errorText(error)}`);
			}
		},

		setDiscoverOpen(open) {
			set({ discoverOpen: open });
		},

		async openProject(pid, sessionPath) {
			const target = project(pid);
			if (!target) return;
			set({ view: "chat" });
			if (pid !== get().activeProjectId || !get().handleId) {
				if (target.missing) {
					get().pushNotice("error", `文件夹不存在：${target.path}`);
					return;
				}
				// 当前项目移入后台（保留 pi 进程）
				const prevId = get().activeProjectId;
				const prev = pickSlice(get());
				const background = { ...get().background };
				if (prevId && prevId !== pid && prev.handleId) background[prevId] = prev;
				const restored = background[pid];
				delete background[pid];
				set({
					...(restored ?? { ...emptySlice(target.path), connecting: true }),
					background,
					activeProjectId: pid,
					unread: { ...get().unread, [pid]: false },
				});
				localStorage.setItem(LAST_PROJECT_KEY, pid);
				void api.projects.touch(pid).then((projects) => set({ projects })).catch(() => undefined);
				if (!restored) {
					try {
						// 未指定会话时继续该项目最近的会话
						let initialSession = sessionPath;
						if (!initialSession) {
							const sessions = await api.service({ type: "list_sessions", cwd: target.path }).catch(() => []);
							set((st) => ({ projectSessions: { ...st.projectSessions, [pid]: sessions } }));
							initialSession = sessions[0]?.path;
						}
						const { handleId, state } = await api.openSession(target.path, get().approvalMode, initialSession);
						if (get().activeProjectId !== pid) {
							// 打开过程中用户已切走：作为后台项目保留
							set((st) => ({ background: { ...st.background, [pid]: { ...emptySlice(target.path), handleId, state } } }));
						} else set({ handleId, state, connecting: false });
						await Promise.all([reloadMessages(pid), loadModelsFor(pid)]);
					} catch (error) {
						if (get().activeProjectId === pid) set({ connecting: false });
						get().pushNotice("error", `打开项目失败：${errorText(error)}`);
						return;
					}
				}
				void get().refreshProjectSessions(pid);
			}
			if (sessionPath && get().state?.sessionFile !== sessionPath) await get().switchSession(sessionPath);
		},

		async stopProject(pid) {
			const slice = sliceOf(pid);
			if (slice?.isRunning && !window.confirm("该项目有任务正在运行，停止后任务会中断。继续？")) return;
			if (slice?.handleId) await api.closeSession(slice.handleId).catch(() => undefined);
			if (pid === get().activeProjectId) set({ ...emptySlice(), activeProjectId: null });
			else
				set((st) => {
					const background = { ...st.background };
					delete background[pid];
					return { background };
				});
		},

		async removeProject(pid) {
			const p = project(pid);
			if (!p) return;
			if (!window.confirm(`从列表中移除「${projectName(p)}」？\n不会删除文件夹和会话记录，之后可以重新导入。`)) return;
			await get().stopProject(pid);
			try {
				set({ projects: await api.projects.remove(pid) });
			} catch (error) {
				get().pushNotice("error", errorText(error));
			}
		},

		toggleExpanded(pid, expanded) {
			const next = expanded ?? !get().expanded[pid];
			const map = { ...get().expanded, [pid]: next };
			localStorage.setItem(EXPANDED_KEY, JSON.stringify(map));
			set({ expanded: map });
			if (next) void get().refreshProjectSessions(pid);
		},

		async refreshProjectSessions(pid) {
			const p = project(pid);
			if (!p || p.missing) return;
			try {
				const sessions = await api.service({ type: "list_sessions", cwd: p.path });
				set((st) => ({ projectSessions: { ...st.projectSessions, [pid]: sessions } }));
			} catch {
				// 读取失败时保留旧列表
			}
		},

		projectStatus(pid) {
			const s = sliceOf(pid);
			return {
				open: !!s?.handleId,
				running: !!s?.isRunning,
				waiting: s?.pendingApprovals.length ?? 0,
				unread: !!get().unread[pid],
			};
		},

		async newSessionIn(pid) {
			await get().openProject(pid);
			if (get().activeProjectId === pid) await get().newSession();
			get().toggleExpanded(pid, true);
		},

		// ----- 当前项目的会话 -----

		async refreshSessions() {
			const pid = get().activeProjectId;
			if (pid) await get().refreshProjectSessions(pid);
		},

		async loadModels() {
			const pid = get().activeProjectId;
			if (pid) await loadModelsFor(pid);
		},

		async newSession() {
			const pid = get().activeProjectId;
			if (!pid) return;
			const state = await active((h) => api.session(h, { type: "new_session" }));
			if (state) await reloadMessages(pid, state);
			set({ view: "chat" });
			await get().refreshSessions();
		},

		async switchSession(path) {
			const pid = get().activeProjectId;
			if (!pid) return;
			if (get().isRunning) {
				get().pushNotice("warning", "当前会话正在运行，请先等待结束或按 Esc 中断");
				return;
			}
			const state = await active((h) => api.session(h, { type: "switch_session", sessionPath: path }));
			if (state) await reloadMessages(pid, state);
			set({ view: "chat" });
		},

		async sendPrompt(text) {
			const message = text.trim();
			if (!message) return;
			await active((h) => api.session(h, { type: "prompt", message }));
		},

		async abort() {
			await active((h) => api.session(h, { type: "abort" }));
		},

		async setModel(model) {
			const state = await active((h) => api.session(h, { type: "set_model", provider: model.provider, modelId: model.id }));
			if (state) set({ state });
		},

		async setThinkingLevel(level) {
			const state = await active((h) => api.session(h, { type: "set_thinking_level", level }));
			if (state) set({ state });
		},

		async setApprovalMode(mode) {
			localStorage.setItem(APPROVAL_KEY, mode);
			set({ approvalMode: mode });
			// 审批模式对所有已打开的项目生效
			const pids = [get().activeProjectId, ...Object.keys(get().background)].filter((p): p is string => !!p);
			await Promise.all(pids.map((pid) => call(pid, (h) => api.session(h, { type: "set_approval_mode", mode }))));
		},

		async respondApproval(toolCallId, decision) {
			set((s) => ({ pendingApprovals: s.pendingApprovals.filter((p) => p.toolCallId !== toolCallId) }));
			await active((h) => api.session(h, { type: "respond_approval", toolCallId, decision }));
		},

		setRightPanel(panel) {
			localStorage.setItem(PANEL_KEY, panel ?? "");
			set({ rightPanel: panel });
			if (panel === "tree") void get().loadTree();
		},

		toggleSidebar() {
			const next = !get().sidebarOpen;
			localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
			set({ sidebarOpen: next });
		},

		setQuickOpen(open) {
			set({ quickOpen: open && !!get().cwd });
		},

		openPreview(path) {
			set({ preview: path });
		},

		insertIntoPrompt(text) {
			set((s) => ({ draft: { text, seq: s.draft.seq + 1, append: true } }));
		},

		refreshFiles() {
			set((s) => ({ filesVersion: s.filesVersion + 1 }));
		},

		async loadTree() {
			const result = await active((h) => api.session(h, { type: "get_tree" }));
			if (result) set({ tree: result.tree, leafId: result.leafId });
		},

		async navigateTo(entryId) {
			if (get().isRunning) {
				get().pushNotice("warning", "请先等待当前运行结束，或按 Esc 中断");
				return;
			}
			const result = await active((h) => api.session(h, { type: "navigate_tree", entryId }));
			if (result?.editorText) set((s) => ({ draft: { text: result.editorText ?? "", seq: s.draft.seq + 1 } }));
		},

		async forkFrom(entryId, position) {
			if (get().isRunning) {
				get().pushNotice("warning", "请先等待当前运行结束，或按 Esc 中断");
				return;
			}
			const result = await active((h) => api.session(h, { type: "fork", entryId, position }));
			if (!result || result.cancelled) return;
			if (result.editorText) set((s) => ({ draft: { text: result.editorText ?? "", seq: s.draft.seq + 1 } }));
			get().pushNotice("info", "已分叉为新会话");
			await get().refreshSessions();
		},

		async setLabel(entryId, label) {
			await active((h) => api.session(h, { type: "set_label", entryId, label }));
			await get().loadTree();
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
				case "session_event": {
					const pid = projectByHandle(push.handleId);
					if (pid) handleEvent(pid, push.event);
					return;
				}
				case "session_exit": {
					const pid = projectByHandle(push.handleId);
					if (!pid) return;
					const name = project(pid) ? projectName(project(pid) as Project) : "项目";
					if (pid === get().activeProjectId) set({ handleId: null, isRunning: false, pendingApprovals: [] });
					else
						set((st) => {
							const background = { ...st.background };
							delete background[pid];
							return { background };
						});
					get().pushNotice("error", `「${name}」的 pi 进程已退出（code ${push.code}），重新点击项目即可再次打开`);
					return;
				}
				case "config_changed": {
					set((s) => ({ configVersion: s.configVersion + 1 }));
					const pids = [get().activeProjectId, ...Object.keys(get().background)].filter((p): p is string => !!p);
					for (const pid of pids) {
						void loadModelsFor(pid);
						void call(pid, (h) => api.session(h, { type: "get_state" })).then((state) => state && patchSlice(pid, { state }));
					}
					return;
				}
				case "projects_changed":
					set({ projects: push.state });
					return;
				case "resources_changed":
					set((st) => ({ resourcesVersion: st.resourcesVersion + 1 }));
					return;
				case "auth":
					// 由 authStore 处理
					return;
			}
		},
	};
});

// 开发模式下暴露 store，便于截图脚本注入示例数据检查样式
if (import.meta.env.DEV) (window as unknown as { __floworkStore: typeof useApp }).__floworkStore = useApp;
if (import.meta.env.DEV) (window as unknown as { __floworkApi: typeof api }).__floworkApi = api;
