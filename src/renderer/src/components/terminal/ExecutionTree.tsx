/**
 * 任务执行进度树（Execution Tree）：
 * 将一组连续的「思考 + 工具调用」聚合为现代、结构化、高质感的执行树。
 *
 * - 折叠状态：紧凑的一体化进度胶囊/摘要卡片，去除了悬空突兀的圆点，显示步骤总数、工具链流向与耗时；
 * - 展开状态：优美的垂直树形导轨线，每个步骤具备专属语义图标、状态徽标、耗时统计与可展开的输出结果；
 * - 运行状态：动态 Spinner 与实时更新，与流式输出无缝接驳。
 */
import { memo, useEffect, useState } from "react";
import type { ImageAttachment } from "@shared/protocol";
import type {
	ExecutionStep,
	ExecutionTreeGroup,
	ThinkingExecutionStep,
	ToolExecutionStep,
} from "../../lib/session-flow";
import { describe, getDiff, imagesOf, partialTextOf, textOf } from "../../lib/tool-format";
import { type ToolRun, useApp } from "../../store";
import { Icon, type IconName } from "../Icon";
import { ImageThumb } from "./ImageThumb";
import { Spinner } from "./Spinner";
import { DiffView } from "./ToolBlock";

function toolIcon(toolName: string): IconName {
	switch (toolName) {
		case "grep":
		case "find":
			return "search";
		case "read":
			return "file-code";
		case "edit":
		case "write":
			return "pencil";
		case "bash":
		case "powershell":
			return "terminal";
		case "subagent":
			return "bot";
		case "submit_plan":
		case "ask_user":
			return "list-checks";
		default:
			return "settings";
	}
}

function toolColor(toolName: string): string {
	switch (toolName) {
		case "grep":
		case "find":
			return "text-accent";
		case "read":
			return "text-fg";
		case "edit":
		case "write":
			return "text-warn";
		case "bash":
		case "powershell":
			return "text-primary";
		case "subagent":
			return "text-accent-strong";
		default:
			return "text-muted";
	}
}

/** 单个工具调用的树节点 */
const ToolStepNode = memo(function ToolStepNode({
	step,
	isLast,
	defaultExpanded = false,
}: {
	step: ToolExecutionStep;
	isLast: boolean;
	defaultExpanded?: boolean;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const call = step.toolCall;

	const cwd = useApp((s) => s.cwd);
	const argsText = useApp((s) => s.toolArgsText[call.id]);
	const run: ToolRun | undefined = useApp((s) => s.toolRuns[call.id]);
	const awaiting = useApp((s) => s.pendingApprovals.some((p) => p.toolCallId === call.id));
	const isRunning = useApp((s) => s.isRunning);

	const status = run?.status ?? (step.toolResult ? (step.toolResult.isError ? "error" : "done") : isRunning || step.live ? "running" : "done");
	const final = run?.result ?? step.toolResult;
	const diff = getDiff(final?.details);
	const output = textOf(final?.content) || (status === "running" ? partialTextOf(run?.partialResult) : "");
	const images = imagesOf(final?.content);
	const lines = output ? output.split("\n") : [];
	const summary = describe(call.name, call.arguments, cwd) || argsText || "";

	const hasOutput = lines.length > 0 || !!diff || images.length > 0;
	const icon = toolIcon(call.name);
	const color = toolColor(call.name);

	const added = diff ? diff.split("\n").filter((l: string) => l.startsWith("+")).length : 0;
	const removed = diff ? diff.split("\n").filter((l: string) => l.startsWith("-")).length : 0;
	const created = diff && (final?.details as { created?: unknown } | undefined)?.created === true;

	return (
		<div className="relative flex gap-3 text-[12.5px]">
			{/* 树干引导线 */}
			{!isLast && <div className="absolute top-5 bottom-0 left-[11px] w-[2px] bg-border/60" />}

			{/* 节点微图标 */}
			<div className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-panel-1">
				{status === "running" ? (
					<Spinner className="size-3 text-warn" />
				) : status === "error" ? (
					<span className="size-2 rounded-full bg-err" />
				) : awaiting ? (
					<span className="size-2 rounded-full bg-warn animate-pulse" />
				) : (
					<Icon name={icon} className={`size-3.5 ${color}`} />
				)}
			</div>

			{/* 步骤内容主体 */}
			<div className="min-w-0 flex-1 pb-3">
				<div
					onClick={() => hasOutput && setExpanded(!expanded)}
					onKeyDown={(e) => {
						if (hasOutput && (e.key === "Enter" || e.key === " ")) {
							e.preventDefault();
							setExpanded(!expanded);
						}
					}}
					tabIndex={hasOutput ? 0 : undefined}
					className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 -ml-1 transition-colors ${
						hasOutput ? "cursor-pointer hover:bg-panel-2/60 select-none" : ""
					}`}
				>
					<span className="font-mono font-medium text-fg">{call.name}</span>
					{summary && <span className="truncate font-mono text-muted max-w-[480px]" title={summary}>{summary}</span>}

					{/* 变更行数标记 */}
					{diff && (
						<span className="ml-1 text-[11px] font-mono">
							{created ? (
								<span className="rounded bg-ok-soft px-1 text-ok">新建</span>
							) : (
								<>
									<span className="text-ok">+{added}</span>
									<span className="text-err"> −{removed}</span>
								</>
							)}
						</span>
					)}

					{/* 等待确认 / 运行态 */}
					{awaiting && <span className="text-[11px] font-medium text-warn">等待确认…</span>}
					{status === "running" && !awaiting && <span className="text-[11px] text-muted">执行中…</span>}

					<div className="ml-auto flex items-center gap-2 text-faint text-[11px]">
						{run?.durationMs !== undefined && run.durationMs > 200 && (
							<span className="tabular-nums">{(run.durationMs / 1000).toFixed(1)}s</span>
						)}
						{hasOutput && (
							<span className="text-muted hover:text-fg">
								{expanded ? "▴" : "▾"}
							</span>
						)}
					</div>
				</div>

				{/* 展开的输出详情 */}
				{expanded && hasOutput && (
					<div className="mt-1.5 ml-1 rounded-lg border border-border/60 bg-pre-bg/60 p-2.5">
						{images.length > 0 && (
							<div className="mb-2 flex flex-wrap gap-2">
								{images.map((image: ImageAttachment, i: number) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: 消息图片按位置稳定
									<ImageThumb key={i} image={image} alt={`输出图片 ${i + 1}`} />
								))}
							</div>
						)}
						{diff && <DiffView diff={diff} />}
						{!diff && output && (
							<pre
								className={`max-h-80 overflow-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all ${
									status === "error" ? "text-err" : "text-fg/80"
								}`}
							>
								{lines.length > 80 ? `${lines.slice(0, 80).join("\n")}\n… (已截断显示剩余 ${lines.length - 80} 行)` : output}
							</pre>
						)}
					</div>
				)}
			</div>
		</div>
	);
});

/** 单个思考步骤的树节点 */
const ThinkingStepNode = memo(function ThinkingStepNode({
	step,
	isLast,
	defaultExpanded = false,
}: {
	step: ThinkingExecutionStep;
	isLast: boolean;
	defaultExpanded?: boolean;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const text = step.thinkingText ?? "";
	if (!text.trim()) return null;

	const chars = text.trim().length;

	return (
		<div className="relative flex gap-3 text-[12.5px]">
			{/* 树干引导线 */}
			{!isLast && <div className="absolute top-5 bottom-0 left-[11px] w-[2px] bg-border/60" />}

			{/* 节点微图标 */}
			<div className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-panel-1 text-accent">
				<Icon name="sparkles" className="size-3.5" />
			</div>

			<div className="min-w-0 flex-1 pb-3">
				<div
					onClick={() => setExpanded(!expanded)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							setExpanded(!expanded);
						}
					}}
					tabIndex={0}
					className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 -ml-1 select-none hover:bg-panel-2/60"
				>
					<span className="font-medium text-accent">深度思考</span>
					<span className="text-[11.5px] text-muted">{step.live ? "思考中…" : `${chars} 字`}</span>
					<div className="ml-auto text-faint text-[11px]">
						{expanded ? "▴" : "▾"}
					</div>
				</div>

				{(expanded || step.live) && (
					<div className="mt-1.5 ml-1 max-h-72 overflow-y-auto rounded-lg border border-border/50 bg-panel-2/40 p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted">
						{text}
					</div>
				)}
			</div>
		</div>
	);
});

export const ExecutionTree = memo(function ExecutionTree({
	group,
	folded,
	onOpenPanel,
}: {
	group: ExecutionTreeGroup;
	folded: boolean;
	onOpenPanel?: () => void;
}) {
	const [open, setOpen] = useState(!folded);
	const isRunning = useApp((s) => s.isRunning);

	useEffect(() => {
		setOpen(!folded);
	}, [folded]);

	const steps = group.steps;
	if (steps.length === 0) return null;

	const thinkingSteps = steps.filter((s): s is ThinkingExecutionStep => s.kind === "thinking");
	const toolSteps = steps.filter((s): s is ToolExecutionStep => s.kind === "tool");

	const totalThinkingChars = thinkingSteps.reduce((sum, s) => sum + (s.thinkingText?.trim().length ?? 0), 0);
	const toolNames = [...new Set(toolSteps.map((s) => s.toolCall?.name).filter(Boolean))];

	const isLive = group.live || (isRunning && steps.some((s) => s.live));

	const summaryItems: string[] = [];
	if (toolSteps.length > 0) {
		summaryItems.push(`${toolSteps.length} 个执行步骤（${toolNames.join("、")}）`);
	}
	if (totalThinkingChars > 0) {
		summaryItems.push(`思考 ${totalThinkingChars} 字`);
	}

	return (
		<div className="my-2 overflow-hidden rounded-xl border border-border/70 bg-panel-1/50 transition-all hover:border-border">
			{/* 头部摘要栏：去除了外挂圆点，精致的一体化胶囊卡片 */}
			<div
				onClick={() => setOpen(!open)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen(!open);
					}
				}}
				tabIndex={0}
				className="flex cursor-pointer items-center gap-2.5 px-3 py-2 select-none hover:bg-panel-2/60"
			>
				{/* 状态徽章 */}
				<div className="flex items-center gap-1.5">
					{isLive ? (
						<Spinner className="size-3.5 text-warn" />
					) : (
						<Icon name="list-tree" className="size-3.5 text-primary" />
					)}
					<span className="font-medium text-[12.5px] text-fg">
						{isLive ? "正在执行任务…" : "任务执行进度树"}
					</span>
				</div>

				<div className="truncate text-[12px] text-muted">
					{summaryItems.join(" · ")}
				</div>

				<div className="ml-auto flex items-center gap-2 text-faint text-[12px]">
					{onOpenPanel && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onOpenPanel();
							}}
							title="在右侧面板全屏查看执行树"
							className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
						>
							在侧栏查看
						</button>
					)}
					<span className="flex items-center gap-1 font-mono text-[11.5px] text-muted">
						{open ? "收起" : "展开"}
						<Icon name={open ? "chevron-up" : "chevron-down"} className="size-3" />
					</span>
				</div>
			</div>

			{/* 展开的树形时间线 */}
			{open && (
				<div className="border-t border-border/50 bg-panel-1/30 px-4 pt-3 pb-1">
					{steps.map((step: ExecutionStep, index: number) => {
						const isLast = index === steps.length - 1;
						if (step.kind === "thinking") {
							return <ThinkingStepNode key={step.id} step={step} isLast={isLast} />;
						}
						return <ToolStepNode key={step.id} step={step} isLast={isLast} />;
					})}
				</div>
			)}
		</div>
	);
});
