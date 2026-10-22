/** 构建仅供回归测试使用的 Electron 主进程入口；不会构建或启动 HTTP/WebSocket 应用服务。 */
import { build } from "esbuild";
import { join } from "node:path";
import { root } from "./runtime.mjs";

await build({
	absWorkingDir: root,
	entryPoints: ["scripts/lib/electron-test-host.ts"],
	outfile: join(root, "out/test-support/electron-test-host.cjs"),
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node22",
	packages: "external",
	alias: { "@shared": "./src/shared" },
	define: { "import.meta.dirname": "__dirname", "import.meta.url": "__floworkMetaUrl" },
	banner: { js: "const __floworkMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
	logLevel: "warning",
});
console.log("Electron IPC 回归入口已构建");
