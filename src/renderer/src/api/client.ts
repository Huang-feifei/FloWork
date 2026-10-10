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
	},
	listDirs: (path?: string) => call("fs.listDirs", { path }),
	listWorkspace: (root: string, path?: string) => call("workspace.list", { root, path }),
	readWorkspaceFile: (root: string, path: string) => call("workspace.read", { root, path }),
	writeWorkspaceFile: (root: string, path: string, content: string, expectedMtime?: number) =>
		call("workspace.write", { root, path, content, expectedMtime }),
	searchWorkspace: (root: string, query: string, options: { limit?: number; fresh?: boolean } = {}) =>
		call("workspace.search", { root, query, ...options }),

	service: <C extends ServiceCommand>(command: C) => call("service.send", command) as Promise<CommandResult<C>>,

	openSession: (cwd: string, approvalMode?: ApprovalMode, sessionPath?: string) =>
		call("session.open", { cwd, approvalMode, sessionPath }),
	session: <C extends SessionCommand>(handleId: string, command: C) =>
		call("session.send", { handleId, command }) as Promise<CommandResult<C>>,
	closeSession: (handleId: string) => call("session.close", { handleId }),

	authAnswer: (flowId: string, promptId: string, value?: string, cancel?: boolean) =>
		call("auth.answer", { flowId, promptId, value, cancel }),
	authCancel: (flowId: string) => call("auth.cancel", { flowId }),

	onPush: (listener: (push: BackendPush) => void) => transport.onPush(listener),
	onStatus: transport.onStatus.bind(transport),
};

export function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	// 去掉 Electron IPC 的包装前缀
	return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
