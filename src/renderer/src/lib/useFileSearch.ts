import { useEffect, useRef, useState } from "react";
import type { FileSearchResult } from "@shared/protocol";
import { api, errorText } from "../api/client";
import { useApp } from "../store";

/** 全项目文件名模糊搜索（防抖）；文件可能变化后的第一次搜索会让后端重建索引 */
export function useFileSearch(query: string, limit = 100) {
	const cwd = useApp((s) => s.cwd);
	const filesVersion = useApp((s) => s.filesVersion);
	const [result, setResult] = useState<FileSearchResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const indexedVersion = useRef(-1);

	useEffect(() => {
		const q = query.trim();
		if (!cwd || !q) {
			setResult(null);
			return;
		}
		let cancelled = false;
		setLoading(true);
		const timer = setTimeout(() => {
			const fresh = indexedVersion.current !== filesVersion;
			api.searchWorkspace(cwd, q, { limit, fresh }).then(
				(r) => {
					if (cancelled) return;
					indexedVersion.current = filesVersion;
					setResult(r);
					setError(null);
					setLoading(false);
				},
				(e: unknown) => {
					if (cancelled) return;
					setError(errorText(e));
					setLoading(false);
				},
			);
		}, 120);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [cwd, query, limit, filesVersion]);

	return { result, error, loading };
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
