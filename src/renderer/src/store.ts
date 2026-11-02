/**
 * 界面状态。
 *
 * - 项目：侧边栏中导入的工作区，列表由后端保存（~/.flowork/projects.json）。
 * - 每个打开的会话有自己的 session worker 与会话状态切片（见 session-slice.ts）。
 *   当前显示的会话字段展开在 store 顶层，其余打开中的会话按 handleId 存在 background，全部继续运行、事件照常累积。
 * - 一个项目可以同时打开多个会话（标签式）；「新会话」会新起一个 worker，点开历史会话也新开一个，可分别关闭。
 */
import { create } from "zustand";
import { displayUserText } from "@shared/skill-text";
import {
	type AppInfo,
	type ApprovalDecision,
	type ApprovalMode,
	type BackendPush,
	DEFAULT_APPROVAL_MODE,
	type GeneratedImage,
	type ImageAttachment,
	type ImageModelInfo,
	type ModelInfo,
	type Project,
	type ProjectsState,
	type SessionEvent,
	type SessionState,
	type SessionSummary,
	type SshHost,
	type ThinkingLevel,
	type WorkMode,
} from "@shared/protocol";
import { api, errorText, setHostKeyChangedHandler } from "./api/client";
import { askConfirm } from "./components/ConfirmDialog";
import { disposeTerminal } from "./components/terminal/terminal-disposer";
import { getRecentCwds } from "./lib/recent";
import { buildTree } from "./lib/session-tree";
import { emptySlice, pickSlice, reduceEvent, type SessionSlice, waitingCount } from "./session-slice";
import {
	applyTheme,
	resolveTheme,
	storedTheme,
	storeTheme,
	syncDesktopTheme,
	watchSystemTheme,
	type ResolvedTheme,
	type ThemeMode,
} from "./theme";
import {
	applyAppearance,
	normalizeAppearance,
	storeAppearance,
	storedAppearance,
	type Appearance,
} from "./appearance";
import { loadStoredImage, saveStoredImage } from "./background-image";

export type { ExtWidget, PendingApproval, ToolRun } from "./session-slice";
export { waitingCount } from "./session-slice";

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

export type View = "welcome" | "chat" | "review" | "settings" | "imagegen" | "gallery" | "database";
export type RightPanel = "files" | "execution" | "session" | "server" | "services" | "browser";
export type SettingsTab = "custom" | "resources" | "mcp" | "preferences" | "subagent" | "appearance" | "raw" | "kernel";
/** 命令面板的初始分类：全部 / 命令 / 文件 / 会话 */
export type PaletteMode = "all" | "commands" | "files" | "sessions";
/** 底部面板的页签 */
export type BottomTab = "terminal" | "output" | "logs";

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
	connection: "connecting" | "open" | "error";
	view: View;
	settingsTab: SettingsTab;
	/** 界面主题：深色 / 浅色 / 跟随系统 */
	theme: ThemeMode;
	/** 实际生效的深浅色（theme = system 时由系统决定） */
	resolvedTheme: ResolvedTheme;
	/** 外观偏好：字体与字号 / 强调色 / 窗口背景 / 辅助功能 */
	appearance: Appearance;
	/** 图片生成：已配置的图片模型（models.json 里的 imageModels） */
	imageModels: ImageModelInfo[];
	/** 生成历史（新→旧）；图片本体在本机缓存目录，这里只有元数据 */
	images: GeneratedImage[];
	/** 正在生成 */
	imageBusy: boolean;
	/** 输入框里待发送的图片；图片生成模块会把生成的图片放进这里 */
	pendingImages: ImageAttachment[];
	/** 图片库侧栏的筛选：all | favorite | week | model:<key> */
	imageFilter: string;
	/** 生成记录的收藏标记（只存在本机，不进 models.json） */
	imageFavorites: Record<string, boolean>;
	/** 配置变更计数，设置页据此刷新 */
	configVersion: number;
	discoverOpen: boolean;

	projects: ProjectsState;
	/** SSH 主机列表（远程项目用） */
	hosts: SshHost[];
	/** 添加远程项目对话框是否打开 */
	remoteOpen: boolean;
	/** 主机密钥已变化：等待用户比对指纹并确认（hostId） */
	hostKeyPrompt: string | null;
	/** 更新指纹后要重试的动作（例如重新连接主机） */
	hostKeyRetry: (() => void) | null;
	activeProjectId: string | null;
	/** 未显示的打开会话切片，按 handleId 索引；当前显示的会话字段在 store 顶层 */
	background: Record<string, SessionSlice>;
	/** 项目 -> 打开中的 handleId（含当前显示的），按打开顺序 */
	projectHandles: Record<string, string[]>;
	/** 项目 -> 上次查看的 handleId（切回项目时恢复） */
	projectActive: Record<string, string>;
	/** 各项目的会话列表（展开时加载） */
	projectSessions: Record<string, SessionSummary[]>;
	sessionOperations: Record<string, "rename" | "delete">;
	sessionOperation(projectId: string, path: string): "rename" | "delete" | undefined;
	sessionBusy(projectId: string, path: string): boolean;
	renameSession(projectId: string, path: string, name: string): Promise<void>;
	deleteSession(projectId: string, path: string): Promise<void>;
	expanded: Record<string, boolean>;
	unread: Record<string, boolean>;

	notices: Notice[];
	approvalMode: ApprovalMode;
	/** 需要填入输入框的文本（回溯 / 分叉时返回的原消息，或从队列取回的消息）；seq 变化时输入框读取 */
	draft: { text: string; images?: ImageAttachment[]; seq: number; append?: boolean };
	/** 版本更新提示：启动时发现版本变化则置为当前版本号，null 表示不弹 */
	updatedTo: string | null;
	/** 右侧面板：项目文件 / 会话文件 / 浏览器；null 表示收起 */
	rightPanel: RightPanel | null;
	/** 会话树窄轨是否显示（贴会话区右缘） */
	railVisible: boolean;
	/** 会话记录里历史轮次的「思考 + 工具调用」是否折叠成一行（运行中的一轮始终展开） */
	foldProcess: boolean;
	/** 左侧项目栏是否展开（Ctrl+B） */
	sidebarOpen: boolean;
	/** Ctrl+P 快速打开文件弹窗 */
	quickOpen: boolean;
	/** Ctrl+K 命令面板 */
	palette: { open: boolean; query: string; mode: PaletteMode };
	/** 底部面板（终端 / 输出 / pi 日志）是否展开 */
	terminalPanel: boolean;
	panelTab: BottomTab;
	/** 工作区文件可能变化时递增，文件面板据此刷新 */
	filesVersion: number;
	/** 技能 / 扩展可能变化时递增，斜杠命令与资源页据此刷新 */
	resourcesVersion: number;

	init(): Promise<void>;
	setView(view: View, tab?: SettingsTab): void;
	/** 切换界面主题（深色 / 浅色 / 跟随系统），立即生效并持久化 */
	setTheme(mode: ThemeMode): void;
	/** 更新外观偏好（字体与字号 / 强调色 / 窗口背景 / 辅助功能），立即生效并持久化 */
	setAppearance(patch: Partial<Appearance>): void;

	// 图片生成
	/** 重新读取图片模型与生成历史 */
	loadImages(): Promise<void>;
	/** 生成图片：走 models.json 里该供应商的 OpenAI 兼容图片接口 */
	generateImages(input: {
		model?: string;
		prompt: string;
		size?: string;
		quality?: "standard" | "hd";
		count?: number;
		reference?: { dataBase64: string; mimeType: string };
	}): Promise<GeneratedImage[]>;
	removeImage(id: string): Promise<void>;
	clearImages(): Promise<void>;
	/** 把缓存里的图片放进输入框，作为下一条消息的附件 */
	attachImage(id: string): Promise<void>;
	setPendingImages(images: ImageAttachment[]): void;
	setImageFilter(filter: string): void;
	toggleImageFavorite(id: string): void;

	// 项目
	importProjects(): Promise<void>;
	addProjects(paths: string[], open?: boolean): Promise<void>;
	/** 添加并打开一个远程项目（服务器上的目录） */
	addRemoteProject(hostId: string, path: string, name?: string): Promise<void>;
	setRemoteOpen(open: boolean): void;
	setHostKeyPrompt(hostId: string | null, retry?: () => void): void;
	setDiscoverOpen(open: boolean): void;
	openProject(projectId: string, sessionPath?: string): Promise<void>;
	/** 停止项目的 pi 进程；当前项目会被关闭回到空白页 */
	stopProject(projectId: string): Promise<void>;
	removeProject(projectId: string): Promise<void>;
	toggleExpanded(projectId: string, expanded?: boolean): void;
	refreshProjectSessions(projectId: string): Promise<void>;
	projectStatus(projectId: string): ProjectStatus;
	newSessionIn(projectId: string): Promise<void>;
	/** 在指定项目里打开一个会话（sessionPath 为空则新草稿）；新起 worker，不影响已在运行的会话 */
	openSessionIn(projectId: string, sessionPath?: string): Promise<void>;
	/** 切换到某个已打开的会话 */
	activateSession(handleId: string): void;
	/** 关闭某个已打开的会话（运行中会先确认） */
	closeSession(handleId: string): Promise<void>;

	// 当前项目的会话
	refreshSessions(): Promise<void>;
	loadModels(): Promise<void>;
	newSession(): Promise<void>;
	switchSession(path: string): Promise<void>;
	sendPrompt(text: string, images?: ImageAttachment[], streamingBehavior?: "steer" | "followUp"): Promise<void>;
	/** 清空排队消息并填回输入框 */
	dequeue(): Promise<void>;
	/** 调整排队消息顺序（steering / followUp 各自内部重排） */
	reorderQueue(steering: string[], followUp: string[]): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelInfo): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	setApprovalMode(mode: ApprovalMode): Promise<void>;
	setWorkMode(mode: WorkMode): Promise<void>;
	respondApproval(toolCallId: string, decision: ApprovalDecision): Promise<void>;
	/** 应答扩展对话框；response 为空表示取消 */
	respondExtUI(id: string, response: { value?: string; confirmed?: boolean } | null): Promise<void>;
	setRightPanel(panel: RightPanel | null): void;
	/** 显示 / 隐藏会话树窄轨 */
	toggleRail(): void;
	/** 折叠 / 展开会话记录里历史轮次的思考与工具调用 */
	toggleFoldProcess(): void;
	toggleSidebar(): void;
	setQuickOpen(open: boolean): void;
	setPalette(open: boolean, mode?: PaletteMode): void;
	setTerminalPanel(open: boolean): void;
	setPanelTab(tab: BottomTab): void;
	openPreview(path: string | null, hostId?: string | null): void;
	/** 把文本追加到输入框（例如引用文件路径） */
	insertIntoPrompt(text: string): void;
	/** 显示 / 关闭「已更新到」弹窗；传 null 关闭 */
	setUpdatedTo(version: string | null): void;
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
/** 上次运行过的版本号：与当前版本不同就弹一次更新说明 */
const LAST_VERSION_KEY = "flowork.lastVersion";
const APPROVAL_KEY = "flowork.approvalMode";
const PANEL_KEY = "flowork.rightPanel";
const RAIL_KEY = "flowork.sessionRail";
const FOLD_PROCESS_KEY = "flowork.foldProcess";
const SIDEBAR_KEY = "flowork.sidebarOpen";
const EXPANDED_KEY = "flowork.expandedProjects";
/** 图库收藏：按图片 id 记录，与缓存文件生命周期解耦（清空缓存后收藏保留） */
const IMAGE_FAVORITES_KEY = "flowork.imageFavorites";

function storedPanel(): RightPanel | null {
	const v = localStorage.getItem(PANEL_KEY);
	return v === "files" || v === "session" || v === "server" || v === "services" || v === "browser" ? v : null;
}

/** 会话树窄轨默认显示；只有显式关过才隐藏 */
function storedRail(): boolean {
	return localStorage.getItem(RAIL_KEY) !== "0";
}

/** 历史轮次的思考与工具调用默认折叠，只留结论；显式关过就默认展开 */
function storedFoldProcess(): boolean {
	return localStorage.getItem(FOLD_PROCESS_KEY) !== "0";
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

function storedImageFavorites(): Record<string, boolean> {
	try {
		const v = JSON.parse(localStorage.getItem(IMAGE_FAVORITES_KEY) ?? "{}") as unknown;
		if (!v || typeof v !== "object") return {};
		// 只保留 true，避免旧数据里的 false / 非布尔值把文件撑大
		const out: Record<string, boolean> = {};
		for (const [id, value] of Object.entries(v)) if (value === true) out[id] = true;
		return out;
	} catch {
		return {};
	}
}

export function projectName(p: Project): string {
	return p.name || p.path.split(/[\\/]/).filter(Boolean).pop() || p.path;
}

export function normalizedPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** 一个项目里打开中的会话（供侧边栏渲染，字段均为基本类型，便于 useShallow 比较） */
export interface OpenSession {
	handleId: string;
	name: string;
	running: boolean;
	waiting: number;
	active: boolean;
	draft: boolean;
}

export function selectOpenSession(s: AppState, handleId: string): OpenSession {
	const slice: SessionSlice | undefined = s.handleId === handleId ? s : s.background[handleId];
	const first = slice?.messages.find((m) => m.role === "user");
	const firstPrompt = first?.role === "user"
		? displayUserText(first.content.map((b) => (b.type === "text" ? b.text : "")).join("")).slice(0, 80)
		: "";
	return {
		handleId,
		name: slice?.state?.sessionName || firstPrompt,
		running: !!slice?.isRunning,
		waiting: slice ? waitingCount(slice) : 0,
		active: s.handleId === handleId,
		draft: !slice?.state?.sessionFile,
	};
}

function operationKey(cwd: string, path: string): string {
	return JSON.stringify([normalizedPath(cwd), normalizedPath(path)]);
}

let noticeSeq = 0;
let initialized = false;

/** 错误文本里带 HOST_KEY_CHANGED 前缀时取出 hostId（错误可能被包在「打开项目失败：」等前缀之后，或被 JSON 转义） */
export function hostKeyChangedHost(text: string): string | null {
	const m = /FLOWORK_HOST_KEY_CHANGED:([\w-]+)/.exec(text);
	return m ? (m[1] ?? null) : null;
}

/** 启动时把 IndexedDB 里的背景图读出来换成 object URL；顺带迁移旧版存在 localStorage 的 data URL */
async function restoreBackgroundImage(): Promise<void> {
	const current = useApp.getState().appearance;
	// 旧版把图片以 data URL 存进 localStorage：搬到 IndexedDB 后才能清掉那份大副本。
	// 必须先写成功并读回校验：写库失败而 localStorage 副本又被清掉，这张图就永久丢了。
	if (current.bgImage.startsWith("data:")) {
		try {
			const blob = await (await fetch(current.bgImage)).blob();
			await saveStoredImage(blob);
			const stored = await loadStoredImage();
			if (!stored || stored.size !== blob.size) throw new Error("图片未能写入本机数据库");
			// 迁移成功：换成 object URL，storeAppearance 会顺手清掉 localStorage 里的 data URL
			useApp.getState().setAppearance({ bgImage: URL.createObjectURL(stored) });
		} catch {
			// 迁移失败：保留 localStorage 里的 data URL（它同样能当壁纸用），下次启动再试一次
			useApp.getState().pushNotice("warning", "背景图暂时没能存进本机数据库，本次仍会显示；下次启动会自动重试。");
		}
		return;
	}
	const blob = await loadStoredImage();
	if (blob) useApp.getState().setAppearance({ bgImage: URL.createObjectURL(blob) });
}

export const useApp = create<AppState>()((set, get) => {
	// ----- 切片读写：当前显示的会话在顶层，其他打开中的会话在 background（按 handleId） -----

	function sliceOfHandle(handleId: string): SessionSlice | undefined {
		if (get().handleId === handleId) return pickSlice(get());
		return get().background[handleId];
	}

	function patchHandle(handleId: string, patch: Partial<SessionSlice> | ((s: SessionSlice) => Partial<SessionSlice> | null)) {
		set((st) => {
			if (st.handleId === handleId) {
				const p = typeof patch === "function" ? patch(pickSlice(st)) : patch;
				return p ?? st;
			}
			const current = st.background[handleId];
			if (!current) return st;
			const p = typeof patch === "function" ? patch(current) : patch;
			return p ? { background: { ...st.background, [handleId]: { ...current, ...p } } } : st;
		});
	}

	/** 只更新请求发起时的会话；同一 worker 已切换记录或关闭时丢弃旧结果。 */
	function sessionPatcher(handleId: string) {
		const sessionId = sliceOfHandle(handleId)?.state?.sessionId;
		return (patch: Partial<SessionSlice>) => patchHandle(handleId,
			(s) => s.state?.sessionId === sessionId ? patch : null);
	}

	const pendingDrafts = new Map<string, { sessionId: string | undefined; draft: Omit<AppState["draft"], "seq"> }>();
	function deliverDraft(handleId: string, sessionId: string | undefined, draft: Omit<AppState["draft"], "seq">) {
		const slice = sliceOfHandle(handleId);
		if (!slice || slice.state?.sessionId !== sessionId) return;
		if (get().handleId === handleId) set((s) => ({ draft: { ...draft, seq: s.draft.seq + 1 } }));
		else pendingDrafts.set(handleId, { sessionId, draft });
	}

	const treeRequests = new Map<string, symbol>();
	async function loadTreeFor(handleId: string): Promise<void> {
		const token = Symbol();
		treeRequests.set(handleId, token);
		const patch = sessionPatcher(handleId);
		try {
			const result = await call(handleId, (h) => api.session(h, { type: "get_tree" }));
			if (result && treeRequests.get(handleId) === token) patch({ tree: buildTree(result.tree), leafId: result.leafId });
		} finally {
			if (treeRequests.get(handleId) === token) treeRequests.delete(handleId);
		}
	}

	/** 所有打开中的会话切片：[handleId, slice] */
	function allSlices(): Array<[string, SessionSlice]> {
		const st = get();
		const out: Array<[string, SessionSlice]> = [];
		if (st.handleId) out.push([st.handleId, pickSlice(st)]);
		for (const [handleId, slice] of Object.entries(st.background)) out.push([handleId, slice]);
		return out;
	}

	function projectByHandle(handleId: string): string | undefined {
		const st = get();
		if (st.handleId === handleId) return st.activeProjectId ?? undefined;
		for (const [pid, handles] of Object.entries(st.projectHandles)) if (handles.includes(handleId)) return pid;
		return undefined;
	}

	/** 把当前显示的会话收回 background（保留其进程与状态） */
	function moveActiveToBackground(): void {
		set((st) => {
			if (!st.handleId) return st;
			const background = { ...st.background };
			if (!background[st.handleId]) background[st.handleId] = pickSlice(st);
			const pid = st.activeProjectId;
			return { background, ...(pid ? { projectActive: { ...st.projectActive, [pid]: st.handleId } } : {}) };
		});
	}

	/** 登记一个新打开的会话（不切换显示） */
	function registerHandle(pid: string, handleId: string, slice: SessionSlice): void {
		set((st) => ({
			background: { ...st.background, [handleId]: slice },
			projectHandles: { ...st.projectHandles, [pid]: [...(st.projectHandles[pid] ?? []).filter((h) => h !== handleId), handleId] },
		}));
	}

	function project(pid: string): Project | undefined {
		return get().projects.projects.find((p) => p.id === pid);
	}

	const projectEpochs = new Map<string, number>();
	const historyRequests = new Map<string, number>();

	function advanceProject(pid: string): number {
		const epoch = (projectEpochs.get(pid) ?? 0) + 1;
		projectEpochs.set(pid, epoch);
		return epoch;
	}

	function matchesFile(slice: SessionSlice | undefined, cwd: string, path: string): boolean {
		return !!slice?.state?.sessionFile && normalizedPath(slice.cwd ?? "") === normalizedPath(cwd) &&
			normalizedPath(slice.state.sessionFile) === normalizedPath(path);
	}

	function owners(cwd: string, path: string): Array<[string, SessionSlice]> {
		return allSlices().filter(([, slice]) => matchesFile(slice, cwd, path));
	}

	/** 关闭一个会话：从打开列表移除；若关闭的是当前显示的，则切到同项目下一个或清空 */
	function clearOwner(handleId: string): void {
		treeRequests.delete(handleId);
		pendingDrafts.delete(handleId);
		const pid = projectByHandle(handleId);
		set((st) => {
			const background = { ...st.background };
			delete background[handleId];
			const projectHandles = { ...st.projectHandles };
			const projectActive = { ...st.projectActive };
			let next: { handleId: string; slice: SessionSlice } | undefined;
			if (pid) {
				const rest = (projectHandles[pid] ?? []).filter((h) => h !== handleId);
				if (rest.length > 0) {
					projectHandles[pid] = rest;
					if (projectActive[pid] === handleId && rest[0]) projectActive[pid] = rest[0];
				} else {
					delete projectHandles[pid];
					delete projectActive[pid];
				}
				if (st.handleId === handleId) {
					const nextHandle = rest[0];
					const slice = nextHandle ? background[nextHandle] : undefined;
					if (nextHandle && slice) {
						delete background[nextHandle];
						next = { handleId: nextHandle, slice };
					}
				}
			}
			const unread = pid ? { ...st.unread, [pid]: false } : st.unread;
			if (next) return { ...next.slice, background, projectHandles, projectActive, unread };
			if (st.handleId === handleId) {
				return {
					...emptySlice(pid && project(pid) ? (project(pid) as Project).path : st.cwd),
					draft: { text: "", seq: st.draft.seq + 1 },
					background,
					projectHandles,
					projectActive,
					unread,
				};
			}
			return { background, projectHandles, projectActive, unread };
		});
	}

	async function refreshHistory(cwd: string): Promise<void> {
		await Promise.all(get().projects.projects.filter((p) => normalizedPath(p.path) === normalizedPath(cwd))
			.map((p) => get().refreshProjectSessions(p.id)));
	}

	function finishOperation(key: string): void {
		set((st) => {
			const sessionOperations = { ...st.sessionOperations };
			delete sessionOperations[key];
			return { sessionOperations };
		});
	}

	async function call<T>(handleId: string, fn: (handleId: string) => Promise<T>): Promise<T | undefined> {
		try {
			return await fn(handleId);
		} catch (error) {
			get().pushNotice("error", errorText(error));
			return undefined;
		}
	}

	/** 对当前显示的会话执行命令 */
	function active<T>(fn: (handleId: string) => Promise<T>): Promise<T | undefined> {
		const handleId = get().handleId;
		return handleId ? call(handleId, fn) : Promise.resolve(undefined);
	}

	async function reloadMessages(handleId: string, state?: SessionState): Promise<void> {
		const owner = sliceOfHandle(handleId);
		if (!owner) return;
		if (state) patchHandle(handleId, { state });
		const file = (state ?? owner.state)?.sessionFile;
		const messages = await call(handleId, (h) => api.session(h, { type: "get_messages" }));
		patchHandle(handleId, (s) => s.handleId === handleId && s.state?.sessionFile === file ? {
			messages: messages ?? [],
			streaming: null,
			toolArgsText: {},
			toolRuns: {},
			pendingApprovals: [],
		} : null);
		if (handleId === get().handleId && get().railVisible) void get().loadTree();
	}

	async function loadModelsFor(handleId: string): Promise<void> {
		const models = await call(handleId, (h) => api.session(h, { type: "get_available_models" }));
		patchHandle(handleId, (s) => s.handleId === handleId ? { models: models ?? [] } : null);
	}

	function handleEvent(handleId: string, event: SessionEvent): void {
		const pid = projectByHandle(handleId);
		const isActive = handleId === get().handleId;
		patchHandle(handleId, (s) => reduceEvent(s, event));
		const name = pid && project(pid) ? projectName(project(pid) as Project) : "会话";
		switch (event.type) {
			case "agent_settled":
				if (pid) void get().refreshProjectSessions(pid);
				if (isActive) {
					if (get().railVisible) void get().loadTree();
					get().refreshFiles();
				} else {
					if (pid) set((st) => ({ unread: { ...st.unread, [pid]: true } }));
					get().pushNotice("info", `「${name}」的任务已${event.aborted ? "中断" : "完成"}`);
				}
				return;
			case "tool_execution_end": {
				if (isActive && ["write", "edit", "bash", "powershell"].includes(event.toolName)) get().refreshFiles();
				const hostKey = event.isError ? hostKeyChangedHost(JSON.stringify(event.result ?? "")) : null;
				if (hostKey) set({ hostKeyPrompt: hostKey });
				return;
			}
			case "session_info_changed":
				if (pid) void get().refreshProjectSessions(pid);
				return;
			case "session_changed":
				void reloadMessages(handleId, event.state);
				if (isActive) set((st) => ({ resourcesVersion: st.resourcesVersion + 1 }));
				return;
			case "notice":
				if (isActive) get().pushNotice(event.level, event.text);
				else if (event.level === "error") get().pushNotice("error", `「${name}」${event.text}`);
				return;
			case "approval_request":
				if (!isActive) get().pushNotice("warning", `「${name}」正在等待你确认 ${event.toolName}`);
				return;
			case "ext_ui_request":
				if (!isActive) get().pushNotice("warning", `「${name}」的扩展正在等待你回应：${event.request.title}`);
				return;
			case "ext_editor_text":
				if (isActive) set((st) => ({ draft: { text: event.text, seq: st.draft.seq + 1 } }));
				return;
		}
	}

	// 系统深浅色变化时，仅在「跟随系统」模式下重新应用
	watchSystemTheme(() => {
		if (get().theme !== "system") return;
		set({ resolvedTheme: applyTheme("system") });
	});

	return {
		...emptySlice(),
		info: null,
		connection: "connecting",
		// 启动时先进入欢迎页（环境自检 + 发现项目）；已导入过项目时 init() 会直接进入会话
		view: "welcome",
		settingsTab: "custom",
		theme: storedTheme(),
		appearance: storedAppearance(),
		imageModels: [],
		images: [],
		imageBusy: false,
		pendingImages: [],
		imageFilter: "all",
		imageFavorites: storedImageFavorites(),
		resolvedTheme: resolveTheme(storedTheme()),
		configVersion: 0,
		discoverOpen: false,
		projects: { projects: [], groups: [] },
		hosts: [],
		remoteOpen: false,
		hostKeyPrompt: null,
		hostKeyRetry: null,
		activeProjectId: null,
		background: {},
		projectHandles: {},
		projectActive: {},
		projectSessions: {},
		sessionOperations: {},
		expanded: storedExpanded(),
		unread: {},
		notices: [],
		approvalMode: storedApprovalMode(),
		draft: { text: "", seq: 0 },
		updatedTo: null,
		rightPanel: storedPanel(),
		railVisible: storedRail(),
		foldProcess: storedFoldProcess(),
		sidebarOpen: localStorage.getItem(SIDEBAR_KEY) !== "0",
		quickOpen: false,
		palette: { open: false, query: "", mode: "all" },
		terminalPanel: false,
		panelTab: "terminal",
		filesVersion: 0,
		resourcesVersion: 0,

		async init() {
			if (initialized) return;
			initialized = true;
			void restoreBackgroundImage();
			api.onPush((push) => get().applyPush(push));
			try {
				const [info, projects] = await Promise.all([api.info(), api.projects.get()]);
				set({ info, projects, connection: "open" });
				// 版本变了才弹更新说明（首次运行只记下版本，不打扰）
				const lastVersion = localStorage.getItem(LAST_VERSION_KEY);
				localStorage.setItem(LAST_VERSION_KEY, info.version);
				if (lastVersion && lastVersion !== info.version) set({ updatedTo: info.version });
				void api.hosts.list().then((hosts) => set({ hosts })).catch(() => undefined);
			} catch (error) {
				set({ connection: "error" });
				get().pushNotice("error", `桌面后端初始化失败：${errorText(error)}`);
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

		setTheme(mode) {
			storeTheme(mode);
			set({ theme: mode, resolvedTheme: applyTheme(mode) });
			syncDesktopTheme(mode);
		},

		setAppearance(patch) {
			const next = applyAppearance(normalizeAppearance({ ...get().appearance, ...patch }));
			storeAppearance(next);
			set({ appearance: next });
		},

		async loadImages() {
			const [imageModels, images] = await Promise.all([api.images.models(), api.images.list()]);
			set({ imageModels, images });
		},

		async generateImages(input) {
			set({ imageBusy: true });
			try {
				const created = await api.images.generate(input);
				set({ images: await api.images.list() });
				return created;
			} finally {
				set({ imageBusy: false });
			}
		},

		async removeImage(id) {
			await api.images.remove(id);
			set({ images: await api.images.list() });
		},

		async clearImages() {
			await api.images.clear();
			set({ images: [] });
		},

		async attachImage(id) {
			const file = await api.images.read(id);
			const image: ImageAttachment = { type: "image", mimeType: file.mimeType, data: file.dataBase64 };
			set({ pendingImages: [...get().pendingImages, image] });
		},

		setPendingImages(images) {
			set({ pendingImages: images });
		},

		setImageFilter(imageFilter) {
			set({ imageFilter });
		},

		toggleImageFavorite(id) {
			const next = { ...get().imageFavorites };
			if (next[id]) delete next[id];
			else next[id] = true;
			set({ imageFavorites: next });
			try {
				localStorage.setItem(IMAGE_FAVORITES_KEY, JSON.stringify(next));
			} catch {
				// 配额耗尽时收藏只在本次运行有效，不阻断界面操作
			}
		},

		// ----- 项目 -----

		async importProjects() {
			const dirs = await api.pickFolders().catch(() => []);
			if (dirs.length > 0) await get().addProjects(dirs, true);
		},

		async addProjects(paths, open = true) {
			try {
				const r = await api.projects.add(paths);
				set({ projects: r.state });
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

		async addRemoteProject(hostId, path, name) {
			try {
				const r = await api.projects.addRemote(hostId, path, name);
				set({ projects: r.state, remoteOpen: false });
				get().pushNotice("info", `已添加远程项目：${r.project.path}`);
				await get().openProject(r.project.id);
			} catch (error) {
				get().pushNotice("error", `添加远程项目失败：${errorText(error)}`);
			}
		},

		setRemoteOpen(open) {
			set({ remoteOpen: open });
		},

		setHostKeyPrompt(hostId, retry) {
			// 已经打开时保留先前登记的重试动作，除非这次给了新的
			set((s) => ({ hostKeyPrompt: hostId, hostKeyRetry: hostId ? (retry ?? (s.hostKeyPrompt === hostId ? s.hostKeyRetry : null)) : null }));
		},

		setDiscoverOpen(open) {
			set({ discoverOpen: open });
		},

		setUpdatedTo(version) {
			set({ updatedTo: version });
		},

		async openProject(pid, sessionPath) {
			const target = project(pid);
			if (!target) return;
			if (sessionPath && get().sessionOperation(pid, sessionPath)) return;
			if (pid === get().activeProjectId && get().connecting) return;
			const prevId = get().activeProjectId;
			if (prevId && prevId !== pid) advanceProject(prevId);
			advanceProject(pid);
			set({ view: "chat" });

			// 指定会话：已打开就切过去，否则新开一个（不替换当前会话）
			if (sessionPath) {
				const existing = owners(target.path, sessionPath)[0];
				if (existing) {
					get().activateSession(existing[0]);
					return;
				}
				await get().openSessionIn(pid, sessionPath);
				return;
			}

			// 项目已有打开中的会话：切回上次查看的那个
			const handles = get().projectHandles[pid] ?? [];
			if (handles.length > 0) {
				const handleId = get().projectActive[pid] ?? handles[0];
				if (handleId) get().activateSession(handleId);
				localStorage.setItem(LAST_PROJECT_KEY, pid);
				void api.projects.touch(pid).then((projects) => set({ projects })).catch(() => undefined);
				void get().refreshProjectSessions(pid);
				return;
			}

			// 项目还没打开过任何会话：继续最近的会话
			if (target.missing) {
				get().pushNotice("error", `文件夹不存在：${target.path}`);
				return;
			}
			const sessions = await api.service({ type: "list_sessions", cwd: target.path }).catch(() => []);
			set((st) => ({ projectSessions: { ...st.projectSessions, [pid]: sessions } }));
			await get().openSessionIn(pid, sessions[0]?.path);
		},

		async openSessionIn(pid, sessionPath) {
			const target = project(pid);
			if (!target) return;
			if (target.missing) {
				get().pushNotice("error", `文件夹不存在：${target.path}`);
				return;
			}
			// 当前项目正在连接中：避免重复打开
			if (pid === get().activeProjectId && get().connecting) return;
			// 同一个历史会话已经打开：直接切过去
			if (sessionPath) {
				const existing = owners(target.path, sessionPath)[0];
				if (existing) {
					get().activateSession(existing[0]);
					return;
				}
			}
			const epoch = advanceProject(pid);
			// 把当前显示的会话收回后台，腾出顶层
			moveActiveToBackground();
			set({ ...emptySlice(target.path), connecting: true, activeProjectId: pid, view: "chat", unread: { ...get().unread, [pid]: false } });
			localStorage.setItem(LAST_PROJECT_KEY, pid);
			void api.projects.touch(pid).then((projects) => set({ projects })).catch(() => undefined);
			try {
				const { handleId, state } = await api.openSession(target.path, get().approvalMode, sessionPath);
				if (projectEpochs.get(pid) !== epoch) {
					await api.closeSession(handleId).catch(() => undefined);
					return;
				}
				registerHandle(pid, handleId, { ...emptySlice(target.path), handleId, state });
				if (get().activeProjectId === pid) get().activateSession(handleId);
				await Promise.all([reloadMessages(handleId), loadModelsFor(handleId)]);
			} catch (error) {
				if (get().activeProjectId === pid && projectEpochs.get(pid) === epoch) set({ connecting: false });
				get().pushNotice("error", `打开会话失败：${errorText(error)}`);
				return;
			}
			void get().refreshProjectSessions(pid);
		},

		activateSession(handleId) {
			const pid = projectByHandle(handleId);
			if (!pid) return;
			set((st) => {
				if (st.handleId === handleId) {
					return st.activeProjectId === pid
						? { unread: { ...st.unread, [pid]: false } }
						: { activeProjectId: pid, unread: { ...st.unread, [pid]: false } };
				}
				const incoming = st.background[handleId];
				if (!incoming) return st;
				const background = { ...st.background };
				delete background[handleId];
				if (st.handleId) background[st.handleId] = pickSlice(st);
				return {
					...incoming,
					background,
					activeProjectId: pid,
					projectActive: { ...st.projectActive, [pid]: handleId },
					unread: { ...st.unread, [pid]: false },
				};
			});
			set({ view: "chat" });
			const pending = pendingDrafts.get(handleId);
			pendingDrafts.delete(handleId);
			if (pending) deliverDraft(handleId, pending.sessionId, pending.draft);
			localStorage.setItem(LAST_PROJECT_KEY, pid);
			void api.projects.touch(pid).then((projects) => set({ projects })).catch(() => undefined);
			if (get().railVisible) void get().loadTree();
			get().refreshFiles();
		},

		async closeSession(handleId) {
			const slice = sliceOfHandle(handleId);
			if (slice?.isRunning && !(await askConfirm({ title: "关闭会话", message: "该会话有任务正在运行，关闭后任务会中断。继续？", confirmLabel: "关闭", danger: true }))) return;
			try {
				await api.closeSession(handleId);
			} catch (error) {
				get().pushNotice("error", `关闭会话失败：${errorText(error)}`);
				return;
			}
			clearOwner(handleId);
		},

		async stopProject(pid) {
			const handles = [...(get().projectHandles[pid] ?? [])];
			const running = handles.some((h) => sliceOfHandle(h)?.isRunning);
			if (running && !(await askConfirm({ title: "停止项目", message: "该项目有任务正在运行，停止后任务会中断。继续？", confirmLabel: "停止", danger: true }))) return;
			// 项目被关闭时连同它的终端一起释放；收起面板、切项目只是隐藏终端实例
			const target = project(pid);
			if (target) disposeTerminal(target.path, target.hostId);
			const epoch = advanceProject(pid);
			for (const handleId of handles) {
				try {
					await api.closeSession(handleId);
				} catch (error) {
					get().pushNotice("error", `停止项目失败：${errorText(error)}`);
					return;
				}
				clearOwner(handleId);
			}
			if (pid === get().activeProjectId && projectEpochs.get(pid) === epoch && !(get().projectHandles[pid] ?? []).length && !get().handleId) {
				set({ ...emptySlice(), activeProjectId: null });
			}
		},

		async removeProject(pid) {
			const p = project(pid);
			if (!p) return;
			if (!(await askConfirm({ title: "移除项目", message: `从列表中移除「${projectName(p)}」？\n不会删除文件夹和会话记录，之后可以重新导入。`, confirmLabel: "移除", danger: true }))) return;
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
			const request = (historyRequests.get(pid) ?? 0) + 1;
			historyRequests.set(pid, request);
			try {
				const sessions = await api.service({ type: "list_sessions", cwd: p.path });
				if (historyRequests.get(pid) !== request || normalizedPath(project(pid)?.path ?? "") !== normalizedPath(p.path)) return;
				set((st) => ({ projectSessions: { ...st.projectSessions, [pid]: sessions } }));
			} catch {
				// 读取失败时保留旧列表
			}
		},

		sessionOperation(pid, path) {
			const p = project(pid);
			return p ? get().sessionOperations[operationKey(p.path, path)] : undefined;
		},

		sessionBusy(pid, path) {
			const p = project(pid);
			return !!p && owners(p.path, path).some(([, s]) => s.isRunning || s.state?.isStreaming || waitingCount(s) > 0);
		},

		async renameSession(pid, path, name) {
			const p = project(pid);
			if (!p || p.missing || get().sessionOperation(pid, path)) return;
			const key = operationKey(p.path, path);
			set((st) => ({ sessionOperations: { ...st.sessionOperations, [key]: "rename" } }));
			try {
				await api.sessions.rename(p.path, path, name.trim());
				await refreshHistory(p.path);
			} catch (error) {
				get().pushNotice("error", `重命名会话失败：${errorText(error)}`);
			} finally {
				finishOperation(key);
			}
		},

		async deleteSession(pid, path) {
			const p = project(pid);
			if (!p || p.missing || get().sessionOperation(pid, path)) return;
			if (get().sessionBusy(pid, path)) {
				get().pushNotice("warning", "该会话正在运行或等待交互，请先中断或结束后再删除");
				return;
			}
			const summary = get().projectSessions[pid]?.find((s) => normalizedPath(s.path) === normalizedPath(path));
			if (!(await askConfirm({ title: "删除会话", message: `永久删除会话「${summary?.name || summary?.firstMessage || "（空会话）"}」？\n只删除该会话记录，不删除项目文件，也不删除分叉会话。此操作无法撤销。`, confirmLabel: "删除", danger: true }))) return;
			const key = operationKey(p.path, path);
			const targetOwners = owners(p.path, path);
			const wasOpen = targetOwners.length > 0;
			set((st) => ({ sessionOperations: { ...st.sessionOperations, [key]: "delete" } }));
			try {
				await api.sessions.delete(p.path, path);
				for (const [handleId] of targetOwners) clearOwner(handleId);
				void refreshHistory(p.path);
				// 删掉的正好是该项目最后一个打开的会话 → 补一个新会话，避免留下空窗
				if (wasOpen && pid === get().activeProjectId && !(get().projectHandles[pid] ?? []).length) await get().openSessionIn(pid);
			} catch (error) {
				get().pushNotice("error", `删除会话失败：${errorText(error)}；原记录保留，可重新打开`);
			} finally {
				finishOperation(key);
			}
		},

		projectStatus(pid) {
			const handles = get().projectHandles[pid] ?? [];
			let running = false;
			let waiting = 0;
			for (const handleId of handles) {
				const s = sliceOfHandle(handleId);
				if (!s) continue;
				if (s.isRunning) running = true;
				waiting += waitingCount(s);
			}
			return { open: handles.length > 0, running, waiting, unread: !!get().unread[pid] };
		},

		async newSessionIn(pid) {
			const hasHandles = (get().projectHandles[pid] ?? []).length > 0;
			if (hasHandles) {
				await get().openProject(pid);
				if (get().activeProjectId === pid) await get().newSession();
			} else {
				await get().openSessionIn(pid);
			}
			get().toggleExpanded(pid, true);
		},

		// ----- 当前项目的会话 -----

		async refreshSessions() {
			const pid = get().activeProjectId;
			if (pid) await get().refreshProjectSessions(pid);
		},

		async loadModels() {
			const handleId = get().handleId;
			if (handleId) await loadModelsFor(handleId);
		},

		async newSession() {
			const pid = get().activeProjectId;
			if (!pid) return;
			await get().openSessionIn(pid);
		},

		async switchSession(path) {
			const pid = get().activeProjectId;
			if (!pid || get().sessionOperation(pid, path)) return;
			await get().openSessionIn(pid, path);
		},

		async sendPrompt(text, images, streamingBehavior) {
			const message = text.trim();
			// 允许只带图片、不带文字的消息
			if (!message && !(images && images.length > 0)) return;
			await active((h) => api.session(h, { type: "prompt", message, images, streamingBehavior }));
		},

		async dequeue() {
			const handleId = get().handleId;
			if (!handleId) return;
			const sessionId = get().state?.sessionId;
			const queue = await call(handleId, (h) => api.session(h, { type: "clear_queue" }));
			if (!queue) return;
			const pending = [...queue.steering, ...queue.followUp];
			if (pending.length === 0) return;
			// 取回时文字和图片一起恢复，不能只恢复文字。
			deliverDraft(handleId, sessionId, {
				text: pending.map((item) => item.text).filter(Boolean).join("\n"),
				images: pending.flatMap((item) => item.images ?? []),
				append: true,
			});
		},

		async reorderQueue(steering, followUp) {
			await active((h) => api.session(h, { type: "reorder_queue", steering, followUp }));
		},

		async abort() {
			await active((h) => api.session(h, { type: "abort" }));
		},

		async setModel(model) {
			const handleId = get().handleId;
			if (!handleId) return;
			const patch = sessionPatcher(handleId);
			const state = await call(handleId, (h) => api.session(h, { type: "set_model", provider: model.provider, modelId: model.id }));
			if (state) patch({ state });
		},

		async setThinkingLevel(level) {
			const handleId = get().handleId;
			if (!handleId) return;
			const patch = sessionPatcher(handleId);
			const state = await call(handleId, (h) => api.session(h, { type: "set_thinking_level", level }));
			if (state) patch({ state });
		},

		async setWorkMode(mode) {
			const handleId = get().handleId;
			if (!handleId) return;
			const patch = sessionPatcher(handleId);
			const state = await call(handleId, (h) => api.session(h, { type: "set_work_mode", mode }));
			if (state) patch({ state });
		},

		async setApprovalMode(mode) {
			localStorage.setItem(APPROVAL_KEY, mode);
			set({ approvalMode: mode });
			// 审批模式对所有已打开的会话生效
			await Promise.all(allSlices().map(([handleId]) => call(handleId, (h) => api.session(h, { type: "set_approval_mode", mode }))));
		},

		async respondExtUI(id, response) {
			set((s) => ({ extDialogs: s.extDialogs.filter((d) => d.id !== id) }));
			await active((h) => api.session(h, { type: "respond_ext_ui", id, ...(response ?? { cancelled: true }) }));
		},

		async respondApproval(toolCallId, decision) {
			set((s) => ({ pendingApprovals: s.pendingApprovals.filter((p) => p.toolCallId !== toolCallId) }));
			await active((h) => api.session(h, { type: "respond_approval", toolCallId, decision }));
		},

		setRightPanel(panel) {
			localStorage.setItem(PANEL_KEY, panel ?? "");
			set({ rightPanel: panel });
		},

		toggleRail() {
			const next = !get().railVisible;
			localStorage.setItem(RAIL_KEY, next ? "1" : "0");
			set({ railVisible: next });
			if (next) void get().loadTree();
		},

		toggleFoldProcess() {
			const next = !get().foldProcess;
			localStorage.setItem(FOLD_PROCESS_KEY, next ? "1" : "0");
			set({ foldProcess: next });
		},

		toggleSidebar() {
			const next = !get().sidebarOpen;
			localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
			set({ sidebarOpen: next });
		},

		setQuickOpen(open) {
			set({ quickOpen: open && !!get().cwd });
		},

		setPalette(open, mode = "all") {
			set({ palette: { open, query: "", mode } });
		},

		setTerminalPanel(open) {
			set({ terminalPanel: open });
		},

		setPanelTab(tab) {
			set({ panelTab: tab });
		},

		openPreview(path, hostId = null) {
			set({ preview: path, previewHostId: hostId });
		},

		insertIntoPrompt(text) {
			set((s) => ({ draft: { text, seq: s.draft.seq + 1, append: true } }));
		},

		refreshFiles() {
			set((s) => ({ filesVersion: s.filesVersion + 1 }));
		},

		async loadTree() {
			const handleId = get().handleId;
			if (handleId) await loadTreeFor(handleId);
		},

		async navigateTo(entryId) {
			if (get().isRunning) {
				get().pushNotice("warning", "请先等待当前运行结束，或按 Esc 中断");
				return;
			}
			const handleId = get().handleId;
			if (!handleId) return;
			const sessionId = get().state?.sessionId;
			const result = await call(handleId, (h) => api.session(h, { type: "navigate_tree", entryId }));
			if (result?.editorText) deliverDraft(handleId, sessionId, { text: result.editorText });
			// 回溯完成时可能已切换标签；刷新原会话而非当前标签。
			if (sliceOfHandle(handleId)) void loadTreeFor(handleId);
		},

		async forkFrom(entryId, position) {
			if (get().isRunning) {
				get().pushNotice("warning", "请先等待当前运行结束，或按 Esc 中断");
				return;
			}
			const handleId = get().handleId;
			if (!handleId) return;
			const pid = projectByHandle(handleId);
			const result = await call(handleId, (h) => api.session(h, { type: "fork", entryId, position }));
			if (!result || result.cancelled) return;
			if (result.editorText) deliverDraft(handleId, result.state.sessionId, { text: result.editorText });
			get().pushNotice("info", "已分叉为新会话");
			if (pid) await get().refreshProjectSessions(pid);
		},

		async setLabel(entryId, label) {
			const handleId = get().handleId;
			if (!handleId) return;
			await call(handleId, (h) => api.session(h, { type: "set_label", entryId, label }));
			if (sliceOfHandle(handleId)) await loadTreeFor(handleId);
		},

		pushNotice(level, text) {
			const hostKey = hostKeyChangedHost(text);
			if (hostKey) {
				set({ hostKeyPrompt: hostKey });
				return;
			}
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
					handleEvent(push.handleId, push.event);
					return;
				}
				case "session_exit": {
					const pid = projectByHandle(push.handleId);
					const name = pid && project(pid) ? projectName(project(pid) as Project) : "会话";
					clearOwner(push.handleId);
					if (!push.expected) get().pushNotice("error", `「${name}」的 pi 进程已退出（code ${push.code}），重新点击项目即可再次打开`);
					return;
				}
				case "sessions_changed":
					void refreshHistory(push.cwd);
					return;
				case "config_changed": {
					set((s) => ({ configVersion: s.configVersion + 1 }));
					for (const [handleId] of allSlices()) {
						void loadModelsFor(handleId);
						void call(handleId, (h) => api.session(h, { type: "get_state" })).then((state) => state && patchHandle(handleId, { state }));
					}
					return;
				}
				case "projects_changed":
					set({ projects: push.state });
					return;
				case "hosts_changed":
					set({ hosts: push.hosts });
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

// 任何地方格式化到「主机密钥已变化」的错误时，弹出核对指纹的对话框
setHostKeyChangedHandler((hostId) => {
	if (!useApp.getState().hostKeyPrompt) useApp.getState().setHostKeyPrompt(hostId);
});

// 仅开发或主进程明确开启的隔离截图模式暴露 store，普通生产运行不暴露。
if (import.meta.env.DEV || window.floworkScreenshot) (window as unknown as { __floworkStore: typeof useApp }).__floworkStore = useApp;
if (import.meta.env.DEV) (window as unknown as { __floworkApi: typeof api }).__floworkApi = api;
