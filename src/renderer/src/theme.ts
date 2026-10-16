/**
 * 界面主题：深色 / 浅色 / 跟随系统。
 *
 * - 选择持久化在 localStorage（与右侧面板、项目展开等界面偏好一致，不进 pi 的 settings.json）；
 * - 实际生效的深浅色写在 `<html data-theme="dark|light">`，由 styles.css 的 `html[data-theme="light"]` 覆盖 token；
 * - 桌面版还会把选择同步给主进程（nativeTheme + 窗口背景），见 syncDesktopTheme。
 */
export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "flowork.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function storedTheme(): ThemeMode {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		return value === "dark" || value === "light" || value === "system" ? value : "light";
	} catch {
		return "light";
	}
}

export function systemTheme(): ResolvedTheme {
	return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
	return mode === "system" ? systemTheme() : mode;
}

/** 把主题写到 <html data-theme>，返回实际生效的深浅色 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
	const resolved = resolveTheme(mode);
	document.documentElement.dataset.theme = resolved;
	return resolved;
}

export function storeTheme(mode: ThemeMode): void {
	try {
		localStorage.setItem(STORAGE_KEY, mode);
	} catch {
		/* 存储不可用时忽略：本次会话仍然生效 */
	}
}

/** 通知桌面版主进程跟随主题（窗口背景、原生控件深浅色）；网页版没有这个桥，静默跳过 */
export function syncDesktopTheme(mode: ThemeMode): void {
	void window.floworkTheme?.set(mode).catch(() => undefined);
}

/** 监听系统深浅色变化；仅在 mode = system 时需要重新应用 */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
	const media = window.matchMedia(DARK_QUERY);
	const handler = () => onChange(media.matches ? "dark" : "light");
	media.addEventListener("change", handler);
	return () => media.removeEventListener("change", handler);
}
