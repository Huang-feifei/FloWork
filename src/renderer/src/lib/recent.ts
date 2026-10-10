const RECENT_KEY = "flowork.recentCwds";

export function getRecentCwds(): string[] {
	try {
		const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
		return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
	} catch {
		return [];
	}
}

export function rememberCwd(cwd: string): void {
	localStorage.setItem(RECENT_KEY, JSON.stringify([cwd, ...getRecentCwds().filter((p) => p !== cwd)].slice(0, 8)));
}
