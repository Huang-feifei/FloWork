import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { projectRoot, rendererConfig } from "./renderer.config";

const shared = resolve(projectRoot, "src/shared");

export default defineConfig({
	main: {
		resolve: { alias: { "@shared": shared } },
		build: {
			rollupOptions: {
				input: {
					// 主进程入口
					index: resolve(projectRoot, "src/main/index.ts"),
					// pi worker：由主进程通过 utilityProcess.fork 启动，内部运行 pi SDK
					"pi-worker": resolve(projectRoot, "src/worker/index.ts"),
				},
			},
		},
	},
	preload: {
		resolve: { alias: { "@shared": shared } },
		build: {
			rollupOptions: {
				// 沙箱化 preload 必须是 CommonJS
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		...rendererConfig(),
		build: {
			rollupOptions: {
				input: resolve(projectRoot, "src/renderer/index.html"),
			},
		},
	},
});
