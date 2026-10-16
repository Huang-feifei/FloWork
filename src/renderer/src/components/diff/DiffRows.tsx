/**
 * diff 渲染：把 pi 生成的 unified diff 文本拆成带行号的行，供会话记录与「审查本会话的修改」共用。
 * 兼容 pi 的 generateDiffString 输出（@@ -old,len +new,len @@ 形式的 hunk）。
 */
import { useMemo } from "react";

export interface DiffRow {
	/** 旧文件行号（新增行为空） */
	o?: number;
	/** 新文件行号（删除行为空） */
	n?: number;
	t: "ctx" | "add" | "del" | "hunk";
	s: string;
}

export function parseDiffRows(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	let seenHunk = false;

	for (const line of diff.split("\n")) {
		const head = line.slice(0, 1);
		if (line.startsWith("@@")) {
			const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (m) {
				oldNo = Number(m[1]);
				newNo = Number(m[2]);
			}
			seenHunk = true;
			rows.push({ t: "hunk", s: line });
			continue;
		}
		// 文件头（--- a/x、+++ b/x）出现在第一个 hunk 之前时跳过
		if (!seenHunk && (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff "))) continue;
		if (head === "+") rows.push({ n: newNo++, t: "add", s: line.slice(1) });
		else if (head === "-") rows.push({ o: oldNo++, t: "del", s: line.slice(1) });
		else if (head === "\\") rows.push({ t: "ctx", s: line });
		else rows.push({ o: oldNo++, n: newNo++, t: "ctx", s: line.slice(1) });
	}
	return rows;
}

/** 每行一个数据块；双列（旧行号 + 新行号）用于审查页，单列用于会话记录 */
export function DiffRows({ diff, twoColumns }: { diff: string; twoColumns?: boolean }) {
	const rows = useMemo(() => parseDiffRows(diff), [diff]);
	const cols = twoColumns ? "grid-cols-[3.25rem_3.25rem_1.5rem_1fr]" : "grid-cols-[3.25rem_1.5rem_1fr]";

	return (
		<>
			{rows.map((r, i) =>
				r.t === "hunk" ? (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: diff 行没有稳定 id
						key={i}
						className="bg-panel-2 px-4 py-0.5 font-mono text-[12.5px] leading-[1.7] text-muted"
					>
						{r.s}
					</div>
				) : (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: diff 行没有稳定 id
						key={i}
						className={`grid ${cols} font-mono text-[12.5px] leading-[1.7] ${
							r.t === "add" ? "bg-diff-add text-diff-add-fg" : r.t === "del" ? "bg-diff-del text-diff-del-fg" : "text-fg/80"
						}`}
					>
						<span className="pr-3 text-right text-faint tabular-nums">{twoColumns ? (r.o ?? "") : (r.n ?? r.o ?? "")}</span>
						{twoColumns && <span className="pr-3 text-right text-faint tabular-nums">{r.n ?? ""}</span>}
						<span className="pr-1 text-center">{r.t === "add" ? "+" : r.t === "del" ? "-" : ""}</span>
						<span className="whitespace-pre">{r.s}</span>
					</div>
				),
			)}
		</>
	);
}
