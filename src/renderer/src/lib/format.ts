export function basename(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

export function relativeTime(ms: number): string {
	const diff = Date.now() - ms;
	const minute = 60_000;
	if (diff < minute) return "刚刚";
	if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
	if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
	if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
	return new Date(ms).toLocaleDateString();
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

/** 思考等级的中文名；pi 的等级标识仍是 off / minimal / low / medium / high / xhigh / max */
const THINKING_LABELS: Record<string, string> = {
	off: "关闭",
	minimal: "最小",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最大",
};

export function thinkingLabel(level: string): string {
	return THINKING_LABELS[level] ?? level;
}
