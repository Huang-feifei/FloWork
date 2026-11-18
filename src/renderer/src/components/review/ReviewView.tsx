/**
 * 审查本会话的修改：左侧是本次会话改动过的文件，右侧是该文件的 diff。
 * 数据来自会话里的 write / edit 工具结果（与「会话文件」面板同源），不额外访问 git。
 */
import { useMemo, useState } from "react";
import { collectSessionFiles } from "../../lib/session-files";
import { useApp } from "../../store";
import { Icon } from "../Icon";
import { DiffRows } from "../diff/DiffRows";

function splitPath(path: string) {
	const i = path.lastIndexOf("/");
	return i >= 0 ? { dir: path.slice(0, i), name: path.slice(i + 1) } : { dir: "", name: path };
}

export function ReviewView() {
	const messages = useApp((s) => s.messages);
	const cwd = useApp((s) => s.cwd);
	const sessionTitle = useApp((s) => s.state?.sessionName ?? "");
	const { setView, openPreview, insertIntoPrompt } = useApp.getState();
	const [selected, setSelected] = useState<string | null>(null);

	const files = useMemo(
		() => collectSessionFiles(messages, cwd).filter((f) => f.changes.some((c) => !c.isError)),
		[messages, cwd],
	);
	const firstPrompt = useMemo(() => {
		const first = messages.find((m) => m.role === "user");
		return first?.role === "user" ? first.content.map((b) => (b.type === "text" ? b.text : "")).join("").slice(0, 60) : "";
	}, [messages]);

	const add = files.reduce((s, f) => s + f.added, 0);
	const del = files.reduce((s, f) => s + f.removed, 0);
	const active = files.find((f) => f.path === selected) ?? files[0];
	const changes = (active?.changes ?? []).filter((c) => !c.isError);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-term px-4 sm:px-7">
				<button
					type="button"
					onClick={() => setView("chat")}
					className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-muted hover:bg-panel-2 hover:text-fg"
				>
					<Icon
						name="arrow-left"
						className="size-3.5"
					/>
					返回会话
				</button>
				<div className="flex-1" />
				{active && (
					<>
						<button
							type="button"
							onClick={() => insertIntoPrompt(active.path)}
							className="fw-workbench-button"
						>
							<Icon
								name="at-sign"
								className="size-3.5"
							/>
							引用到输入框
						</button>
						<button
							type="button"
							onClick={() => {
								setView("chat");
								openPreview(active.path);
							}}
							className="fw-workbench-button fw-workbench-primary"
						>
							<Icon
								name="pencil"
								className="size-3.5"
							/>
							在编辑器中打开
						</button>
					</>
				)}
			</div>
			<header className="fw-page-heading"><div className="min-w-0">
				<h1 className="fw-page-title">本次会话的修改</h1>
				<div className="mt-2 flex items-center gap-4 text-[13px] text-muted">
					{(sessionTitle || firstPrompt) && <span className="max-w-[320px] truncate">{sessionTitle || firstPrompt}</span>}
					<span className="shrink-0">{files.length} 个文件</span>
					<span className="shrink-0 tabular-nums text-diff-add-fg">+{add}</span>
					<span className={`shrink-0 tabular-nums ${del ? "text-diff-del-fg" : "text-muted"}`}>−{del}</span>
				</div>
				</div>
			</header>

			<div className="flex min-h-0 flex-1">
				<nav aria-label="已修改文件" className="w-[clamp(163px,17vw,225px)] shrink-0 space-y-1 overflow-y-auto border-r border-border bg-term-bar px-3 py-5 sm:px-4">
					<p className="mb-3 px-2 text-[12px] font-medium text-muted">已修改</p>
					{files.length === 0 && (
						<div className="px-3 py-2 text-[12px] leading-5 text-muted">
							本次会话还没有修改过文件。pi 通过 write / edit 工具改动的文件会出现在这里。
						</div>
					)}
					{files.map((f) => {
						const { dir, name } = splitPath(f.path);
						const on = f.path === active?.path;
						return (
							<button
								type="button"
								key={f.path}
								onClick={() => setSelected(f.path)}
								aria-pressed={on}
								className={`flex min-h-12 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ${on ? "bg-panel-2" : "hover:bg-highlight"}`}
							>
								<Icon name="file-code" className="size-3.5 shrink-0 text-muted" />
								<span className="min-w-0 flex-1">
									<span className={`block truncate text-[13px] ${on ? "font-semibold" : ""}`} title={f.path}>{name}</span>
									<span className="block truncate text-[11px] text-muted">{dir}</span>
								</span>
								<span className="shrink-0 text-[11px] tabular-nums">
									<span className="text-diff-add-fg">+{f.added}</span>{f.removed > 0 && <span className="ml-1 text-diff-del-fg">−{f.removed}</span>}
								</span>
							</button>
						);
					})}
					<div className="mt-5 px-2 text-[12px] leading-6 text-muted">
						diff 来自 edit 工具与写入前快照。之后被外部改动的部分不在这里显示。
					</div>
				</nav>

				<div className="min-w-0 flex-1 overflow-y-auto bg-bg px-5 py-6 sm:px-8">
					{active ? (
						<>
							<div className="mb-5 flex items-center gap-2 text-[12px]">
								<span className={active.created ? "text-ok" : "text-warn"}>{active.created ? "A" : "M"}</span>
								<span className="min-w-0 truncate font-mono text-fg" title={active.path}>{active.path}</span>
								<span className="shrink-0 text-muted">· {changes.length} 次修改</span>
								<div className="flex-1" />
								<span className="shrink-0 text-muted">
									读取 {active.reads} 次
								</span>
							</div>
							<div className="space-y-4 pb-6 font-mono text-[12.5px] leading-[1.75]">
								{changes.map((c, i) => (
									<div key={`${c.tool}-${c.diff?.length ?? 0}-${i}`} className="overflow-hidden rounded-lg border border-border bg-term">
										<div className="border-b border-border bg-term-bar px-4 py-2 font-sans text-[12px] text-muted">
											第 {i + 1} 次 · {c.tool}
											{c.created ? "（新建）" : ""}
										</div>
										{c.diff ? <div className="overflow-x-auto py-1.5"><div className="min-w-full w-max"><DiffRows diff={c.diff} twoColumns /></div></div> : <div className="px-4 py-2 text-muted">这次修改没有 diff 记录</div>}
									</div>
								))}
							</div>
						</>
					) : (
						<div className="p-6 text-[13px] text-muted">选择左侧的文件查看修改内容。</div>
					)}
				</div>
			</div>
		</div>
	);
}
