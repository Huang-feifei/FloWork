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

import type { DatabaseMethods } from "./database";

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

/**
 * 随消息发送的图片附件。
 * 与 pi 的 ImageContent 同形，worker 可直接透传给 session.prompt({ images })。
 */
export type ImageAttachment = Extract<ContentBlock, { type: "image" }>;

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

/**
 * 会话消息。历史消息带 `entryId`（会话树条目的 id），界面据此把消息与树节点对应；
 * 流式消息还没落盘，没有 entryId。
 */
export type ChatMessage =
	| { role: "user"; content: ContentBlock[]; timestamp: number; entryId?: string }
	| {
			role: "assistant";
			content: ContentBlock[];
			provider: string;
			model: string;
			stopReason: StopReason;
			errorMessage?: string;
			usage?: Usage;
			timestamp: number;
			entryId?: string;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ContentBlock[];
			details?: unknown;
			isError: boolean;
			timestamp: number;
			entryId?: string;
	  }
	| {
			/** bashExecution / custom / branchSummary / compactionSummary 等其他角色，统一以文本呈现 */
			role: "note";
			kind: string;
			text: string;
			timestamp: number;
			entryId?: string;
	  };

export interface ProjectTrust {
	/** not_needed：项目没有需要信任的配置 */
	state: "trusted" | "untrusted" | "not_needed";
	/** 用户是否已做过决定（未决定时界面提示） */
	decided: boolean;
	/** 需要信任才会加载的项目配置，如 .pi/extensions */
	items: string[];
}

export type ResourceKind = "skill" | "extension" | "prompt";

export interface ResourceInfo {
	kind: ResourceKind;
	name: string;
	description?: string;
	/** 资源文件或目录的绝对路径 */
	path: string;
	enabled: boolean;
	/** user：所有项目可用；project：仅当前项目 */
	scope: string;
	/** pi 发现它的方式：auto（约定目录）、local（settings 中的路径）、npm / git 包等 */
	source: string;
	origin: "package" | "top-level";
	/** 位于配置目录或项目 .pi 内、可由 FloWork 删除的副本 */
	removable: boolean;
}

export interface ResourcesResult {
	resources: ResourceInfo[];
	packages: Array<{ source: string; scope: "user" | "project"; installedPath?: string }>;
	trust: ProjectTrust;
	dirs: { user: Record<ResourceKind, string>; project: Record<ResourceKind, string> };
}

export interface SlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

/** 运行中排队等待送达的消息：steering 插话，followUp 当前轮结束后执行 */
export interface SessionQueue {
	steering: string[];
	followUp: string[];
}

/** 计划模式只读探索；确认计划后进入执行模式，工具审批设置仍然生效。 */
export type WorkMode = "plan" | "execute";

export interface SessionState {
	workMode?: WorkMode;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	isStreaming: boolean;
	messageCount: number;
	trust?: ProjectTrust;
	/** 当前排队的消息；pi 在消息被送达时更新 */
	queue: SessionQueue;
	/** 运维会话（SSH 远程主机）：cwd 为远程起始目录 */
	ops?: OpsSessionInfo;
}

/** 远程主机画像：会话开始时探测一次（发行版、包管理器、服务等），键为英文、值为原始文本 */
export interface HostProfile {
	facts: Record<string, string>;
	probedAt: number;
}

export interface OpsSessionInfo {
	hostId: string;
	/** user@host[:port] */
	label: string;
	remoteCwd: string;
	/** 探测失败或尚未完成时为空 */
	profile?: HostProfile;
	profileError?: string;
}

/**
 * 工具审批模式：
 * - auto：全部自动执行（运维会话中高危命令仍需确认）
 * - ask_writes：修改文件、执行命令及其他非只读工具前确认（默认）；运维会话中只读命令自动执行
 * - ask_all：所有工具都需确认
 */
export type ApprovalMode = "auto" | "ask_writes" | "ask_all";
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask_writes";
/** 只读工具：ask_writes 模式下自动执行 */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export type ApprovalDecision = "allow" | "allow_session" | "deny";

/** 运维会话中工具调用的风险评估（随审批请求下发，界面据此显示红色警告） */
export interface ApprovalRisk {
	level: "read" | "write" | "danger";
	reasons: string[];
}

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
	/** 文件最后修改时间（ms）；文件不存在时为 0。保存时回传，用于发现外部改动 */
	mtime: number;
}

/** 保存配置文件时磁盘内容已被外部改动（mtime 不一致）的提示片段，worker 与界面共用同一文案 */
export const CONFIG_MTIME_CONFLICT = "已被外部修改（磁盘 mtime 与打开时不一致）";

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
	| { type: "prompt"; message: string; images?: ImageAttachment[]; streamingBehavior?: "steer" | "followUp" }
	/** 清空并取回排队消息（界面把返回的文本填回输入框） */
	| { type: "clear_queue" }
	/** 按给定顺序重建排队消息（pi 队列是 FIFO，重排通过清空后重新入队实现） */
	| { type: "reorder_queue"; steering: string[]; followUp: string[] }
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
	| { type: "set_work_mode"; mode: WorkMode }
	| { type: "respond_approval"; toolCallId: string; decision: ApprovalDecision }
	/** 应答扩展对话框：select / input / editor 传 value，confirm 传 confirmed，取消传 cancelled */
	| { type: "respond_ext_ui"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean }
	/** 记录对当前项目的信任决定并重新加载会话 */
	| { type: "set_project_trust"; trusted: boolean }
	/** 重新加载技能、扩展、提示模板；运行中时推迟到本轮结束 */
	| { type: "reload_resources" }
	| { type: "get_commands" }
	/** 配置（凭据 / models.json / settings.json）变化后重新加载 */
	| { type: "refresh_config" };

/** 不依赖活动会话的服务类命令，由常驻的 service worker 处理 */
export type ServiceCommand =
	| { type: "ping" }
	| { type: "list_sessions"; cwd?: string; /** 列出所有目录时使用的会话根目录，默认 FloWork 自己的 */ sessionDir?: string }
	| { type: "validate_session"; cwd: string; path: string }
	| { type: "rename_session"; cwd: string; path: string; name: string }
	| { type: "delete_session"; cwd: string; path: string }
	| { type: "list_providers" }
	| { type: "list_models"; availableOnly?: boolean }
	| { type: "auth_login"; flowId: string; provider: string; method: "api_key" | "oauth" }
	| { type: "logout"; provider: string }
	| { type: "test_model"; provider: string; modelId: string }
	| { type: "get_config_file"; name: ConfigFileName }
	| { type: "save_config_file"; name: ConfigFileName; text: string; expectedMtime?: number }
	| { type: "fetch_remote_models"; baseUrl: string; apiKey?: string }
	| { type: "get_shell_info" }
	| { type: "list_resources"; cwd: string }
	| { type: "set_resource_enabled"; cwd: string; kind: ResourceKind; path: string; enabled: boolean }
	| { type: "import_resource"; cwd: string; kind: ResourceKind; sourcePath: string; scope: "user" | "project" }
	| { type: "remove_resource"; cwd: string; kind: ResourceKind; path: string }
	| { type: "install_package"; cwd: string; source: string; scope: "user" | "project" }
	| { type: "remove_package"; cwd: string; source: string; scope: "user" | "project" };

export interface CommandResultMap {
	prompt: { disposition: "started" | "queued" | "handled" };
	clear_queue: SessionQueue;
	reorder_queue: SessionQueue;
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
	set_work_mode: SessionState;
	respond_approval: null;
	respond_ext_ui: null;
	set_project_trust: SessionState;
	reload_resources: { deferred: boolean };
	get_commands: SlashCommand[];
	refresh_config: SessionState;
	ping: { pid: number; versions: Record<string, string | undefined>; agentDir: string; protocolVersion: number };
	list_sessions: SessionSummary[];
	validate_session: SessionSummary;
	rename_session: null;
	delete_session: null;
	list_providers: ProviderInfo[];
	list_models: ModelEntry[];
	auth_login: { provider: string };
	logout: null;
	test_model: TestResult;
	get_config_file: ConfigFile;
	save_config_file: ConfigFile;
	fetch_remote_models: string[];
	get_shell_info: ShellInfo;
	list_resources: ResourcesResult;
	set_resource_enabled: null;
	import_resource: { path: string; name: string };
	remove_resource: null;
	install_package: null;
	remove_package: null;
}

export type AnyCommand = SessionCommand | ServiceCommand;
export type CommandResult<C extends AnyCommand> = CommandResultMap[C["type"]];

/** 会修改配置、需要通知各会话刷新的服务命令 */
export const CONFIG_MUTATING_COMMANDS = new Set<ServiceCommand["type"]>(["auth_login", "logout", "save_config_file"]);

/** 会改变技能 / 扩展 / 提示模板、需要各会话重新加载资源的服务命令 */
export const RESOURCE_MUTATING_COMMANDS = new Set<ServiceCommand["type"]>([
	"set_resource_enabled",
	"import_resource",
	"remove_resource",
	"install_package",
	"remove_package",
]);

// ---------------------------------------------------------------------------
// 会话事件（worker → 界面）
// ---------------------------------------------------------------------------

export type BlockKind = "text" | "thinking" | "toolCall";

/** 扩展发起的对话框请求 */
export interface ExtUIRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	/** 内置决策工具的展示信息；未设置时为第三方扩展对话框。 */
	purpose?: "question" | "plan";
	confirmLabel?: string;
	cancelLabel?: string;
	title: string;
	/** confirm 的正文 */
	message?: string;
	/** select 的选项 */
	options?: string[];
	/** input 的占位提示 */
	placeholder?: string;
	/** editor 的初始内容 */
	prefill?: string;
	/** 超时毫秒数；到期后按取消处理 */
	timeoutMs?: number;
	/** 请求到达的时间戳（worker 时钟），用于显示倒计时 */
	startedAt: number;
}

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
	| { type: "work_mode_changed"; mode: WorkMode }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	| { type: "approval_request"; toolCallId: string; toolName: string; args: unknown; risk?: ApprovalRisk }
	| { type: "approval_resolved"; toolCallId: string; decision: ApprovalDecision }
	/** 第三方扩展请求用户输入（ctx.ui.select / confirm / input / editor） */
	| { type: "ext_ui_request"; request: ExtUIRequest }
	/** 对话框已结束（用户应答、超时或被扩展取消） */
	| { type: "ext_ui_closed"; id: string }
	/** ctx.ui.setStatus：状态栏文字，text 为空表示移除 */
	| { type: "ext_status"; key: string; text?: string }
	/** ctx.ui.setWidget：输入框上方 / 下方的文本块，lines 为空表示移除 */
	| { type: "ext_widget"; key: string; lines?: string[]; placement: "aboveEditor" | "belowEditor" }
	/** ctx.ui.setEditorText / pasteToEditor：替换输入框内容 */
	| { type: "ext_editor_text"; text: string }
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
	/** 运维会话：工具在这台主机上执行；cwd 为本地占位目录 */
	ops?: { host: SshHost; remoteCwd: string };
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
	/** 本机 ssh 可执行文件路径；为 null 时无法使用远程功能 */
	ssh: string | null;
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

/** 服务器状态快照（只读命令，服务状态面板用） */
export interface HostMonitorSnapshot {
	probedAt: number;
	/** 1 / 5 / 15 分钟负载，例如 "0.12 0.08 0.05" */
	load: string;
	/** CPU 核数 */
	cores: number;
	uptime: string;
	memory: { totalMb: number; usedMb: number; availableMb: number; percent: number };
	disks: Array<{ mount: string; size: string; used: string; free: string; percent: string }>;
	services: Array<{ name: string; load: string; active: string; sub: string; description: string }>;
	ports: Array<{ proto: string; local: string; process: string }>;
	/** 处于 failed 状态的单元名 */
	failed: string[];
	/** 最近的高级别日志（journalctl -p err） */
	logs: string[];
}

/** 服务器目录（自由导航，绝对路径）的列表结果 */
export interface ServerDirListing {
	/** 当前目录的绝对路径 */
	path: string;
	/** 上一级绝对路径；已在 / 时为 null */
	parent: string | null;
	/** 条目；path 为绝对路径（与 WorkspaceEntry 的相对路径语义不同） */
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
	/** 文件夹绝对路径（远程项目为服务器上的路径） */
	path: string;
	/** 关联的 SSH 主机；未设置表示本地文件夹 */
	hostId?: string;
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

// ---------------------------------------------------------------------------
// SSH 主机（远程服务器）
// ---------------------------------------------------------------------------

/** 认证方式：agent 走 ssh-agent 与 ~/.ssh/config；key 指定私钥文件；password 仅交互式终端可用 */
export type SshAuthMethod = "agent" | "key" | "password";

export interface SshHost {
	id: string;
	/** 显示名；未设置时用 user@host */
	name?: string;
	/** 主机名或 IP */
	host: string;
	/** 端口；未设置时用 ssh 默认（22） */
	port?: number;
	user?: string;
	auth: SshAuthMethod;
	/** auth = key 时的私钥路径（本机路径） */
	keyPath?: string;
	/** auth = password 时保存的口令（明文，仅用于交互式终端） */
	password?: string;
	/** 连接后的默认工作目录；未设置时用远程 home */
	defaultPath?: string;
	/** 远程平台，连接测试后记录，用于路径语义 */
	platform?: "linux" | "darwin" | "win32" | "unknown";
	createdAt: number;
}

export type SshHostInput = Omit<SshHost, "id" | "createdAt" | "platform">;

/** known_hosts 中的一条记录（或服务器当前出示的一把公钥） */
export interface HostKeyEntry {
	type: string;
	/** SHA256:xxxx */
	fingerprint: string;
	/** 所在的 known_hosts 文件（仅已记录的条目有） */
	file?: string;
}

/** 主机密钥检查结果：known 为本机记录，current 为服务器当前出示的 */
export interface HostKeyReport {
	hostId: string;
	/** known_hosts 中的主机标记，例如 [1.2.3.4]:2222 */
	target: string;
	known: HostKeyEntry[];
	current: HostKeyEntry[];
	/** 同类型公钥指纹不同 */
	changed: boolean;
}

/** 错误信息里带上这个前缀，界面据此弹出「主机密钥已变化」对话框；格式：前缀 + hostId + 换行 + 原始错误 */
export const HOST_KEY_CHANGED_PREFIX = "FLOWORK_HOST_KEY_CHANGED:";

/** 连接测试结果：连通性 + 远程环境探测 */
export interface SshTestResult {
	ok: boolean;
	latencyMs: number;
	platform?: string;
	home?: string;
	/** 远程 Node 版本；未安装时为 null */
	node?: string | null;
	error?: string;
}

/** 远程目录浏览（用于挑选远程项目目录） */
export interface RemoteDirListing {
	path: string;
	parent: string | null;
	entries: Array<{ name: string; path: string }>;
	home: string;
}

export interface DiscoveredProject {
	path: string;
	sessionCount: number;
	lastModified: number;
	/** 会话来自 FloWork 还是 pi 命令行 */
	sources: Array<"flowork" | "pi-cli">;
	exists: boolean;
}

export interface ImageModelInfo {
	/** provider/id，例如 relay-openai/gpt-image-1 */
	key: string;
	provider: string;
	id: string;
	name: string;
	/** 支持的尺寸，例如 ["1024x1024", "1536x1024"] */
	sizes: string[];
	/** 是否支持参考图（走 /images/edits） */
	edits: boolean;
	/** 每张价格（元），用于生成前的预估 */
	price?: number;
}

/** 一次生成的记录；图片本体存在本机缓存目录里，这里只有元数据 */
export interface GeneratedImage {
	/** 缓存文件名，也是读取与删除的标识 */
	id: string;
	prompt: string;
	/** provider/id */
	model: string;
	/** 例如 1024x1024 */
	size: string;
	quality: "standard" | "hd";
	bytes: number;
	createdAt: number;
	/** 是否用了参考图生成 */
	edited: boolean;
}

export interface BackendMethods extends DatabaseMethods {
	"app.info": { params: undefined; result: AppInfo };
	"kernel.status": { params: undefined; result: import("./kernel").KernelUpdateStatus };
	"kernel.check": { params: undefined; result: import("./kernel").KernelUpdateStatus };
	"kernel.install": { params: undefined; result: import("./kernel").KernelUpdateStatus };
	"kernel.useBundled": { params: undefined; result: import("./kernel").KernelUpdateStatus };
	"kernel.restart": { params: undefined; result: null };
	"app.pickFolder": { params: undefined; result: string | null };
	/** 系统对话框多选文件夹（仅桌面版） */
	"app.pickFolders": { params: undefined; result: string[] };
	/** 系统「保存到」对话框（仅桌面版）；取消返回 null */
	"app.pickSavePath": { params: { defaultName?: string }; result: string | null };
	"projects.get": { params: undefined; result: ProjectsState };
	"projects.add": { params: { paths: string[]; groupId?: string }; result: { state: ProjectsState; added: Project[]; skipped: string[] } };
	/** 添加远程项目：path 为服务器上的绝对路径 */
	"projects.addRemote": { params: { hostId: string; path: string; name?: string }; result: { state: ProjectsState; project: Project } };
	"projects.update": { params: { id: string; patch: ProjectPatch }; result: ProjectsState };
	"projects.remove": { params: { id: string }; result: ProjectsState };
	"projects.touch": { params: { id: string }; result: ProjectsState };
	/** 把 ids 按顺序放入目标区域：pinned 为置顶区，否则为 groupId（null 表示未分组） */
	"projects.move": { params: { ids: string[]; pinned: boolean; groupId: string | null }; result: ProjectsState };
	"projects.groupCreate": { params: { name: string }; result: { state: ProjectsState; group: ProjectGroup } };
	"projects.groupUpdate": { params: { id: string; name?: string; collapsed?: boolean }; result: ProjectsState };
	"projects.groupRemove": { params: { id: string }; result: ProjectsState };
	"projects.discover": { params: undefined; result: DiscoveredProject[] };
	// ----- SSH 主机 -----
	"hosts.get": { params: undefined; result: SshHost[] };
	"hosts.add": { params: SshHostInput; result: { hosts: SshHost[]; host: SshHost } };
	"hosts.update": { params: { id: string; patch: Partial<SshHostInput> }; result: SshHost[] };
	"hosts.remove": { params: { id: string }; result: SshHost[] };
	/** 连接测试：探测平台、home、远程 Node 版本 */
	"hosts.test": { params: { id: string }; result: SshTestResult };
	/** 浏览远程目录，用于挑选远程项目路径 */
	"hosts.listDirs": { params: { id: string; path?: string }; result: RemoteDirListing };
	/** 系统对话框挑选私钥文件（仅桌面版） */
	"hosts.pickKey": { params: undefined; result: string | null };
	/** 比对 known_hosts 记录与服务器当前的主机密钥 */
	"hosts.inspectKey": { params: { id: string }; result: HostKeyReport };
	/** 用户确认后更新 known_hosts（只接受与 fingerprints 一致的公钥） */
	"hosts.acceptKey": { params: { id: string; fingerprints: string[] }; result: { removedFrom: string[] } };
	"fs.listDirs": { params: { path?: string }; result: DirListing };
	"workspace.list": { params: { root: string; path?: string }; result: WorkspaceDirListing };
	"workspace.read": { params: { root: string; path: string }; result: FilePreview };
	/** 保存文件；expectedMtime 与磁盘不一致时拒绝（文件已被 AI 或外部修改） */
	"workspace.write": {
		params: { root: string; path: string; content: string; expectedMtime?: number };
		result: FilePreview;
	};
	"workspace.search": { params: { root: string; query: string; limit?: number; /** 忽略缓存重新扫描 */ fresh?: boolean }; result: FileSearchResult };
	/** 重命名（同目录改名）；name 不能包含路径分隔符 */
	"workspace.rename": { params: { root: string; path: string; name: string }; result: { path: string } };
	/** 在 path 下新建文件或文件夹；文件夹会自动创建父目录 */
	"workspace.create": { params: { root: string; path: string; type: "file" | "dir" }; result: { path: string } };
	/** 删除文件/文件夹；桌面版移入系统回收站，网页版永久删除 */
	"workspace.delete": { params: { root: string; path: string }; result: { trashed: boolean } };
	/** 移动到工作区内的另一个目录（targetDir 为相对路径，"" 表示根） */
	"workspace.move": { params: { root: string; path: string; targetDir: string }; result: { path: string } };
	/** 在系统文件管理器中定位（仅桌面版） */
	"workspace.reveal": { params: { root: string; path: string }; result: null };
	/** 在系统终端中打开所在目录（仅桌面版） */
	"workspace.openTerminal": { params: { root: string; path: string }; result: null };
	/** 为项目根目录起一个只读的本地预览服务，返回可直接在内置浏览器打开的 origin（仅本地项目） */
	"preview.serve": { params: { root: string }; result: { origin: string } };
	// ----- 服务器目录：按 hostId + 绝对路径操作，不限定在项目根内 -----
	/** 列目录；path 省略时从 / 开始 */
	"server.list": { params: { hostId: string; path?: string }; result: ServerDirListing };
	"server.read": { params: { hostId: string; path: string }; result: FilePreview };
	/** 保存文件；expectedMtime 与远端不一致时拒绝（文件已被 AI 或外部修改） */
	"server.write": {
		params: { hostId: string; path: string; content: string; expectedMtime?: number };
		result: FilePreview;
	};
	/** 新建文件或文件夹；文件夹会自动创建父目录 */
	"server.create": { params: { hostId: string; path: string; type: "file" | "dir" }; result: { path: string } };
	/** 重命名（同目录改名）；name 不能包含路径分隔符 */
	"server.rename": { params: { hostId: string; path: string; name: string }; result: { path: string } };
	/** 删除文件/文件夹；远端没有回收站，是永久删除 */
	"server.delete": { params: { hostId: string; path: string }; result: { trashed: boolean } };
	/** 移动到另一个绝对路径目录 */
	"server.move": { params: { hostId: string; path: string; targetDir: string }; result: { path: string } };
	/** 上传：把本地文件内容（base64）写到 dir/name；同名文件已存在时拒绝 */
	"server.upload": { params: { hostId: string; dir: string; name: string; dataBase64: string }; result: { path: string } };
	/** 下载：把远端文件内容以 base64 返回；超过上限时拒绝 */
	"server.download": { params: { hostId: string; path: string }; result: { name: string; dataBase64: string; size: number } };
	/** 下载到本地指定路径（桌面版：先弹「保存到」对话框拿 targetPath，再一步写盘，内容不过渲染进程） */
	"server.exportToLocal": { params: { hostId: string; path: string; targetPath: string }; result: { size: number } };
	/** 服务器状态快照（只读）：负载 / 内存 / 磁盘 / 服务单元 / 监听端口 / 失败与日志 */
	"server.monitor": { params: { hostId: string }; result: HostMonitorSnapshot };
	"service.send": { params: ServiceCommand; result: unknown };
	"session.open": { params: { cwd: string; sessionPath?: string; approvalMode?: ApprovalMode }; result: { handleId: string; state: SessionState } };
	"session.send": { params: { handleId: string; command: SessionCommand }; result: unknown };
	"session.close": { params: { handleId: string }; result: null };
	"sessions.rename": { params: { cwd: string; path: string; name: string }; result: null };
	"sessions.delete": { params: { cwd: string; path: string }; result: null };
	"auth.answer": { params: { flowId: string; promptId: string; value?: string; cancel?: boolean }; result: null };
	"auth.cancel": { params: { flowId: string }; result: null };
	/** 打开真终端（PTY）；同一 cwd 已有存活终端时复用，reused 为 true */
	"terminal.open": { params: { cwd: string; cols: number; rows: number; /** 远程主机；不传为本地终端 */ hostId?: string }; result: { terminalId: string; shell: string; reused: boolean } };
	"terminal.write": { params: { terminalId: string; data: string }; result: null };
	"terminal.resize": { params: { terminalId: string; cols: number; rows: number }; result: null };
	"terminal.close": { params: { terminalId: string }; result: null };
	// ---------------------------------------------------------------------
	// 图片生成（OpenAI 兼容的 /images/generations 与 /images/edits）
	// ---------------------------------------------------------------------
	/** 已配置的图片模型（models.json 里各供应商声明的 imageModels） */
	"images.models": { params: undefined; result: ImageModelInfo[] };
	/** 生成图片；结果写入本机缓存目录并返回这次的记录 */
	"images.generate": {
		params: {
			model?: string;
			prompt: string;
			size?: string;
			quality?: "standard" | "hd";
			count?: number;
			/** 参考图（base64，不带前缀）；传了就走图生图 */
			reference?: { dataBase64: string; mimeType: string };
		};
		result: GeneratedImage[];
	};
	/** 生成历史（新→旧） */
	"images.list": { params: undefined; result: GeneratedImage[] };
	/** 读取图片内容（base64），用于界面显示与插入会话 */
	"images.read": { params: { id: string }; result: { id: string; mimeType: string; dataBase64: string; bytes: number } };
	"images.remove": { params: { id: string }; result: null };
	/** 清空缓存；已经插入会话的附件不受影响 */
	"images.clear": { params: undefined; result: { removed: number } };
}

export type BackendMethod = keyof BackendMethods;

export type BackendPush =
	| { type: "kernel_update"; status: import("./kernel").KernelUpdateStatus }
	| { type: "session_event"; handleId: string; event: SessionEvent }
	| { type: "session_exit"; handleId: string; code: number; expected?: boolean }
	| { type: "sessions_changed"; cwd: string }
	| { type: "auth"; event: AuthFlowEvent }
	/** 凭据或配置文件变更，界面应刷新模型与供应商列表 */
	| { type: "config_changed" }
	| { type: "projects_changed"; state: ProjectsState }
	/** SSH 主机列表变更 */
	| { type: "hosts_changed"; hosts: SshHost[] }
	/** 技能 / 扩展变化，设置页与斜杠命令列表应刷新 */
	| { type: "resources_changed" }
	/** 终端输出；不做回放，重连后只收到之后的数据 */
	| { type: "terminal_data"; terminalId: string; data: string }
	| { type: "terminal_exit"; terminalId: string; code: number };

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

/**
 * 桌面版 preload 暴露的原始通道。
 * contextBridge 只允许 1000 层嵌套（实测约 330 层就报错），而会话树这种「每多一条记录就深一层」
 * 的响应很容易越界，所以跨桥的请求结果与推送一律先序列化成字符串，
 * 由渲染进程侧 parse（见 renderer/src/api/transport.ts）。
 */
export interface ElectronBridge {
	request(method: BackendMethod, params: unknown): Promise<string>;
	onPush(listener: (payload: string) => void): () => void;
}

export const ELECTRON_CHANNELS = {
	request: "flowork:request",
	push: "flowork:push",
	/** 自绘标题栏的窗口按钮（最小化 / 最大化 / 关闭） */
	windowControl: "flowork:window-control",
	/** 界面主题（深色 / 浅色 / 跟随系统）：同步 nativeTheme 与窗口背景色 */
	theme: "flowork:theme",
} as const;
