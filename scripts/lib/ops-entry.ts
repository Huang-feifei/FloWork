/**
 * test-ops-tools.mjs 的打包入口：把运维扩展注册的工具取出来，脱离 pi 会话直接调用。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackupLog, createOpsExtension, type OpsTarget } from "../../src/worker/ops-tools";

export { probeHostProfile } from "../../src/core/host-profile";

type Handler = (event: unknown, ctx?: unknown) => unknown;

export function createTools(target: OpsTarget) {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Handler[]>();
	const fakePi = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		setActiveTools: () => undefined,
	};
	createOpsExtension(target, () => null, new BackupLog())(fakePi as never);
	const resultHandlers = handlers.get("tool_result") ?? [];
	const wrap = (name: string) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`tool ${name} not registered`);
		return {
			async execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: (u: unknown) => void, ctx: unknown) {
				const result = (await tool.execute(id, params as never, signal, onUpdate as never, ctx as never)) as { content: Array<{ type: string; text?: string }>; details?: unknown };
				// 模拟 pi 调用 tool_result 钩子（备份路径、远程路径在这里补上）
				let current = result;
				for (const handler of resultHandlers) {
					const patch = (await handler({ toolName: name, toolCallId: id, input: params, content: current.content, details: current.details, isError: false })) as Partial<typeof result> | undefined;
					if (patch) current = { ...current, ...patch };
				}
				return current;
			},
		};
	};
	return { bash: wrap("bash"), read: wrap("read"), write: wrap("write"), edit: wrap("edit") };
}
