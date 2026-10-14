/**
 * 渲染进程的公共 Vite 配置，桌面版（electron.vite.config.ts）与网页版（vite.web.config.ts）共用。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, UserConfig } from "vite";

export const projectRoot = dirname(fileURLToPath(import.meta.url));

/**
 * 生产构建注入的 CSP。桌面版从 file:// 加载页面、网页版从 http://127.0.0.1:<端口> 加载，两者共用同一份策略。
 *
 * - style-src 必须留 'unsafe-inline'：CodeMirror 与 xterm 都靠运行时插入 <style> 实现高亮与终端样式
 * - img-src 放开 data:/blob:：Markdown 里的图片可能是内联的 data URL
 * - connect-src 显式放开 127.0.0.1：网页版用 WebSocket 连本地后端，同源时 'self' 已覆盖，
 *   显式列出是为了后端端口变化、或用 localhost 之外的别名访问页面时仍然连得上
 * - object-src / base-uri / form-action 收紧：应用不需要它们，留着只会给注入留口子
 */
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

/**
 * 只在生产构建往 index.html 注入 CSP：开发模式下 Vite 的 HMR 客户端依赖内联脚本与 websocket，
 * 注入会把热更新直接挡掉。
 */
function cspPlugin(): Plugin {
	return {
		name: "flowork-csp",
		apply: "build",
		transformIndexHtml(html) {
			return {
				html,
				tags: [
					{
						tag: "meta",
						attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
						injectTo: "head-prepend",
					},
				],
			};
		},
	};
}

export function rendererConfig(): UserConfig {
	return {
		root: resolve(projectRoot, "src/renderer"),
		resolve: {
			alias: {
				"@shared": resolve(projectRoot, "src/shared"),
				"@renderer": resolve(projectRoot, "src/renderer/src"),
			},
		},
		plugins: [react(), tailwindcss(), cspPlugin()],
	};
}
