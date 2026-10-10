/** 启动已构建的网页版后端（npm run build:web 之后），参数原样透传，例如 --open、--smoke */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { backendRuntime, root } from "./web-build-options.mjs";

const runtime = await backendRuntime();
console.log(`[flowork] 后端运行时：${runtime.label}`);
const child = spawn(runtime.command, [resolve(root, "out/web/server/index.js"), ...process.argv.slice(2)], {
	cwd: root,
	stdio: "inherit",
	env: { ...process.env, ...runtime.env },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
