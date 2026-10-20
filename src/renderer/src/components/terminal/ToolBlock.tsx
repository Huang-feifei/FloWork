/**
 * 终端风格的工具调用：
 *   ● bash(ls -la)
 *     ⎿  输出前几行
 *        … 还有 N 行（点击展开）
 */
import { memo, useState } from "react";
import type { ContentBlock, ImageAttachment } from "@shared/protocol";
import { type ToolRun, useApp } from "../../store";
import { ImageThumb } from "./ImageThumb";
import { Spinner } from "./Spinner";

interface Props {
	call: Extract<ContentBlock, { type: "toolCall" }>;
	result?: { content: ContentBlock[]; details?: unknown; isError: boolean };
}

const PREVIEW_LINES = 5;

function shortPath(path: string, cwd: string | null): string {
	if (!cwd) return path;
	const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");
	const base = norm(cwd);
	const target = norm(path);
	return target.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? target.slice(base.length + 1) : path;
}

function describe(name: string, args: Record<string, unknown>, cwd: string | null): string {
	const s = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	switch (name) {
		case "bash":
		case "powershell":
			return s("command") ?? "";
		case "read":
		case "write":
		case "edit": {
			const path = s("path") ?? s("file_path") ?? "";
			return shortPath(path, cwd);
		}
		case "grep":
		case "find":
			return [s("pattern"), s("path") ? shortPath(s("path") as string, cwd) : undefined].filter(Boolean).join(", ");
		case "ls":
			return shortPath(s("path") ?? ".", cwd);
		case "subagent": {
			const agent = s("agent");
			if (agent) {
				const task = s("task") ?? "";
				return task ? `${agent} · ${task.length > 60 ? `${task.slice(0, 60)}…` : task}` : agent;
			}
			const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
			if (tasks > 0) return `parallel · ${tasks} 个任务`;
			const chain = Array.isArray(args.chain) ? args.chain.length : 0;
			if (chain > 0) return `chain · ${chain} 步`;
			return "";
		}
		default: {
			const json = JSON.stringify(args);
			return json.length > 100 ? `${json.slice(0, 100)}…` : json;
		}
	}
}

function textOf(content: ContentBlock[] | undefined): string {
	return (content ?? [])
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("\n")
		.replace(/\s+$/, "");
}

/** 工具执行中的增量结果（例如子代理的实时输出），复用同一套 ContentBlock 结构。 */
function partialTextOf(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content) ? textOf(content as ContentBlock[]) : "";
}

/** 工具结果里的图片（例如 read 读了一张图），单独渲染为缩略图 */
function imagesOf(content: ContentBlock[] | undefined): ImageAttachment[] {
	return (content ?? []).filter((b): b is ImageAttachment => b.type === "image");
}

function getDiff(details: unknown): string | undefined {
	if (details && typeof details === "object" && "diff" in details) {
		const diff = (details as { diff: unknown }).diff;
		return typeof diff === "string" && diff.length > 0 ? diff : undefined;
	}
	return undefined;
}

function DiffView({ diff }: { diff: string }) {
	const lines = diff.split("\n");
	return (
		<div className="mt-2 overflow-x-auto rounded-xl border border-border bg-pre-bg py-1">
			{lines.map((line, i) => {
				const kind = line[0];
				const cls =
					kind === "+" ? "bg-diff-add text-diff-add-fg" : kind === "-" ? "bg-diff-del text-diff-del-fg" : "text-muted";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff 行没有稳定 id
					<div key={i} className={`px-3 font-mono text-[12.5px] leading-[1.7] whitespace-pre ${cls}`}>
						{line || " "}
					</div>
				);
			})}
		</div>
	);
}

/**
 * 单个工具调用。
 * 自己订阅 store 里按 id 切出的运行状态（而不是让整个会话记录订阅 toolRuns），
 * 这样流式输出时只有真正变化的那一个工具块重渲染，配合 memo 让历史消息完全不动。
 */
export const ToolBlock = memo(function ToolBlock({ call, result }: Props) {
	const [expanded, setExpanded] = useState(false);
	const cwd = useApp((s) => s.cwd);
	const argsText = useApp((s) => s.toolArgsText[call.id]);
	const run: ToolRun | undefined = useApp((s) => s.toolRuns[call.id]);
	const awaiting = useApp((s) => s.pendingApprovals.some((p) => p.toolCallId === call.id));
	const isRunning = useApp((s) => s.isRunning);
	const status = run?.status ?? (result ? (result.isError ? "error" : "done") : isRunning ? "pending" : "skipped");
	const final = run?.result ?? result;
	const diff = getDiff(final?.details);
	const output = textOf(final?.content) || (status === "running" ? partialTextOf(run?.partialResult) : "");
	const images = imagesOf(final?.content);
	const lines = output ? output.split("\n") : [];
	const summary = describe(call.name, call.arguments, cwd) || argsText || "";

	let resultLine: React.ReactNode = null;
	if (awaiting) {
		resultLine = <span className="text-warn">等待你的确认…</span>;
	} else if (status === "pending" || status === "running") {
		resultLine = <span className="text-muted">{status === "running" ? "执行中…" : "等待执行…"}</span>;
	} else if (status === "skipped") {
		resultLine = <span className="text-muted">未执行</span>;
	} else if (diff) {
		const created = (final?.details as { created?: unknown } | undefined)?.created === true;
		const added = diff.split("\n").filter((l) => l.startsWith("+")).length;
		const removed = diff.split("\n").filter((l) => l.startsWith("-")).length;
		resultLine = (
			<span>
				{created ? "新建文件" : "已修改"} <span className="text-ok">+{added}</span>
				{!created && <span className="text-err"> −{removed}</span>}
			</span>
		);
	} else if (call.name === "read" && status === "done") {
		resultLine = (
			<span className="text-muted">
				{images.length > 0 ? `读取了 ${images.length} 张图片` : `读取了 ${lines.length} 行`}
			</span>
		);
	} else if (!output && images.length === 0) {
		resultLine = <span className="text-muted">{status === "error" ? "失败" : "完成，无输出"}</span>;
	}

	const showFull = expanded || lines.length <= PREVIEW_LINES;
	const visibleOutput = showFull ? lines : lines.slice(0, PREVIEW_LINES);
	const collapsible = (call.name === "read" && lines.length > 0) || lines.length > PREVIEW_LINES;

	const bullet =
		status === "running" || status === "pending" ? (
			<Spinner className="text-warn" />
		) : status === "error" ? (
			<span className="text-err">●</span>
		) : status === "skipped" ? (
			<span className="text-muted">○</span>
		) : (
			<span className="text-ok">●</span>
		);

	return (
		<div className="grid grid-cols-[2ch_1fr] gap-x-2">
			<div>{bullet}</div>
			<div className="min-w-0">
				<div className="truncate font-mono text-[12.5px]" title={summary}>
					<span className="font-medium text-fg">{call.name}</span>
					<span className="text-muted">({summary})</span>
					{run?.durationMs !== undefined && run.durationMs > 1000 && (
						<span className="ml-2 tabular-nums text-faint">{(run.durationMs / 1000).toFixed(1)}s</span>
					)}
				</div>
				<div className="grid grid-cols-[3ch_1fr]">
					<span className="text-faint">⎿</span>
					<div className="min-w-0">
						{resultLine}
						{images.length > 0 && (
							<div className="mt-1 flex flex-wrap gap-2">
								{images.map((image, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: 工具结果内容块按位置稳定，没有独立 id
									<ImageThumb key={i} image={image} alt={`工具结果图片 ${i + 1}`} />
								))}
							</div>
						)}
						{diff && <DiffView diff={diff} />}
						{!diff && output && !(call.name === "read" && !expanded) && (
							<pre
								className={`mt-1 overflow-x-auto font-mono text-[12.5px] leading-[1.7] whitespace-pre-wrap break-all ${
									status === "error" ? "text-err" : "text-fg/80"
								}`}
							>
								{visibleOutput.join("\n")}
							</pre>
						)}
						{collapsible && (
							<button
								type="button"
								onClick={() => setExpanded(!expanded)}
								className={`text-[12.5px] text-primary hover:underline ${call.name === "read" && !expanded ? "ml-3" : "block"}`}
							>
								{expanded
									? "收起"
									: call.name === "read"
										? "展开内容"
										: `… 还有 ${lines.length - PREVIEW_LINES} 行（点击展开）`}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
});
