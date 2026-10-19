/**
 * 本地预览服务：把项目根目录以只读 HTTP 暴露在 127.0.0.1 的随机端口上，
 * 供桌面版「内置浏览器」加载本地 HTML / SVG 等文件。
 *
 * 为什么不用 file://：Chromium 会以 CORS 拦住 file:// 页面的 fetch / ES module，
 * 稍复杂的前端页面会白屏；本地 HTTP 则相对路径、模块、图片、字体都能正常工作。
 *
 * 安全边界：
 * - 只监听回环地址，端口随机，不对外网开放；
 * - 校验 Host 头 + 拒绝 Sec-Fetch-Site: cross-site，防止网页探测本地端口与 DNS rebinding；
 * - 路径经 resolveInside 限制在项目根内，禁止目录穿越；
 * - 一律 no-store，改完文件刷新即见。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { resolveInside } from "./workspace-fs";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".cjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".wasm": "application/wasm",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".pdf": "application/pdf",
};

interface PreviewSite {
	server: Server;
	port: number;
}

export class PreviewServer {
	private readonly sites = new Map<string, PreviewSite>();

	/** 为项目根目录启动（或复用）预览服务，返回内置浏览器可用的 origin */
	async serve(root: string): Promise<{ origin: string }> {
		const key = resolve(root);
		const existing = this.sites.get(key);
		if (existing) return { origin: `http://127.0.0.1:${existing.port}` };
		const site = await this.listen(key);
		this.sites.set(key, site);
		return { origin: `http://127.0.0.1:${site.port}` };
	}

	closeAll(): void {
		for (const site of this.sites.values()) site.server.close();
		this.sites.clear();
	}

	private listen(root: string): Promise<PreviewSite> {
		return new Promise((resolvePromise, reject) => {
			const server = createServer((request, response) => void this.respond(root, request, response));
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") {
					server.close();
					reject(new Error("无法为预览服务分配端口"));
					return;
				}
				resolvePromise({ server, port: address.port });
			});
		});
	}

	private async respond(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const deny = (code: number, message: string) => {
			response.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			response.end(message);
		};
		if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "只支持 GET / HEAD");
		if (!isLocalHost(request.headers.host)) return deny(403, "仅允许本机访问");
		if (request.headers["sec-fetch-site"] === "cross-site") return deny(403, "拒绝跨站请求");
		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		} catch {
			return deny(400, "无效的路径");
		}
		try {
			let target = resolveInside(root, pathname.replace(/^\/+/, ""));
			let info = await stat(target.abs);
			if (info.isDirectory()) {
				// 目录默认找 index.html；rel 为空（项目根）时不能带前导斜杠，否则 resolve 会当成绝对路径
				target = resolveInside(root, target.rel ? `${target.rel}/index.html` : "index.html");
				info = await stat(target.abs);
			}
			if (!info.isFile()) return deny(404, "文件不存在");
			const type = MIME[extname(target.abs).toLowerCase()] ?? "application/octet-stream";
			response.writeHead(200, { "content-type": type, "content-length": info.size, "cache-control": "no-store" });
			if (request.method === "HEAD") {
				response.end();
				return;
			}
			createReadStream(target.abs).on("error", () => response.destroy()).pipe(response);
		} catch {
			return deny(404, "文件不存在");
		}
	}
}

function isLocalHost(host: string | undefined): boolean {
	if (!host) return false;
	const value = host.toLowerCase();
	return value === "127.0.0.1" || value === "localhost" || value.startsWith("127.0.0.1:") || value.startsWith("localhost:");
}
