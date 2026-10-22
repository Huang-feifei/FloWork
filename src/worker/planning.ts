/** 内置计划工作流：只读策略、向用户提问、提交计划并等待明确确认。 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { READ_ONLY_TOOLS, type WorkMode } from "@shared/protocol";

export const WORK_MODE_ENTRY = "flowork.work-mode";
export const DECISION_TOOLS = new Set(["ask_user", "submit_plan"]);

/** 不尝试用命令字符串推断安全性：计划阶段禁用整个 Shell 和未知工具（包括嵌套调用）。 */
export function allowedInPlan(toolName: string): boolean {
	return READ_ONLY_TOOLS.has(toolName) || DECISION_TOOLS.has(toolName);
}

export function restoredWorkMode(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): WorkMode {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== WORK_MODE_ENTRY) continue;
		const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
		if (mode === "plan" || mode === "execute") return mode;
	}
	return "execute";
}

export interface PlanningHost {
	getMode(): WorkMode;
	/** 仅在提交计划的会话仍是当前会话时允许授权，防止迟到的应答影响新会话。 */
	acceptPlan(sessionId: string, signal: AbortSignal | undefined): void;
	askUser(question: string, options: string[], signal: AbortSignal | undefined): Promise<string | undefined>;
	reviewPlan(plan: string, signal: AbortSignal | undefined): Promise<boolean>;
}

export function createPlanningExtension(host: PlanningHost): ExtensionFactory {
	return (pi) => {
		pi.on("user_bash", () => {
			if (host.getMode() === "plan") throw new Error("计划模式禁止 Shell 命令，请先确认计划或切换执行模式");
		});
		// 每次请求读取实时模式（含 submit_plan 同轮获批），但提示必须固定在历史之前。
		// 若临时追加在末尾，下一次请求会将它移到新消息之后，破坏上一轮的缓存前缀；
		// 置于开头后，同一模式下只有真实历史增长。切换模式时的一次缓存失效是预期行为。
		pi.on("context", (event) => ({
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: host.getMode() === "plan"
					? "[FloWork 工作流：计划模式] 只读分析，不要修改文件或执行 Shell/其他有副作用的工具。需求或实现取舍不明确时调用 ask_user，等待用户决策，不要替用户做关键选择。明确需求后调用 submit_plan，提交包含目标、实施步骤、涉及文件、风险和验证方法的完整计划。只有 submit_plan 返回用户已确认并切换执行模式，才能实施。用户拒绝或取消时保持计划模式，按反馈调整，不要反复强迫确认。"
					: "[FloWork 工作流：执行模式] 可以按用户要求实施，仍须遵循工具审批。需求或关键取舍不明确时调用 ask_user 等待用户决策。如果 submit_plan 刚刚获批，按已批准的计划执行；不要扩大范围。" }],
				timestamp: 0,
			}, ...event.messages],
		}));

		pi.registerTool({
			name: "ask_user",
			label: "向用户提问",
			description: "向用户提出一个需要决策的问题并等待回答。可以提供候选选项，用户也可以自行填写。取消不代表同意，不得自行猜测答案。计划和执行模式均可使用。",
			exposure: "model-only",
			executionMode: "sequential",
			parameters: Type.Object({
				question: Type.String({ minLength: 1, maxLength: 4000, description: "问题、相关背景及需要用户决定的取舍" }),
				options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 8, description: "候选方案；可在文字中说明利弊或标注推荐项" })),
			}),
			async execute(_id, params, signal) {
				const question = params.question.trim();
				if (!question) throw new Error("问题不能为空");
				const options = [...new Set((params.options ?? []).map((s) => s.trim()).filter(Boolean))];
				const answer = await host.askUser(question, options, signal);
				return {
					content: [{ type: "text", text: answer === undefined ? "用户取消了问题，尚未作出决定。不要将取消视为同意。" : `用户回答：${answer}` }],
					details: { question, options, answer: answer ?? null },
					...(answer === undefined ? { terminate: true } : {}),
				};
			},
		});

		pi.registerTool({
			name: "submit_plan",
			label: "提交计划",
			description: "仅用于计划模式：展示完整实施计划并等待用户明确确认。批准后切换执行模式；拒绝、中断或取消都不会授权执行。不要把该工具和修改操作放在同一批调用中。",
			exposure: "model-only",
			executionMode: "sequential",
			parameters: Type.Object({
				plan: Type.String({ minLength: 1, maxLength: 30000, description: "完整计划：目标、步骤、相关文件、风险和验证方法，可使用 Markdown" }),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (host.getMode() !== "plan") throw new Error("请先切换到计划模式再提交计划");
				const plan = params.plan.trim();
				if (!plan) throw new Error("计划不能为空");
				const sessionId = ctx.sessionManager.getSessionId();
				const accepted = await host.reviewPlan(plan, signal);
				if (accepted) host.acceptPlan(sessionId, signal);
				return {
					content: [{ type: "text", text: accepted
						? "用户已明确确认此计划，已切换到执行模式。现在按该计划实施，仍遵循工具审批。"
						: "用户未批准该计划。继续保持只读计划模式，等待用户提供调整意见后再修改计划，不得执行。" }],
					details: { plan, accepted },
					...(!accepted ? { terminate: true } : {}),
				};
			},
		});
	};
}
