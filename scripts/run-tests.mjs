/**
 * 串行运行全部回归脚本，并汇总结果。
 *   npm test               类型检查 → 构建网页版 → 全部回归
 *   npm test -- --no-build 跳过类型检查与构建（out/web 已是最新时）
 *   npm test -- hosts ext  只跑名字包含这些关键字的脚本
 *
 * 各回归脚本自起隔离后端，不写真实配置目录、不调用模型。任一步失败时退出码非零。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const skipBuild = args.includes("--no-build");
const filters = args.filter((a) => !a.startsWith("--"));

/** 不依赖构建产物的脚本排在前面，尽早暴露问题 */
const SUITES = [
	{ name: "hosts", file: "scripts/test-hosts.mjs", needsBuild: false },
	{ name: "command-risk", file: "scripts/test-command-risk.mjs", needsBuild: false },
	{ name: "planning", file: "scripts/test-planning.mjs", needsBuild: false },
	// 需要测试主机：未设置 FLOWORK_TEST_SSH 时自动跳过
	{ name: "ops-tools", file: "scripts/test-ops-tools.mjs", needsBuild: false },
	// 还需要 FLOWORK_TEST_SSH_CONTAINER（会在容器里重新生成主机密钥）；未设置时跳过
	{ name: "host-key", file: "scripts/test-host-key.mjs", needsBuild: false },
	{ name: "projects", file: "scripts/test-projects.mjs", needsBuild: true },
	{ name: "preview", file: "scripts/test-preview.mjs", needsBuild: true },
	{ name: "sessions", file: "scripts/test-sessions.mjs", needsBuild: true },
	{ name: "resources", file: "scripts/test-resources.mjs", needsBuild: true },
	{ name: "ext-ui", file: "scripts/test-ext-ui.mjs", needsBuild: true },
	// 需要测试主机：未设置 FLOWORK_TEST_SSH 时自动跳过
	{ name: "ops-session", file: "scripts/test-ops-session.mjs", needsBuild: true },
];

function run(label, command, commandArgs) {
	return new Promise((resolve) => {
		const started = Date.now();
		console.log(`\n▶ ${label}`);
		const child = spawn(command, commandArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && command === "npm" });
		child.on("exit", (code) => resolve({ label, ok: code === 0, ms: Date.now() - started }));
		child.on("error", (error) => {
			console.error(error);
			resolve({ label, ok: false, ms: Date.now() - started });
		});
	});
}

const suites = SUITES.filter((s) => filters.length === 0 || filters.some((f) => s.name.includes(f)));
if (suites.length === 0) {
	console.error(`没有匹配的回归脚本：${filters.join(", ")}（可选：${SUITES.map((s) => s.name).join(", ")}）`);
	process.exit(1);
}

const results = [];
if (!skipBuild) {
	results.push(await run("类型检查", "npm", ["run", "typecheck"]));
	if (suites.some((s) => s.needsBuild) && results.every((r) => r.ok)) results.push(await run("构建网页版", "npm", ["run", "build:web"]));
} else if (suites.some((s) => s.needsBuild) && !existsSync(join(root, "out/web/server/index.js"))) {
	console.error("--no-build 但 out/web 不存在，请先 npm run build:web");
	process.exit(1);
}

// 类型检查或构建失败时，依赖构建的脚本没有意义，只跑不依赖构建的
const prepared = results.every((r) => r.ok);
for (const suite of suites) {
	if (suite.needsBuild && !prepared) {
		results.push({ label: suite.name, ok: false, ms: 0, skipped: true });
		continue;
	}
	results.push(await run(suite.name, process.execPath, [suite.file]));
}

console.log("\n──────── 汇总 ────────");
for (const r of results) console.log(`${r.skipped ? "－" : r.ok ? "✓" : "✗"} ${r.label}${r.skipped ? "（因前置步骤失败跳过）" : `  ${(r.ms / 1000).toFixed(1)}s`}`);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
	console.error(`\n${failed.length} 项未通过`);
	process.exit(1);
}
console.log("\n全部通过");
