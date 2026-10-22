/**
 * 管理 pi worker 子进程：启动、请求-响应关联、事件转发与退出处理。
 * 与 Electron 无关，子进程的启动方式由 WorkerSpawner 注入。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
	AnyCommand,
	ApprovalMode,
	AuthFlowEvent,
	MainToWorker,
	SessionCommand,
	SessionEvent,
	SessionState,
	SessionSummary,
	WorkerInit,
} from "@shared/protocol";
import { withGitBashOnPath } from "./git-bash";
import { getPiAgentDir } from "./paths";
import { samePath } from "./projects";
import type { WorkerProcess, WorkerSpawner } from "./worker-process";

const INIT_TIMEOUT_MS = 30_000;

export interface WorkerTimeouts {
	requestMs: number;
	operationMs: number;
	packageMs: number;
	heartbeatMs: number;
}
const DEFAULT_TIMEOUTS: WorkerTimeouts = { requestMs: 30_000, operationMs: 120_000, packageMs: 600_000, heartbeatMs: 15_000 };

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	flowId?: string;
	cancel?: () => void;
	arm: () => void;
	timer?: ReturnType<typeof setTimeout>;
	health: boolean;
}

/** prompt / OAuth 可能等待用户或扩展，不设任务总时限，改由独立心跳检测 worker 是否失联。 */
function commandTimeout(command: AnyCommand, policy: WorkerTimeouts): number {
	if (command.type === "prompt" || command.type === "auth_login" || (command.type === "navigate_tree" && command.summarize)) return 0;
	if (command.type === "abort") return policy.requestMs;
	if (command.type === "install_package" || command.type === "remove_package") return policy.packageMs;
	if (command.type.startsWith("get_") || command.type.startsWith("list_") || command.type === "ping" || command.type === "validate_session") return policy.requestMs;
	return policy.operationMs;
}

export interface WorkerCallbacks {
	onEvent?: (event: SessionEvent) => void;
	onAuth?: (event: AuthFlowEvent) => void;
	onExit?: (code: number) => void;
}

export class WorkerClient {
	private readonly pending = new Map<string, Pending>();
	private exited = false;
	private failure: Error | undefined;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private checkingHealth = false;
	private readonly interactions = new Set<string>();
	private readonly exitWaiters: Array<() => void> = [];

	private constructor(
		readonly id: string,
		private readonly proc: WorkerProcess,
		private readonly timeouts: WorkerTimeouts,
	) {}

	static start(
		spawn: WorkerSpawner,
		init: WorkerInit,
		callbacks: WorkerCallbacks = {},
		timeouts: Partial<WorkerTimeouts> = {},
	): Promise<{ client: WorkerClient; state?: SessionState }> {
		const id = randomUUID();
		const proc = spawn({
			serviceName: `flowork-pi-${init.role}`,
			env: withGitBashOnPath({
				...process.env,
				PI_CODING_AGENT_DIR: getPiAgentDir(),
				PI_SKIP_VERSION_CHECK: "1",
			}),
		});
		const client = new WorkerClient(id, proc, { ...DEFAULT_TIMEOUTS, ...timeouts });
		const tag = `[pi-worker:${init.role}:${id.slice(0, 8)}]`;
		proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`${tag} ${chunk.toString()}`));
		proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`${tag} ${chunk.toString()}`));

		return new Promise((resolve, reject) => {
			let ready = false;
			const timer = setTimeout(() => {
				if (!ready) {
					proc.kill();
					reject(new Error("pi worker 启动超时"));
				}
			}, INIT_TIMEOUT_MS);

			proc.onMessage((message) => {
				// Electron utilityProcess 在消息过深等情况下会静默投递 null（不报错），
				// 这里先挡住，避免主进程抛未捕获异常弹出错误框。
				if (!message || typeof message !== "object") {
					console.error(`${tag} 忽略无效消息：${String(message)}`);
					return;
				}
				switch (message.kind) {
					case "ready":
						ready = true;
						clearTimeout(timer);
						resolve({ client, state: message.state });
						return;
					case "init_error":
						clearTimeout(timer);
						proc.kill();
						reject(new Error(message.error));
						return;
					case "response": {
						const pending = client.pending.get(message.id);
						if (!pending) return;
						if (message.ok) pending.resolve(message.data);
						else pending.reject(new Error(message.error));
						return;
					}
					case "event": {
						const event = message.event;
						if (event.type === "ext_ui_request") client.interaction(`ui:${event.request.id}`, true);
						if (event.type === "ext_ui_closed") client.interaction(`ui:${event.id}`, false);
						if (event.type === "approval_request") client.interaction(`approval:${event.toolCallId}`, true);
						if (event.type === "approval_resolved") client.interaction(`approval:${event.toolCallId}`, false);
						callbacks.onEvent?.(event);
						return;
					}
					case "auth":
						if (message.event.kind === "prompt") client.interaction(`auth:${message.event.flowId}:${message.event.promptId}`, true);
						if (message.event.kind === "prompt_cancelled") client.interaction(`auth:${message.event.flowId}:${message.event.promptId}`, false);
						callbacks.onAuth?.(message.event);
						return;
				}
			});

			proc.onExit((code) => {
				client.exited = true;
				clearTimeout(timer);
				clearInterval(client.heartbeat);
				client.interactions.clear();
				for (const pending of [...client.pending.values()]) pending.reject(new Error(`pi worker 已退出（code ${code}）`));
				for (const waiter of client.exitWaiters.splice(0)) waiter();
				if (!ready) reject(new Error(`pi worker 启动失败（code ${code}）`));
				callbacks.onExit?.(code);
			});

			proc.onSpawn(() => client.post({ kind: "init", init }));
		});
	}

	post(message: MainToWorker): void {
		if (this.exited) return;
		if (message.kind === "auth_answer") this.interaction(`auth:${message.flowId}:${message.promptId}`, false);
		if (message.kind === "auth_cancel") {
			for (const id of [...this.interactions]) if (id.startsWith(`auth:${message.flowId}:`)) this.interaction(id, false);
			// 先发送协作取消；SDK 未响应取消时也不能让无总时限的登录请求永久挂起。
			for (const pending of this.pending.values()) if (pending.flowId === message.flowId) pending.cancel?.();
		}
		this.proc.postMessage(message);
	}

	private interaction(id: string, open: boolean): void {
		if (open) this.interactions.add(id);
		else this.interactions.delete(id);
		for (const pending of this.pending.values()) {
			if (pending.health) continue;
			clearTimeout(pending.timer);
			if (!this.interactions.size) pending.arm();
		}
	}

	/** 失联后不重放命令；先停用并终止原进程，直到真实 exit 才释放会话锁。 */
	private fail(error: Error): void {
		if (this.failure || this.exited) return;
		this.failure = error;
		clearInterval(this.heartbeat);
		for (const pending of [...this.pending.values()]) pending.reject(error);
		try { this.proc.kill(); }
		catch (cause) { console.error("[pi-worker] 无法确认失联进程退出，保留会话锁", cause); }
	}

	send(command: AnyCommand, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
		return this.request(command, options, false);
	}

	private request(command: AnyCommand, options: { signal?: AbortSignal; timeoutMs?: number }, health: boolean): Promise<unknown> {
		if (this.exited) return Promise.reject(new Error("pi worker 已退出"));
		if (this.failure) return Promise.reject(this.failure);
		if (options.signal?.aborted) return Promise.reject(new Error("pi worker 请求已取消（未发送）"));
		let timeoutMs = options.timeoutMs ?? commandTimeout(command, this.timeouts);
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error("无效的 worker 请求超时"));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const finish = (error: Error | undefined, value?: unknown) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(pending.timer);
				options.signal?.removeEventListener("abort", cancel);
				if (!this.pending.size) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
				if (error) reject(error); else resolve(value);
			};
			const uncertain = "worker 已停用；操作可能已生效，请检查后再操作（不会自动重试）";
			const cancel = () => this.fail(new Error(`pi worker 请求已取消（${command.type}）；${uncertain}`));
			const pending: Pending = {
				resolve: (value) => finish(undefined, value), reject: (error) => finish(error), health: health || command.type === "abort",
				flowId: command.type === "auth_login" ? command.flowId : undefined,
				cancel: () => { timeoutMs = this.timeouts.requestMs; pending.health = true; pending.arm(); },
				arm: () => {
					clearTimeout(pending.timer);
					if (timeoutMs > 0) pending.timer = setTimeout(() => this.fail(new Error(`pi worker 请求超时（${command.type}，${timeoutMs}ms）；${uncertain}`)), timeoutMs);
				},
			};
			this.pending.set(id, pending);
			options.signal?.addEventListener("abort", cancel, { once: true });
			if (pending.health || !this.interactions.size) pending.arm();
			this.heartbeat ??= setInterval(() => {
				if (this.checkingHealth || !this.pending.size) return;
				this.checkingHealth = true;
				void this.request({ type: "ping" }, { timeoutMs: this.timeouts.requestMs }, true)
					.catch(() => undefined).finally(() => { this.checkingHealth = false; });
			}, this.timeouts.heartbeatMs);
			try { this.post({ kind: "command", id, command }); }
			catch (cause) { this.fail(cause instanceof Error ? cause : new Error(String(cause))); }
		});
	}

	/** 请求 worker 释放会话后退出；强制结束后仍须确认 exit */
	shutdown(timeoutMs = 5_000): Promise<void> {
		if (this.exited) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const onExit = () => {
				clearTimeout(timer);
				clearTimeout(killTimer);
				resolve();
			};
			const fail = (error: Error) => {
				const index = this.exitWaiters.indexOf(onExit);
				if (index !== -1) this.exitWaiters.splice(index, 1);
				reject(error);
			};
			const timer = setTimeout(() => {
				killTimer = setTimeout(() => fail(new Error("无法确认 pi worker 已退出，会话仍保留锁定")), timeoutMs);
				try {
					this.proc.kill();
				} catch (error) {
					clearTimeout(killTimer);
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			}, timeoutMs);
			this.exitWaiters.push(onExit);
			this.post({ kind: "shutdown" });
		});
	}

	get hasExited(): boolean {
		return this.exited;
	}

	get hasFailed(): boolean {
		return !!this.failure;
	}
}

export interface SessionCallbacks {
	onEvent: (handleId: string, event: SessionEvent) => void;
	onExit: (handleId: string, code: number, expected?: boolean) => void;
}

interface SessionOwner {
	client: WorkerClient;
	state: SessionState;
	approvals: Set<string>;
	uiRequests: Set<string>;
	operations: number;
	closing: boolean;
	draft: boolean;
	/** 替换会话的结果不确定时，原文件与目标文件都锁定到进程真正退出。 */
	reservedFiles: Set<string>;
}

const IDENTITY_COMMANDS = new Set<SessionCommand["type"]>(["new_session", "switch_session", "fork", "navigate_tree", "set_project_trust"]);
const INTERACTION_COMMANDS = new Set<SessionCommand["type"]>(["abort", "respond_approval", "respond_ext_ui", "set_approval_mode"]);

/** 常驻 service worker + 每个打开的会话一个 session worker */
export class WorkerManager {
	private service: Promise<WorkerClient> | undefined;
	private readonly sessions = new Map<string, SessionOwner>();
	private queue: Promise<unknown> = Promise.resolve();
	private shuttingDown = false;

	constructor(
		private readonly spawn: WorkerSpawner,
		private readonly onAuth: (event: AuthFlowEvent) => void = () => undefined,
		private readonly timeouts: Partial<WorkerTimeouts> = {},
	) {}

	private coordinate<T>(action: () => Promise<T>): Promise<T> {
		const run = this.queue.then(action);
		this.queue = run.catch(() => undefined);
		return run;
	}

	getService(): Promise<WorkerClient> {
		if (this.shuttingDown) return Promise.reject(new Error("后端正在关闭"));
		if (!this.service) {
			const started = WorkerClient.start(this.spawn, { role: "service", cwd: process.cwd() }, {
				onAuth: this.onAuth,
				onExit: () => {
					if (this.service === started) this.service = undefined;
				},
			}, this.timeouts).then((r) => r.client);
			this.service = started;
			started.catch(() => {
				if (this.service === started) this.service = undefined;
			});
		}
		return this.service;
	}

	private owner(handleId: string): SessionOwner {
		const owner = this.sessions.get(handleId);
		if (!owner) throw new Error(`会话不存在或已关闭：${handleId}`);
		return owner;
	}

	private ownersOf(path: string): SessionOwner[] {
		return [...this.sessions.values()].filter((owner) =>
			(owner.state.sessionFile && samePath(owner.state.sessionFile, path)) || [...owner.reservedFiles].some((file) => samePath(file, path)));
	}

	private assertNotOpened(path: string, except?: SessionOwner): void {
		if (this.ownersOf(path).some((owner) => owner !== except)) throw new Error("该历史会话已打开，请先关闭原会话");
	}

	private updateEvent(owner: SessionOwner, event: SessionEvent): void {
		switch (event.type) {
			case "session_changed":
				if (owner.state.sessionId !== event.state.sessionId) {
					owner.approvals.clear();
					owner.uiRequests.clear();
					owner.draft = !event.state.sessionFile || !existsSync(event.state.sessionFile);
				}
				owner.state = event.state;
				break;
			case "session_info_changed": owner.state.sessionName = event.name; break;
			case "work_mode_changed": owner.state.workMode = event.mode; break;
			case "agent_start": owner.state.isStreaming = true; break;
			case "agent_settled": owner.state.isStreaming = false; break;
			case "approval_request": owner.approvals.add(event.toolCallId); break;
			case "approval_resolved": owner.approvals.delete(event.toolCallId); break;
			case "ext_ui_request": owner.uiRequests.add(event.request.id); break;
			case "ext_ui_closed": owner.uiRequests.delete(event.id); break;
		}
	}

	private busy(owner: SessionOwner): boolean {
		return owner.state.isStreaming || owner.approvals.size > 0 || owner.uiRequests.size > 0 || owner.operations > 0;
	}

	private async refresh(owner: SessionOwner): Promise<void> {
		owner.state = await owner.client.send({ type: "get_state" }) as SessionState;
	}

	openSession(
		options: { cwd: string; sessionPath?: string; approvalMode?: ApprovalMode; ops?: WorkerInit["ops"] },
		callbacks: SessionCallbacks,
	): Promise<{ handleId: string; state: SessionState }> {
		return this.coordinate(async () => {
			if (this.shuttingDown) throw new Error("后端正在关闭");
			let sessionPath = options.sessionPath;
			if (sessionPath) {
				const target = await (await this.getService()).send({ type: "validate_session", cwd: options.cwd, path: sessionPath }) as SessionSummary;
				sessionPath = target.path;
				this.assertNotOpened(sessionPath);
			}
			let handleId = "";
			let owner: SessionOwner | undefined;
			const earlyEvents: SessionEvent[] = [];
			const { client, state } = await WorkerClient.start(this.spawn,
				{ role: "session", cwd: options.cwd, sessionPath, approvalMode: options.approvalMode, ops: options.ops }, {
					onEvent: (event) => {
						if (!owner) earlyEvents.push(event);
						else {
							this.updateEvent(owner, event);
							callbacks.onEvent(handleId, event);
						}
					},
					onExit: (code) => {
						this.sessions.delete(handleId);
						if (handleId) callbacks.onExit(handleId, code, owner?.closing || undefined);
					},
				}, this.timeouts);
			if (!state || client.hasExited) {
				await client.shutdown();
				throw new Error("session worker 未返回可用会话状态");
			}
			handleId = client.id;
			owner = { client, state, approvals: new Set(), uiRequests: new Set(), operations: 0, closing: false, draft: !sessionPath, reservedFiles: new Set() };
			this.sessions.set(handleId, owner);
			for (const event of earlyEvents) {
				this.updateEvent(owner, event);
				callbacks.onEvent(handleId, event);
			}
			return { handleId, state: owner.state };
		});
	}

	getSession(handleId: string): WorkerClient {
		return this.owner(handleId).client;
	}

	private async send(owner: SessionOwner, command: SessionCommand): Promise<unknown> {
		if (owner.closing) throw new Error("会话正在关闭");
		if (owner.client.hasFailed) throw new Error("会话 worker 已停用，尚未确认退出");
		const identity = IDENTITY_COMMANDS.has(command.type);
		if (identity) {
			if (owner.state.sessionFile) owner.reservedFiles.add(owner.state.sessionFile);
			if (command.type === "switch_session") owner.reservedFiles.add(command.sessionPath);
		}
		owner.operations++;
		try {
			const result = await owner.client.send(command);
			if (command.type === "fork") owner.state = (result as { state: SessionState }).state;
			else if (["get_state", "set_model", "set_thinking_level", "new_session", "switch_session", "set_project_trust", "refresh_config"].includes(command.type)) {
				owner.state = result as SessionState;
			}
			return result;
		} finally {
			owner.operations--;
			if (identity && !owner.client.hasFailed) owner.reservedFiles.clear();
		}
	}

	async sendToSession(handleId: string, command: SessionCommand): Promise<unknown> {
		if (INTERACTION_COMMANDS.has(command.type)) return this.send(this.owner(handleId), command);
		if (IDENTITY_COMMANDS.has(command.type) || command.type === "set_session_name") {
			return this.coordinate(async () => {
				const owner = this.owner(handleId);
				// 只挡「运行中」：pi 允许替换会话并取消未应答的扩展对话框（界面也依赖这一点），
				// 但运行中的任务不该被悄悄换掉
				if (IDENTITY_COMMANDS.has(command.type) && owner.state.isStreaming) throw new Error("请先中断或结束当前运行");
				if (command.type === "switch_session") {
					const target = await (await this.getService()).send({ type: "validate_session", cwd: owner.state.cwd, path: command.sessionPath }) as SessionSummary;
					this.assertNotOpened(target.path);
					command = { ...command, sessionPath: target.path };
				}
				return this.send(owner, command);
			});
		}
		const started = await this.coordinate(async () => ({ result: this.send(this.owner(handleId), command) }));
		return started.result;
	}

	async renameSession(cwd: string, path: string, name: string): Promise<void> {
		await this.coordinate(async () => {
			const owners = this.ownersOf(path);
			if (owners.length > 1) throw new Error("会话存在多个 writer，不能重命名");
			const owner = owners[0];
			if (owner && !samePath(owner.state.cwd, cwd)) throw new Error("会话不属于此工作区");
			if (owner?.closing) throw new Error("会话正在关闭");
			const service = await this.getService();
			if (!(owner?.draft && !existsSync(path))) await service.send({ type: "validate_session", cwd, path });
			if (owner) await this.send(owner, { type: "set_session_name", name: name.trim() });
			else await service.send({ type: "rename_session", cwd, path, name: name.trim() });
		});
	}

	async deleteSession(cwd: string, path: string): Promise<void> {
		await this.coordinate(async () => {
			const service = await this.getService();
			const target = await service.send({ type: "validate_session", cwd, path }) as SessionSummary;
			const owners = this.ownersOf(target.path);
			for (const owner of owners) {
				if (owner.closing) throw new Error("会话正在关闭，尚未确认退出");
				if (this.busy(owner)) throw new Error("会话正在运行或等待交互，请先中断或结束后再删除");
				await this.refresh(owner);
				if (this.busy(owner)) throw new Error("会话正在运行或等待交互，请先中断或结束后再删除");
			}
			await Promise.all(owners.map((owner) => this.closeOwner(owner)));
			await service.send({ type: "delete_session", cwd, path: target.path });
		});
	}

	async broadcastToSessions(command: SessionCommand): Promise<void> {
		await Promise.allSettled([...this.sessions.keys()].map((id) => this.sendToSession(id, command)));
	}

	private async closeOwner(owner: SessionOwner): Promise<void> {
		owner.closing = true;
		await owner.client.shutdown();
	}

	closeSession(handleId: string): Promise<void> {
		return this.coordinate(async () => {
			const owner = this.sessions.get(handleId);
			if (owner) await this.closeOwner(owner);
		});
	}

	hasBusySessions(): boolean {
		return [...this.sessions.values()].some((owner) => this.busy(owner));
	}

	shutdownAll(): Promise<void> {
		this.shuttingDown = true;
		return this.coordinate(async () => {
			await Promise.all([...this.sessions.values()].map((owner) => this.closeOwner(owner)));
			const service = this.service;
			if (service) await service.then((client) => client.shutdown(), () => undefined);
			this.service = undefined;
		});
	}
}
