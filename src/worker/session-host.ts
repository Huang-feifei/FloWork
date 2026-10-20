/**
 * 在 worker 内承载一个 pi 会话（AgentSessionRuntime），处理 SessionCommand 并转发事件。
 */
import { existsSync } from "node:fs";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { assessToolCall } from "@shared/command-risk";
import {
	type ApprovalDecision,
	type ApprovalMode,
	type ApprovalRisk,
	type CommandResultMap,
	DEFAULT_APPROVAL_MODE,
	type HostProfile,
	type ImageAttachment,
	type OpsSessionInfo,
	type QueuedMessage,
	type QueuedMessages,
	READ_ONLY_TOOLS,
	type SessionCommand,
	type SessionEvent,
	type SessionState,
	type SlashCommand,
	type SshHost,
	type WorkMode,
} from "@shared/protocol";
import { readSubagentSettings } from "@shared/subagent-settings";
import { toChatMessage, toContentBlocks, toModelInfo, toSessionEvents, toSessionState, toTree } from "./adapter";
import { ExtensionUI } from "./extension-ui";
import { type ApprovalRequest, createFloworkExtension } from "./flowork-extension";
import { BackupLog, createOpsExtension, type OpsTarget, probeHostProfile } from "./ops-tools";
import { getProjectTrust, isProjectTrusted, setProjectTrust } from "./trust";
import { createSubagentExtension } from "./subagent";
import { validateSession } from "./session-files";
import { allowedInPlan, createPlanningExtension, DECISION_TOOLS, restoredWorkMode, WORK_MODE_ENTRY } from "./planning";

interface PendingApproval {
	toolName: string;
	/** 高危操作：不允许「本会话始终允许」 */
	danger: boolean;
	resolve: (decision: ApprovalDecision, reason?: string) => void;
}

export interface OpsInit {
	host: SshHost;
	remoteCwd: string;
}

/** pi 内部队列保存的是完整 AgentMessage；用它取回被队列暂存的图片附件。 */
type AgentQueueInternals = {
	steeringQueue?: { messages?: unknown[] };
	followUpQueue?: { messages?: unknown[] };
};

function queuedImages(message: unknown): ImageAttachment[] | undefined {
	const images = toContentBlocks((message as { content?: unknown } | null)?.content).filter(
		(block): block is ImageAttachment => block.type === "image",
	);
	return images.length > 0 ? images : undefined;
}

/**
 * 把队列文本和 pi 内部队列里的完整消息按顺序对齐，得到带图片的排队消息。
 * 升级 pi 后如果内部队列结构变化，这里会退化成只有文字，取回仍然可用。
 */
function readQueuedMessages(session: AgentSession): QueuedMessages {
	const internal = session.agent as unknown as AgentQueueInternals;
	const align = (texts: readonly string[], messages: unknown[] | undefined): QueuedMessage[] =>
		texts.map((text, index) => {
			const images = messages?.length === texts.length ? queuedImages(messages[index]) : undefined;
			return images ? { text, images } : { text };
		});
	return {
		steering: align(session.getSteeringMessages(), internal.steeringQueue?.messages),
		followUp: align(session.getFollowUpMessages(), internal.followUpQueue?.messages),
	};
}

/**
 * 按顺序列出「每条消息属于哪个会话树条目」。
 * pi 的 session.messages 是会话投影里消息的扁平列表，而每个投影条目带 sourceEntry.id，
 * 所以可以按顺序一一对上；对不上（长度不一致）时返回空数组，界面会退化成只标当前位置。
 */
function messageEntryIds(session: AgentSession): string[] {
	try {
		const ids: string[] = [];
		for (const entry of session.sessionManager.buildSessionProjection().entries) {
			for (let i = 0; i < entry.messages.length; i++) ids.push(entry.sourceEntry.id);
		}
		return ids;
	} catch {
		return [];
	}
}

export class SessionHost {
	private runtime: AgentSessionRuntime | undefined;
	private unsubscribe: (() => void) | undefined;
	private approvalMode: ApprovalMode;
	private workMode: WorkMode = "execute";
	/** 本会话中用户选择“始终允许”的工具 */
	private readonly allowedTools = new Set<string>();
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	/** 运行中收到的资源重新加载请求，推迟到本轮结束 */
	private reloadPending = false;
	/** 第三方扩展的 ctx.ui（对话框、状态、小组件） */
	private readonly extUI: ExtensionUI;
	/** 运维会话：工具在远程主机上执行 */
	private ops: { target: OpsTarget; info: OpsSessionInfo; backups: BackupLog } | undefined;

	constructor(
		private readonly emit: (event: SessionEvent) => void,
		approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
	) {
		this.approvalMode = approvalMode;
		this.extUI = new ExtensionUI(emit);
	}

	private get opsProfile(): HostProfile | null {
		return this.ops?.info.profile ?? null;
	}

	/** 运维会话开始时探测主机画像；失败不阻止会话，只在头部提示 */
	private async probeProfile(): Promise<void> {
		const ops = this.ops;
		if (!ops) return;
		try {
			ops.info.profile = await probeHostProfile(ops.target.host);
			delete ops.info.profileError;
		} catch (error) {
			ops.info.profileError = errorText(error).replace(/^FLOWORK_HOST_KEY_CHANGED:[^\n]*\n/, "");
			// 带前缀的错误原样发给界面，界面据此弹出「主机密钥已变化」对话框
			this.emit({ type: "notice", level: "warning", text: errorText(error).startsWith("FLOWORK_HOST_KEY_CHANGED:") ? errorText(error) : `无法探测主机环境：${errorText(error)}` });
		}
		if (this.runtime) this.changed();
	}

	private get session(): AgentSession {
		if (!this.runtime) throw new Error("会话尚未初始化");
		return this.runtime.session;
	}

	/** 每次新建 / 切换 / 分叉会话时 pi 都会调用它重建服务，FloWork 扩展随之注入 */
	private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const ops = this.ops;
		// SDK 默认信任所有项目；这里按用户的信任决定加载项目级配置（见 trust.ts）。
		// 运维会话的 cwd 是本地占位目录，里面没有项目配置，按不信任处理
		const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: !ops && isProjectTrusted(cwd) });
		const subagentSettings = readSubagentSettings(settingsManager.getGlobalSettings());
		const extensionFactories = [
			createFloworkExtension({ approve: (req, signal) => this.approve(req, signal), skipWriteDiff: !!ops }),
			createPlanningExtension({
				getMode: () => this.workMode,
				askUser: (question, options, signal) => this.extUI.askUser(question, options, signal),
				reviewPlan: (plan, signal) => this.extUI.reviewPlan(plan, signal),
				acceptPlan: (sessionId, signal) => {
					if (signal?.aborted || this.session.sessionManager.getSessionId() !== sessionId || this.workMode !== "plan") {
						throw new Error("计划确认已失效，请重新提交计划");
					}
					this.setWorkMode("execute");
				},
			}),
		];
		if (ops) extensionFactories.push(createOpsExtension(ops.target, () => this.opsProfile, ops.backups));
		// 子代理只在本地会话可用：运维会话的工具在远端，不能把本地子会话当作远程子代理。
		// 设置关闭时新会话不注册这个工具；已打开的会话需要重开或切换会话。
		else if (subagentSettings.enabled) {
			extensionFactories.push(createSubagentExtension({ getModelRuntime: () => this.session.modelRuntime }, subagentSettings));
		}
		const services = await createAgentSessionServices({
			cwd,
			settingsManager,
			resourceLoaderOptions: { extensionFactories },
		});
		return {
			...(await createAgentSessionFromServices({
				services, sessionManager, sessionStartEvent,
				// 计划阶段不能用 Shell 搜索，补齐本地专用只读工具；运维会话不能误用本地目录。
				tools: ops ? undefined : ["+grep", "+find", "+ls"],
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	async init(cwd: string, sessionPath?: string, ops?: OpsInit): Promise<SessionState> {
		if (ops) {
			const { host, remoteCwd } = ops;
			const label = `${host.user ? `${host.user}@` : ""}${host.host}${host.port ? `:${host.port}` : ""}`;
			this.ops = {
				target: { host, remoteCwd, localCwd: cwd },
				info: { hostId: host.id, label, remoteCwd },
				backups: new BackupLog(),
			};
			// 画像在后台探测，完成后推送 session_changed；第一轮对话前通常已经完成
			void this.probeProfile();
		}
		if (sessionPath) await validateSession(cwd, sessionPath);
		const sessionManager = sessionPath ? SessionManager.open(sessionPath) : SessionManager.create(cwd);
		this.runtime = await createAgentSessionRuntime(this.createRuntime, { cwd, agentDir: getAgentDir(), sessionManager });
		// 新建 / 切换 / 分叉会话（无论由界面还是扩展命令发起）后 pi 先调用它，再执行扩展传入的 withSession 回调。
		// 在这里通知界面，使 withSession 中弹出的对话框出现时界面已切到新会话
		this.runtime.setRebindSession(async () => {
			this.resetApprovals();
			await this.bind();
			this.changed();
		});
		for (const diagnostic of this.runtime.diagnostics ?? []) {
			this.emit({ type: "notice", level: "warning", text: formatDiagnostic(diagnostic) });
		}
		await this.bind();
		return this.stateOf();
	}

	/** 运行时替换会话后，事件订阅与扩展绑定都属于旧会话，必须重新绑定 */
	private async bind(): Promise<void> {
		this.unsubscribe?.();
		this.extUI.cancelAll();
		const session = this.session;
		this.workMode = restoredWorkMode(session.sessionManager.getBranch());
		const runtime = this.requireRuntime();
		await session.bindExtensions({
			uiContext: this.extUI.createContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: async (entryId, options) => ({ cancelled: (await runtime.fork(entryId, options)).cancelled }),
				navigateTree: async (targetId, options) => {
					this.extUI.cancelAll();
					const result = await this.session.navigateTree(targetId, options);
					if (!result.cancelled) {
						this.workMode = restoredWorkMode(this.session.sessionManager.getBranch());
						this.changed();
					}
					return { cancelled: result.cancelled };
				},
				// 扩展代码本身在本机运行，其传入的会话路径不经过界面，交给 pi 校验即可
				switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
				reload: async () => {
					await this.session.reload();
					this.changed();
				},
			},
			onError: (err) => {
				this.emit({ type: "notice", level: "error", text: `扩展出错（${err.event}）：${err.error}
${err.extensionPath}` });
			},
		});
		this.unsubscribe = session.subscribe((event) => {
			for (const out of toSessionEvents(event)) this.emit(out);
			if (event.type === "agent_settled" && this.reloadPending) {
				this.reloadPending = false;
				void this.reloadResources();
			}
		});
	}

	private stateOf(): SessionState {
		const session = this.session;
		const state: SessionState = { ...toSessionState(session), workMode: this.workMode, trust: getProjectTrust(session.sessionManager.getCwd()) };
		if (this.ops) {
			state.ops = { ...this.ops.info };
			// 运维会话不需要项目信任（占位目录里没有项目配置）
			delete state.trust;
		}
		return state;
	}

	private changed(): SessionState {
		const state = this.stateOf();
		this.emit({ type: "session_changed", state });
		return state;
	}

	private setWorkMode(mode: WorkMode): void {
		if (mode !== "plan" && mode !== "execute") throw new Error("无效的工作模式");
		this.session.sessionManager.appendCustomEntry(WORK_MODE_ENTRY, { mode });
		this.workMode = mode;
		this.emit({ type: "work_mode_changed", mode });
	}

	// ----- 工具审批 -----

	/**
	 * 是否需要确认：
	 * - 本地会话按工具名判断（只读工具在 ask_writes 下自动执行）
	 * - 运维会话按命令内容判断：高危在任何模式下都要确认、不受「始终允许」影响；
	 *   ask_writes 下只读命令自动执行；auto 下非高危自动执行
	 */
	private needsApproval(toolName: string, risk: ApprovalRisk | undefined): boolean {
		if (risk) {
			if (risk.level === "danger") return true;
			if (this.approvalMode === "auto" || this.allowedTools.has(toolName)) return false;
			if (this.approvalMode === "ask_all") return true;
			return risk.level !== "read";
		}
		if (this.approvalMode === "auto" || this.allowedTools.has(toolName)) return false;
		if (this.approvalMode === "ask_all") return true;
		return !READ_ONLY_TOOLS.has(toolName);
	}

	private assess(request: ApprovalRequest): ApprovalRisk | undefined {
		if (!this.ops) return undefined;
		const { risk, reasons } = assessToolCall(request.toolName, request.input);
		return { level: risk, reasons };
	}

	private approve(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<string | null> {
		// 计划限制优先于自动审批及「本会话始终允许」，未知工具一律禁止。
		if (this.workMode === "plan" && !allowedInPlan(request.toolName)) {
			return Promise.resolve("计划模式禁止此工具。只能只读探索、ask_user 提问和 submit_plan 提交计划；须用户确认计划后才能修改或运行命令。");
		}
		// 决策工具本身会等待用户应答，无需再套一层工具执行审批。
		if (DECISION_TOOLS.has(request.toolName)) return Promise.resolve(null);
		const risk = this.assess(request);
		if (!this.needsApproval(request.toolName, risk)) return Promise.resolve(null);
		if (signal?.aborted) return Promise.resolve("运行已中断");
		return new Promise((resolve) => {
			const onAbort = () => this.resolveApproval(request.toolCallId, "deny", "运行已中断");
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pendingApprovals.set(request.toolCallId, {
				toolName: request.toolName,
				danger: risk?.level === "danger",
				resolve: (decision, reason) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(decision === "deny" ? (reason ?? "用户拒绝执行此工具调用") : null);
				},
			});
			this.emit({
				type: "approval_request",
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				args: request.input,
				risk,
			});
		});
	}

	private resolveApproval(toolCallId: string, decision: ApprovalDecision, reason?: string): void {
		const pending = this.pendingApprovals.get(toolCallId);
		if (!pending) return;
		this.pendingApprovals.delete(toolCallId);
		// 高危操作的「始终允许」按单次允许处理，不放开整个工具
		if (decision === "allow_session" && !pending.danger) this.allowedTools.add(pending.toolName);
		pending.resolve(decision, reason);
		this.emit({ type: "approval_resolved", toolCallId, decision });
	}

	private denyAllPending(reason: string): void {
		for (const id of [...this.pendingApprovals.keys()]) this.resolveApproval(id, "deny", reason);
	}

	/** 切换会话时清空“本会话始终允许”的工具 */
	private resetApprovals(): void {
		this.denyAllPending("会话已切换");
		this.allowedTools.clear();
	}

	// ----- 命令 -----

	async handle(command: SessionCommand): Promise<CommandResultMap[SessionCommand["type"]]> {
		const session = this.session;
		switch (command.type) {
			case "prompt":
				return this.prompt(command.message, command.images, command.streamingBehavior);
			case "clear_queue": {
				// 先读取完整消息（含图片）再清空，供界面「取回」到输入框。
				const queue = readQueuedMessages(session);
				session.clearQueue();
				return queue;
			}
			case "reorder_queue":
				return this.reorderQueue(command.steering, command.followUp);
			case "abort":
				this.denyAllPending("用户中断了运行");
				this.extUI.cancelAll();
				await session.abort();
				return null;
			case "get_state":
				return this.stateOf();
			case "get_messages": {
				const entryIds = messageEntryIds(session);
				const aligned = entryIds.length === session.messages.length;
				return session.messages.flatMap((m, i) => {
					const message = toChatMessage(m, aligned ? entryIds[i] : undefined);
					return message ? [message] : [];
				});
			}
			case "get_tree":
				return {
					tree: toTree(session.sessionManager.getTree()),
					leafId: session.sessionManager.getLeafId(),
				};
			case "navigate_tree": {
				this.extUI.cancelAll();
				const result = await session.navigateTree(command.entryId, { summarize: command.summarize });
				if (!result.cancelled) {
					this.workMode = restoredWorkMode(session.sessionManager.getBranch());
					this.changed();
				}
				return { cancelled: result.cancelled, editorText: result.editorText };
			}
			case "fork": {
				this.resetApprovals();
				const result = await this.requireRuntime().fork(command.entryId, { position: command.position });
				const state = this.stateOf();
				return { cancelled: result.cancelled, editorText: result.selectedText, state };
			}
			case "set_label":
				session.sessionManager.appendLabelChange(command.entryId, command.label || undefined);
				return null;
			case "get_available_models": {
				const models = await session.modelRuntime.getAvailable();
				return models.flatMap((m) => toModelInfo(m) ?? []);
			}
			case "set_model": {
				const model = session.modelRuntime.getModel(command.provider, command.modelId);
				if (!model) throw new Error(`找不到模型：${command.provider}/${command.modelId}`);
				await session.setModel(model);
				return this.stateOf();
			}
			case "set_thinking_level":
				session.setThinkingLevel(command.level);
				return this.stateOf();
			case "new_session":
				this.resetApprovals();
				await this.requireRuntime().newSession();
				return this.stateOf();
			case "switch_session":
				this.resetApprovals();
				await this.requireRuntime().switchSession(command.sessionPath);
				return this.stateOf();
			case "set_session_name":
				session.setSessionName(command.name.trim());
				return null;
			case "set_work_mode":
				if (session.isStreaming || this.extUI.hasPending || this.pendingApprovals.size > 0) throw new Error("请先结束当前运行或中断，再切换工作模式");
				this.setWorkMode(command.mode);
				return this.stateOf();
			case "set_approval_mode":
				this.approvalMode = command.mode;
				// 切换到自动模式时，放行正在等待的请求（高危操作除外）
				if (command.mode === "auto") {
					for (const [id, pending] of [...this.pendingApprovals]) if (!pending.danger) this.resolveApproval(id, "allow");
				}
				return null;
			case "respond_approval":
				this.resolveApproval(command.toolCallId, command.decision);
				return null;
			case "respond_ext_ui":
				this.extUI.respond(command.id, command);
				return null;
			case "set_project_trust": {
				if (this.ops) throw new Error("运维会话没有项目信任设置");
				const cwd = session.sessionManager.getCwd();
				if (session.isStreaming) throw new Error("请先等待当前运行结束");
				setProjectTrust(cwd, command.trusted);
				// 重建运行时，使新的信任状态生效（保留当前会话）
				this.resetApprovals();
				const file = session.sessionFile;
				if (file && existsSync(file)) await this.requireRuntime().switchSession(file);
				else await this.requireRuntime().newSession();
				return this.stateOf();
			}
			case "reload_resources":
				if (session.isStreaming) {
					this.reloadPending = true;
					return { deferred: true };
				}
				await this.reloadResources();
				return { deferred: false };
			case "get_commands":
				return this.commands();
			case "refresh_config":
				// 凭据与 models.json 由 ModelRuntime 重新加载；settings.json 由 SettingsManager 重新读取
				await session.settingsManager.reload();
				await session.modelRuntime.refresh();
				return this.stateOf();
		}
	}

	private async reloadResources(): Promise<void> {
		try {
			await this.session.reload();
			this.emit({ type: "notice", level: "info", text: "技能与扩展已重新加载" });
			this.changed();
		} catch (error) {
			this.emit({ type: "notice", level: "error", text: `重新加载失败：${errorText(error)}` });
		}
	}

	private commands(): SlashCommand[] {
		const session = this.session;
		const out: SlashCommand[] = [];
		for (const c of session.extensionRunner.getRegisteredCommands()) {
			out.push({ name: c.invocationName, description: c.description, source: "extension" });
		}
		for (const t of session.promptTemplates) out.push({ name: t.name, description: t.description, source: "prompt" });
		for (const s of session.resourceLoader.getSkills().skills) {
			out.push({ name: `skill:${s.name}`, description: s.description, source: "skill" });
		}
		return out;
	}

	/**
	 * pi 的 prompt() 会等到整轮运行结束才 resolve。
	 * 这里在 pi 接受（或排队、被扩展处理）后立即返回，运行中的错误通过事件上报。
	 */
	private prompt(
		message: string,
		images: ImageAttachment[] | undefined,
		streamingBehavior: "steer" | "followUp" | undefined,
	): Promise<CommandResultMap["prompt"]> {
		const session = this.session;
		const behavior = session.isStreaming ? (streamingBehavior ?? "followUp") : undefined;
		return new Promise((resolve, reject) => {
			let accepted = false;
			session
				.prompt(message, {
					// 空数组按未传处理；pi 在运行中排队时会带着图片一起送达
					images: images && images.length > 0 ? images : undefined,
					streamingBehavior: behavior,
					preflightResult: (disposition) => {
						accepted = true;
						resolve({ disposition });
					},
				})
				.then(() => {
					if (!accepted) resolve({ disposition: "handled" });
				})
				.catch((error: unknown) => {
					if (!accepted) reject(error);
					else this.emit({ type: "notice", level: "error", text: errorText(error) });
				});
		});
	}

	/**
	 * pi 的队列是 FIFO，没有重排 API，这里用「清空后按新顺序重新入队」实现排序。
	 * 用内部入队方法（不再展开模板、不重复触发扩展 input handler），并尽量在一次同步执行内完成，
	 * 避免 agent 在重排中途取走消息造成顺序错乱。
	 */
	private async reorderQueue(steering: string[], followUp: string[]): Promise<{ steering: string[]; followUp: string[] }> {
		const session = this.session;
		const internals = session as unknown as {
			_queueSteer?: (text: string, images?: ImageAttachment[]) => Promise<void>;
			_queueFollowUp?: (text: string, images?: ImageAttachment[]) => Promise<void>;
		};
		if (typeof internals._queueSteer !== "function" || typeof internals._queueFollowUp !== "function") {
			throw new Error("当前 pi 版本不支持队列重排");
		}
		// 清除前先保留每条消息的图片，重排后按文本多重集把附件补回去。
		const before = readQueuedMessages(session);
		const next = { steering: [...steering], followUp: [...followUp] };
		// 多重集校验：界面操作期间队列可能变化（新消息入队或被送达）
		const counts = new Map<string, number>();
		for (const item of [...before.steering, ...before.followUp]) counts.set(item.text, (counts.get(item.text) ?? 0) + 1);
		for (const text of [...next.steering, ...next.followUp]) counts.set(text, (counts.get(text) ?? 0) - 1);
		if ([...counts.values()].some((n) => n !== 0)) throw new Error("队列已变化，请重试");

		session.clearQueue();
		const pool = [...before.steering, ...before.followUp];
		const take = (text: string): QueuedMessage | undefined => {
			const index = pool.findIndex((item) => item.text === text);
			return index >= 0 ? pool.splice(index, 1)[0] : undefined;
		};
		try {
			for (const text of next.steering) await internals._queueSteer(text, take(text)?.images);
			for (const text of next.followUp) await internals._queueFollowUp(text, take(text)?.images);
		} catch (error) {
			// 中途失败时恢复原队列（连同图片），避免消息丢失。
			session.clearQueue();
			for (const item of before.steering) await internals._queueSteer(item.text, item.images);
			for (const item of before.followUp) await internals._queueFollowUp(item.text, item.images);
			throw error;
		}
		return { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] };
	}

	private requireRuntime(): AgentSessionRuntime {
		if (!this.runtime) throw new Error("会话尚未初始化");
		return this.runtime;
	}

	async dispose(): Promise<void> {
		this.denyAllPending("会话已关闭");
		this.extUI.cancelAll();
		this.unsubscribe?.();
		await this.runtime?.dispose();
		this.runtime = undefined;
	}
}

function formatDiagnostic(diagnostic: unknown): string {
	if (diagnostic && typeof diagnostic === "object" && "message" in diagnostic) {
		return String((diagnostic as { message: unknown }).message);
	}
	return String(diagnostic);
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
