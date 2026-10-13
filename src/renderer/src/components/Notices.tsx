import { useApp } from "../store";

const LEVEL = {
	info: { dot: "bg-info", text: "text-fg" },
	warning: { dot: "bg-warn", text: "text-fg" },
	error: { dot: "bg-err", text: "text-err" },
} as const;

export function Notices() {
	const notices = useApp((s) => s.notices);
	const dismiss = useApp((s) => s.dismissNotice);
	if (notices.length === 0) return null;
	return (
		<div className="pointer-events-none absolute right-5 bottom-5 z-40 flex w-96 flex-col gap-2">
			{notices.map((n) => (
				<div
					key={n.id}
					className="fw-float pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border-strong px-3.5 py-2.5 text-[13px]"
				>
					<span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${LEVEL[n.level].dot}`} />
					<div className={`min-w-0 flex-1 break-words whitespace-pre-wrap ${LEVEL[n.level].text}`}>{n.text}</div>
					<button type="button" onClick={() => dismiss(n.id)} className="text-muted hover:text-fg">
						✕
					</button>
				</div>
			))}
		</div>
	);
}
