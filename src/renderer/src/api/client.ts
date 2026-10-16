/** 基于 Transport 的类型化 API，界面只通过这里访问后端 */
import type {
	ApprovalMode,
	ProjectPatch,
	BackendMethod,
	BackendMethods,
	BackendPush,
	CommandResult,
	ServiceCommand,
	SessionCommand,
	SshHostInput,
} from "@shared/protocol";
import { transport } from "./transport";

function call<M extends BackendMethod>(method: M, params: BackendMethods[M]["params"]): Promise<BackendMethods[M]["result"]> {
	return transport.request(method, params) as Promise<BackendMethods[M]["result"]>;
}

export const api = {
	info: () => call("app.info", undefined),
	pickFolder: () => call("app.pickFolder", undefined),
	pickFolders: () => call("app.pickFolders", undefined),
	projects: {
		get: () => call("projects.get", undefined),
		add: (paths: string[], groupId?: string) => call("projects.add", { paths, groupId }),
		update: (id: string, patch: ProjectPatch) => call("projects.update", { id, patch }),
		remove: (id: string) => call("projects.remove", { id }),
		touch: (id: string) => call("projects.touch", { id }),
		move: (ids: string[], pinned: boolean, groupId: string | null) => call("projects.move", { ids, pinned, groupId }),
		groupCreate: (name: string) => call("projects.groupCreate", { name }),
		groupUpdate: (id: string, patch: { name?: string; collapsed?: boolean }) => call("projects.groupUpdate", { id, ...patch }),
		groupRemove: (id: string) => call("projects.groupRemove", { id }),
		discover: () => call("projects.discover", undefined),
		addRemote: (hostId: string, path: string, name?: string) => call("projects.addRemote", { hostId, path, name }),
	},
	/** SSH 主机管理 */
	hosts: {
		list: () => call("hosts.get", undefined),
		add: (input: SshHostInput) => call("hosts.add", input),
		update: (id: string, patch: Partial<SshHostInput>) => call("hosts.update", { id, patch }),
		remove: (id: string) => call("hosts.remove", { id }),
		test: (id: string) => call("hosts.test", { id }),
		listDirs: (id: string, path?: string) => call("hosts.listDirs", { id, path }),
		pickKey: () => call("hosts.pickKey", undefined),
		inspectKey: (id: string) => call("hosts.inspectKey", { id }),
		acceptKey: (id: string, fingerprints: string[]) => call("hosts.acceptKey", { id, fingerprints }),
	},
	listDirs: (path?: string) => call("fs.listDirs", { path }),
	listWorkspace: (root: string, path?: string) => call("workspace.list", { root, path }),
	readWorkspaceFile: (root: string, path: string) => call("workspace.read", { root, path }),
	writeWorkspaceFile: (root: string, path: string, content: string, expectedMtime?: number) =>
		call("workspace.write", { root, path, content, expectedMtime }),
	searchWorkspace: (root: string, query: string, options: { limit?: number; fresh?: boolean } = {}) =>
		call("workspace.search", { root, query, ...options }),
	renameWorkspaceEntry: (root: string, path: string, name: string) => call("workspace.rename", { root, path, name }),
	createWorkspaceEntry: (root: string, path: string, type: "file" | "dir") => call("workspace.create", { root, path, type }),
	deleteWorkspaceEntry: (root: string, path: string) => call("workspace.delete", { root, path }),
	moveWorkspaceEntry: (root: string, path: string, targetDir: string) => call("workspace.move", { root, path, targetDir }),
	revealWorkspaceEntry: (root: string, path: string) => call("workspace.reveal", { root, path }),
	openTerminalAt: (root: string, path: string) => call("workspace.openTerminal", { root, path }),

	service: <C extends ServiceCommand>(command: C) => call("service.send", command) as Promise<CommandResult<C>>,

	openSession: (cwd: string, approvalMode?: ApprovalMode, sessionPath?: string) =>
		call("session.open", { cwd, approvalMode, sessionPath }),
	session: <C extends SessionCommand>(handleId: string, command: C) =>
		call("session.send", { handleId, command }) as Promise<CommandResult<C>>,
	closeSession: (handleId: string) => call("session.close", { handleId }),
	sessions: {
		rename: (cwd: string, path: string, name: string) => call("sessions.rename", { cwd, path, name }),
		delete: (cwd: string, path: string) => call("sessions.delete", { cwd, path }),
	},

	/** 终端按 cwd 幂等：同一目录重复 open 会复用同一个 shell（远程路径由后端根据项目注册表自动识别） */
	terminal: {
		open: (cwd: string, cols: number, rows: number, hostId?: string) => call("terminal.open", { cwd, cols, rows, hostId }),
		write: (terminalId: string, data: string) => call("terminal.write", { terminalId, data }),
		resize: (terminalId: string, cols: number, rows: number) => call("terminal.resize", { terminalId, cols, rows }),
		close: (terminalId: string) => call("terminal.close", { terminalId }),
	},

	authAnswer: (flowId: string, promptId: string, value?: string, cancel?: boolean) =>
		call("auth.answer", { flowId, promptId, value, cancel }),
	authCancel: (flowId: string) => call("auth.cancel", { flowId }),

	onPush: (listener: (push: BackendPush) => void) => transport.onPush(listener),
	onStatus: transport.onStatus.bind(transport),
};

/** 主机密钥变化的错误：返回 hostId（错误文本以内部前缀开头） */
export function hostKeyErrorHost(error: unknown): string | null {
	const text = error instanceof Error ? error.message : String(error);
	const m = /FLOWORK_HOST_KEY_CHANGED:([\w-]+)/.exec(text);
	return m ? (m[1] ?? null) : null;
}

let onHostKeyChanged: ((hostId: string) => void) | undefined;
/** store 注册：任何地方格式化到主机密钥错误时，弹出处理对话框 */
export function setHostKeyChangedHandler(handler: (hostId: string) => void): void {
	onHostKeyChanged = handler;
}

export function errorText(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const hostId = hostKeyErrorHost(raw);
	if (hostId) {
		onHostKeyChanged?.(hostId);
		return "服务器的主机密钥与本机记录不一致，请在弹出的对话框中核对指纹";
	}
	const text = raw;
	// 去掉 Electron IPC 的包装前缀
	return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
