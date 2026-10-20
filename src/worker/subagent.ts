/**
 * 内置子代理：把任务委派给拥有独立上下文窗口的子会话。
 *
 * - 子会话在 worker 进程内通过 pi SDK 创建，不依赖外部 `pi` 可执行文件；
 * - 子会话不加载 FloWork 的内联审批扩展，因此 `subagent` 只请求一次审批，
 *   子代理内部的工具调用不再逐个弹审批；
 * - agent 定义从用户级 `<agentDir>/agents/*.md` 和项目级 `.pi/agents/*.md` 读取，
 *   项目内 agent 在项目未受信任时先向用户确认；
 * - 支持 single / parallel / chain 三种模式，结果以工具输出返回父会话。
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
	parseFrontmatter,
	type AgentSession,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionFactory,
	type ExtensionToolContext,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getProjectTrust, isProjectTrusted } from "./trust";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_OUTPUT_CHARS = 50 * 1024;
const UPDATE_INTERVAL_MS = 100;

/** 子会话默认启用的内置工具；agent 的 frontmatter.tools 可覆盖。 */
const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

type AgentSource = "user" | "project";
type AgentScope = "user" | "project" | "both";
type ThinkingLevel = AgentSession["thinkingLevel"];
type ParentModel = NonNullable<ExtensionToolContext["model"]>;

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

interface AgentDiscovery {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SubagentResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	output: string;
	error?: string;
	aborted?: boolean;
	usage: SubagentUsage;
	model?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SubagentResult[];
}

const USAGE_ZERO = (): SubagentUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = asRecord(block);
			return b.type === "text" ? str(b.text) : "";
		})
		.join("");
}

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n…（输出过长，已截断）`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** frontmatter 的 tools 既可能是逗号分隔字符串，也可能是 YAML 数组。 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!isDirectory(dir)) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = join(dir, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
		} catch {
			// 单个 agent 文件格式错误不应让整个 subagent 工具不可用。
			continue;
		}
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

/** 从 cwd 向上查找最近的 `.pi/agents`，与 pi 官方 subagent 示例一致。 */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = resolve(cwd);
	for (;;) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = resolve(current, "..");
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscovery {
	const userDir = join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const map = new Map<string, AgentConfig>();
	for (const agent of userAgents) map.set(agent.name, agent);
	// 项目级 agent 覆盖同名用户级 agent
	for (const agent of projectAgents) map.set(agent.name, agent);
	return { agents: [...map.values()], projectAgentsDir };
}

function resolveAgentModel(ctx: ExtensionToolContext, spec: string): ParentModel | undefined {
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

function formatToolCall(name: string, args: Record<string, unknown>): string {
	const path = str(args.path ?? args.file_path);
	switch (name) {
		case "bash":
			return `$ ${str(args.command)}`;
		case "read":
		case "write":
		case "edit":
			return `${name} ${path}`;
		case "grep":
		case "find":
			return `${name} ${str(args.pattern)}${path ? ` in ${path}` : ""}`;
		case "ls":
			return `ls ${path || "."}`;
		default: {
			const json = JSON.stringify(args);
			return `${name} ${json.length > 120 ? `${json.slice(0, 120)}…` : json}`;
		}
	}
}

function addUsage(target: SubagentUsage, raw: unknown): void {
	const u = asRecord(raw);
	target.input += num(u.input);
	target.output += num(u.output);
	target.cacheRead += num(u.cacheRead);
	target.cacheWrite += num(u.cacheWrite);
	target.cost += num(asRecord(u.cost).total);
	target.contextTokens = num(u.totalTokens);
	target.turns += 1;
}

export interface SubagentHost {
	/** 复用主会话的 ModelRuntime，确保认证、模型目录和供应商配置一致。 */
	getModelRuntime(): ModelRuntime;
}

interface RunAgentOptions {
	ctx: ExtensionToolContext;
	host: SubagentHost;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd: string | undefined;
	step: number | undefined;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined;
	makeDetails: (results: SubagentResult[]) => SubagentDetails;
}

/** 运行一个子代理；失败时返回带 error 的结果，由调用方决定是否中断链。 */
async function runAgent(options: RunAgentOptions): Promise<SubagentResult> {
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
			usage: USAGE_ZERO(),
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
			usage: USAGE_ZERO(),
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
				usage: USAGE_ZERO(),
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
			usage: USAGE_ZERO(),
			step,
		};
	}

	const usage = USAGE_ZERO();
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

function isFailed(result: SubagentResult): boolean {
	return result.aborted === true || Boolean(result.error);
}

function resultText(result: SubagentResult): string {
	if (result.error) return result.output ? `${result.output}\n\n[错误] ${result.error}` : `[错误] ${result.error}`;
	return result.output || "(无输出)";
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			const item = items[index];
			if (item === undefined) return;
			results[index] = await fn(item, index);
		}
	});
	await Promise.all(workers);
	return results;
}

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

export function createSubagentExtension(host: SubagentHost): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "subagent",
			label: "子代理",
			description: [
				"把任务委派给拥有独立上下文窗口的专用子代理。",
				"模式：single（agent + task）、parallel（tasks 数组，最多 8 个、并发 4 个）、chain（按顺序执行，可用 {previous} 引用上一步输出）。",
				`用户级 agent 位于 ${join(getAgentDir(), "agents")}，项目级 agent 位于 .pi/agents。默认 agentScope 为 "both"。`,
				"子代理内部的工具调用不会再逐个请求审批；本工具本身只请求一次审批。",
			].join(" "),
			promptSnippet: "Delegate a task to a specialized subagent with isolated context.",
			promptGuidelines: [
				"适合把大范围搜索、独立审查或并行子任务交给子代理，避免污染主上下文。",
				"子代理内部工具自动执行；调用前确认任务范围。",
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
				const available = agents.map((agent) => `${agent.name}（${agent.source}）`).join("、") || "无";
				if (modeCount !== 1) {
					return {
						content: [{ type: "text", text: `必须且只能提供一种模式。可用 agent：${available}` }],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
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
								details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							};
						}
					}
				}

				if (params.chain && params.chain.length > 0) {
					const modeDetails = makeDetails("chain");
					const results: SubagentResult[] = [];
					let previous = "";
					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						if (!step) continue;
						const task = step.task.replace(/\{previous\}/g, previous);
						const result = await runAgent({
							ctx,
							host,
							agents,
							agentName: step.agent,
							task,
							cwd: step.cwd,
							step: i + 1,
							signal,
							onUpdate: onUpdate
								? (partial) => {
										const current = partial.details?.results[0];
										onUpdate({ ...partial, details: modeDetails(current ? [...results, current] : results) });
									}
								: undefined,
							makeDetails: modeDetails,
						});
						results.push(result);
						if (isFailed(result)) {
							return {
								content: [{ type: "text", text: `链式执行在第 ${i + 1} 步（${step.agent}）失败：${resultText(result)}` }],
								details: modeDetails(results),
								isError: true,
							};
						}
						previous = result.output;
					}
					const last = results[results.length - 1];
					return {
						content: [{ type: "text", text: last ? resultText(last) : "(无输出)" }],
						details: modeDetails(results),
					};
				}

				if (params.tasks && params.tasks.length > 0) {
					const modeDetails = makeDetails("parallel");
					if (params.tasks.length > MAX_PARALLEL_TASKS) {
						return {
							content: [{ type: "text", text: `并行任务过多（${params.tasks.length}），最多 ${MAX_PARALLEL_TASKS} 个。` }],
							details: modeDetails([]),
							isError: true,
						};
					}
					const all: Array<SubagentResult | undefined> = new Array(params.tasks.length);
					const emit = () => {
						if (!onUpdate) return;
						const done = all.filter((item) => item !== undefined).length;
						onUpdate({
							content: [{ type: "text", text: `并行子代理：${done}/${all.length} 完成…` }],
							details: modeDetails(all.filter((item): item is SubagentResult => item !== undefined)),
						});
					};
					const results = await mapWithConcurrency(params.tasks, MAX_CONCURRENCY, async (item, index) => {
						const result = await runAgent({
							ctx,
							host,
							agents,
							agentName: item.agent,
							task: item.task,
							cwd: item.cwd,
							step: undefined,
							signal,
							onUpdate: onUpdate
								? (partial) => {
										const current = partial.details?.results[0];
										if (current) all[index] = current;
										emit();
									}
								: undefined,
							makeDetails: modeDetails,
						});
						all[index] = result;
						emit();
						return result;
					});
					const success = results.filter((result) => !isFailed(result)).length;
					const summary = results
						.map((result) => `### [${result.agent}] ${isFailed(result) ? "失败" : "完成"}\n\n${truncate(resultText(result))}`)
						.join("\n\n---\n\n");
					return {
						content: [{
							type: "text",
							text: `并行子代理：${success}/${results.length} 成功\n\n${summary}`,
						}],
						details: modeDetails(results),
						...(success === results.length ? {} : { isError: true }),
					};
				}

				const singleDetails = makeDetails("single");
				const result = await runAgent({
					ctx,
					host,
					agents,
					agentName: params.agent ?? "",
					task: params.task ?? "",
					cwd: params.cwd,
					step: undefined,
					signal,
					onUpdate,
					makeDetails: singleDetails,
				});
				return {
					content: [{ type: "text", text: isFailed(result) ? `子代理 ${result.agent} 失败：${resultText(result)}` : resultText(result) }],
					details: singleDetails([result]),
					...(isFailed(result) ? { isError: true } : {}),
				};
			},
		});
	};
}
