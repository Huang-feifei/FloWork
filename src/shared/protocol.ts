/**
 * FloWork 内部协议。三段链路共用：
 *
 *   界面（renderer） ──Transport──▶ 后端核心（core/Backend） ──worker 消息──▶ pi worker
 *
 * - Transport：桌面版走 Electron IPC（preload 暴露），网页版走 WebSocket。两者的信封格式相同。
 * - worker 命令与事件命名沿用 pi RPC 协议（prompt / abort / get_state / get_tree …），
 *   并补充 RPC 没有的命令（navigate_tree / list_sessions / 登录与配置 …）。
 * - 这里只定义 FloWork 自己的数据形状，不 re-export pi 的类型；pi 的类型只在 src/worker/adapter.ts 中解读。
 */

// ---------------------------------------------------------------------------
// 基础数据
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow?: number;
	maxTokens?: number;
	/** 美元 / 百万 token */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ModelEntry extends ModelInfo {
	/** 供应商凭据可用 */
	available: boolean;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "image"; mimeType: string; data: string };

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type ChatMessage =
	| { role: "user"; content: ContentBlock[]; timestamp: number }
	| {
			role: "assistant";
			content: ContentBlock[];
			provider: string;
			model: string;
			stopReason: StopReason;
			errorMessage?: string;
			usage?: Usage;
			timestamp: number;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ContentBlock[];
			details?: unknown;
			isError: boolean;
			timestamp: number;
	  }
	| {
			/** bashExecution / custom / branchSummary / compactionSummary 等其他角色，统一以文本呈现 */
			role: "note";
			kind: string;
			text: string;
			timestamp: number;
	  };

export interface SessionState {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	isStreaming: boolean;
	messageCount: number;
}

/**
 * 工具审批模式：
 * - auto：全部自动执行
 * - ask_writes：修改文件、执行命令及其他非只读工具前确认（默认）
 * - ask_all：所有工具都需确认
 */
export type ApprovalMode = "auto" | "ask_writes" | "ask_all";
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask_writes";
/** 只读工具：ask_writes 模式下自动执行 */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export type ApprovalDecision = "allow" | "allow_session" | "deny";

export interface SessionSummary {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	created: number;
	modified: number;
	parentSessionPath?: string;
}

export interface SessionTreeNode {
	id: string;
	parentId: string | null;
	/** 条目类型：message / model_change / compaction / branch_summary / label … */
	entryType: string;
	/** 消息条目的角色 */
	role?: string;
	/** 用于树视图展示的简短文本 */
	preview: string;
	label?: string;
	timestamp: string;
	children: SessionTreeNode[];
}

export type AuthMethod = "api_key" | "ambient" | "oauth" | "oauth_subscription";

export interface ProviderInfo {
	id: string;
	name: string;
	authMethods: AuthMethod[];
	configured: boolean;
	/** 凭据来源：stored（auth.json）/ environment / models_json_key … */
	authSource?: string;
	/** 来源的可读说明，例如环境变量名 */
	authLabel?: string;
	modelCount: number;
	/** 是否来自 models.json 的自定义供应商 */
	custom: boolean;
}

// ---------------------------------------------------------------------------
// 登录流程（API Key / OAuth），提示与通知从 worker 转发到界面
// ---------------------------------------------------------------------------

export type AuthPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> };

export type AuthNotice =
	| { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
	| { type: "progress"; message: string };

export type AuthFlowEvent =
	| { flowId: string; kind: "prompt"; promptId: string; prompt: AuthPrompt }
	| { flowId: string; kind: "prompt_cancelled"; promptId: string }
	| { flowId: string; kind: "notice"; notice: AuthNotice };

// ---------------------------------------------------------------------------
// 配置文件
// ---------------------------------------------------------------------------

/** 允许界面直接读写的 pi 配置文件（auth.json 含密钥，不开放） */
export type ConfigFileName = "settings" | "models";

export interface ConfigFile {
	name: ConfigFileName;
	path: string;
	exists: boolean;
	text: string;
}

export interface ShellInfo {
	/** pi 的 bash 工具实际会使用的 shell；无法解析时为 null */
	resolved: string | null;
	error?: string;
	/** 解析结果是否为 WSL 启动器（System32\bash.exe） */
	isWsl: boolean;
	/** 自动识别到的 Git Bash */
	gitBash: string | null;
	/** settings.json 中的 shellPath */
	shellPathSetting?: string;
}

export interface TestResult {
	ok: boolean;
	latencyMs: number;
	text?: string;
	error?: string;
}

// ---------------------------------------------------------------------------
// worker 命令
// ---------------------------------------------------------------------------

export type SessionCommand =
	| { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
	| { type: "abort" }
	| { type: "get_state" }
	| { type: "get_messages" }
	| { type: "get_tree" }
	| { type: "navigate_tree"; entryId: string; summarize?: boolean }
	/** 从某个条目分叉出新会话；position = before 时 entryId 必须是用户消息，其文本会返回给输入框 */
	| { type: "fork"; entryId: string; position?: "before" | "at" }
	| { type: "set_label"; entryId: string; label: string }
	| { type: "get_available_models" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: ThinkingLevel }
	| { type: "new_session" }
	| { type: "switch_session"; sessionPath: string }
	| { type: "set_session_name"; name: string }
	| { type: "set_approval_mode"; mode: ApprovalMode }
	| { type: "respond_approval"; toolCallId: string; decision: ApprovalDecision }
	/** 配置（凭据 / models.json / settings.json）变化后重新加载 */
	| { type: "refresh_config" };

/** 不依赖活动会话的服务类命令，由常驻的 service worker 处理 */
export type ServiceCommand =
	| { type: "ping" }
	| { type: "list_sessions"; cwd?: string; /** 列出所有目录时使用的会话根目录，默认 FloWork 自己的 */ sessionDir?: string }
	| { type: "list_providers" }
	| { type: "list_models"; availableOnly?: boolean }
	| { type: "auth_login"; flowId: string; provider: string; method: "api_key" | "oauth" }
	| { type: "logout"; provider: string }
	| { type: "test_model"; provider: string; modelId: string }
	| { type: "get_config_file"; name: ConfigFileName }
	| { type: "save_config_file"; name: ConfigFileName; text: string }
	| { type: "fetch_remote_models"; baseUrl: string; apiKey?: string }
	| { type: "get_shell_info" };

export interface CommandResultMap {
	prompt: { disposition: "started" | "queued" | "handled" };
	abort: null;
	get_state: SessionState;
	get_messages: ChatMessage[];
	get_tree: { tree: SessionTreeNode[]; leafId: string | null };
	navigate_tree: { cancelled: boolean; editorText?: string };
	fork: { cancelled: boolean; editorText?: string; state: SessionState };
	set_label: null;
	get_available_models: ModelInfo[];
	set_model: SessionState;
	set_thinking_level: SessionState;
	new_session: SessionState;
	switch_session: SessionState;
	set_session_name: null;
	set_approval_mode: null;
	respond_approval: null;
	refresh_config: SessionState;
	ping: { pid: number; versions: Record<string, string | undefined>; agentDir: string };
	list_sessions: SessionSummary[];
	list_providers: ProviderInfo[];
	list_models: ModelEntry[];
	auth_login: { provider: string };
	logout: null;
	test_model: TestResult;
	get_config_file: ConfigFile;
	save_config_file: ConfigFile;
	fetch_remote_models: string[];
	get_shell_info: ShellInfo;
}

export type AnyCommand = SessionCommand | ServiceCommand;
export type CommandResult<C extends AnyCommand> = CommandResultMap[C["type"]];

/** 会修改配置、需要通知各会话刷新的服务命令 */
export const CONFIG_MUTATING_COMMANDS = new Set<ServiceCommand["type"]>(["auth_login", "logout", "save_config_file"]);

// ---------------------------------------------------------------------------
// 会话事件（worker → 界面）
// ---------------------------------------------------------------------------

export type BlockKind = "text" | "thinking" | "toolCall";

export type SessionEvent =
	| { type: "agent_start" }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "message_start"; message: ChatMessage }
	| { type: "block_start"; contentIndex: number; kind: BlockKind; toolCallId?: string; toolName?: string }
	| { type: "block_delta"; contentIndex: number; kind: BlockKind; delta: string }
	| { type: "block_end"; contentIndex: number; block: ContentBlock }
	| { type: "message_end"; message: ChatMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; partialResult: unknown }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: { content: ContentBlock[]; details?: unknown };
			isError: boolean;
			durationMs?: number;
	  }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	| { type: "approval_request"; toolCallId: string; toolName: string; args: unknown }
	| { type: "approval_resolved"; toolCallId: string; decision: ApprovalDecision }
	/** 会话被替换（新建 / 切换）或当前分支移动（树导航），界面需要重新拉取消息 */
	| { type: "session_changed"; state: SessionState };

// ---------------------------------------------------------------------------
// 后端核心 ⇄ worker 的线上消息
// ---------------------------------------------------------------------------

export interface WorkerInit {
	/** service：处理 ServiceCommand；session：承载一个 pi 会话 */
	role: "service" | "session";
	cwd: string;
	/** 打开已有会话；不传则新建 */
	sessionPath?: string;
	approvalMode?: ApprovalMode;
}

export type MainToWorker =
	| { kind: "init"; init: WorkerInit }
	| { kind: "command"; id: string; command: AnyCommand }
	| { kind: "auth_answer"; flowId: string; promptId: string; value?: string; cancel?: boolean }
	| { kind: "auth_cancel"; flowId: string }
	| { kind: "shutdown" };

export type WorkerToMain =
	| { kind: "ready"; state?: SessionState }
	| { kind: "init_error"; error: string }
	| { kind: "response"; id: string; ok: true; data: unknown }
	| { kind: "response"; id: string; ok: false; error: string }
	| { kind: "event"; event: SessionEvent }
	| { kind: "auth"; event: AuthFlowEvent };

// ---------------------------------------------------------------------------
// 界面 ⇄ 后端核心：Transport 信封
// ---------------------------------------------------------------------------

export interface AppInfo {
	version: string;
	versions: Record<string, string | undefined>;
	agentDir: string;
	/** 当前外壳 */
	shell: "electron" | "web";
	/** 是否支持系统原生文件夹对话框（仅桌面版） */
	nativeDialogs: boolean;
}

export interface DirListing {
	path: string;
	parent: string | null;
	entries: Array<{ name: string; path: string }>;
	/** Windows 盘符或 / */
	roots: string[];
	home: string;
}

export interface WorkspaceEntry {
	name: string;
	/** 相对工作区根目录，/ 分隔 */
	path: string;
	type: "file" | "dir";
	size?: number;
	/** 被 .gitignore 或常见构建目录规则命中，界面置灰 */
	ignored: boolean;
}

export interface WorkspaceDirListing {
	path: string;
	entries: WorkspaceEntry[];
}

export interface FilePreview {
	path: string;
	absolutePath: string;
	size: number;
	mtime: number;
	binary: boolean;
	truncated: boolean;
	text: string;
}

export interface FileSearchResult {
	/** 匹配的相对路径，按得分排序 */
	matches: Array<{ path: string; score: number }>;
	/** 参与搜索的文件总数 */
	total: number;
	/** 文件过多时只扫描了一部分 */
	truncated: boolean;
}

export const WRITE_CONFLICT_PREFIX = "WRITE_CONFLICT:";

// ---------------------------------------------------------------------------
// 项目（侧边栏中导入的工作区）
// ---------------------------------------------------------------------------

export interface ProjectGroup {
	id: string;
	name: string;
	collapsed?: boolean;
}

export interface Project {
	id: string;
	/** 文件夹绝对路径 */
	path: string;
	/** 自定义显示名；未设置时显示文件夹名 */
	name?: string;
	groupId?: string;
	pinned?: boolean;
	/** 同一区域（置顶 / 分组 / 未分组）内的排序 */
	order: number;
	addedAt: number;
	lastOpenedAt?: number;
	/** 文件夹当前是否存在（读取时计算，不持久化） */
	missing?: boolean;
}

export interface ProjectsState {
	projects: Project[];
	groups: ProjectGroup[];
}

export interface ProjectPatch {
	name?: string | null;
	groupId?: string | null;
	pinned?: boolean;
}

export interface DiscoveredProject {
	path: string;
	sessionCount: number;
	lastModified: number;
	/** 会话来自 FloWork 还是 pi 命令行 */
	sources: Array<"flowork" | "pi-cli">;
	exists: boolean;
}

export interface BackendMethods {
	"app.info": { params: undefined; result: AppInfo };
	"app.pickFolder": { params: undefined; result: string | null };
	/** 系统对话框多选文件夹（仅桌面版） */
	"app.pickFolders": { params: undefined; result: string[] };
	"projects.get": { params: undefined; result: ProjectsState };
	"projects.add": { params: { paths: string[]; groupId?: string }; result: { state: ProjectsState; added: Project[]; skipped: string[] } };
	"projects.update": { params: { id: string; patch: ProjectPatch }; result: ProjectsState };
	"projects.remove": { params: { id: string }; result: ProjectsState };
	"projects.touch": { params: { id: string }; result: ProjectsState };
	/** 把 ids 按顺序放入目标区域：pinned 为置顶区，否则为 groupId（null 表示未分组） */
	"projects.move": { params: { ids: string[]; pinned: boolean; groupId: string | null }; result: ProjectsState };
	"projects.groupCreate": { params: { name: string }; result: { state: ProjectsState; group: ProjectGroup } };
	"projects.groupUpdate": { params: { id: string; name?: string; collapsed?: boolean }; result: ProjectsState };
	"projects.groupRemove": { params: { id: string }; result: ProjectsState };
	"projects.discover": { params: undefined; result: DiscoveredProject[] };
	"fs.listDirs": { params: { path?: string }; result: DirListing };
	"workspace.list": { params: { root: string; path?: string }; result: WorkspaceDirListing };
	"workspace.read": { params: { root: string; path: string }; result: FilePreview };
	/** 保存文件；expectedMtime 与磁盘不一致时拒绝（文件已被 AI 或外部修改） */
	"workspace.write": {
		params: { root: string; path: string; content: string; expectedMtime?: number };
		result: FilePreview;
	};
	"workspace.search": { params: { root: string; query: string; limit?: number; /** 忽略缓存重新扫描 */ fresh?: boolean }; result: FileSearchResult };
	"service.send": { params: ServiceCommand; result: unknown };
	"session.open": { params: { cwd: string; sessionPath?: string; approvalMode?: ApprovalMode }; result: { handleId: string; state: SessionState } };
	"session.send": { params: { handleId: string; command: SessionCommand }; result: unknown };
	"session.close": { params: { handleId: string }; result: null };
	"auth.answer": { params: { flowId: string; promptId: string; value?: string; cancel?: boolean }; result: null };
	"auth.cancel": { params: { flowId: string }; result: null };
}

export type BackendMethod = keyof BackendMethods;

export type BackendPush =
	| { type: "session_event"; handleId: string; event: SessionEvent }
	| { type: "session_exit"; handleId: string; code: number }
	| { type: "auth"; event: AuthFlowEvent }
	/** 凭据或配置文件变更，界面应刷新模型与供应商列表 */
	| { type: "config_changed" }
	| { type: "projects_changed"; state: ProjectsState };

/** 网页版 WebSocket 帧 */
export type ClientFrame = { id: string; method: BackendMethod; params: unknown };
export type ServerFrame =
	| { id: string; ok: true; result: unknown }
	| { id: string; ok: false; error: string }
	| { push: BackendPush };

/** 渲染进程看到的传输层；桌面版由 preload 以 window.floworkTransport 暴露 */
export interface Transport {
	request(method: BackendMethod, params: unknown): Promise<unknown>;
	onPush(listener: (push: BackendPush) => void): () => void;
}

export const ELECTRON_CHANNELS = {
	request: "flowork:request",
	push: "flowork:push",
} as const;
