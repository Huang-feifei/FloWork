/**
 * 桌面后端冒烟检查，由 src/main/smoke.ts 调用。
 * 不调用模型，也不修改任何配置文件。
 */
import type { CommandResultMap } from "@shared/protocol";
import type { Backend } from "./backend";

export async function runCoreChecks(backend: Backend): Promise<Record<string, unknown>> {
	const report: Record<string, unknown> = {};
	const info = await backend.handle("app.info", undefined);
	report.shell = info.shell;

	const ping = (await backend.handle("service.send", { type: "ping" })) as CommandResultMap["ping"];
	report.workerNode = ping.versions.node;
	report.workerElectron = ping.versions.electron ?? null;
	report.agentDir = ping.agentDir;

	const providers = (await backend.handle("service.send", { type: "list_providers" })) as CommandResultMap["list_providers"];
	report.providers = providers.length;
	report.configuredProviders = providers.filter((p) => p.configured).map((p) => p.id);

	const models = (await backend.handle("service.send", { type: "list_models" })) as CommandResultMap["list_models"];
	report.models = models.length;

	const settings = (await backend.handle("service.send", {
		type: "get_config_file",
		name: "settings",
	})) as CommandResultMap["get_config_file"];
	report.settingsFile = settings.path;

	const sessions = (await backend.handle("service.send", { type: "list_sessions" })) as CommandResultMap["list_sessions"];
	report.sessionsOnDisk = sessions.length;

	const dirs = await backend.handle("workspace.list", { root: process.cwd() });
	report.workspaceEntries = dirs.entries.length;

	const { handleId, state } = await backend.handle("session.open", { cwd: process.cwd() }, "smoke");
	report.sessionId = state.sessionId;
	report.model = state.model ? `${state.model.provider}/${state.model.id}` : null;
	const tree = (await backend.handle("session.send", {
		handleId,
		command: { type: "get_tree" },
	})) as CommandResultMap["get_tree"];
	report.treeRoots = tree.tree.length;
	await backend.handle("session.send", { handleId, command: { type: "refresh_config" } });
	report.refreshConfig = "ok";
	await backend.handle("session.close", { handleId }, "smoke");
	return report;
}
