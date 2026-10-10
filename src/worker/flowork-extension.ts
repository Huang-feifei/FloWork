/**
 * FloWork 内联扩展：在 pi 的工具执行流程中加入
 * 1. 工具审批：tool_call 钩子中请求界面确认，拒绝时阻止执行并把原因告诉模型；
 * 2. write 的修改 diff：执行前记录原文件内容，执行后生成与 edit 工具相同格式的 diff 放进结果 details。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type ExtensionFactory, generateDiffString } from "@earendil-works/pi-coding-agent";

export interface ApprovalRequest {
	toolCallId: string;
	toolName: string;
	input: unknown;
}

export interface FloworkExtensionHost {
	/** 返回 null 表示允许；返回字符串表示拒绝原因（会告诉模型） */
	approve(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<string | null>;
}

/** diff 过大时不放进会话记录 */
const MAX_DIFF_CHARS = 200_000;

function resolvePath(path: string, cwd: string): string {
	const p = path.startsWith("@") ? path.slice(1) : path;
	if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(1));
	return isAbsolute(p) ? p : resolve(cwd, p);
}

async function readOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

export function createFloworkExtension(host: FloworkExtensionHost): ExtensionFactory {
	return (pi) => {
		/** toolCallId → write 之前的文件内容（null 表示新建文件） */
		const snapshots = new Map<string, { path: string; before: string | null }>();

		pi.on("tool_call", async (event, ctx) => {
			const reason = await host.approve(
				{ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input },
				ctx.signal,
			);
			if (reason !== null) return { block: true, reason };

			if (event.toolName === "write") {
				const input = event.input as { path?: unknown };
				if (typeof input.path === "string") {
					const path = resolvePath(input.path, ctx.cwd);
					snapshots.set(event.toolCallId, { path, before: await readOrNull(path) });
				}
			}
			return undefined;
		});

		pi.on("tool_result", async (event) => {
			if (event.toolName !== "write") return undefined;
			const snapshot = snapshots.get(event.toolCallId);
			snapshots.delete(event.toolCallId);
			if (!snapshot || event.isError) return undefined;
			const after = await readOrNull(snapshot.path);
			if (after === null) return undefined;
			const { diff, firstChangedLine } = generateDiffString(snapshot.before ?? "", after);
			if (diff.length > MAX_DIFF_CHARS) return { details: { created: snapshot.before === null, diffTooLarge: true } };
			return { details: { diff, firstChangedLine, created: snapshot.before === null } };
		});
	};
}
