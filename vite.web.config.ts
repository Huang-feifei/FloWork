/**
 * 网页版渲染进程配置。开发模式下 /ws 代理到本地后端（src/server）。
 */
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { projectRoot, rendererConfig } from "./renderer.config";

export const WEB_DEV_PORT = 5173;
export const BACKEND_PORT = Number(process.env.FLOWORK_PORT ?? 17321);

export default defineConfig({
	...rendererConfig(),
	server: {
		host: "127.0.0.1",
		port: WEB_DEV_PORT,
		strictPort: true,
		proxy: {
			"/ws": { target: `ws://127.0.0.1:${BACKEND_PORT}`, ws: true },
		},
	},
	build: {
		outDir: resolve(projectRoot, "out/web/renderer"),
		emptyOutDir: true,
	},
});
