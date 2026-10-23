/** token 数使用十进制单位：1K = 1000，1M = 1000000；配置仍保存为精确整数。 */
export interface TokenPreset {
	label: string;
	tokens: number;
}

export const CONTEXT_WINDOW_PRESETS: readonly TokenPreset[] = [
	{ label: "128K", tokens: 128000 },
	{ label: "200K", tokens: 200000 },
	{ label: "256K", tokens: 256000 },
	{ label: "400K", tokens: 400000 },
	{ label: "512K", tokens: 512000 },
	{ label: "1M", tokens: 1000000 },
];

export const MAX_OUTPUT_PRESETS: readonly TokenPreset[] = [
	{ label: "8K", tokens: 8000 },
	{ label: "16K", tokens: 16000 },
	{ label: "32K", tokens: 32000 },
	{ label: "64K", tokens: 64000 },
	{ label: "128K", tokens: 128000 },
];

/** 空白或无效输入返回 undefined；允许小数单位，但换算后的 token 必须是安全正整数。 */
export function parseTokenLimit(input: string): number | undefined {
	const match = /^(\d+)(?:\.(\d+))?\s*([km])?$/i.exec(input.trim());
	if (!match) return undefined;
	const [, whole, fraction = "", unit = ""] = match;
	const places = unit.toLowerCase() === "m" ? 6 : unit.toLowerCase() === "k" ? 3 : 0;
	// 按十进制位拼接，避免 1.001 * 1000 的浮点误差，也拒绝小于 1 token 的尾数。
	if (/[^0]/.test(fraction.slice(places))) return undefined;
	const value = Number(whole + fraction.slice(0, places).padEnd(places, "0"));
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
