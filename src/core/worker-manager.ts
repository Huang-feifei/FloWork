/**
 * 管理 pi worker 子进程：启动、请求-响应关联、事件转发与退出处理。
 * 与 Electron 无关，子进程的启动方式由 WorkerSpawner 注入。
 */
import { randomUUID } from "node:crypto";
import type {
	AnyCommand,
	ApprovalMode,
	AuthFlowEvent,
	MainToWorker,
	SessionCommand,
	SessionEvent,
	SessionState,
	WorkerInit,
} from "@shared/protocol";
import { withGitBashOnPath } from "./git-bash";
import { getPiAgentDir } from "./paths";
import type { WorkerProcess, WorkerSpawner } from "./worker-process";

const INIT_TIMEOUT_MS = 30_000;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface WorkerCallbacks {
	onEvent?: (event: SessionEvent) => void;
	onAuth?: (event: AuthFlowEvent) => void;
	onExit?: (code: number) => void;
}

export class WorkerClient {
	private readonly pending = new Map<string, Pending>();
	private exited = false;
	private readonly exitWaiters: Array<() => void> = [];

	private constructor(
		readonly id: string,
		private readonly proc: WorkerProcess,
	) {}

	static start(
		spawn: WorkerSpawner,
		init: WorkerInit,
		callbacks: WorkerCallbacks = {},
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
		const client = new WorkerClient(id, proc);
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
						client.pending.delete(message.id);
						if (message.ok) pending.resolve(message.data);
						else pending.reject(new Error(message.error));
						return;
					}
					case "event":
						callbacks.onEvent?.(message.event);
						return;
					case "auth":
						callbacks.onAuth?.(message.event);
						return;
				}
			});

			proc.onExit((code) => {
				client.exited = true;
				clearTimeout(timer);
				for (const pending of client.pending.values()) pending.reject(new Error(`pi worker 已退出（code ${code}）`));
				client.pending.clear();
				for (const waiter of client.exitWaiters.splice(0)) waiter();
				if (!ready) reject(new Error(`pi worker 启动失败（code ${code}）`));
				callbacks.onExit?.(code);
			});

			proc.onSpawn(() => client.post({ kind: "init", init }));
		});
	}

	post(message: MainToWorker): void {
		if (!this.exited) this.proc.postMessage(message);
	}

	send(command: AnyCommand): Promise<unknown> {
		if (this.exited) return Promise.reject(new Error("pi worker 已退出"));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.post({ kind: "command", id, command });
		});
	}

	/** 请求 worker 释放会话后退出；超时则强制结束 */
	shutdown(timeoutMs = 5_000): Promise<void> {
		if (this.exited) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.proc.kill();
				resolve();
			}, timeoutMs);
			this.exitWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
			this.post({ kind: "shutdown" });
		});
	}
}

export interface SessionCallbacks {
	onEvent: (handleId: string, event: SessionEvent) => void;
	onExit: (handleId: string, code: number) => void;
}

/** 常驻 service worker + 每个打开的会话一个 session worker */
export class WorkerManager {
	private service: Promise<WorkerClient> | undefined;
	private readonly sessions = new Map<string, WorkerClient>();

	constructor(
		private readonly spawn: WorkerSpawner,
		private readonly onAuth: (event: AuthFlowEvent) => void = () => undefined,
	) {}

	getService(): Promise<WorkerClient> {
		if (!this.service) {
			const started = WorkerClient.start(
				this.spawn,
				{ role: "service", cwd: process.cwd() },
				{
					onAuth: this.onAuth,
					onExit: () => {
						// 下次调用时自动重启
						if (this.service === started) this.service = undefined;
					},
				},
			).then((r) => r.client);
			this.service = started;
			started.catch(() => {
				if (this.service === started) this.service = undefined;
			});
		}
		return this.service;
	}

	async openSession(
		options: { cwd: string; sessionPath?: string; approvalMode?: ApprovalMode },
		callbacks: SessionCallbacks,
	): Promise<{ handleId: string; state: SessionState }> {
		let handleId = "";
		const { client, state } = await WorkerClient.start(
			this.spawn,
			{ role: "session", cwd: options.cwd, sessionPath: options.sessionPath, approvalMode: options.approvalMode },
			{
				onEvent: (event) => callbacks.onEvent(handleId, event),
				onExit: (code) => {
					this.sessions.delete(handleId);
					callbacks.onExit(handleId, code);
				},
			},
		);
		handleId = client.id;
		this.sessions.set(handleId, client);
		if (!state) throw new Error("session worker 未返回会话状态");
		return { handleId, state };
	}

	getSession(handleId: string): WorkerClient {
		const client = this.sessions.get(handleId);
		if (!client) throw new Error(`会话不存在或已关闭：${handleId}`);
		return client;
	}

	sendToSession(handleId: string, command: SessionCommand): Promise<unknown> {
		return this.getSession(handleId).send(command);
	}

	/** 向所有会话广播命令（例如配置变更后刷新），忽略单个会话的失败 */
	async broadcastToSessions(command: SessionCommand): Promise<void> {
		await Promise.allSettled([...this.sessions.values()].map((c) => c.send(command)));
	}

	async closeSession(handleId: string): Promise<void> {
		const client = this.sessions.get(handleId);
		this.sessions.delete(handleId);
		await client?.shutdown();
	}

	async shutdownAll(): Promise<void> {
		const all = [...this.sessions.values()];
		this.sessions.clear();
		const service = this.service;
		this.service = undefined;
		await Promise.all([
			...all.map((c) => c.shutdown()),
			service?.then(
				(c) => c.shutdown(),
				() => undefined,
			),
		]);
	}
}
