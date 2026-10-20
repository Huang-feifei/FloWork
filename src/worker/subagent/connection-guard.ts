/**
 * 子代理发起数据库 / SSH 连接时，借用父会话的扩展 UI 再确认一次。
 *
 * `subagent` 工具本身只审批一次，子代理内部的普通工具调用会自动执行；但连接类命令属于例外：
 * 即使父会话审批关闭，也必须在执行前让用户看到具体命令并单独确认。这里只提供「允许 / 拒绝」，
 * 不提供「本会话始终允许」，避免子代理把后续连接一起放行。
 */
import { assessToolCall } from "@shared/command-risk";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { asRecord, formatToolCall } from "./format";

export async function confirmSubagentConnection(
	ctx: Pick<ExtensionToolContext, "ui">,
	agentName: string,
	toolName: string,
	input: unknown,
	signal: AbortSignal | undefined,
): Promise<{ block: true; reason: string } | undefined> {
	const { forced } = assessToolCall(toolName, input);
	if (!forced) return undefined;
	const preview = formatToolCall(toolName, asRecord(input));
	const ok = await ctx.ui.confirm(
		"子代理请求连接",
		`子代理 ${agentName} 即将执行：\n\n${preview}\n\n数据库 / SSH 连接每次都需要确认，不能由子代理直接放行。`,
		{ signal },
	);
	if (ok) return undefined;
	return { block: true, reason: "用户拒绝子代理发起数据库 / SSH 连接。" };
}
