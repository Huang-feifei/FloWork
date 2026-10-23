/**
 * 仅精简压缩请求，不改写原始会话或正常对话请求。
 * Pi 1.1.0 的摘要序列化会完整带入历史 thinking；长工具轮次中它可能占绝大多数输入。
 * 通过公开的 session_before_compact / compact API 复用原来的摘要格式、预算和截断检查。
 */
import { type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	compact,
	convertToLlm,
	type ExtensionFactory,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

type Preparation = SessionBeforeCompactEvent["preparation"];
/** fromHook 摘要的文件清单由扩展负责继承，只识别自己的版本标记。 */
const DETAILS_VERSION = 1;

function withoutThinking(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((message) => {
		if (message.role !== "assistant" || !message.content.some((block) => block.type === "thinking")) return message;
		return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
	});
}

export function prepareCompactionInput(event: SessionBeforeCompactEvent): Preparation {
	const source = event.preparation;
	const fileOps = {
		read: new Set(source.fileOps.read),
		written: new Set(source.fileOps.written),
		edited: new Set(source.fileOps.edited),
	};
	// Pi 不继承 fromHook 的 details。补回上一份 FloWork 摘要的累积文件清单，
	// 但不能混入已被上下文投影排除的摘要，或第三方扩展的自定义 details。
	if (source.previousSummary !== undefined) {
		const previous = event.branchEntries.findLast((entry) => entry.type === "compaction" && entry.summary === source.previousSummary);
		if (previous?.type === "compaction" && previous.fromHook) {
			const details = previous.details as { floworkCompaction?: unknown; readFiles?: unknown; modifiedFiles?: unknown } | undefined;
			if (details?.floworkCompaction === DETAILS_VERSION) {
				if (Array.isArray(details.readFiles)) for (const path of details.readFiles) if (typeof path === "string") fileOps.read.add(path);
				if (Array.isArray(details.modifiedFiles)) for (const path of details.modifiedFiles) if (typeof path === "string") fileOps.edited.add(path);
			}
		}
	}
	return {
		...source,
		messagesToSummarize: withoutThinking(source.messagesToSummarize),
		turnPrefixMessages: withoutThinking(source.turnPrefixMessages),
		fileOps,
	};
}

export function createCompactionExtension(getSession: () => AgentSession): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", async (event, ctx) => {
			try {
				event.signal.throwIfAborted();
				const session = getSession();
				const selectedModel = ctx.model;
				if (!selectedModel) throw new Error("尚未选择模型");
				// 与 Pi 内置摘要一致：虚拟模型先路由，再按实际模型限制计算预算。
				const { model, thinkingLevel } = selectedModel.api === "pi-virtual"
					? await session.modelRuntime.resolveModel(selectedModel, convertToLlm(session.messages), {
						reason: "direct", thinkingLevel: session.thinkingLevel, signal: event.signal,
					})
					: { model: selectedModel, thinkingLevel: session.thinkingLevel };
				event.signal.throwIfAborted();
				// 常规请求由 registry 保留供应商配置、请求时认证和 OAuth 路由；
				// SDK 调用方若显式替换 streamFunction，仍尊重它（离线回归也走此入口）。
				const customTransport = session.agent.streamFunction !== streamSimple;
				const transport: StreamFn = customTransport
					? session.agent.streamFunction
					: (target, context, options) => ctx.modelRegistry.streamSimple(target, context, options);
				let auth: Awaited<ReturnType<AgentSession["modelRuntime"]["getAuth"]>>;
				if (customTransport) {
					try {
						auth = await session.modelRuntime.getAuth(model, { signal: event.signal });
					} catch (error) {
						// 与 SDK 自定义传输一致：允许完全离线 / 自带认证的传输，取消不能吞掉。
						if (event.signal.aborted) throw error;
					}
				}
				const requestModel = auth?.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
				const headers = auth?.auth.headers
					? Object.fromEntries(Object.entries(auth.auth.headers).filter((entry): entry is [string, string] => entry[1] !== null))
					: undefined;
				const checkedStream: StreamFn = async (target, context, options) => {
					const stream = await transport(target, context, options);
					const response = await stream.result();
					event.signal.throwIfAborted();
					// length/error 仍交给 compact 的原生检查；额外阻止取消、延迟及空摘要。
					if (!["stop", "length", "error"].includes(response.stopReason)) {
						throw new Error(`摘要未正常完成（${response.stopReason}），未保存摘要`);
					}
					if (response.stopReason === "stop" && !response.content.some((block) => block.type === "text" && block.text.trim())) {
						throw new Error("模型返回空摘要，未保存摘要");
					}
					return stream;
				};
				const result = await compact(
					prepareCompactionInput(event), requestModel, auth?.auth.apiKey, headers, event.customInstructions,
					event.signal, thinkingLevel, checkedStream, auth?.env, session.settingsManager.getRetrySettings(),
				);
				event.signal.throwIfAborted();
				return {
					compaction: { ...result, details: { ...(result.details as object), floworkCompaction: DETAILS_VERSION } },
				};
			} catch (error) {
				if (!event.signal.aborted) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`上下文压缩失败：${message}。原始记录已保留，未写入新摘要。`, "error");
				}
				// Pi 会吞掉扩展抛出的异常并回落默认摘要。必须明确 cancel，
				// 否则失败后会再次发送未精简的历史，造成重复计费或再度撞限。
				return { cancel: true };
			}
		});
	};
}
