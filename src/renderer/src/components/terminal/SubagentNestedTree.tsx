/**
 * Subagent（子代理）嵌套执行树视图：
 * 在执行树中为 subagent 工具调用提供专用的嵌套子任务大纲。
 *
 * 支持 single、parallel 并行与 chain 串行链路的层级下钻：
 * - 展示每个子代理的名称、工作模式、派发任务（Task）、调用模型与 Token 用量；
 * - 实时展示子代理内部执行的工具调用链路（Sub-tool Trace）；
 * - 提供每个子代理最终输出的独立折叠/展开与一键复制。
 */
import { memo, useState } from "react";
import type { SubagentDetails, SubagentResult, SubagentToolCall } from "@shared/protocol";
import { Icon, type IconName } from "../Icon";
import { Spinner } from "./Spinner";
import { formatMs } from "./ExecutionTree";

function subtoolIcon(name: string): IconName {
	switch (name) {
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

/** 单个子代理任务卡片 */
const SubagentCard = memo(function SubagentCard({
	result,
	index,
	total,
	defaultExpanded = true,
}: {
	result: SubagentResult;
	index: number;
	total: number;
	defaultExpanded?: boolean;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const isFailed = Boolean(result.error);
	const toolCalls = result.toolCalls ?? [];

	return (
		<div className="rounded-xl border border-border/70 bg-panel-2/40 overflow-hidden text-[12px]">
			{/* 子代理任务头部 */}
			<div
				onClick={() => setExpanded(!expanded)}
				className="flex cursor-pointer items-center justify-between px-3 py-2 bg-panel-2/60 select-none hover:bg-panel-2/80 transition-colors"
			>
				<div className="flex min-w-0 items-center gap-2">
					<span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent font-mono text-[11px] font-semibold">
						{result.step ? `#${result.step}` : total > 1 ? `#${index + 1}` : "🤖"}
					</span>
					<span className="font-mono font-semibold text-fg">
						[{result.agent}]
					</span>
					<span className="truncate text-muted max-w-[320px]" title={result.task}>
						{result.task}
					</span>
				</div>

				<div className="flex items-center gap-2 text-faint text-[11px]">
					{result.model && (
						<span className="hidden sm:inline font-mono text-[10.5px] text-muted">
							{result.model.split("/").pop()}
						</span>
					)}
					{isFailed ? (
						<span className="text-err font-medium">失败</span>
					) : (
						<span className="text-ok font-medium">完成</span>
					)}
					<span className="text-muted">{expanded ? "▴" : "▾"}</span>
				</div>
			</div>

			{/* 展开的子代理详情 */}
			{expanded && (
				<div className="p-3 space-y-2.5 border-t border-border/50">
					{/* 子代理内部调用的工具链时间线 */}
					{toolCalls.length > 0 && (
						<div>
							<div className="mb-1 text-[11px] font-medium text-muted">
								子代理工具执行流（共 {toolCalls.length} 步）：
							</div>
							<div className="space-y-1 pl-2 border-l-2 border-border/70">
								{toolCalls.map((tc: SubagentToolCall, tcIdx: number) => {
									const icon = subtoolIcon(tc.name);
									return (
										<div key={tcIdx} className="flex items-center gap-2 py-0.5 text-[11.5px]">
											{tc.status === "running" ? (
												<Spinner className="size-3 text-warn shrink-0" />
											) : tc.status === "error" ? (
												<span className="size-1.5 rounded-full bg-err shrink-0" />
											) : (
												<Icon name={icon} className="size-3 text-primary shrink-0" />
											)}
											<span className="font-mono text-fg font-medium">{tc.name}</span>
											<span className="truncate font-mono text-muted max-w-[340px]" title={tc.argsSummary}>
												{tc.argsSummary}
											</span>
											{tc.durationMs !== undefined && tc.durationMs > 20 && (
												<span className="ml-auto font-mono text-faint text-[10.5px]">
													{formatMs(tc.durationMs)}
												</span>
											)}
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* 失败错误信息 */}
					{result.error && (
						<div className="rounded-lg bg-err-soft/50 p-2 text-err font-mono text-[11.5px] leading-relaxed">
							{result.error}
						</div>
					)}

					{/* 最终输出内容 */}
					{result.output && (
						<div>
							<div className="flex items-center justify-between text-[11px] font-medium text-muted mb-1">
								<span>执行结论 / 产出：</span>
								<CopyButton text={result.output} title="复制子任务输出" />
							</div>
							<pre className="max-h-56 overflow-auto rounded-lg bg-pre-bg/70 p-2.5 font-mono text-[11.5px] leading-relaxed text-fg/85 whitespace-pre-wrap break-all">
								{result.output}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
});

export const SubagentNestedTree = memo(function SubagentNestedTree({
	details,
}: {
	details: SubagentDetails;
}) {
	const results = details.results ?? [];
	if (results.length === 0) return null;

	const modeLabel = details.mode === "parallel" ? "并行" : details.mode === "chain" ? "链式串行" : "单一";

	return (
		<div className="my-2 space-y-2">
			{/* 模式与进度栏 */}
			<div className="flex items-center justify-between text-[11.5px] text-muted">
				<div className="flex items-center gap-1.5 font-medium text-accent">
					<Icon name="bot" className="size-3.5" />
					<span>子任务层级流 ({modeLabel} · 共 {results.length} 个任务)</span>
				</div>
			</div>

			{/* 子任务列表 */}
			<div className="space-y-2">
				{results.map((res: SubagentResult, idx: number) => (
					<SubagentCard
						key={`${res.agent}-${idx}`}
						result={res}
						index={idx}
						total={results.length}
					/>
				))}
			</div>
		</div>
	);
});
