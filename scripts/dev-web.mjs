/**
 * 网页版开发模式：
 * - esbuild 监听 src/server、src/worker、src/core、src/shared，变更后重启后端
 * - Vite 开发服务器提供页面（热更新），/ws 代理到后端
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { context } from "esbuild";
import { createServer } from "vite";
import { backendRuntime, root, serverBuildOptions } from "./web-build-options.mjs";

const outdir = resolve(root, "out/web-dev/server");
let backend;
const runtime = await backendRuntime();
console.log(`[flowork] 后端运行时：${runtime.label}`);

function startBackend() {
	backend = spawn(runtime.command, [resolve(outdir, "index.js")], {
		cwd: root,
		stdio: "inherit",
		env: {
			...process.env,
			...runtime.env,
			FLOWORK_DEV_ORIGIN: "http://127.0.0.1:5173,http://localhost:5173",
			// 开发模式下页面由 Vite 提供
			FLOWORK_STATIC_DIR: resolve(root, "out/web-dev/no-static"),
		},
	});
}

async function restartBackend() {
	const previous = backend;
	backend = undefined;
	if (previous && previous.exitCode === null) {
		await new Promise((r) => {
			previous.once("exit", r);
			previous.kill("SIGTERM");
		});
	}
	startBackend();
}

const ctx = await context({
	...serverBuildOptions(outdir),
	plugins: [
		{
			name: "restart-backend",
			setup(build) {
				build.onEnd((result) => {
					if (result.errors.length === 0) void restartBackend();
				});
			},
		},
	],
});
await ctx.watch();

const vite = await createServer({ configFile: resolve(root, "vite.web.config.ts") });
await vite.listen();
console.log("\n[flowork] 网页版开发模式：http://127.0.0.1:5173/\n");

async function stop() {
	await ctx.dispose();
	await vite.close();
	backend?.kill("SIGTERM");
	process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
