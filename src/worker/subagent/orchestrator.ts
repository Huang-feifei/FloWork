import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { isFailed, resultText, truncate } from "./format";
import type {
	RunStep,
	SubagentChainStep,
	SubagentDetails,
	SubagentResult,
	SubagentTask,
} from "./types";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;

export interface OrchestratorDeps {
	runStep: RunStep;
	modeDetails: (results: SubagentResult[]) => SubagentDetails;
	onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
}

export interface SingleInput {
	agent: string;
	task: string;
	cwd?: string;
}

export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
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

export async function runSingle(
	input: SingleInput,
	deps: OrchestratorDeps,
): Promise<AgentToolResult<SubagentDetails>> {
	const result = await deps.runStep({
		agentName: input.agent,
		task: input.task,
		cwd: input.cwd,
		step: undefined,
		onUpdate: deps.onUpdate,
		makeDetails: deps.modeDetails,
	});
	return {
		content: [{
			type: "text",
			text: isFailed(result) ? `子代理 ${result.agent} 失败：${resultText(result)}` : resultText(result),
		}],
		details: deps.modeDetails([result]),
		...(isFailed(result) ? { isError: true } : {}),
	};
}

export async function runParallel(
	tasks: readonly SubagentTask[],
	deps: OrchestratorDeps,
): Promise<AgentToolResult<SubagentDetails>> {
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return {
			content: [{ type: "text", text: `并行任务过多（${tasks.length}），最多 ${MAX_PARALLEL_TASKS} 个。` }],
			details: deps.modeDetails([]),
			isError: true,
		};
	}

	const all: Array<SubagentResult | undefined> = new Array(tasks.length);
	const emit = () => {
		if (!deps.onUpdate) return;
		const done = all.filter((item) => item !== undefined).length;
		deps.onUpdate({
			content: [{ type: "text", text: `并行子代理：${done}/${all.length} 完成…` }],
			details: deps.modeDetails(all.filter((item): item is SubagentResult => item !== undefined)),
		});
	};

	const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, async (item, index) => {
		const result = await deps.runStep({
			agentName: item.agent,
			task: item.task,
			cwd: item.cwd,
			step: undefined,
			onUpdate: deps.onUpdate
				? (partial) => {
						const current = partial.details?.results[0];
						if (current) all[index] = current;
						emit();
					}
				: undefined,
			makeDetails: deps.modeDetails,
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
		details: deps.modeDetails(results),
		...(success === results.length ? {} : { isError: true }),
	};
}

export async function runChain(
	chain: readonly SubagentChainStep[],
	deps: OrchestratorDeps,
): Promise<AgentToolResult<SubagentDetails>> {
	const results: SubagentResult[] = [];
	let previous = "";
	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		if (!step) continue;
		const task = step.task.replace(/\{previous\}/g, previous);
		const result = await deps.runStep({
			agentName: step.agent,
			task,
			cwd: step.cwd,
			step: i + 1,
			onUpdate: deps.onUpdate
				? (partial) => {
						const current = partial.details?.results[0];
						deps.onUpdate?.({
							...partial,
							details: deps.modeDetails(current ? [...results, current] : results),
						});
					}
				: undefined,
			makeDetails: deps.modeDetails,
		});
		results.push(result);
		if (isFailed(result)) {
			return {
				content: [{
					type: "text",
					text: `链式执行在第 ${i + 1} 步（${step.agent}）失败：${resultText(result)}`,
				}],
				details: deps.modeDetails(results),
				isError: true,
			};
		}
		previous = result.output;
	}
	const last = results[results.length - 1];
	return {
		content: [{ type: "text", text: last ? resultText(last) : "(无输出)" }],
		details: deps.modeDetails(results),
	};
}
