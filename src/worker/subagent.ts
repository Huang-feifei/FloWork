/**
 * 内置子代理：把任务委派给拥有独立上下文窗口的子会话。
 *
 * - 子会话在 worker 进程内通过 pi SDK 创建，不依赖外部 `pi` 可执行文件；
 * - 子会话不加载 FloWork 的内联审批扩展，因此 `subagent` 只请求一次审批，
 *   子代理内部的工具调用不再逐个弹审批；数据库 / SSH 连接例外，执行前仍会请求确认；
 * - agent 定义从用户级 `<agentDir>/agents/*.md` 和项目级 `.pi/agents/*.md` 读取，
 *   项目内 agent 在项目未受信任时先向用户确认；
 * - 支持 single / parallel / chain 三种模式，结果以工具输出返回父会话。
 */
import { dirname, join } from "node:path";
import {
	getAgentDir,
	type AgentToolResult,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_SUBAGENT_SETTINGS, normalizeSubagentSettings, type SubagentSettings } from "@shared/subagent-settings";
import { getProjectTrust } from "./trust";
import { discoverAgents } from "./subagent/discovery";
import {
	runChain,
	runParallel,
	runSingle,
} from "./subagent/orchestrator";
import { runAgent } from "./subagent/runner";
import type {
	AgentScope,
	RunStepOptions,
	SubagentDetails,
	SubagentHost,
	SubagentResult,
} from "./subagent/types";

export { discoverAgents, runChain, runParallel, runSingle };

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent 名称" }),
	task: Type.String({ description: "委派给该 agent 的任务" }),
	cwd: Type.Optional(Type.String({ description: "该 agent 的工作目录，默认继承当前会话" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Agent 名称" }),
	task: Type.String({ description: "任务；可用 {previous} 引用上一步的输出" }),
	cwd: Type.Optional(Type.String({ description: "该 agent 的工作目录，默认继承当前会话" })),
});

const AgentScopeSchema = Type.Union(
	[Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
	{ description: 'Agent 目录范围：用户级、项目级或两者。默认 "both"。' },
);

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "single 模式的 agent 名称" })),
	task: Type.Optional(Type.String({ description: "single 模式的任务" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "parallel 模式的任务列表" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "chain 模式的步骤列表，按顺序执行" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "single 模式 agent 的工作目录" })),
});

export function createSubagentExtension(
	host: SubagentHost,
	settings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS,
): ExtensionFactory {
	const config = normalizeSubagentSettings(settings);
	return (pi) => {
		if (!config.enabled) return;
		pi.registerTool({
			name: "subagent",
			label: "子代理",
			description: [
				"把任务委派给拥有独立上下文窗口的专用子代理。",
				`模式：single（agent + task）、parallel（tasks 数组，最多 ${config.maxTasks} 个、并发 ${config.maxConcurrency} 个）、chain（按顺序执行，可用 {previous} 引用上一步输出）。`,
				`用户级 agent 位于 ${join(getAgentDir(), "agents")}，项目级 agent 位于 .pi/agents。默认 agentScope 为 "both"。`,
				"子代理内部的普通工具调用不会再逐个请求审批；本工具本身只请求一次审批。数据库 / SSH 连接属于例外，执行前仍会请求确认。",
			].join(" "),
			promptSnippet: "Delegate a task to a specialized subagent with isolated context.",
			promptGuidelines: [
				"适合把大范围搜索、独立审查或并行子任务交给子代理，避免污染主上下文。",
				"子代理内部工具自动执行；调用前确认任务范围。子代理发起数据库 / SSH 连接时仍会逐次请求确认。",
			],
			parameters: SubagentParams,

			async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
				const agentScope: AgentScope = params.agentScope ?? "both";
				const discovery = discoverAgents(ctx.cwd, agentScope);
				const agents = discovery.agents;
				const makeDetails = (mode: SubagentDetails["mode"]) => (results: SubagentResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

				const hasChain = (params.chain?.length ?? 0) > 0;
				const hasTasks = (params.tasks?.length ?? 0) > 0;
				const hasSingle = Boolean(params.agent && params.task);
				const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
				const fallbackMode: SubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";
				const available = agents.map((agent) => `${agent.name}（${agent.source}）`).join("、") || "无";
				if (modeCount !== 1) {
					return {
						content: [{ type: "text", text: `必须且只能提供一种模式。可用 agent：${available}` }],
						details: makeDetails(fallbackMode)([]),
						isError: true,
					};
				}

				// 项目级 agent 的 system prompt 受仓库控制；项目未明确信任时先确认一次。
				const projectRoot = discovery.projectAgentsDir ? dirname(dirname(discovery.projectAgentsDir)) : null;
				const projectTrusted = projectRoot !== null && getProjectTrust(projectRoot).state === "trusted";
				if (agentScope !== "user" && !projectTrusted) {
					const requested = new Set<string>();
					for (const step of params.chain ?? []) requested.add(step.agent);
					for (const item of params.tasks ?? []) requested.add(item.agent);
					if (params.agent) requested.add(params.agent);
					const projectAgents = agents.filter((agent) => agent.source === "project" && requested.has(agent.name));
					if (projectAgents.length > 0) {
						const names = projectAgents.map((agent) => agent.name).join("、");
						const dir = discovery.projectAgentsDir ?? "(未知目录)";
						const ok = await ctx.ui.confirm(
							"运行项目内子代理？",
							`Agent：${names}\n来源：${dir}\n\n项目内 agent 是仓库控制的提示词，只应在信任此项目时运行。`,
						);
						if (!ok) {
							return {
								content: [{ type: "text", text: "已取消：未批准运行项目内 agent。" }],
								details: makeDetails(fallbackMode)([]),
							};
						}
					}
				}

				const runStep = (options: RunStepOptions) =>
					runAgent({
						ctx,
						host,
						agents,
						agentName: options.agentName,
						task: options.task,
						cwd: options.cwd,
						step: options.step,
						defaultModel: config.defaultModel,
						signal,
						onUpdate: options.onUpdate,
						makeDetails: options.makeDetails,
					});

				if (params.chain && params.chain.length > 0) {
					return runChain(params.chain, {
						runStep,
						modeDetails: makeDetails("chain"),
						onUpdate,
					});
				}

				if (params.tasks && params.tasks.length > 0) {
					return runParallel(params.tasks, {
						runStep,
						modeDetails: makeDetails("parallel"),
						onUpdate,
						limits: { maxTasks: config.maxTasks, maxConcurrency: config.maxConcurrency },
					});
				}

				return runSingle(
					{ agent: params.agent ?? "", task: params.task ?? "", cwd: params.cwd },
					{
						runStep,
						modeDetails: makeDetails("single"),
						onUpdate,
					},
				);
			},
		});
	};
}
