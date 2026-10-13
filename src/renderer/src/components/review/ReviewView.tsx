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
			<div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3 font-mono text-[12px]">
				<button
					type="button"
					onClick={() => setView("chat")}
					className="flex items-center gap-1 text-muted hover:text-fg"
				>
					<Icon
						name="arrow-left"
						className="size-3.5"
					/>
					返回会话
				</button>
				<span className="text-faint">|</span>
				<span className="text-fg">本次会话的修改</span>
				<span className="max-w-[320px] truncate text-faint">{sessionTitle || firstPrompt}</span>
				<span className="text-faint">·</span>
				<span className="text-muted">{files.length} files</span>
				<span className="text-ok">+{add}</span>
				<span className="text-err">−{del}</span>
				<div className="flex-1" />
				{active && (
					<>
						<button
							type="button"
							onClick={() => insertIntoPrompt(active.path)}
							className="flex h-6 items-center gap-1 rounded px-2 text-muted hover:bg-panel-2 hover:text-fg"
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
							className="flex h-6 items-center gap-1 rounded bg-accent px-2 font-semibold text-accent-foreground hover:bg-accent-strong"
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

			<div className="flex min-h-0 flex-1">
				<nav className="w-[280px] shrink-0 overflow-y-auto border-r border-border bg-sidebar py-1">
					<div className="flex h-7 items-center px-3 font-mono text-[10.5px] font-semibold tracking-[0.06em] text-faint">已修改</div>
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
								className={`relative flex h-[42px] w-full items-center gap-2 px-3 text-left ${on ? "bg-accent-soft" : "hover:bg-panel-2"}`}
							>
								{on && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
								<span className={`w-2.5 font-mono text-[11px] font-bold ${f.created ? "text-ok" : "text-warn"}`}>{f.created ? "A" : "M"}</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[12.5px]">{name}</span>
									<span className="block truncate font-mono text-[10.5px] text-faint">{dir}</span>
								</span>
								<span className="font-mono text-[11px] text-ok">+{f.added}</span>
								<span className="w-6 text-right font-mono text-[11px] text-err">−{f.removed}</span>
							</button>
						);
					})}
					<div className="mt-4 px-3 text-[11.5px] leading-relaxed text-faint">
						diff 来自 edit 工具与写入前快照。之后被外部改动的部分不在这里显示。
					</div>
				</nav>

				<div className="min-w-0 flex-1 overflow-y-auto bg-bg">
					{active ? (
						<>
							<div className="sticky top-0 flex h-8 items-center gap-2 border-b border-border bg-glass px-4 font-mono text-[12px] backdrop-blur-xl">
								<span className={active.created ? "text-ok" : "text-warn"}>{active.created ? "A" : "M"}</span>
								<span className="truncate text-fg">{active.path}</span>
								<span className="text-faint">· {changes.length} 次修改</span>
								<div className="flex-1" />
								<span className="text-faint">
									读取 {active.reads} 次
								</span>
							</div>
							<div className="pb-8 font-mono text-[12.5px] leading-[1.75]">
								{changes.map((c, i) => (
									<div key={`${c.tool}-${c.diff?.length ?? 0}-${i}`}>
										<div className="flex items-center gap-2 bg-panel-2 px-4 py-0.5 font-mono text-[11px] text-faint">
											第 {i + 1} 次 · {c.tool}
											{c.created ? "（新建）" : ""}
										</div>
										{c.diff ? <DiffRows diff={c.diff} twoColumns /> : <div className="px-4 py-2 text-muted">这次修改没有 diff 记录</div>}
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
