/** 会话文件：本会话读取、修改、新建过的文件 */
import { useMemo } from "react";
import { collectSessionFiles, isInsideWorkspace } from "../../lib/session-files";
import { useApp } from "../../store";
import { Icon } from "../Icon";

export function SessionFiles() {
	const messages = useApp((s) => s.messages);
	const cwd = useApp((s) => s.cwd);
	const preview = useApp((s) => s.preview);
	const { openPreview, insertIntoPrompt, setView } = useApp.getState();
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
				className={`group relative flex min-h-11 items-center gap-2 rounded-md px-2 py-2 ${preview === f.path ? "bg-primary-soft" : "hover:bg-panel-2"}`}
			>
				<button
					type="button"
					disabled={!inside}
					onClick={() => openPreview(f.path)}
					className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
					title={inside ? f.path : `${f.path}（工作区外，无法预览）`}
				>
					<Icon name={changed ? "file-code" : "files"} className="size-4 shrink-0 text-muted" />
					<span className="min-w-0 flex-1">
						<span className="block truncate leading-5">{name}</span>
						{dir && <span className="block truncate text-[11px] leading-4 text-muted">{dir}</span>}
					</span>
				</button>
				<span className="shrink-0 text-[11px] group-focus-within:invisible group-hover:invisible">
					{changed ? (
						<>
							<span className="tabular-nums text-diff-add-fg">+{f.added}</span> <span className="tabular-nums text-diff-del-fg">−{f.removed}</span>
						</>
					) : (
						<span className="text-muted">读取 {f.reads} 次</span>
					)}
				</span>
				<button
					type="button"
					onClick={() => insertIntoPrompt(f.path)}
					title="把路径引用到输入框"
					className="absolute right-2 rounded-md px-2 py-0.5 text-[11.5px] text-primary-strong opacity-0 hover:bg-primary-soft focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
				>
					引用
				</button>
			</div>
		);
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-[12.5px] leading-6">
			{files.length === 0 && <div className="px-3 text-muted">本会话还没有读取或修改文件</div>}
			{changedFiles.length > 0 && (
				<>
					<div className="flex h-8 items-center px-2 text-[11.5px] font-semibold text-muted">
						<span className="flex-1">已修改 {changedFiles.length} 个文件</span>
						<span className="font-medium tabular-nums text-diff-add-fg">+{totals.added}</span>&nbsp;<span className="font-medium tabular-nums text-diff-del-fg">−{totals.removed}</span>
					</div>
					{changedFiles.map(row)}
					<button type="button" onClick={() => setView("review")} className="fw-workbench-button mt-3 mb-2 w-full">
						审查本次修改
						<Icon name="arrow-right" className="size-3.5" />
					</button>
				</>
			)}
			{readOnly.length > 0 && (
				<>
					<div className="mt-3 flex h-8 items-center px-2 text-[11.5px] font-semibold text-muted">只读取过 {readOnly.length} 个文件</div>
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
