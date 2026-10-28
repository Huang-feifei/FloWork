/**
 * 窗口底色：页面渲染前可见的那一层（BrowserWindow backgroundColor）。
 *
 * 必须与 src/renderer/src/styles.css 的 `--color-window` 保持一致，否则切换主题后
 * 透明面板 / 壁纸边缘会透出错的主题底色。CSS 无法导入 TS，改这里时请同步改 CSS。
 */
export const WINDOW_COLORS = { dark: "#141417", light: "#f5f5f7" } as const;

export type ResolvedThemeName = keyof typeof WINDOW_COLORS;

/** 按实际生效的深浅色取窗口底色 */
export function windowColor(dark: boolean): string {
	return dark ? WINDOW_COLORS.dark : WINDOW_COLORS.light;
}
