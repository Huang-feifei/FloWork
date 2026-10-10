/**
 * 终端风格的工具调用：
 *   ● bash(ls -la)
 *     ⎿  输出前几行
 *        … 还有 N 行（点击展开）
 */
import { useState } from "react";
import type { ContentBlock } from "@shared/protocol";
import type { ToolRun } from "../../store";
import { Spinner } from "./Spinner";

interface Props {
	call: Extract<ContentBlock, { type: "toolCall" }>;
	cwd: string | null;
	argsText?: string;
	run?: ToolRun;
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
		default: {
			const json = JSON.stringify(args);
			return json.length > 100 ? `${json.slice(0, 100)}…` : json;
		}
	}
}

function textOf(content: ContentBlock[] | undefined): string {
	return (content ?? [])
		.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[图片]" : ""))
		.join("\n")
		.replace(/\s+$/, "");
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
		<div className="mt-0.5 overflow-x-auto rounded border border-border bg-panel">
			{lines.map((line, i) => {
				const kind = line[0];
				const cls =
					kind === "+" ? "bg-diff-add text-[#1e5e33]" : kind === "-" ? "bg-diff-del text-[#8f2a1d]" : "text-muted";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: diff 行没有稳定 id
					<div key={i} className={`px-2 whitespace-pre ${cls}`}>
						{line || " "}
					</div>
				);
			})}
		</div>
	);
}

export function ToolBlock({ call, cwd, argsText, run, result }: Props) {
	const [expanded, setExpanded] = useState(false);
	const status = run?.status ?? (result ? (result.isError ? "error" : "done") : "pending");
	const final = run?.result ?? result;
	const diff = getDiff(final?.details);
	const output = textOf(final?.content);
	const lines = output ? output.split("\n") : [];
	const summary = describe(call.name, call.arguments, cwd) || argsText || "";

	let resultLine: React.ReactNode = null;
	if (status === "pending" || status === "running") {
		resultLine = <span className="text-muted">{status === "running" ? "执行中…" : "等待执行…"}</span>;
	} else if (diff) {
		const added = diff.split("\n").filter((l) => l.startsWith("+")).length;
		const removed = diff.split("\n").filter((l) => l.startsWith("-")).length;
		resultLine = (
			<span>
				已修改 <span className="text-ok">+{added}</span> <span className="text-err">−{removed}</span>
			</span>
		);
	} else if (call.name === "read" && status === "done") {
		resultLine = <span className="text-muted">读取了 {lines.length} 行</span>;
	} else if (!output) {
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
		) : (
			<span className="text-ok">●</span>
		);

	return (
		<div className="grid grid-cols-[2ch_1fr] gap-x-1">
			<div>{bullet}</div>
			<div className="min-w-0">
				<div className="truncate" title={summary}>
					<span className="font-bold">{call.name}</span>
					<span className="text-muted">(</span>
					<span>{summary}</span>
					<span className="text-muted">)</span>
					{run?.durationMs !== undefined && run.durationMs > 1000 && (
						<span className="ml-2 text-muted">{(run.durationMs / 1000).toFixed(1)}s</span>
					)}
				</div>
				<div className="grid grid-cols-[3ch_1fr]">
					<span className="text-muted">⎿</span>
					<div className="min-w-0">
						{resultLine}
						{diff && <DiffView diff={diff} />}
						{!diff && output && !(call.name === "read" && !expanded) && (
							<pre
								className={`overflow-x-auto font-mono whitespace-pre-wrap break-all ${
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
								className={`text-muted underline decoration-dotted underline-offset-2 hover:text-accent ${call.name === "read" && !expanded ? "ml-3" : "block"}`}
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
}
