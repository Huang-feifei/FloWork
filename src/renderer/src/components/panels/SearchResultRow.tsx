import { matchPositions } from "../../lib/useFileSearch";

/** 搜索结果一行：文件名在前，目录在后，匹配字符加粗 */
export function SearchResultLabel({ path, query }: { path: string; query: string }) {
	const hits = matchPositions(path, query);
	const baseStart = path.lastIndexOf("/") + 1;
	const render = (from: number, to: number) =>
		[...path.slice(from, to)].map((ch, i) => {
			const idx = from + i;
			return hits.has(idx) ? (
				<span key={idx} className="font-bold text-accent">
					{ch}
				</span>
			) : (
				<span key={idx}>{ch}</span>
			);
		});
	return (
		<span className="min-w-0 truncate">
			{render(baseStart, path.length)}
			{baseStart > 0 && <span className="ml-2 text-[11px] text-muted">{render(0, baseStart - 1)}</span>}
		</span>
	);
}
