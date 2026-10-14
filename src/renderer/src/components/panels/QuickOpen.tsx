/** Ctrl+P 快速打开文件：全项目模糊搜索，↑↓ 选择，Enter 打开预览 */
import { useEffect, useRef, useState } from "react";
import { useFileSearch } from "../../lib/useFileSearch";
import { useBrowserOcclusion } from "../../lib/browser";
import { useApp } from "../../store";
import { SearchResultLabel } from "./SearchResultRow";

export function QuickOpen() {
	const open = useApp((s) => s.quickOpen);
	useBrowserOcclusion(open);
	const setOpen = useApp((s) => s.setQuickOpen);
	const openPreview = useApp((s) => s.openPreview);
	const insertIntoPrompt = useApp((s) => s.insertIntoPrompt);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const { result, loading } = useFileSearch(open ? query : "", 50);
	const matches = result?.matches ?? [];

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "p") {
				e.preventDefault();
				setOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [setOpen]);

	// 每次打开都从空白搜索开始
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActive(0);
	}, [open]);

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	useEffect(() => setActive(0), [query]);

	if (!open) return null;

	const choose = (path: string, insert: boolean) => {
		setOpen(false);
		if (insert) insertIntoPrompt(path);
		else openPreview(path);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 点击遮罩关闭
		<div className="fixed inset-0 z-50 flex justify-center bg-scrim pt-[12vh]" onMouseDown={() => setOpen(false)}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: 阻止冒泡到遮罩 */}
			<div
				className="fw-float flex h-fit max-h-[60vh] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border-strong"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<input
					ref={inputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.stopPropagation();
							setOpen(false);
						} else if (e.key === "ArrowDown") {
							e.preventDefault();
							setActive((a) => Math.min(a + 1, matches.length - 1));
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							setActive((a) => Math.max(a - 1, 0));
						} else if (e.key === "Enter" && matches[active]) {
							e.preventDefault();
							choose(matches[active].path, e.altKey);
						}
					}}
					placeholder="搜索项目文件（模糊匹配，例如 sesshost → session-host.ts）"
					className="border-b border-border px-4 py-3 text-[14px] outline-none placeholder:text-muted/70"
				/>
				<div className="term min-h-0 flex-1 overflow-y-auto py-1 text-[12.5px] leading-6">
					{!query.trim() && <div className="px-4 py-2 text-muted">输入文件名的一部分</div>}
					{query.trim() && !loading && matches.length === 0 && <div className="px-4 py-2 text-muted">没有匹配的文件</div>}
					{matches.map((m, i) => (
						<button
							type="button"
							key={m.path}
							onMouseEnter={() => setActive(i)}
							onClick={() => choose(m.path, false)}
							className={`flex w-full items-center px-4 text-left ${i === active ? "bg-accent-soft" : ""}`}
						>
							<SearchResultLabel path={m.path} query={query} />
						</button>
					))}
				</div>
				<div className="flex gap-4 border-t border-border px-4 py-1.5 text-[11px] text-muted">
					<span>↑↓ 选择</span>
					<span>Enter 打开</span>
					<span>Alt+Enter 引用到输入框</span>
					<span>Esc 关闭</span>
					<div className="flex-1" />
					{result && (
						<span>
							共 {result.total} 个文件{result.truncated ? "（文件过多，只索引了一部分）" : ""}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}
