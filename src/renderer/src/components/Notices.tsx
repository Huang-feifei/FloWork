/** 右下角浮层提示（info / warning / error），点 ✕ 关闭 */
import { useApp } from "../store";
import { useBrowserOcclusion } from "../lib/browser";

const LEVEL = {
	info: { dot: "bg-info", text: "text-fg" },
	warning: { dot: "bg-warn", text: "text-fg" },
	error: { dot: "bg-err", text: "text-err" },
} as const;

export function Notices() {
	const notices = useApp((s) => s.notices);
	useBrowserOcclusion(notices.length > 0);
	const dismiss = useApp((s) => s.dismissNotice);
	if (notices.length === 0) return null;
	return (
		<div className="pointer-events-none absolute right-5 bottom-5 z-40 flex w-96 flex-col gap-2">
			{notices.map((n) => (
				<div
					key={n.id}
					className="fw-float pointer-events-auto flex items-start gap-3 rounded-2xl px-4 py-3 text-[13.5px]"
				>
					<span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${LEVEL[n.level].dot}`} />
					<div className={`min-w-0 flex-1 break-words whitespace-pre-wrap leading-relaxed ${LEVEL[n.level].text}`}>{n.text}</div>
					<button
						type="button"
						onClick={() => dismiss(n.id)}
						className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-fg"
					>
						✕
					</button>
				</div>
			))}
		</div>
	);
}
