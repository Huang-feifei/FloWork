/**
 * 每轮回复结束后的汇总条：
 *   上排是本轮修改过的文件（点击预览），下排是耗时与操作（复制回复、展开 / 折叠过程、分叉、回到本轮重发）。
 * 数据都来自本轮消息本身，不需要后端额外提供。
 */
import { formatDuration, type Turn } from "../../lib/session-turns";
import { isInsideWorkspace, type SessionFile } from "../../lib/session-files";
import { useApp } from "../../store";
import { Icon } from "../Icon";

type AssistantMessage = Extract<Turn["messages"][number], { role: "assistant" }>;

export function TurnFooter({
	turn,
	changed,
	foldOpen,
	onToggleFold,
}: {
	turn: Turn;
	/** 本轮修改过的文件（由上层算好，用于决定是否显示时已算过） */
	changed: SessionFile[];
	/** 本轮过程当前是否展开 */
	foldOpen: boolean;
	onToggleFold: () => void;
}) {
	const preview = useApp((s) => s.preview);
	const isRunning = useApp((s) => s.isRunning);
	const { openPreview, navigateTo, forkFrom, pushNotice, setView } = useApp.getState();

	const duration = formatDuration(turn.endTimestamp - turn.user.timestamp);
	const entryId = turn.user.entryId;
	const busy = isRunning || !entryId;

	const copyReply = () => {
		const text = turn.messages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap((m) => m.content)
			.filter((b): b is Extract<AssistantMessage["content"][number], { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("\n\n")
			.trim();
		if (!text) {
			pushNotice("info", "本轮没有可复制的回复文本");
			return;
		}
		void navigator.clipboard.writeText(text).then(() => pushNotice("info", "已复制本轮回复"));
	};

	const btn =
		"rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted";

	return (
		<div className="mt-2">
			{changed.length > 0 && (
				<div className="mb-2 overflow-hidden rounded-lg border border-border">
					<div className="flex items-center justify-between gap-3 bg-term-bar px-3 py-2 text-[12px] text-muted">
						<span>本轮修改 · {changed.length} 个文件</span>
						<button type="button" onClick={() => setView("review")} className="shrink-0 text-fg hover:underline">查看会话改动</button>
					</div>
					{changed.map((f) => {
						const inside = isInsideWorkspace(f.path);
						const name = f.path.split("/").pop() ?? f.path;
						return (
							<button
								key={f.path}
								type="button"
								disabled={!inside}
								onClick={() => openPreview(f.path)}
								title={`${f.path}　+${f.added} −${f.removed}${inside ? "" : "（工作区外，无法预览）"}`}
								className={`flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-[13px] ${
									preview === f.path ? "bg-primary-soft text-primary-strong" : "hover:bg-panel-2"
								} disabled:cursor-default`}
							>
								<Icon name="file-code" className="size-4 shrink-0 text-muted" />
								<span className="min-w-0 flex-1 truncate">{name}</span>
								<span className="shrink-0 text-[12px] tabular-nums">
									<span className="text-diff-add-fg">+{f.added}</span> <span className="text-diff-del-fg">−{f.removed}</span>
								</span>
							</button>
						);
					})}
				</div>
			)}
			<div className="flex items-center gap-1 text-[12px] text-muted">
				<span className="px-1 tabular-nums" title="本轮耗时">
					{duration}
				</span>
				<button type="button" onClick={copyReply} title="复制本轮回复" className={btn}>
					<Icon name="copy" className="size-3.5" />
				</button>
				<button
					type="button"
					onClick={onToggleFold}
					title={foldOpen ? "折叠本轮过程" : "展开本轮过程"}
					className={`${btn} ${foldOpen ? "text-primary" : ""}`}
				>
					<Icon name="list-checks" className="size-3.5" />
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => entryId && void forkFrom(entryId, "before")}
					title="从本轮开始分叉为一个新会话"
					className={btn}
				>
					<Icon name="git-fork" className="size-3.5" />
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => entryId && void navigateTo(entryId)}
					title="回到本轮，原文填回输入框，可修改后重新发送"
					className={btn}
				>
					<Icon name="undo" className="size-3.5" />
				</button>
				{isRunning && <span className="ml-1 text-[11px] text-faint">运行中不可回溯</span>}
			</div>
		</div>
	);
}
