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
import {
	type ApprovalDecision,
	type ApprovalMode,
	type CommandResultMap,
	DEFAULT_APPROVAL_MODE,
	READ_ONLY_TOOLS,
	type SessionCommand,
	type SessionEvent,
	type SessionState,
	type SlashCommand,
} from "@shared/protocol";
import { toChatMessage, toModelInfo, toSessionEvents, toSessionState, toTree } from "./adapter";
import { ExtensionUI } from "./extension-ui";
import { type ApprovalRequest, createFloworkExtension } from "./flowork-extension";
import { getProjectTrust, isProjectTrusted, setProjectTrust } from "./trust";
import { validateSession } from "./session-files";

interface PendingApproval {
	toolName: string;
	resolve: (decision: ApprovalDecision, reason?: string) => void;
}

export class SessionHost {
	private runtime: AgentSessionRuntime | undefined;
	private unsubscribe: (() => void) | undefined;
	private approvalMode: ApprovalMode;
	/** 本会话中用户选择“始终允许”的工具 */
	private readonly allowedTools = new Set<string>();
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	/** 运行中收到的资源重新加载请求，推迟到本轮结束 */
	private reloadPending = false;
	/** 第三方扩展的 ctx.ui（对话框、状态、小组件） */
	private readonly extUI: ExtensionUI;

	constructor(
		private readonly emit: (event: SessionEvent) => void,
		approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
	) {
		this.approvalMode = approvalMode;
		this.extUI = new ExtensionUI(emit);
	}

	private get session(): AgentSession {
		if (!this.runtime) throw new Error("会话尚未初始化");
		return this.runtime.session;
	}

	/** 每次新建 / 切换 / 分叉会话时 pi 都会调用它重建服务，FloWork 扩展随之注入 */
	private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			// SDK 默认信任所有项目；这里按用户的信任决定加载项目级配置（见 trust.ts）
			settingsManager: SettingsManager.create(cwd, getAgentDir(), { projectTrusted: isProjectTrusted(cwd) }),
			resourceLoaderOptions: {
				extensionFactories: [createFloworkExtension({ approve: (req, signal) => this.approve(req, signal) })],
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};

	async init(cwd: string, sessionPath?: string): Promise<SessionState> {
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
		const runtime = this.requireRuntime();
		await session.bindExtensions({
			uiContext: this.extUI.createContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: async (entryId, options) => ({ cancelled: (await runtime.fork(entryId, options)).cancelled }),
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, options);
					if (!result.cancelled) this.changed();
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
		return { ...toSessionState(session), trust: getProjectTrust(session.sessionManager.getCwd()) };
	}

	private changed(): SessionState {
		const state = this.stateOf();
		this.emit({ type: "session_changed", state });
		return state;
	}

	// ----- 工具审批 -----

	private needsApproval(toolName: string): boolean {
		if (this.approvalMode === "auto" || this.allowedTools.has(toolName)) return false;
		if (this.approvalMode === "ask_all") return true;
		return !READ_ONLY_TOOLS.has(toolName);
	}

	private approve(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<string | null> {
		if (!this.needsApproval(request.toolName)) return Promise.resolve(null);
		if (signal?.aborted) return Promise.resolve("运行已中断");
		return new Promise((resolve) => {
			const onAbort = () => this.resolveApproval(request.toolCallId, "deny", "运行已中断");
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pendingApprovals.set(request.toolCallId, {
				toolName: request.toolName,
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
			});
		});
	}

	private resolveApproval(toolCallId: string, decision: ApprovalDecision, reason?: string): void {
		const pending = this.pendingApprovals.get(toolCallId);
		if (!pending) return;
		this.pendingApprovals.delete(toolCallId);
		if (decision === "allow_session") this.allowedTools.add(pending.toolName);
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
				return this.prompt(command.message, command.streamingBehavior);
			case "abort":
				this.denyAllPending("用户中断了运行");
				this.extUI.cancelAll();
				await session.abort();
				return null;
			case "get_state":
				return this.stateOf();
			case "get_messages":
				return session.messages.flatMap((m) => toChatMessage(m) ?? []);
			case "get_tree":
				return {
					tree: toTree(session.sessionManager.getTree()),
					leafId: session.sessionManager.getLeafId(),
				};
			case "navigate_tree": {
				const result = await session.navigateTree(command.entryId, { summarize: command.summarize });
				if (!result.cancelled) this.changed();
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
			case "set_approval_mode":
				this.approvalMode = command.mode;
				// 切换到自动模式时，放行正在等待的请求
				if (command.mode === "auto") for (const id of [...this.pendingApprovals.keys()]) this.resolveApproval(id, "allow");
				return null;
			case "respond_approval":
				this.resolveApproval(command.toolCallId, command.decision);
				return null;
			case "respond_ext_ui":
				this.extUI.respond(command.id, command);
				return null;
			case "set_project_trust": {
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
		streamingBehavior: "steer" | "followUp" | undefined,
	): Promise<CommandResultMap["prompt"]> {
		const session = this.session;
		const behavior = session.isStreaming ? (streamingBehavior ?? "followUp") : undefined;
		return new Promise((resolve, reject) => {
			let accepted = false;
			session
				.prompt(message, {
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
