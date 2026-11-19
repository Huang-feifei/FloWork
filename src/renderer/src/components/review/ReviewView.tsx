import { useMemo, useState } from "react";
import { displayUserText } from "@shared/skill-text";
import { collectSessionFiles, isInsideWorkspace } from "../../lib/session-files";
import { useApp } from "../../store";
import { Icon } from "../Icon";
import { WorkbenchEmpty } from "../PageHeading";
import { DiffRows } from "../diff/DiffRows";

function splitPath(path: string) {
	const index = path.lastIndexOf("/");
	return index >= 0 ? { dir: path.slice(0, index), name: path.slice(index + 1) } : { dir: "", name: path };
}

export function ReviewView() {
	const messages = useApp((s) => s.messages);
	const cwd = useApp((s) => s.cwd);
	const sessionTitle = useApp((s) => s.state?.sessionName);
	const hasProject = useApp((s) => !!s.activeProjectId);
	const { setView, openPreview, insertIntoPrompt } = useApp.getState();
	const [selected, setSelected] = useState<string | null>(null);
	const files = useMemo(() => collectSessionFiles(messages, cwd).filter((file) => file.changes.some((change) => !change.isError)), [messages, cwd]);
	const firstPrompt = useMemo(() => {
		const first = messages.find((message) => message.role === "user");
		return first?.role === "user" ? displayUserText(first.content.map((block) => block.type === "text" ? block.text : "").join("")).slice(0, 80) : "";
	}, [messages]);
	const active = files.find((file) => file.path === selected) ?? files[0];
	const changes = active?.changes.filter((change) => !change.isError) ?? [];
	const canOpen = !!active && isInsideWorkspace(active.path);
	const add = files.reduce((total, file) => total + file.added, 0);
	const del = files.reduce((total, file) => total + file.removed, 0);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="fw-page-heading flex-wrap">
				<div className="min-w-0 flex-1">
					<h1 className="fw-page-title">本会话的文件改动</h1>
					<p className="mt-1 truncate text-[12px] text-muted">{sessionTitle || firstPrompt || "查看会话记录中的文件差异"}</p>
				</div>
				<button type="button" onClick={() => setView("chat")} className="fw-workbench-button">
					<Icon name="arrow-left" className="size-3.5" />返回会话
				</button>
			</header>
			{active ? (
				<div className="flex min-h-0 flex-1">
					<nav aria-label="改动文件" className="w-[clamp(172px,18vw,240px)] shrink-0 overflow-y-auto border-r border-border bg-term-bar p-3 sm:p-4">
						<div className="mb-3 border-b border-border px-2 pb-3">
							<h2 className="text-[13px] font-semibold">改动文件 · {files.length}</h2>
							<p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] tabular-nums text-muted">
								<span className="text-diff-add-fg">新增 {add} 行</span><span className="text-diff-del-fg">删除 {del} 行</span>
							</p>
						</div>
						<div className="space-y-1">
							{files.map((file) => {
								const { dir, name } = splitPath(file.path);
								const on = file.path === active.path;
								return (
									<button key={file.path} type="button" aria-pressed={on} title={file.path} onClick={() => setSelected(file.path)} className={`flex min-h-12 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ${on ? "bg-panel-2" : "hover:bg-highlight"}`}>
										<Icon name="file-code" className="size-3.5 shrink-0 text-muted" />
										<span className="min-w-0 flex-1">
											<span className={`block truncate ${on ? "font-semibold" : ""}`}>{name}</span>
											{dir && <span className="block truncate text-[11px] text-muted">{dir}</span>}
										</span>
									</button>
								);
							})}
						</div>
						<p className="mt-4 border-t border-border px-2 pt-3 text-[12px] leading-5 text-muted">只显示本会话记录到的写入、编辑操作。不包含 Git 中的其他改动，也不处理工具审批。</p>
					</nav>
					<section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="所选文件的差异">
						<header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-term px-4 py-3 sm:px-6">
							<div className="min-w-0 flex-1 basis-44">
								<h2 className="truncate text-[15px] font-semibold" title={active.path}>{splitPath(active.path).name}</h2>
								<p className="mt-0.5 truncate text-[12px] text-muted" title={active.path}>{active.path} · {changes.length} 次修改</p>
							</div>
							<button type="button" onClick={() => insertIntoPrompt(active.path)} className="fw-workbench-button">
								<Icon name="at-sign" className="size-3.5" />引用到输入框
							</button>
							<button type="button" disabled={!canOpen} title={canOpen ? undefined : "工作区外的文件无法在编辑器中打开"} onClick={() => { setView("chat"); openPreview(active.path); }} className="fw-workbench-button fw-workbench-primary">
								<Icon name="pencil" className="size-3.5" />打开文件
							</button>
						</header>
						<div key={active.path} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:px-6 sm:py-5">
							{changes.map((change, index) => (
								<div key={index} className="overflow-hidden rounded-lg border border-border bg-term">
									<div className="border-b border-border bg-term-bar px-4 py-2 text-[12px] text-muted">第 {index + 1} 次 · {change.created ? "新建文件" : change.tool === "write" ? "写入文件" : "编辑文件"}</div>
									{change.diff ? <div className="overflow-x-auto py-1.5"><div className="w-max min-w-full"><DiffRows diff={change.diff} twoColumns /></div></div> : <p className="px-4 py-3 text-muted">记录到了这次操作，但没有逐行差异可供查看。</p>}
								</div>
							))}
						</div>
					</section>
				</div>
			) : <WorkbenchEmpty icon="git-compare" title={hasProject ? "还没有文件改动记录" : "尚未打开项目"} detail={hasProject ? "通过会话中的写入或编辑工具修改文件后，这里会列出文件和逐行差异。终端操作产生的改动不在这个列表中。" : "先打开项目和会话，然后就能在这里查看该会话记录的文件改动。"} />}
		</div>
	);
}
