/**
 * 计划模式任务看板（Plan Task Board）：
 * 从已批准的 submit_plan 计划中提取结构化任务清单，
 * 在执行模式下常驻提供进度追踪与任务步骤大纲。
 */
import { memo, useMemo, useState } from "react";
import type { ChatMessage, ContentBlock } from "@shared/protocol";
import { parsePlanMarkdown, type ParsedPlan } from "../../lib/plan-parser";
import { useApp } from "../../store";
import { Icon } from "../Icon";

export function findLatestAcceptedPlan(messages: readonly ChatMessage[]): ParsedPlan | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "assistant") {
			const call = m.content.find(
				(b): b is Extract<ContentBlock, { type: "toolCall" }> => b.type === "toolCall" && b.name === "submit_plan",
			);
			if (call) {
				const resultMsg = messages.find(
					(r) => r && r.role === "toolResult" && r.toolCallId === call.id,
				);
				const details = resultMsg && "details" in resultMsg ? (resultMsg.details as { accepted?: boolean; plan?: string } | undefined) : undefined;
				if (details?.accepted === true || typeof call.arguments.plan === "string") {
					const planText = details?.plan || (call.arguments.plan as string);
					return parsePlanMarkdown(planText);
				}
			}
		}
	}
	return null;
}

export const PlanBoard = memo(function PlanBoard() {
	const messages = useApp((s) => s.messages);
	const workMode = useApp((s) => s.state?.workMode);
	const openPreview = useApp((s) => s.openPreview);
	const setRightPanel = useApp((s) => s.setRightPanel);
	const [expanded, setExpanded] = useState(false);
	const [checkedSteps, setCheckedSteps] = useState<Record<number, boolean>>({});

	const plan = useMemo(() => findLatestAcceptedPlan(messages), [messages]);

	// 仅在执行模式且有计划时显示，或者有计划且步骤不为空
	if (!plan || plan.steps.length === 0 || workMode === "plan") {
		return null;
	}

	const totalSteps = plan.steps.length;
	const completedCount = plan.steps.filter((s) => checkedSteps[s.id] ?? s.completed).length;

	const toggleCheck = (id: number) => {
		setCheckedSteps((prev) => ({
			...prev,
			[id]: !(prev[id] ?? plan.steps.find((s) => s.id === id)?.completed ?? false),
		}));
	};

	return (
		<div className="mb-4 overflow-hidden rounded-2xl border border-primary/30 bg-primary-soft/30 backdrop-blur-sm transition-all shadow-sm">
			{/* 头部标题与进度条 */}
			<div
				onClick={() => setExpanded(!expanded)}
				className="flex cursor-pointer items-center justify-between px-4 py-2.5 select-none hover:bg-primary-soft/50"
			>
				<div className="flex min-w-0 items-center gap-2.5">
					<span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-primary">
						<Icon name="list-checks" className="size-3.5" />
					</span>
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span className="text-[13px] font-semibold text-fg truncate">
								{plan.title || "当前执行计划看板"}
							</span>
							<span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
								{completedCount}/{totalSteps} 步
							</span>
						</div>
					</div>
				</div>

				<div className="flex items-center gap-2 text-[12px] text-muted">
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							setRightPanel("execution");
						}}
						title="在右侧面板全屏查看执行树"
						className="rounded px-2 py-0.5 text-[11.5px] text-primary hover:bg-primary/10 transition-colors"
					>
						执行树面板
					</button>
					<span className="flex items-center gap-1 font-mono text-[11.5px] text-muted">
						{expanded ? "收起" : "展开清单"}
						<Icon name={expanded ? "chevron-up" : "chevron-down"} className="size-3" />
					</span>
				</div>
			</div>

			{/* 进度条指示 */}
			<div className="h-1 w-full bg-primary/10">
				<div
					className="h-full bg-primary transition-all duration-300"
					style={{ width: `${Math.round((completedCount / totalSteps) * 100)}%` }}
				/>
			</div>

			{/* 展开的任务清单 */}
			{expanded && (
				<div className="border-t border-primary/20 bg-panel-1/70 p-4 space-y-2.5 text-[12.5px]">
					<div className="space-y-1.5">
						{plan.steps.map((step) => {
							const done = checkedSteps[step.id] ?? step.completed;
							return (
								<div
									key={step.id}
									onClick={() => toggleCheck(step.id)}
									className={`flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors ${
										done ? "bg-ok-soft/30 text-muted line-through" : "hover:bg-panel-2/60 text-fg"
									}`}
								>
									<span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
										done ? "border-ok bg-ok text-bg" : "border-border-strong bg-panel-1"
									}`}>
										{done && <Icon name="check" className="size-3 text-white" />}
									</span>
									<span className="min-w-0 flex-1 leading-relaxed">
										<span className="font-mono mr-1.5 font-medium text-faint">{step.id}.</span>
										{step.title}
									</span>
								</div>
							);
						})}
					</div>

					{/* 计划涉及的文件 */}
					{plan.files.length > 0 && (
						<div className="pt-2 border-t border-border/50">
							<div className="mb-1 text-[11px] font-medium text-muted">涉及代码文件：</div>
							<div className="flex flex-wrap gap-1.5">
								{plan.files.map((f) => (
									<button
										key={f}
										type="button"
										onClick={() => openPreview(f)}
										className="inline-flex items-center gap-1 rounded bg-panel-2 px-2 py-0.5 font-mono text-[11px] text-primary hover:bg-primary-soft transition-colors"
									>
										<Icon name="file-code" className="size-3" />
										{f.split("/").pop() ?? f}
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
});
