import type {
	AgentSession,
	AgentToolUpdateCallback,
	ExtensionToolContext,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";

export type AgentSource = "user" | "project";
export type AgentScope = "user" | "project" | "both";
export type SubagentMode = "single" | "parallel" | "chain";
export type ThinkingLevel = AgentSession["thinkingLevel"];
export type ParentModel = NonNullable<ExtensionToolContext["model"]>;

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscovery {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentResult {
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

export interface SubagentDetails {
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SubagentResult[];
}

export interface SubagentHost {
	/** 复用主会话的 ModelRuntime，确保认证、模型目录和供应商配置一致。 */
	getModelRuntime(): ModelRuntime;
}

export interface SubagentTask {
	agent: string;
	task: string;
	cwd?: string;
}

export interface SubagentChainStep extends SubagentTask {}

export interface RunStepOptions {
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
	makeDetails: (results: SubagentResult[]) => SubagentDetails;
}

export type RunStep = (options: RunStepOptions) => Promise<SubagentResult>;

export interface RunAgentOptions {
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
