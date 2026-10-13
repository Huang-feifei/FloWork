/** 轻量弹出菜单：点击外部或按 Esc 关闭 */
import { type ReactNode, useEffect, useRef } from "react";

export interface MenuItem {
	label: ReactNode;
	onClick?: () => void;
	danger?: boolean;
	disabled?: boolean;
	/** 分隔线 */
	separator?: boolean;
	/** 次级说明（灰色小字），例如“当前” */
	hint?: string;
}

export function Menu({
	items,
	position,
	onClose,
}: {
	items: MenuItem[];
	position: { x: number; y: number };
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("mousedown", onDown, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	// 避免超出窗口底部
	const top = Math.min(position.y, window.innerHeight - 24 - items.length * 30);

	return (
		<div
			ref={ref}
			className="fw-float fixed z-50 min-w-44 rounded-lg border border-border-strong py-1 text-[13px]"
			style={{ left: position.x, top: Math.max(8, top) }}
		>
			{items.map((item, i) =>
				item.separator ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 分隔线没有 id
					<div key={i} className="my-1 border-t border-border" />
				) : (
					<button
						type="button"
						// biome-ignore lint/suspicious/noArrayIndexKey: 菜单项顺序固定
						key={i}
						disabled={item.disabled}
						onClick={() => {
							onClose();
							item.onClick?.();
						}}
						className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel-2 disabled:opacity-40 ${
							item.danger ? "text-err" : ""
						}`}
					>
						<span className="flex-1">{item.label}</span>
						{item.hint && <span className="text-[11px] text-muted">{item.hint}</span>}
					</button>
				),
			)}
		</div>
	);
}
