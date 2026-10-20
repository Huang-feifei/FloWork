import { isAbsolute, resolve } from "node:path";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "../trust";
import { isDirectory } from "./discovery";
import {
	addUsage,
	asRecord,
	errorText,
	formatToolCall,
	str,
	textOfContent,
	truncate,
	usageZero,
} from "./format";
import type {
	ParentModel,
	RunAgentOptions,
	SubagentResult,
	ThinkingLevel,
} from "./types";

/** 子会话默认启用的内置工具；agent 的 frontmatter.tools 可覆盖。 */
const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const UPDATE_INTERVAL_MS = 100;

function resolveAgentModel(ctx: RunAgentOptions["ctx"], spec: string): ParentModel | undefined {
	const slash = spec.indexOf("/");
	if (slash > 0) {
		const model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
		if (model) return model;
	}
	const wanted = spec.toLowerCase();
	return ctx.modelRegistry
		.getAll()
		.find((model) => model.id.toLowerCase() === wanted || `${model.provider}/${model.id}`.toLowerCase() === wanted);
}

/** 运行一个子代理；失败时返回带 error 的结果，由调用方决定是否中断链。 */
export async function runAgent(options: RunAgentOptions): Promise<SubagentResult> {
	const { ctx, host, agents, agentName, task, signal, step, onUpdate, makeDetails } = options;
	const agent = agents.find((item) => item.name === agentName);
	if (!agent) {
		const available = agents.map((item) => `${item.name}（${item.source}）`).join("、") || "无";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			output: "",
			error: `找不到 agent "${agentName}"。可用 agent：${available}`,
			usage: usageZero(),
			step,
		};
	}

	const childCwd = options.cwd ? (isAbsolute(options.cwd) ? options.cwd : resolve(ctx.cwd, options.cwd)) : ctx.cwd;
	if (!isDirectory(childCwd)) {
		return {
			agent: agent.name,
			agentSource: agent.source,
			task,
			output: "",
			error: `工作目录不存在：${childCwd}`,
			usage: usageZero(),
			step,
		};
	}
	let model: ParentModel | undefined = ctx.model;
	let thinkingLevel: ThinkingLevel | undefined = ctx.thinkingLevel;
	if (agent.model) {
		const resolved = resolveAgentModel(ctx, agent.model);
		if (!resolved) {
			return {
				agent: agent.name,
				agentSource: agent.source,
				task,
				output: "",
				error: `找不到模型 "${agent.model}"`,
				usage: usageZero(),
				step,
			};
		}
		model = resolved;
		// 与 pi 官方示例一致：显式指定模型时使用该模型的默认 thinking 设置
		thinkingLevel = undefined;
	}

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(childCwd, agentDir, {
		projectTrusted: isProjectTrusted(childCwd),
	});
	const loader = new DefaultResourceLoader({
		cwd: childCwd,
		agentDir,
		settingsManager,
		// 与 pi 的 JSON/print 模式一致：加载用户与项目资源，但不提供交互 UI。
		// 子代理工具本身会从子会话的工具列表中排除，避免无限递归。
		...(agent.systemPrompt.trim() ? { appendSystemPrompt: [agent.systemPrompt] } : {}),
	});
	await loader.reload();

	const configuredTools = agent.tools?.filter((tool) => tool !== "subagent");
	const tools = configuredTools && configuredTools.length > 0 ? configuredTools : DEFAULT_AGENT_TOOLS;

	let session: AgentSession;
	try {
		({ session } = await createAgentSession({
			cwd: childCwd,
			agentDir,
			modelRuntime: host.getModelRuntime(),
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(childCwd),
			model,
			thinkingLevel,
			tools,
			excludeTools: ["subagent"],
		}));
		// 子会话没有交互界面；扩展按 JSON 模式绑定，和 pi 官方的无头子代理保持一致。
		await session.bindExtensions({
			mode: "json",
			onError: () => {
				// 子代理扩展错误不应打断父会话；错误会通过最终输出或 stderr 体现。
			},
		});
	} catch (error) {
		return {
			agent: agent.name,
			agentSource: agent.source,
			task,
			output: "",
			error: errorText(error),
			usage: usageZero(),
			step,
		};
	}

	const usage = usageZero();
	let finalText = "";
	let partialText = "";
	let modelName = model ? `${model.provider}/${model.id}` : undefined;
	let error: string | undefined;
	let aborted = false;
	let lastUpdate = 0;
	const displayLog: string[] = [];

	const emitUpdate = (force: boolean) => {
		if (!onUpdate) return;
		const now = Date.now();
		if (!force && now - lastUpdate < UPDATE_INTERVAL_MS) return;
		lastUpdate = now;
		const progress = [displayLog.slice(-10).join("\n"), partialText.trim()].filter(Boolean).join("\n\n");
		onUpdate({
			content: [{ type: "text", text: progress || `子代理 ${agent.name} 正在执行…` }],
			details: makeDetails([{
				agent: agent.name,
				agentSource: agent.source,
				task,
				output: truncate(finalText || partialText),
				usage: { ...usage },
				model: modelName,
				step,
			}]),
		});
	};

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "message_start": {
				const message = asRecord(event.message);
				if (message.role === "assistant") partialText = "";
				break;
			}
			case "message_update": {
				const update = asRecord(event.assistantMessageEvent);
				if (update.type === "text_delta" && typeof update.delta === "string") {
					partialText += update.delta;
					emitUpdate(false);
				}
				break;
			}
			case "message_end": {
				const message = asRecord(event.message);
				if (message.role !== "assistant") break;
				const text = textOfContent(message.content);
				if (text.trim()) finalText = text;
				partialText = "";
				addUsage(usage, message.usage);
				if (typeof message.model === "string") modelName = message.model;
				if (typeof message.errorMessage === "string" && message.errorMessage) error = message.errorMessage;
				if (message.stopReason === "error" && !error) error = "模型返回错误";
				if (message.stopReason === "aborted") aborted = true;
				emitUpdate(true);
				break;
			}
			case "tool_execution_start": {
				displayLog.push(formatToolCall(str(event.toolName), asRecord(event.args)));
				if (displayLog.length > 50) displayLog.shift();
				emitUpdate(true);
				break;
			}
			default:
				break;
		}
	});

	const onAbort = () => {
		aborted = true;
		void session.abort();
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await session.prompt(task);
	} catch (caught) {
		if (aborted || signal?.aborted) {
			aborted = true;
			error = error ?? "子代理已中断";
		} else {
			error = errorText(caught);
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}

	if (aborted) error = error ?? "子代理已中断";
	const output = truncate(finalText || partialText || displayLog.slice(-10).join("\n"));
	return {
		agent: agent.name,
		agentSource: agent.source,
		task,
		output,
		error,
		aborted,
		usage,
		model: modelName,
		step,
	};
}
