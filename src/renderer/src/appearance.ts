/**
 * 外观偏好：主题之外的界面外观（字体与字号 / 强调色 / 窗口背景 / 辅助功能）。
 *
 * - 与主题一样只保存在本机 localStorage（不进 pi 的 settings.json）；
 * - 实际生效的方式是把 data-* 属性写到 <html> 上，样式钩子在 styles.css 末尾；
 * - 模糊与不透明度这类连续量写成 CSS 变量：--app-bg-blur / --app-bg-opacity / --app-bg-image。
 *
 * 属性缺失时就是默认值：苹果蓝 + 系统字 + 标准字号 + 跟随系统背景 + 无辅助增强。
 */

export type AccentId = "blue" | "purple" | "pink" | "red" | "orange" | "yellow" | "green" | "graphite";
export type FontId = "default" | "compact" | "cn";
export type MonoId = "default" | "cn";
export type ScaleId = "compact" | "normal" | "loose";
export type CodeSize = 12 | 13 | 14;
export type BgMode = "system" | "solid" | "image";

export interface Appearance {
	/** 强调色：只换 primary / accent 这一支 token */
	accent: AccentId;
	/** 界面字体 */
	font: FontId;
	/** 等宽字体（终端 / diff / 代码） */
	mono: MonoId;
	/** 界面字号：整体缩放 */
	scale: ScaleId;
	/** 代码字号：只影响终端 / diff / 代码块 */
	codeSize: CodeSize;
	/** 窗口背景：跟随系统壁纸 / 纯色 / 图片 */
	bg: BgMode;
	/** 自定义背景图：本次会话的 object URL（blob:…），图片本体存在 IndexedDB，bg = image 时生效 */
	bgImage: string;
	/** 背景模糊（px，0–40）：只作用于壁纸本身 */
	bgBlur: number;
	/** 壁纸浓度（0.2–1）：越低壁纸越淡、面板越实；实现为壁纸上方一层薄膜的浓度，不是壁纸自身的 opacity */
	bgOpacity: number;
	/** 提高对比度 */
	contrast: boolean;
	/** 减少动态效果 */
	reducedMotion: boolean;
	/** 边栏图标大小：大号 */
	largeSidebarIcons: boolean;
}

/** 强调色预设：色值与 styles.css 的 html[data-accent] 一一对应 */
export const ACCENTS: Array<{ id: AccentId; label: string; color: string }> = [
	{ id: "blue", label: "苹果蓝", color: "#0071e3" },
	{ id: "purple", label: "紫", color: "#8e3fa0" },
	{ id: "pink", label: "粉", color: "#d6247a" },
	{ id: "red", label: "红", color: "#d70015" },
	{ id: "orange", label: "橙", color: "#b45309" },
	{ id: "yellow", label: "黄", color: "#9a7b00" },
	{ id: "green", label: "绿", color: "#1f8b4c" },
	{ id: "graphite", label: "石墨", color: "#6b6b70" },
];

/** 界面字体：只用系统字栈，不加载外部字体 */
export const FONTS: Array<{ id: FontId; label: string }> = [
	{ id: "default", label: "系统默认" },
	{ id: "compact", label: "紧凑（Segoe UI Variable）" },
	{ id: "cn", label: "中文优先（苹方 / 微软雅黑）" },
];

export const MONOS: Array<{ id: MonoId; label: string }> = [
	{ id: "default", label: "Cascadia Mono" },
	{ id: "cn", label: "Sarasa Mono SC（中文等宽）" },
];

export const SCALES: Array<{ id: ScaleId; label: string }> = [
	{ id: "compact", label: "紧凑" },
	{ id: "normal", label: "标准" },
	{ id: "loose", label: "宽松" },
];

export const CODE_SIZES: Array<{ id: string; label: string }> = [
	{ id: "12", label: "12" },
	{ id: "13", label: "13" },
	{ id: "14", label: "14" },
];

export const BG_MODES: Array<{ id: BgMode; label: string }> = [
	{ id: "system", label: "跟随系统" },
	{ id: "solid", label: "纯色" },
	{ id: "image", label: "图片" },
];

export const DEFAULT_APPEARANCE: Appearance = {
	accent: "blue",
	font: "default",
	mono: "default",
	scale: "normal",
	codeSize: 13,
	bg: "system",
	bgImage: "",
	bgBlur: 0,
	bgOpacity: 1,
	contrast: false,
	reducedMotion: false,
	largeSidebarIcons: false,
};

const STORAGE_KEY = "flowork.appearance";

const ACCENT_IDS = ACCENTS.map((a) => a.id);
const FONT_IDS = FONTS.map((f) => f.id);
const MONO_IDS = MONOS.map((m) => m.id);
const SCALE_IDS = SCALES.map((s) => s.id);
const BG_IDS = BG_MODES.map((b) => b.id);

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function num(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** 把任意来源（localStorage / 旧版本 / 手改过的 JSON）收敛成合法的外观对象 */
export function normalizeAppearance(value: Partial<Appearance> | null | undefined): Appearance {
	const v = value ?? {};
	return {
		accent: pick(v.accent, ACCENT_IDS, DEFAULT_APPEARANCE.accent),
		font: pick(v.font, FONT_IDS, DEFAULT_APPEARANCE.font),
		mono: pick(v.mono, MONO_IDS, DEFAULT_APPEARANCE.mono),
		scale: pick(v.scale, SCALE_IDS, DEFAULT_APPEARANCE.scale),
		codeSize: CODE_SIZES.some((s) => Number(s.id) === v.codeSize)
			? (v.codeSize as CodeSize)
			: DEFAULT_APPEARANCE.codeSize,
		bg: pick(v.bg, BG_IDS, DEFAULT_APPEARANCE.bg),
		bgImage: typeof v.bgImage === "string" ? v.bgImage : "",
		bgBlur: Math.round(num(v.bgBlur, 0, 40, DEFAULT_APPEARANCE.bgBlur)),
		bgOpacity: Math.round(num(v.bgOpacity, 0.2, 1, DEFAULT_APPEARANCE.bgOpacity) * 100) / 100,
		contrast: v.contrast === true,
		reducedMotion: v.reducedMotion === true,
		largeSidebarIcons: v.largeSidebarIcons === true,
	};
}

export function storedAppearance(): Appearance {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? normalizeAppearance(JSON.parse(raw) as Partial<Appearance>) : { ...DEFAULT_APPEARANCE };
	} catch {
		return { ...DEFAULT_APPEARANCE };
	}
}

export function storeAppearance(appearance: Appearance): void {
	try {
		// bgImage 是本次会话的 object URL，不能落盘；图片本体存在 IndexedDB（见 background-image.ts）。
		// 但如果还是 data: 值，说明这张图没进 IndexedDB（迁移失败或旧版遗留）：此时必须原样保留，
		// 否则清空后再也找不回来（曾因此丢失用户的壁纸）。
		const keepDataUrl = appearance.bgImage.startsWith("data:");
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...appearance, bgImage: keepDataUrl ? appearance.bgImage : "" }));
	} catch {
		/* 存储不可用时忽略：本次会话仍然生效 */
	}
}

/** 上一次应用的背景图 URL：换图时释放旧的 object URL，避免内存泄漏 */
let lastBgImageUrl = "";

function revokeObjectUrl(url: string): void {
	if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/** 把外观写到 <html>：data-* 走样式钩子，连续量走 CSS 变量；返回实际生效的对象 */
export function applyAppearance(appearance: Appearance): Appearance {
	const next = normalizeAppearance(appearance);
	const root = document.documentElement;
	const set = (key: string, value: string | undefined) => {
		if (value === undefined) delete root.dataset[key];
		else root.dataset[key] = value;
	};

	set("accent", next.accent);
	set("font", next.font === "default" ? undefined : next.font);
	set("mono", next.mono === "default" ? undefined : next.mono);
	set("scale", next.scale === "normal" ? undefined : next.scale);
	set("codeSize", next.codeSize === DEFAULT_APPEARANCE.codeSize ? undefined : String(next.codeSize));
	// 图片还没从 IndexedDB 读出来时先退回系统壁纸，读到后再切到图片
	set("bg", next.bg === "image" ? (next.bgImage ? "image" : undefined) : next.bg === "solid" ? "solid" : undefined);
	set("contrast", next.contrast ? "high" : undefined);
	set("motion", next.reducedMotion ? "reduced" : undefined);
	set("sidebarIcons", next.largeSidebarIcons ? "lg" : undefined);

	const previousUrl = lastBgImageUrl;
	lastBgImageUrl = next.bgImage;
	if (next.bg === "image" && next.bgImage) root.style.setProperty("--app-bg-image", `url("${next.bgImage}")`);
	else root.style.removeProperty("--app-bg-image");
	if (previousUrl !== next.bgImage) revokeObjectUrl(previousUrl);
	root.style.setProperty("--app-bg-blur", `${next.bgBlur}px`);
	root.style.setProperty("--app-bg-opacity", String(next.bgOpacity));

	return next;
}
