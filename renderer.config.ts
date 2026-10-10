/**
 * 渲染进程的公共 Vite 配置，桌面版（electron.vite.config.ts）与网页版（vite.web.config.ts）共用。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { UserConfig } from "vite";

export const projectRoot = dirname(fileURLToPath(import.meta.url));

export function rendererConfig(): UserConfig {
	return {
		root: resolve(projectRoot, "src/renderer"),
		resolve: {
			alias: {
				"@shared": resolve(projectRoot, "src/shared"),
				"@renderer": resolve(projectRoot, "src/renderer/src"),
			},
		},
		plugins: [react(), tailwindcss()],
	};
}
