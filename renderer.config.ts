/**
 * Electron 渲染进程的 Vite 配置，由 electron.vite.config.ts 引入。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, UserConfig } from "vite";

export const projectRoot = dirname(fileURLToPath(import.meta.url));

/**
 * 生产构建注入的 CSP，桌面界面从 file:// 加载页面。
 *
 * - style-src 必须留 'unsafe-inline'：CodeMirror 与 xterm 都靠运行时插入 <style> 实现高亮与终端样式
 * - img-src 放开 data:/blob:：Markdown 里的图片可能是内联的 data URL
 * - connect-src 只允许自身：后端请求走 Electron IPC，网页预览运行在独立浏览器视图
 * - object-src / base-uri / form-action 收紧：应用不需要它们，留着只会给注入留口子
 */
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
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

/** 可选依赖体积报告：只分析构建结果，不改变分包或生产页面。模块长度为压缩前的估算贡献。 */
function bundleAnalysisPlugin(): Plugin {
	return {
		name: "flowork-bundle-analysis",
		apply: "build",
		generateBundle(_options, bundle) {
			if (process.env.FLOWORK_ANALYZE !== "1") return;
			const chunks = Object.values(bundle).flatMap((item) => item.type === "chunk" ? [{
				file: item.fileName, entry: item.isEntry, dynamicEntry: item.isDynamicEntry,
				bytes: Buffer.byteLength(item.code), imports: item.imports, dynamicImports: item.dynamicImports,
				modules: Object.entries(item.modules).map(([id, info]) => ({
					id: id.replaceAll("\\", "/").replace(`${projectRoot.replaceAll("\\", "/")}/`, ""),
					renderedBytes: info.renderedLength,
				})).sort((a, b) => b.renderedBytes - a.renderedBytes).slice(0, 30),
			}] : []).sort((a, b) => b.bytes - a.bytes);
			this.emitFile({ type: "asset", fileName: "bundle-analysis.json", source: JSON.stringify(chunks, null, 2) });
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
		plugins: [react(), tailwindcss(), cspPlugin(), bundleAnalysisPlugin()],
	};
}
