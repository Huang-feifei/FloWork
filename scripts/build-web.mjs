/** 构建网页版：页面 → out/web/renderer，后端 → out/web/server */
import { resolve } from "node:path";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { root, serverBuildOptions } from "./web-build-options.mjs";

await viteBuild({ configFile: resolve(root, "vite.web.config.ts"), logLevel: "warn" });
await esbuild(serverBuildOptions(resolve(root, "out/web/server")));
console.log("网页版构建完成：npm run start:web");
