/**
 * 后端核心：处理来自界面的请求，管理 worker，向界面推送事件。
 * 桌面版（Electron IPC）与网页版（WebSocket）共用同一个 Backend，外壳只负责传输。
 */
import {
	type AppInfo,
	type DiscoveredProject,
	type ProjectsState,
	type SessionSummary,
	type BackendMethod,
	type BackendMethods,
	type BackendPush,
	CONFIG_MUTATING_COMMANDS,
	RESOURCE_MUTATING_COMMANDS,
	type ServiceCommand,
} from "@shared/protocol";
import { isDirectory, listDirs } from "./fs";
import { getPiAgentDir, getPiCliSessionsDir } from "./paths";
import { ProjectStore, samePath } from "./projects";
import { listWorkspaceDir, readWorkspaceFile, searchWorkspaceFiles, writeWorkspaceFile } from "./workspace-fs";
import { WorkerManager } from "./worker-manager";
import type { WorkerSpawner } from "./worker-process";

export interface BackendHost {
	shell: AppInfo["shell"];
	version: string;
	spawnWorker: WorkerSpawner;
	/** 系统原生文件夹对话框；网页版不提供 */
	pickFolder?: () => Promise<string | null>;
	/** 系统原生文件夹对话框（多选）；网页版不提供 */
	pickFolders?: () => Promise<string[]>;
}

type PushListener = (push: BackendPush) => void;

export class Backend {
	readonly workers: WorkerManager;
	readonly projects = new ProjectStore();
	private readonly listeners = new Set<PushListener>();
	/** clientId → 该客户端打开的会话，客户端断开时一并关闭 */
	private readonly clientSessions = new Map<string, Set<string>>();

	constructor(private readonly host: BackendHost) {
		this.workers = new WorkerManager(host.spawnWorker, (event) => this.push({ type: "auth", event }));
	}

	onPush(listener: PushListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private push(push: BackendPush): void {
		for (const listener of this.listeners) listener(push);
	}

	async handle<M extends BackendMethod>(
		method: M,
		params: BackendMethods[M]["params"],
		clientId = "default",
	): Promise<BackendMethods[M]["result"]> {
		return (await this.dispatch(method, params, clientId)) as BackendMethods[M]["result"];
	}

	private async dispatch(method: BackendMethod, rawParams: unknown, clientId: string): Promise<unknown> {
		switch (method) {
			case "app.info":
				return {
					version: this.host.version,
					versions: { ...process.versions },
					agentDir: getPiAgentDir(),
					shell: this.host.shell,
					nativeDialogs: this.host.pickFolder !== undefined,
				} satisfies AppInfo;
			case "app.pickFolder":
				if (!this.host.pickFolder) throw new Error("当前外壳不支持系统文件夹对话框");
				return this.host.pickFolder();
			case "app.pickFolders":
				if (!this.host.pickFolders) throw new Error("当前外壳不支持系统文件夹对话框");
				return this.host.pickFolders();
			case "projects.get":
				return this.projects.get();
			case "projects.add": {
				const params = rawParams as BackendMethods["projects.add"]["params"];
				const r = await this.projects.add(params.paths, params.groupId);
				this.projectsChanged(r.state);
				return { state: r.state, ...r.result };
			}
			case "projects.update": {
				const params = rawParams as BackendMethods["projects.update"]["params"];
				return this.projectsChanged(await this.projects.update(params.id, params.patch));
			}
			case "projects.remove": {
				const params = rawParams as BackendMethods["projects.remove"]["params"];
				return this.projectsChanged(await this.projects.remove(params.id));
			}
			case "projects.touch": {
				const params = rawParams as BackendMethods["projects.touch"]["params"];
				return this.projectsChanged(await this.projects.touch(params.id));
			}
			case "projects.move": {
				const params = rawParams as BackendMethods["projects.move"]["params"];
				return this.projectsChanged(await this.projects.move(params.ids, params.pinned, params.groupId));
			}
			case "projects.groupCreate": {
				const params = rawParams as BackendMethods["projects.groupCreate"]["params"];
				const r = await this.projects.createGroup(params.name);
				this.projectsChanged(r.state);
				return { state: r.state, group: r.result };
			}
			case "projects.groupUpdate": {
				const params = rawParams as BackendMethods["projects.groupUpdate"]["params"];
				return this.projectsChanged(await this.projects.updateGroup(params.id, params));
			}
			case "projects.groupRemove": {
				const params = rawParams as BackendMethods["projects.groupRemove"]["params"];
				return this.projectsChanged(await this.projects.removeGroup(params.id));
			}
			case "projects.discover":
				return this.discoverProjects();
			case "fs.listDirs": {
				const params = rawParams as BackendMethods["fs.listDirs"]["params"];
				return listDirs(params?.path);
			}
			case "workspace.list": {
				const params = rawParams as BackendMethods["workspace.list"]["params"];
				return listWorkspaceDir(params.root, params.path);
			}
			case "workspace.read": {
				const params = rawParams as BackendMethods["workspace.read"]["params"];
				return readWorkspaceFile(params.root, params.path);
			}
			case "workspace.write": {
				const params = rawParams as BackendMethods["workspace.write"]["params"];
				return writeWorkspaceFile(params.root, params.path, params.content, params.expectedMtime);
			}
			case "workspace.search": {
				const params = rawParams as BackendMethods["workspace.search"]["params"];
				return searchWorkspaceFiles(params.root, params.query, params.limit, params.fresh);
			}
			case "service.send": {
				const command = rawParams as ServiceCommand;
				const service = await this.workers.getService();
				const result = await service.send(command);
				if (CONFIG_MUTATING_COMMANDS.has(command.type)) {
					await this.workers.broadcastToSessions({ type: "refresh_config" });
					this.push({ type: "config_changed" });
				}
				if (RESOURCE_MUTATING_COMMANDS.has(command.type)) {
					await this.workers.broadcastToSessions({ type: "reload_resources" });
					this.push({ type: "resources_changed" });
				}
				return result;
			}
			case "session.open": {
				const params = rawParams as BackendMethods["session.open"]["params"];
				if (!(await isDirectory(params.cwd))) throw new Error(`工作区不存在或不是文件夹：${params.cwd}`);
				const opened = await this.workers.openSession(params, {
					onEvent: (handleId, event) => this.push({ type: "session_event", handleId, event }),
					onExit: (handleId, code) => {
						this.clientSessions.get(clientId)?.delete(handleId);
						this.push({ type: "session_exit", handleId, code });
					},
				});
				let owned = this.clientSessions.get(clientId);
				if (!owned) {
					owned = new Set();
					this.clientSessions.set(clientId, owned);
				}
				owned.add(opened.handleId);
				return opened;
			}
			case "session.send": {
				const params = rawParams as BackendMethods["session.send"]["params"];
				return this.workers.sendToSession(params.handleId, params.command);
			}
			case "session.close": {
				const params = rawParams as BackendMethods["session.close"]["params"];
				this.clientSessions.get(clientId)?.delete(params.handleId);
				await this.workers.closeSession(params.handleId);
				return null;
			}
			case "auth.answer": {
				const params = rawParams as BackendMethods["auth.answer"]["params"];
				(await this.workers.getService()).post({ kind: "auth_answer", ...params });
				return null;
			}
			case "auth.cancel": {
				const params = rawParams as BackendMethods["auth.cancel"]["params"];
				(await this.workers.getService()).post({ kind: "auth_cancel", flowId: params.flowId });
				return null;
			}
		}
	}

	private projectsChanged(state: ProjectsState): ProjectsState {
		this.push({ type: "projects_changed", state });
		return state;
	}

	/** 从 FloWork 与 pi CLI 的已有会话中找出涉及的目录，排除已导入的项目 */
	private async discoverProjects(): Promise<DiscoveredProject[]> {
		const service = await this.workers.getService();
		const [own, cli] = await Promise.all([
			service.send({ type: "list_sessions" }) as Promise<SessionSummary[]>,
			service.send({ type: "list_sessions", sessionDir: getPiCliSessionsDir() }).catch(() => []) as Promise<SessionSummary[]>,
		]);
		const { projects } = await this.projects.get();
		const found = new Map<string, DiscoveredProject>();
		const collect = (sessions: SessionSummary[], source: "flowork" | "pi-cli") => {
			for (const s of sessions) {
				if (!s.cwd || projects.some((p) => samePath(p.path, s.cwd))) continue;
				const key = process.platform === "win32" ? s.cwd.toLowerCase() : s.cwd;
				const entry = found.get(key) ?? { path: s.cwd, sessionCount: 0, lastModified: 0, sources: [], exists: false };
				entry.sessionCount++;
				entry.lastModified = Math.max(entry.lastModified, s.modified);
				if (!entry.sources.includes(source)) entry.sources.push(source);
				found.set(key, entry);
			}
		};
		collect(own, "flowork");
		collect(cli, "pi-cli");
		const list = [...found.values()];
		await Promise.all(list.map(async (d) => (d.exists = await isDirectory(d.path))));
		return list.sort((a, b) => b.lastModified - a.lastModified);
	}

	/** 客户端断开（网页标签关闭）时，关闭它打开的会话 */
	async releaseClient(clientId: string): Promise<void> {
		const owned = this.clientSessions.get(clientId);
		this.clientSessions.delete(clientId);
		if (owned) await Promise.all([...owned].map((handleId) => this.workers.closeSession(handleId)));
	}

	shutdown(): Promise<void> {
		return this.workers.shutdownAll();
	}
}
