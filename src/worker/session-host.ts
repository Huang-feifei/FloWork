/**
 * 在 worker 内承载一个 pi 会话（AgentSessionRuntime），处理 SessionCommand 并转发事件。
 */
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CommandResultMap, SessionCommand, SessionEvent, SessionState } from "@shared/protocol";
import { toChatMessage, toModelInfo, toSessionEvents, toSessionState, toTree } from "./adapter";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd });
	return {
		...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
		services,
		diagnostics: services.diagnostics,
	};
};

export class SessionHost {
	private runtime: AgentSessionRuntime | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(private readonly emit: (event: SessionEvent) => void) {}

	private get session(): AgentSession {
		if (!this.runtime) throw new Error("会话尚未初始化");
		return this.runtime.session;
	}

	async init(cwd: string, sessionPath?: string): Promise<SessionState> {
		const sessionManager = sessionPath ? SessionManager.open(sessionPath) : SessionManager.create(cwd);
		this.runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir: getAgentDir(), sessionManager });
		for (const diagnostic of this.runtime.diagnostics ?? []) {
			this.emit({ type: "notice", level: "warning", text: formatDiagnostic(diagnostic) });
		}
		await this.bind();
		return toSessionState(this.session);
	}

	/** 运行时替换会话后，事件订阅属于旧会话，必须重新绑定 */
	private async bind(): Promise<void> {
		this.unsubscribe?.();
		const session = this.session;
		// TODO(M1): 传入 uiContext，实现工具审批与扩展对话框
		await session.bindExtensions({});
		this.unsubscribe = session.subscribe((event) => {
			for (const out of toSessionEvents(event)) this.emit(out);
		});
	}

	private changed(): SessionState {
		const state = toSessionState(this.session);
		this.emit({ type: "session_changed", state });
		return state;
	}

	async handle(command: SessionCommand): Promise<CommandResultMap[SessionCommand["type"]]> {
		const session = this.session;
		switch (command.type) {
			case "prompt":
				return this.prompt(command.message, command.streamingBehavior);
			case "abort":
				await session.abort();
				return null;
			case "get_state":
				return toSessionState(session);
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
			case "get_available_models": {
				const models = await session.modelRuntime.getAvailable();
				return models.flatMap((m) => toModelInfo(m) ?? []);
			}
			case "set_model": {
				const model = session.modelRuntime.getModel(command.provider, command.modelId);
				if (!model) throw new Error(`找不到模型：${command.provider}/${command.modelId}`);
				await session.setModel(model);
				return toSessionState(session);
			}
			case "set_thinking_level":
				session.setThinkingLevel(command.level);
				return toSessionState(session);
			case "new_session":
				await this.requireRuntime().newSession();
				await this.bind();
				return this.changed();
			case "switch_session":
				await this.requireRuntime().switchSession(command.sessionPath);
				await this.bind();
				return this.changed();
			case "set_session_name":
				session.setSessionName(command.name);
				return null;
			case "refresh_config":
				// 凭据与 models.json 由 ModelRuntime 重新加载；settings.json 由 SettingsManager 重新读取
				await session.settingsManager.reload();
				await session.modelRuntime.refresh();
				return toSessionState(session);
		}
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
