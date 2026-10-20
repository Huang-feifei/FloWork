/** 轻量弹出菜单：点击外部或按 Esc 关闭。Apple 体系下是白色圆角浮层 + 内缩圆角项。 */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBrowserOcclusion } from "../../lib/browser";

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
	const [placed, setPlaced] = useState(position);
	useBrowserOcclusion();

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

	// 菜单靠近窗口右侧或底部时，优先翻到鼠标左侧 / 上方；仍不够则贴边。
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const place = () => {
			const rect = el.getBoundingClientRect();
			const margin = 8;
			let left = position.x;
			let top = position.y;
			if (left + rect.width > window.innerWidth - margin) {
				left = Math.max(margin, position.x - rect.width);
			}
			if (top + rect.height > window.innerHeight - margin) {
				top = Math.max(margin, position.y - rect.height);
			}
			setPlaced({ x: left, y: top });
		};
		place();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [position.x, position.y]);

	return (
		<div
			ref={ref}
			className="fw-float fixed z-50 min-w-44 rounded-2xl border border-border py-1.5 text-[13.5px]"
			style={{ left: placed.x, top: placed.y, maxHeight: "calc(100vh - 16px)", overflowY: "auto" }}
		>
			{items.map((item, i) =>
				item.separator ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 分隔线没有 id
					<div key={i} className="my-1.5 border-t border-border" />
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
						className={`mx-1.5 flex w-[calc(100%-12px)] items-center gap-2 rounded-[10px] px-2.5 py-2 text-left hover:bg-panel-2 disabled:opacity-40 ${
							item.danger ? "text-err" : ""
						}`}
					>
						<span className="flex-1">{item.label}</span>
						{item.hint && <span className="text-[11.5px] text-faint">{item.hint}</span>}
					</button>
				),
			)}
		</div>
	);
}
