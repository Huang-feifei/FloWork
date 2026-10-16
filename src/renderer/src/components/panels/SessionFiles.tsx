/** 会话文件：本会话读取、修改、新建过的文件 */
import { useMemo } from "react";
import { collectSessionFiles, isInsideWorkspace } from "../../lib/session-files";
import { useApp } from "../../store";

export function SessionFiles() {
	const messages = useApp((s) => s.messages);
	const cwd = useApp((s) => s.cwd);
	const preview = useApp((s) => s.preview);
	const { openPreview, insertIntoPrompt } = useApp.getState();
	const files = useMemo(() => collectSessionFiles(messages, cwd), [messages, cwd]);
	const changedFiles = files.filter((f) => f.changes.some((c) => !c.isError));
	const readOnly = files.filter((f) => !f.changes.some((c) => !c.isError));

	const totals = changedFiles.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), {
		added: 0,
		removed: 0,
	});

	const row = (f: (typeof files)[number]) => {
		const inside = isInsideWorkspace(f.path);
		const name = f.path.split("/").pop() ?? f.path;
		const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, "");
		const changed = f.changes.some((c) => !c.isError);
		return (
			<div
				key={f.path}
				className={`group flex h-8 items-center gap-2 rounded-[10px] pr-2 pl-2 ${preview === f.path ? "bg-primary-soft" : "hover:bg-panel-2"}`}
			>
				<button
					type="button"
					disabled={!inside}
					onClick={() => openPreview(f.path)}
					className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
					title={inside ? f.path : `${f.path}（工作区外，无法预览）`}
				>
					<span
						className={`w-3 shrink-0 text-center text-[10px] font-bold ${
							!changed ? "text-faint" : f.created ? "text-accent-strong" : "text-warn"
						}`}
					>
						{!changed ? "R" : f.created ? "A" : "M"}
					</span>
					<span className="min-w-0 flex-1 truncate">
						{name}
						{dir && <span className="ml-1.5 truncate font-mono text-[11px] text-faint">{dir}</span>}
					</span>
				</button>
				<span className="shrink-0 text-[11px] group-hover:hidden">
					{changed ? (
						<>
							<span className="tabular-nums text-accent-strong">+{f.added}</span> <span className="tabular-nums text-err">−{f.removed}</span>
						</>
					) : (
						<span className="text-muted">读取 {f.reads} 次</span>
					)}
				</span>
				<button
					type="button"
					onClick={() => insertIntoPrompt(f.path)}
					title="把路径引用到输入框"
					className="hidden shrink-0 rounded-full px-2 py-0.5 text-[11.5px] text-primary hover:bg-primary-soft group-hover:block"
				>
					引用
				</button>
			</div>
		);
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 text-[12.5px] leading-6">
			{files.length === 0 && <div className="px-3 text-muted">本会话还没有读取或修改文件</div>}
			{changedFiles.length > 0 && (
				<>
					<div className="flex h-8 items-center px-2 text-[11.5px] font-semibold text-muted">
						<span className="flex-1">已修改 {changedFiles.length} 个文件</span>
						<span className="font-medium tabular-nums text-accent-strong">+{totals.added}</span>&nbsp;<span className="font-medium tabular-nums text-err">−{totals.removed}</span>
					</div>
					{changedFiles.map(row)}
				</>
			)}
			{readOnly.length > 0 && (
				<>
					<div className="flex h-8 items-center px-2 pt-2 text-[11.5px] font-semibold text-muted">只读取过 {readOnly.length} 个文件</div>
					{readOnly.map(row)}
				</>
			)}
			{files.length > 0 && (
				<div className="mt-2 border-t border-border px-2 pt-2 text-[11.5px] leading-5 text-faint">
					只统计 read / write / edit 工具；通过 bash 命令改动的文件不在此列，可在“项目文件”中查看。
				</div>
			)}
		</div>
	);
}
