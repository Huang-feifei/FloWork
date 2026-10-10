/** 文件预览：覆盖在终端窗口上方，显示文件内容与本会话对它的修改 */
import { useEffect, useMemo, useState } from "react";
import type { FilePreview as Preview } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { collectSessionFiles } from "../../lib/session-files";
import { useApp } from "../../store";

function DiffBlock({ diff }: { diff: string }) {
	return (
		<div className="overflow-x-auto rounded border border-border bg-panel">
			{diff.split("\n").map((line, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: diff 行没有稳定 id
					key={i}
					className={`px-2 whitespace-pre ${
						line[0] === "+" ? "bg-diff-add text-[#1e5e33]" : line[0] === "-" ? "bg-diff-del text-[#8f2a1d]" : "text-muted"
					}`}
				>
					{line || " "}
				</div>
			))}
		</div>
	);
}

export function FilePreview() {
	const path = useApp((s) => s.preview);
	const cwd = useApp((s) => s.cwd);
	const messages = useApp((s) => s.messages);
	const filesVersion = useApp((s) => s.filesVersion);
	const { openPreview, insertIntoPrompt, pushNotice } = useApp.getState();
	const [file, setFile] = useState<Preview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<"content" | "changes">("content");

	const changes = useMemo(() => {
		if (!path) return [];
		const f = collectSessionFiles(messages, cwd).find((x) => x.path.toLowerCase() === path.toLowerCase());
		return (f?.changes ?? []).filter((c) => !c.isError);
	}, [messages, cwd, path]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: filesVersion 只用于触发刷新
	useEffect(() => {
		if (!path || !cwd) return;
		let cancelled = false;
		setError(null);
		api.readWorkspaceFile(cwd, path).then(
			(f) => !cancelled && setFile(f),
			(e: unknown) => !cancelled && (setFile(null), setError(errorText(e))),
		);
		return () => {
			cancelled = true;
		};
	}, [path, cwd, filesVersion]);

	useEffect(() => setTab("content"), [path]);

	useEffect(() => {
		if (!path) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopImmediatePropagation();
				openPreview(null);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [path, openPreview]);

	if (!path) return null;
	const lines = file && !file.binary ? file.text.split("\n") : [];
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	const gutter = String(lines.length).length;

	return (
		<div className="absolute inset-x-0 top-9 bottom-0 z-20 flex flex-col bg-term">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-term-bar px-3 text-xs">
				<span className="min-w-0 truncate font-mono font-medium" title={file?.absolutePath ?? path}>
					{path}
				</span>
				{file && (
					<span className="shrink-0 text-muted">
						{lines.length} 行 · {(file.size / 1024).toFixed(1)} KB
					</span>
				)}
				<div className="flex-1" />
				{changes.length > 0 && (
					<div className="flex shrink-0 rounded border border-border">
						{(["content", "changes"] as const).map((t) => (
							<button
								type="button"
								key={t}
								onClick={() => setTab(t)}
								className={`px-2 py-0.5 ${tab === t ? "bg-panel font-medium text-fg" : "text-muted hover:text-fg"}`}
							>
								{t === "content" ? "内容" : `本会话的修改（${changes.length}）`}
							</button>
						))}
					</div>
				)}
				<button type="button" onClick={() => insertIntoPrompt(path)} className="rounded px-1.5 text-accent hover:bg-accent-soft">
					引用
				</button>
				<button
					type="button"
					onClick={() =>
						void navigator.clipboard
							.writeText(file?.absolutePath ?? path)
							.then(() => pushNotice("info", "已复制路径"))
					}
					className="rounded px-1.5 text-muted hover:bg-panel-2 hover:text-fg"
				>
					复制路径
				</button>
				<button type="button" onClick={() => openPreview(null)} title="关闭（Esc）" className="px-1 text-muted hover:text-fg">
					✕
				</button>
			</div>
			<div className="term min-h-0 flex-1 overflow-auto text-[12.5px] leading-5">
				{error && <div className="p-4 text-err">{error}</div>}
				{!file && !error && <div className="p-4 text-muted">读取中…</div>}
				{file && tab === "content" && (
					<>
						{file.binary ? (
							<div className="p-4 text-muted">二进制文件，不显示内容。</div>
						) : (
							<table className="w-full border-collapse">
								<tbody>
									{lines.map((line, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: 行号即 key
										<tr key={i} className="hover:bg-panel-2/60">
											<td
												className="sticky left-0 border-r border-border bg-term pr-3 pl-3 text-right align-top text-muted/70 select-none"
												style={{ width: `${gutter + 3}ch` }}
											>
												{i + 1}
											</td>
											<td className="pr-4 pl-3 whitespace-pre">{line || " "}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
						{file.truncated && <div className="p-3 text-warn">文件较大，只显示前 512 KB。</div>}
					</>
				)}
				{tab === "changes" && (
					<div className="space-y-3 p-4">
						{changes.map((c, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 修改按时间排列
							<div key={i}>
								<div className="mb-1 text-muted">
									第 {i + 1} 次 · {c.tool}
									{c.created ? "（新建）" : ""}
								</div>
								{c.diff ? <DiffBlock diff={c.diff} /> : <div className="text-muted">没有 diff 记录</div>}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
