/** 文档图片允许的格式与单图上限；主进程和渲染进程共用，不允许任意文件充当图片。 */
export const MAX_MARKDOWN_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
	webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
};
export function imageMimeType(path: string): string | null {
	const ext = /\.([a-z\d]+)$/i.exec(path)?.[1]?.toLowerCase();
	return ext ? (IMAGE_MIME[ext] ?? null) : null;
}
