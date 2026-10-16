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
	type SshHost,
	type SshTestResult,
} from "@shared/protocol";
import { isDirectory, listDirs } from "./fs";
import { probeHostMonitor } from "./host-monitor";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { acceptHostKey, inspectHostKey } from "./host-key";
import { OpsPathMap } from "./ops-paths";
import { HostStore, type SecretCodec } from "./hosts";
import { getPiAgentDir, getPiCliSessionsDir } from "./paths";
import { ProjectStore, samePath } from "./projects";
import * as remoteFs from "./remote-fs";
import { probeHost, sshBinary, sshRun } from "./ssh";
import { TerminalManager } from "./terminal";
import {
	createWorkspaceEntry,
	deleteWorkspaceEntry,
	listWorkspaceDir,
	moveWorkspaceEntry,
	readWorkspaceFile,
	renameWorkspaceEntry,
	resolveInside,
	searchWorkspaceFiles,
	writeWorkspaceFile,
} from "./workspace-fs";
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
	/** 把文件 / 文件夹移入系统回收站；网页版不提供（退回永久删除） */
	trashItem?: (absPath: string) => Promise<void>;
	/** 在系统文件管理器中定位；网页版不提供 */
	revealItem?: (absPath: string) => void;
	/** 在系统终端中打开目录；网页版不提供 */
	openTerminal?: (absDir: string) => void;
	/** 系统原生文件选择对话框（挑选 SSH 私钥）；网页版不提供 */
	pickFile?: () => Promise<string | null>;
	/** 系统「保存到」对话框（下载远端文件用）；网页版不提供（退回浏览器下载） */
	pickSavePath?: (defaultName?: string) => Promise<string | null>;
	/** 系统级加密（Windows DPAPI / macOS 钥匙串 / libsecret），用于落盘的 SSH 密码；网页版不提供（退回明文） */
	secrets?: SecretCodec;
}

type PushListener = (push: BackendPush) => void;

export class Backend {
	readonly workers: WorkerManager;
	readonly projects = new ProjectStore();
	readonly hosts: HostStore;
	/** 真终端按 cwd 归属，不随客户端断线关闭 */
	readonly terminals: TerminalManager;
	private readonly listeners = new Set<PushListener>();
	/** clientId → 该客户端打开的会话，客户端断开时一并关闭 */
	private readonly clientSessions = new Map<string, Set<string>>();
	/** 运维会话：本地占位目录 ⇄ 远程路径 */
	private readonly opsPaths = new OpsPathMap();
	/** handleId → 运维会话（用于把 worker 返回的状态里的路径换回远程路径） */
	private readonly opsHandles = new Set<string>();

	constructor(private readonly host: BackendHost) {
		this.hosts = new HostStore(undefined, host.secrets);
		this.workers = new WorkerManager(host.spawnWorker, (event) => this.push({ type: "auth", event }));
		this.terminals = new TerminalManager(
			(push) => this.push(push),
			(id) => this.hosts.require(id),
		);
	}

	/**
	 * 界面传来的 cwd（远程项目即服务器路径）→ worker 使用的 cwd。
	 * 远程项目返回本地占位目录与主机；本地项目原样返回。
	 */
	private async workerCwd(cwd: string): Promise<{ cwd: string; host?: SshHost }> {
		const host = await this.hostOf(cwd);
		if (!host) return { cwd };
		return { cwd: this.opsPaths.register(host.id, cwd), host };
	}

	/** worker 返回的结果里如有 SessionState，把占位目录换回远程路径 */
	private fromWorker(handleId: string, result: unknown): unknown {
		if (!this.opsHandles.has(handleId) || !result || typeof result !== "object") return result;
		const r = result as { cwd?: unknown; ops?: unknown; state?: unknown };
		if (r.ops && typeof r.cwd === "string") return this.opsPaths.state(result as never);
		if (r.state && typeof r.state === "object") return { ...r, state: this.opsPaths.state(r.state as never) };
		return result;
	}

	/** 项目根路径 → 所属 SSH 主机；本地项目返回 undefined */
	private async hostOf(root: string): Promise<SshHost | undefined> {
		const project = await this.projects.findByPath(root);
		if (!project?.hostId) return undefined;
		return this.hosts.require(project.hostId);
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
					ssh: sshBinary(),
				} satisfies AppInfo;
			case "app.pickFolder":
				if (!this.host.pickFolder) throw new Error("当前外壳不支持系统文件夹对话框");
				return this.host.pickFolder();
			case "app.pickFolders":
				if (!this.host.pickFolders) throw new Error("当前外壳不支持系统文件夹对话框");
				return this.host.pickFolders();
			case "app.pickSavePath":
				if (!this.host.pickSavePath) throw new Error("当前外壳不支持系统保存对话框");
				return this.host.pickSavePath((rawParams as BackendMethods["app.pickSavePath"]["params"]).defaultName);
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
				// 项目移除后其路径无从查起，先取出路径以便关闭该目录下的终端
				const { projects } = await this.projects.get();
				const removed = projects.find((p) => p.id === params.id);
				const state = this.projectsChanged(await this.projects.remove(params.id));
				if (removed) this.terminals.closeByCwd(removed.path, removed.hostId);
				return state;
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
				const host = await this.hostOf(params.root);
				return host ? remoteFs.listWorkspaceDir(host, params.root, params.path) : listWorkspaceDir(params.root, params.path);
			}
			case "workspace.read": {
				const params = rawParams as BackendMethods["workspace.read"]["params"];
				const host = await this.hostOf(params.root);
				return host ? remoteFs.readWorkspaceFile(host, params.root, params.path) : readWorkspaceFile(params.root, params.path);
			}
			case "workspace.write": {
				const params = rawParams as BackendMethods["workspace.write"]["params"];
				const host = await this.hostOf(params.root);
				return host
					? remoteFs.writeWorkspaceFile(host, params.root, params.path, params.content, params.expectedMtime)
					: writeWorkspaceFile(params.root, params.path, params.content, params.expectedMtime);
			}
			case "workspace.search": {
				const params = rawParams as BackendMethods["workspace.search"]["params"];
				const host = await this.hostOf(params.root);
				return host
					? remoteFs.searchWorkspaceFiles(host, params.root, params.query, params.limit, params.fresh)
					: searchWorkspaceFiles(params.root, params.query, params.limit, params.fresh);
			}
			case "workspace.rename": {
				const params = rawParams as BackendMethods["workspace.rename"]["params"];
				const host = await this.hostOf(params.root);
				return host ? remoteFs.renameWorkspaceEntry(host, params.root, params.path, params.name) : renameWorkspaceEntry(params.root, params.path, params.name);
			}
			case "workspace.create": {
				const params = rawParams as BackendMethods["workspace.create"]["params"];
				const host = await this.hostOf(params.root);
				return host ? remoteFs.createWorkspaceEntry(host, params.root, params.path, params.type) : createWorkspaceEntry(params.root, params.path, params.type);
			}
			case "workspace.delete": {
				const params = rawParams as BackendMethods["workspace.delete"]["params"];
				const host = await this.hostOf(params.root);
				// 远程没有回收站，一律永久删除
				return host
					? remoteFs.deleteWorkspaceEntry(host, params.root, params.path)
					: deleteWorkspaceEntry(params.root, params.path, this.host.trashItem?.bind(this.host));
			}
			case "workspace.move": {
				const params = rawParams as BackendMethods["workspace.move"]["params"];
				const host = await this.hostOf(params.root);
				return host ? remoteFs.moveWorkspaceEntry(host, params.root, params.path, params.targetDir) : moveWorkspaceEntry(params.root, params.path, params.targetDir);
			}
			case "workspace.reveal": {
				const params = rawParams as BackendMethods["workspace.reveal"]["params"];
				if (await this.hostOf(params.root)) throw new Error("远程文件无法在本地文件管理器中显示");
				if (!this.host.revealItem) throw new Error("当前外壳不支持在文件管理器中显示");
				this.host.revealItem(resolveInside(params.root, params.path).abs);
				return null;
			}
			case "workspace.openTerminal": {
				const params = rawParams as BackendMethods["workspace.openTerminal"]["params"];
				if (await this.hostOf(params.root)) throw new Error("远程项目请在应用内的终端标签中打开");
				if (!this.host.openTerminal) throw new Error("当前外壳不支持在终端中打开");
				this.host.openTerminal(resolveInside(params.root, params.path).abs);
				return null;
			}
			// ----- 服务器目录：按 hostId + 绝对路径操作 -----
			case "server.list": {
				const params = rawParams as BackendMethods["server.list"]["params"];
				return remoteFs.listServerDir(await this.hosts.require(params.hostId), params.path);
			}
			case "server.read": {
				const params = rawParams as BackendMethods["server.read"]["params"];
				return remoteFs.readServerFile(await this.hosts.require(params.hostId), params.path);
			}
			case "server.write": {
				const params = rawParams as BackendMethods["server.write"]["params"];
				return remoteFs.writeServerFile(await this.hosts.require(params.hostId), params.path, params.content, params.expectedMtime);
			}
			case "server.create": {
				const params = rawParams as BackendMethods["server.create"]["params"];
				return remoteFs.createServerEntry(await this.hosts.require(params.hostId), params.path, params.type);
			}
			case "server.rename": {
				const params = rawParams as BackendMethods["server.rename"]["params"];
				return remoteFs.renameServerEntry(await this.hosts.require(params.hostId), params.path, params.name);
			}
			case "server.delete": {
				const params = rawParams as BackendMethods["server.delete"]["params"];
				return remoteFs.deleteServerEntry(await this.hosts.require(params.hostId), params.path);
			}
			case "server.move": {
				const params = rawParams as BackendMethods["server.move"]["params"];
				return remoteFs.moveServerEntry(await this.hosts.require(params.hostId), params.path, params.targetDir);
			}
			case "server.upload": {
				const params = rawParams as BackendMethods["server.upload"]["params"];
				return remoteFs.uploadServerFile(await this.hosts.require(params.hostId), params.dir, params.name, Buffer.from(params.dataBase64, "base64"));
			}
			case "server.download": {
				const params = rawParams as BackendMethods["server.download"]["params"];
				return remoteFs.downloadServerFile(await this.hosts.require(params.hostId), params.path);
			}
			case "server.exportToLocal": {
				const params = rawParams as BackendMethods["server.exportToLocal"]["params"];
				const file = await remoteFs.downloadServerFile(await this.hosts.require(params.hostId), params.path);
				await mkdir(dirname(params.targetPath), { recursive: true });
				await writeFile(params.targetPath, Buffer.from(file.dataBase64, "base64"));
				return { size: file.size };
			}
			case "server.monitor": {
				const params = rawParams as BackendMethods["server.monitor"]["params"];
				return probeHostMonitor(await this.hosts.require(params.hostId));
			}
			case "hosts.get":
				return this.hosts.list();
			case "hosts.add": {
				const params = rawParams as BackendMethods["hosts.add"]["params"];
				const host = await this.hosts.add(params);
				return { hosts: this.hostsChanged(await this.hosts.list()), host };
			}
			case "hosts.update": {
				const params = rawParams as BackendMethods["hosts.update"]["params"];
				await this.hosts.update(params.id, params.patch);
				return this.hostsChanged(await this.hosts.list());
			}
			case "hosts.remove": {
				const params = rawParams as BackendMethods["hosts.remove"]["params"];
				await this.hosts.remove(params.id);
				this.terminals.closeByHost(params.id);
				return this.hostsChanged(await this.hosts.list());
			}
			case "hosts.test": {
				const params = rawParams as BackendMethods["hosts.test"]["params"];
				return this.testHost(params.id);
			}
			case "hosts.listDirs": {
				const params = rawParams as BackendMethods["hosts.listDirs"]["params"];
				return remoteFs.listRemoteDirs(await this.hosts.require(params.id), params.path);
			}
			case "hosts.inspectKey": {
				const params = rawParams as BackendMethods["hosts.inspectKey"]["params"];
				return inspectHostKey(await this.hosts.require(params.id));
			}
			case "hosts.acceptKey": {
				const params = rawParams as BackendMethods["hosts.acceptKey"]["params"];
				return acceptHostKey(await this.hosts.require(params.id), params.fingerprints);
			}
			case "hosts.pickKey": {
				if (!this.host.pickFile) throw new Error("当前外壳不支持系统文件对话框");
				return this.host.pickFile();
			}
			case "projects.addRemote": {
				const params = rawParams as BackendMethods["projects.addRemote"]["params"];
				await this.hosts.require(params.hostId);
				// ProjectStore.mutate 返回 { state, result }，result 才是项目本身
				const { result: project } = await this.projects.addRemote(params.hostId, params.path, params.name);
				const state = this.projectsChanged(await this.projects.get());
				return { state, project };
			}
			case "service.send": {
				const command = rawParams as ServiceCommand;
				if (["validate_session", "rename_session", "delete_session"].includes(command.type)) {
					throw new Error("历史会话操作必须通过 sessions.rename/delete 协调");
				}
				const service = await this.workers.getService();
				// 远程项目的会话按本地占位目录归档
				if (command.type === "list_sessions" && command.cwd) {
					const { cwd, host } = await this.workerCwd(command.cwd);
					if (host) {
						const list = (await service.send({ ...command, cwd })) as SessionSummary[];
						return this.opsPaths.summaries(list, command.cwd);
					}
				}
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
				const { cwd, host } = await this.workerCwd(params.cwd);
				if (host) {
					// 运维会话：先确认能连上，错误信息比 worker 里冒出来的更直接
					if (host.auth === "password" && !host.password) throw new Error("该主机的密码未保存或无法解密，请在主机设置里重新填写");
					await sshRun(host, "true", { timeoutMs: 20_000 });
				} else if (!(await isDirectory(cwd))) throw new Error(`工作区不存在或不是文件夹：${cwd}`);
				const opened = await this.workers.openSession(
					{ ...params, cwd, ops: host ? { host, remoteCwd: params.cwd } : undefined },
					{
						onEvent: (handleId, event) => {
							const out = this.opsHandles.has(handleId) && event.type === "session_changed" ? { ...event, state: this.opsPaths.state(event.state) } : event;
							this.push({ type: "session_event", handleId, event: out });
						},
						onExit: (handleId, code, expected) => {
							this.clientSessions.get(clientId)?.delete(handleId);
							this.opsHandles.delete(handleId);
							this.push({ type: "session_exit", handleId, code, expected });
						},
					},
				);
				if (host) this.opsHandles.add(opened.handleId);
				let owned = this.clientSessions.get(clientId);
				if (!owned) {
					owned = new Set();
					this.clientSessions.set(clientId, owned);
				}
				owned.add(opened.handleId);
				return { handleId: opened.handleId, state: this.opsPaths.state(opened.state) };
			}
			case "session.send": {
				const params = rawParams as BackendMethods["session.send"]["params"];
				const result = await this.workers.sendToSession(params.handleId, params.command);
				if (params.command.type === "set_session_name") {
					const state = await this.workers.sendToSession(params.handleId, { type: "get_state" }) as { cwd: string };
					this.push({ type: "sessions_changed", cwd: this.opsPaths.remoteOf(state.cwd) });
				}
				return this.fromWorker(params.handleId, result);
			}
			case "session.close": {
				const params = rawParams as BackendMethods["session.close"]["params"];
				await this.workers.closeSession(params.handleId);
				this.clientSessions.get(clientId)?.delete(params.handleId);
				return null;
			}
			case "sessions.rename": {
				const params = rawParams as BackendMethods["sessions.rename"]["params"];
				await this.workers.renameSession((await this.workerCwd(params.cwd)).cwd, params.path, params.name);
				this.push({ type: "sessions_changed", cwd: params.cwd });
				return null;
			}
			case "sessions.delete": {
				const params = rawParams as BackendMethods["sessions.delete"]["params"];
				await this.workers.deleteSession((await this.workerCwd(params.cwd)).cwd, params.path);
				this.push({ type: "sessions_changed", cwd: params.cwd });
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
			case "terminal.open": {
				const params = rawParams as BackendMethods["terminal.open"]["params"];
				// 界面只传 cwd：远程路径通过项目注册表反查出主机
				if (!params.hostId && params.cwd) params.hostId = (await this.hostOf(params.cwd))?.id;
				return this.terminals.open(params);
			}
			case "terminal.write": {
				const params = rawParams as BackendMethods["terminal.write"]["params"];
				return this.terminals.write(params);
			}
			case "terminal.resize": {
				const params = rawParams as BackendMethods["terminal.resize"]["params"];
				return this.terminals.resize(params);
			}
			case "terminal.close": {
				const params = rawParams as BackendMethods["terminal.close"]["params"];
				return this.terminals.close(params);
			}
		}
	}

	private projectsChanged(state: ProjectsState): ProjectsState {
		this.push({ type: "projects_changed", state });
		return state;
	}

	/** 主机列表变更：广播给所有客户端并返回列表 */
	private hostsChanged(hosts: SshHost[]): SshHost[] {
		this.push({ type: "hosts_changed", hosts });
		return hosts;
	}

	/** 连接测试：探测远程环境，并把平台记录到主机上（失败也返回结构化结果，不抛错） */
	private async testHost(id: string): Promise<SshTestResult> {
		const target = await this.hosts.require(id);
		const startedAt = Date.now();
		try {
			const probe = await probeHost(target);
			if (probe.platform !== target.platform) {
				await this.hosts.setPlatform(id, probe.platform as SshHost["platform"]);
				this.push({ type: "hosts_changed", hosts: await this.hosts.list() });
			}
			return { ok: true, latencyMs: Date.now() - startedAt, ...probe };
		} catch (error) {
			return { ok: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
		}
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

	/** 客户端断开（网页标签关闭）时，关闭它打开的会话。终端不在此列：它按项目存在，刷新页面不该杀掉正在跑的命令 */
	async releaseClient(clientId: string): Promise<void> {
		const owned = this.clientSessions.get(clientId);
		this.clientSessions.delete(clientId);
		if (!owned) return;
		// 断线清理不能让单个无法确认退出的 worker 拖垮后端进程
		const results = await Promise.allSettled([...owned].map((handleId) => this.workers.closeSession(handleId)));
		for (const result of results) {
			if (result.status === "rejected") console.error(`[flowork] 断开连接时关闭会话失败：${result.reason}`);
		}
	}

	async shutdown(): Promise<void> {
		this.terminals.closeAll();
		await this.workers.shutdownAll();
	}
}
