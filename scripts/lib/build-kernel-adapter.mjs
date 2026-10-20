/** 同一构建配方供应用内置适配层与维护者本地放行测试复用。 */
import { build } from "esbuild";

export async function buildKernelAdapter(root, outfile) {
	await build({
		absWorkingDir: root, entryPoints: ["src/worker/index.ts"], outfile,
		bundle: true, platform: "node", format: "esm", target: "node22", packages: "external",
		alias: { "@shared": "./src/shared" }, logLevel: "silent",
	});
}
