/**
 * 右侧面板：任务执行进度树全景面板（Execution Tree Panel）。
 * 提供整个会话中所有任务轮次的执行链路图、工具链调用流、耗时与详细输出。
 */
import { memo, useMemo, useState } from "react";
import type { ChatMessage, ImageAttachment } from "@shared/protocol";
import { buildTurns, turnChangedFiles, turnKey, type Turn } from "../../lib/session-turns";
import {
	buildTurnFlowBlocks,
	type ExecutionStep,
	type ToolResultMap,
} from "../../lib/session-flow";
import { describe, getDiff, imagesOf, textOf } from "../../lib/tool-format";
import { type ToolRun, useApp } from "../../store";
import { Icon, type IconName } from "../Icon";
import { Spinner } from "../terminal/Spinner";
import { ImageThumb } from "../terminal/ImageThumb";
import { DiffView } from "../terminal/ToolBlock";
import { formatMs } from "../terminal/ExecutionTree";

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

/** 快捷复制按钮 */
function CopyButton({ text, title = "复制" }: { text: string; title?: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = (e: React.MouseEvent) => {
		e.stopPropagation();
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};
	return (
		<button
			type="button"
			onClick={handleCopy}
			title={copied ? "已复制" : title}
			className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-fg transition-colors"
		>
			<Icon name={copied ? "check" : "copy"} className={`size-3 ${copied ? "text-ok" : ""}`} />
			{copied && <span className="text-[10px] text-ok">已复制</span>}
		</button>
	);
}

/** 单个步骤卡片 */
const DetailStepRow = memo(function DetailStepRow({
	step,
	index,
	total,
}: {
	step: ExecutionStep;
	index: number;
	total: number;
}) {
	const [expanded, setExpanded] = useState(false);
	const cwd = useApp((s) => s.cwd);
	const run: ToolRun | undefined = useApp((s) => (step.kind === "tool" ? s.toolRuns[step.toolCall.id] : undefined));
	const isRunning = useApp((s) => s.isRunning);
	const openPreview = useApp((s) => s.openPreview);

	if (step.kind === "thinking") {
		const text = step.thinkingText ?? "";
		return (
			<div className="relative pl-6 pb-4">
				{index < total - 1 && <div className="absolute top-4 bottom-0 left-2.5 w-[2px] bg-border/60" />}
				<div className="absolute top-0.5 left-0 z-10 flex size-5 items-center justify-center rounded-full border border-border/80 bg-panel-1 text-accent">
					<Icon name="sparkles" className="size-3" />
				</div>
				<div className="rounded-lg border border-border/60 bg-panel-1/60 p-2.5 text-[12px]">
					<div
						onClick={() => setExpanded(!expanded)}
						className="flex cursor-pointer items-center justify-between font-medium text-accent select-none"
					>
						<span>深度思考 ({text.trim().length} 字)</span>
						<div className="flex items-center gap-2">
							<CopyButton text={text} title="复制思考过程" />
							<span className="text-muted">{expanded ? "收起" : "查看思考"}</span>
						</div>
					</div>
					{expanded && (
						<div className="mt-2 max-h-60 overflow-y-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
							{text}
						</div>
					)}
				</div>
			</div>
		);
	}

	const call = step.toolCall;
	const status = run?.status ?? (step.toolResult ? (step.toolResult.isError ? "error" : "done") : isRunning || step.live ? "running" : "done");
	const final = run?.result ?? step.toolResult;
	const diff = getDiff(final?.details);
	const output = textOf(final?.content);
	const images = imagesOf(final?.content);
	const summary = describe(call.name, call.arguments, cwd);
	const icon = toolIcon(call.name);

	const filePath = typeof call.arguments.path === "string" ? call.arguments.path : typeof call.arguments.file_path === "string" ? call.arguments.file_path : undefined;

	return (
		<div className="relative pl-6 pb-4">
			{index < total - 1 && <div className="absolute top-4 bottom-0 left-2.5 w-[2px] bg-border/60" />}
			<div className="absolute top-0.5 left-0 z-10 flex size-5 items-center justify-center rounded-full border border-border/80 bg-panel-1">
				{status === "running" ? (
					<Spinner className="size-2.5 text-warn" />
				) : status === "error" ? (
					<span className="size-1.5 rounded-full bg-err" />
				) : (
					<Icon name={icon} className="size-3 text-primary" />
				)}
			</div>
			<div className="rounded-lg border border-border/60 bg-panel-1/60 p-2.5 text-[12px]">
				<div
					onClick={() => setExpanded(!expanded)}
					className="flex cursor-pointer items-center justify-between select-none"
				>
					<div className="flex items-center gap-1.5 truncate">
						<span className="font-mono font-medium text-fg">{call.name}</span>
						{summary && <span className="truncate font-mono text-muted max-w-[180px]" title={summary}>{summary}</span>}
					</div>
					<div className="flex items-center gap-2 text-faint text-[11px]">
						{filePath && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									openPreview(filePath);
								}}
								className="text-primary hover:underline"
							>
								预览
							</button>
						)}
						{run?.durationMs !== undefined && run.durationMs > 20 && (
							<span className="tabular-nums font-mono">{formatMs(run.durationMs)}</span>
						)}
						<span className="text-muted">{expanded ? "收起" : "详情"}</span>
					</div>
				</div>

				{expanded && (
					<div className="mt-2 space-y-2 pt-2 border-t border-border/50">
						<div>
							<div className="flex items-center justify-between text-[11px] font-medium text-muted">
								<span>调用参数：</span>
								<CopyButton text={JSON.stringify(call.arguments, null, 2)} title="复制参数" />
							</div>
							<pre className="mt-1 max-h-36 overflow-auto rounded bg-pre-bg/70 p-2 font-mono text-[11px] text-fg/80">
								{JSON.stringify(call.arguments, null, 2)}
							</pre>
						</div>
						{images.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{images.map((img: ImageAttachment, i: number) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: 图片稳定
									<ImageThumb key={i} image={img} alt="输出图片" />
								))}
							</div>
						)}
						{diff && <DiffView diff={diff} />}
						{!diff && output && (
							<div>
								<div className="flex items-center justify-between text-[11px] font-medium text-muted">
									<span>执行输出：</span>
									<CopyButton text={output} title="复制输出" />
								</div>
								<pre className="mt-1 max-h-48 overflow-auto rounded bg-pre-bg/70 p-2 font-mono text-[11px] text-fg/80 whitespace-pre-wrap break-all">
									{output}
								</pre>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
});

/** 单轮任务执行树卡片 */
function TurnExecutionCard({
	turn,
	index,
	toolResults,
	streaming,
	isLive,
}: {
	turn: Turn;
	index: number;
	toolResults: ToolResultMap;
	streaming: Extract<ChatMessage, { role: "assistant" }> | null;
	isLive: boolean;
}) {
	const cwd = useApp((s) => s.cwd);
	const [open, setOpen] = useState(true);

	const blocks = useMemo(
		() => buildTurnFlowBlocks(turn.messages, toolResults, isLive ? streaming : null),
		[turn.messages, toolResults, isLive, streaming],
	);

	const execBlocks = blocks.filter((b): b is Extract<typeof b, { type: "execution" }> => b.type === "execution");
	const allSteps = execBlocks.flatMap((b) => b.group.steps);
	const changedFiles = useMemo(() => turnChangedFiles(turn, cwd), [turn, cwd]);

	const userText = turn.user.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();

	if (allSteps.length === 0) {
		return null;
	}

	return (
		<div className="overflow-hidden rounded-xl border border-border/70 bg-panel-1/40">
			{/* 轮次头部 */}
			<div
				onClick={() => setOpen(!open)}
				className="flex cursor-pointer items-center justify-between bg-panel-2/50 px-3.5 py-2.5 select-none hover:bg-panel-2/70"
			>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[11px] font-semibold text-primary">
							{index + 1}
						</span>
						<span className="truncate text-[12.5px] font-medium text-fg" title={userText}>
							{userText || "未命名任务"}
						</span>
					</div>
					<div className="mt-0.5 text-[11px] text-muted pl-7">
						共 {allSteps.length} 个执行步骤
						{changedFiles.length > 0 && ` · 修改了 ${changedFiles.length} 个文件`}
					</div>
				</div>
				<div className="flex items-center gap-1.5 text-muted text-[11.5px]">
					{isLive && <Spinner className="size-3 text-warn" />}
					<Icon name={open ? "chevron-up" : "chevron-down"} className="size-3.5" />
				</div>
			</div>

			{/* 执行步骤树 */}
			{open && (
				<div className="p-3.5 pt-4">
					{allSteps.map((step, sIdx) => (
						<DetailStepRow
							key={step.id}
							step={step}
							index={sIdx}
							total={allSteps.length}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function ExecutionTreePanel() {
	const messages = useApp((s) => s.messages);
	const streaming = useApp((s) => s.streaming);
	const isRunning = useApp((s) => s.isRunning);

	const turns = useMemo(() => buildTurns(messages), [messages]);
	const toolResults: ToolResultMap = useMemo(() => {
		const map: ToolResultMap = new Map();
		for (const m of messages) {
			if (m.role === "toolResult") {
				map.set(m.toolCallId, { content: m.content, details: m.details, isError: m.isError });
			}
		}
		return map;
	}, [messages]);

	const lastTurnIndex = turns.length - 1;

	// 统计数据
	const totalToolCalls = useMemo(() => {
		let count = 0;
		for (const m of messages) {
			if (m.role === "assistant") {
				for (const b of m.content) {
					if (b.type === "toolCall") count++;
				}
			}
		}
		return count;
	}, [messages]);

	return (
		<div className="flex h-full flex-col overflow-hidden bg-bg">
			{/* 顶部概览栏 */}
			<div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 bg-panel-1/30">
				<div>
					<div className="flex items-center gap-2">
						<Icon name="list-tree" className="size-4 text-primary" />
						<h2 className="text-[13px] font-semibold text-fg">任务执行进度树</h2>
						{isRunning && (
							<span className="flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
								<Spinner className="size-2.5" />
								执行中
							</span>
						)}
					</div>
					<div className="mt-1 text-[11.5px] text-muted">
						已完成 {turns.length} 轮对话 · 累计调用 {totalToolCalls} 次工具
					</div>
				</div>
			</div>

			{/* 执行树内容区 */}
			<div className="flex-1 overflow-y-auto p-4 space-y-4">
				{turns.length === 0 ? (
					<div className="flex h-48 flex-col items-center justify-center text-center text-muted">
						<Icon name="list-tree" className="size-8 text-faint mb-2" />
						<p className="text-[13px]">暂无执行中的任务</p>
						<p className="mt-1 text-[11.5px] text-faint">在会话中输入任务后，工具链与执行进度将在此实时展示</p>
					</div>
				) : (
					turns.map((turn, index) => {
						const isLast = index === lastTurnIndex;
						const isLive = isLast && (isRunning || !!streaming);
						return (
							<TurnExecutionCard
								key={turnKey(turn)}
								turn={turn}
								index={index}
								toolResults={toolResults}
								streaming={streaming}
								isLive={isLive}
							/>
						);
					})
				)}
			</div>
		</div>
	);
}
