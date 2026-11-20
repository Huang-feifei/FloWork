/** 本地只校验格式；分辨率和宽高比是否受支持由图片服务商决定。 */
export function normalizeImageSize(input: string, presets: readonly string[] = []): string | undefined {
	const value = input.trim();
	const dimensions = /^([1-9]\d{0,7})\s*[x×*]\s*([1-9]\d{0,7})$/i.exec(value);
	if (dimensions) return `${dimensions[1]}x${dimensions[2]}`;
	if (value.toLowerCase() === "auto") return "auto";
	if (value && value.length <= 64 && presets.includes(value)) return value;
	return undefined;
}
