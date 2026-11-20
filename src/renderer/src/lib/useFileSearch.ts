import { useEffect, useRef, useState } from "react";
import type { FileSearchResult } from "@shared/protocol";
import { api, errorText } from "../api/client";
import { useApp } from "../store";

/** 全项目文件名模糊搜索（防抖）；文件可能变化后的第一次搜索会让后端重建索引 */
export function useFileSearch(query: string, limit = 100) {
	const cwd = useApp((s) => s.cwd);
	const filesVersion = useApp((s) => s.filesVersion);
	const [settled, setSettled] = useState<{ key: string; result: FileSearchResult | null; error: string | null }>();
	const indexed = useRef<{ cwd: string; version: number } | null>(null);
	const q = query.trim();
	const key = cwd && q ? JSON.stringify([cwd, q, limit, filesVersion]) : null;

	useEffect(() => {
		if (!cwd || !key) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			const fresh = indexed.current?.cwd !== cwd || indexed.current.version !== filesVersion;
			api.searchWorkspace(cwd, q, { limit, fresh }).then(
				(r) => {
					if (cancelled) return;
					indexed.current = { cwd, version: filesVersion };
					setSettled({ key, result: r, error: null });
				},
				(e: unknown) => {
					if (cancelled) return;
					setSettled({ key, result: null, error: errorText(e) });
				},
			);
		}, 120);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [cwd, q, key, limit, filesVersion]);

	const current = key && settled?.key === key ? settled : undefined;
	return { result: current?.result ?? null, error: current?.error ?? null, loading: !!key && !current };
}

/** 把路径中与查询字符（按顺序）匹配的位置标出来，用于高亮 */
export function matchPositions(path: string, query: string): Set<number> {
	const p = path.toLowerCase();
	const q = query.toLowerCase().replace(/\s+/g, "");
	const positions = new Set<number>();
	if (!q) return positions;
	const base = p.lastIndexOf("/") + 1;
	const direct = p.indexOf(q, base) >= 0 ? p.indexOf(q, base) : p.indexOf(q);
	if (direct >= 0) {
		for (let i = 0; i < q.length; i++) positions.add(direct + i);
		return positions;
	}
	// 子序列：优先在文件名中匹配
	const tryFrom = (start: number) => {
		const found = new Set<number>();
		let from = start;
		for (const ch of q) {
			const idx = p.indexOf(ch, from);
			if (idx < 0) return null;
			found.add(idx);
			from = idx + 1;
		}
		return found;
	};
	return tryFrom(base) ?? tryFrom(0) ?? positions;
}
