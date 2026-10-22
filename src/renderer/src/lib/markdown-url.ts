/**
 * Markdown 里的相对地址解析。
 *
 * 文件预览的 Markdown 会同时服务本地工作区与远程服务器：
 * - 本地路径是没有前导 `/` 的工作区相对路径，预览服务以项目根为站点根；
 * - 远程路径是服务器绝对路径，相对链接必须保留前导 `/`。
 *
 * 这里不依赖 Node 的 path，纯字符串处理，方便渲染层与回归脚本共用。
 */

const EXTERNAL_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

/** 是否是外链、锚点或 data:/mailto: 等非本地路径 */
export function isExternalMarkdownUrl(url: string): boolean {
	return !url || EXTERNAL_URL.test(url.trim());
}

/** 去掉 `#锚点` / `?查询` 并解码；文件名里的字面 `#` / `?` 应写成 %23 / %3F */
function hrefPath(href: string): string {
	const raw = href.split("#")[0]?.split("?")[0] ?? "";
	if (!raw) return "";
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/**
 * 把 Markdown 文件里的相对地址解析成项目内路径。
 *
 * - `basePath` 是当前 Markdown 文件路径：本地如 `docs/README.md`，远程如 `/opt/app/README.md`
 * - 返回 `null` 表示外链、锚点、空地址或越出项目根
 */
export function resolveMarkdownPath(basePath: string, href: string): string | null {
	const raw = href.trim();
	if (!raw || isExternalMarkdownUrl(raw)) return null;

	const pathPart = hrefPath(raw);
	if (!pathPart) return null;

	// 根相对地址：本地指工作区根，远程指服务器根
	const rootRelative = pathPart.startsWith("/");
	const rooted = basePath.startsWith("/");
	const baseDir = rootRelative ? [] : basePath.split("/").slice(0, -1);
	const parts = [...baseDir, ...pathPart.split("/")];
	const out: string[] = [];

	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			// 不允许跳出项目根；本地回退由后端再兜底
			if (out.length === 0) return null;
			out.pop();
			continue;
		}
		out.push(part);
	}

	if (out.length === 0) return null;
	const joined = out.join("/");
	return rooted ? `/${joined}` : joined;
}

/**
 * 把本地预览服务的 origin 与 Markdown 相对图片地址拼成可加载的 URL。
 * `origin` 为空（远程项目或尚未启动预览服务）时原样返回，避免生成坏链接。
 */
export function resolveMarkdownAssetUrl(origin: string | null | undefined, basePath: string, src: string): string {
	if (!origin) return src;
	const target = resolveMarkdownPath(basePath, src);
	if (!target) return src;
	const pathname = (target.startsWith("/") ? target.slice(1) : target)
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `${origin}/${pathname}`;
}

export { imageMimeType } from "@shared/image";
