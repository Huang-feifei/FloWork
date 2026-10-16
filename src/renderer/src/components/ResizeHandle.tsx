/**
 * 侧栏拖拽调宽：竖向分隔条 + 记忆宽度的 hook。
 *
 * - 拖拽时只改内存状态，松手（或键盘调整）时写 localStorage，避免拖动中频繁写盘。
 * - 双击分隔条恢复默认宽度。
 * - 分隔条贴在面板的某一侧边缘（edge），向外拖动变宽。
 */
import { useCallback, useRef, useState } from "react";

function clamp(value: number, min: number, max: number): number {
	return Math.round(Math.max(min, Math.min(max, value)));
}

export interface PersistentWidth {
	width: number;
	/** 拖拽过程中更新（不落盘） */
	setWidth: (width: number) => void;
	/** 落盘当前（或指定）宽度 */
	commit: (width?: number) => void;
	reset: () => void;
	min: number;
	max: number;
}

export function usePersistentWidth(key: string, initial: number, min: number, max: number): PersistentWidth {
	const [width, setRaw] = useState(() => {
		const stored = Number(localStorage.getItem(key));
		return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : initial;
	});
	const latest = useRef(width);
	const setWidth = useCallback(
		(next: number) => {
			latest.current = clamp(next, min, max);
			setRaw(latest.current);
		},
		[min, max],
	);
	const commit = useCallback(
		(next?: number) => {
			if (next !== undefined) setWidth(next);
			localStorage.setItem(key, String(latest.current));
		},
		[key, setWidth],
	);
	const reset = useCallback(() => {
		latest.current = initial;
		setRaw(initial);
		localStorage.removeItem(key);
	}, [key, initial]);
	return { width, setWidth, commit, reset, min, max };
}

export function ResizeHandle({ state, edge, label }: { state: PersistentWidth; edge: "left" | "right"; label: string }) {
	const drag = useRef<{ x: number; width: number } | null>(null);
	// 分隔条在右边缘时向右拖变宽，在左边缘时向左拖变宽
	const sign = edge === "right" ? 1 : -1;

	return (
		<div
			role="separator"
			aria-label={label}
			aria-orientation="vertical"
			aria-valuemin={state.min}
			aria-valuemax={state.max}
			aria-valuenow={state.width}
			tabIndex={0}
			title={`${label}（双击恢复默认）`}
			className={`absolute inset-y-0 ${edge === "right" ? "right-0" : "left-0"} z-10 w-1.5 cursor-col-resize touch-none hover:bg-accent/40 focus:bg-accent/40 focus:outline-none`}
			onPointerDown={(event) => {
				drag.current = { x: event.clientX, width: state.width };
				event.currentTarget.setPointerCapture(event.pointerId);
				event.preventDefault();
			}}
			onPointerMove={(event) => {
				const start = drag.current;
				if (start) state.setWidth(start.width + sign * (event.clientX - start.x));
			}}
			onPointerUp={(event) => {
				if (!drag.current) return;
				drag.current = null;
				event.currentTarget.releasePointerCapture(event.pointerId);
				state.commit();
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
			onDoubleClick={state.reset}
			onKeyDown={(event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const step = (event.key === "ArrowRight" ? 16 : -16) * sign;
				state.commit(state.width + step);
			}}
		/>
	);
}
