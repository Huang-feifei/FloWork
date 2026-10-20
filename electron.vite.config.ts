import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { projectRoot, rendererConfig } from "./renderer.config";
import { buildKernelAdapter } from "./scripts/lib/build-kernel-adapter.mjs";

const shared = resolve(projectRoot, "src/shared");

export default defineConfig({
	main: {
		// 独立且可复现的内置适配层；仅替换官方 SDK 时不携带 Rollup 共享 chunk。
		plugins: [{ name: "flowork-kernel-adapter", async writeBundle() {
			await buildKernelAdapter(projectRoot, resolve(projectRoot, "out/main/kernel-adapter/pi-worker.js"));
		} }],
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
