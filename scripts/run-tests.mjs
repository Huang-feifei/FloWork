/**
 * 串行回归：npm test [--no-build] [--require-all] [名称过滤…]
 * PASS / SKIP / FAIL / BLOCKED 分开汇总；--require-all 将环境跳过视作未完成。
 * 隔离后端不写真实配置，不调用模型。跳过由脚本结构化报告，不从日志文字猜测。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { classifyResult } from "./lib/test-results.mjs";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const skipBuild = args.includes("--no-build");
const requireAll = args.includes("--require-all");
const filters = args.filter((a) => !a.startsWith("--"));
mkdirSync(join(root, "out"), { recursive: true });
const reportDir = mkdtempSync(join(root, "out/test-results-"));
process.on("exit", () => rmSync(reportDir, { recursive: true, force: true }));

const SUITES = [
	{ name: "kernel", file: "scripts/test-kernel.mjs", needsBuild: false },
	{ name: "database", file: "scripts/test-database.mjs", needsBuild: false },
	{ name: "hosts", file: "scripts/test-hosts.mjs", needsBuild: false },
	{ name: "command-risk", file: "scripts/test-command-risk.mjs", needsBuild: false },
	{ name: "planning", file: "scripts/test-planning.mjs", needsBuild: false },
	{ name: "prompt-cache", file: "scripts/test-prompt-cache.mjs", needsBuild: false },
	{ name: "compaction", file: "scripts/test-compaction.mjs", needsBuild: false },
	{ name: "model-limits", file: "scripts/test-model-limits.mjs", needsBuild: false },
	{ name: "model-metadata", file: "scripts/test-model-metadata.mjs", needsBuild: false },
	{ name: "markdown", file: "scripts/test-markdown.mjs", needsBuild: false },
	{ name: "session-store", file: "scripts/test-session-store.mjs", needsBuild: false },
	{ name: "worker-manager", file: "scripts/test-worker-manager.mjs", needsBuild: false },
	{ name: "test-results", file: "scripts/test-test-results.mjs", needsBuild: false },
	{ name: "subagent", file: "scripts/test-subagent.mjs", needsBuild: false },
	// 外部环境不足由脚本 reportSkip，不把退出码 0 直接等同于通过。
	{ name: "ops-tools", file: "scripts/test-ops-tools.mjs", needsBuild: false },
	{ name: "host-key", file: "scripts/test-host-key.mjs", needsBuild: false },
	{ name: "markdown-desktop", file: "scripts/test-markdown-desktop.mjs", needsBuild: true },
	{ name: "model-limits-desktop", file: "scripts/test-model-limits-desktop.mjs", needsBuild: true },
	{ name: "projects", file: "scripts/test-projects.mjs", needsBuild: true },
	{ name: "preview", file: "scripts/test-preview.mjs", needsBuild: true },
	{ name: "sessions", file: "scripts/test-sessions.mjs", needsBuild: true },
	{ name: "resources", file: "scripts/test-resources.mjs", needsBuild: true },
	{ name: "ext-ui", file: "scripts/test-ext-ui.mjs", needsBuild: true },
	{ name: "ops-session", file: "scripts/test-ops-session.mjs", needsBuild: true },
];

function run(label, command, commandArgs) {
	return new Promise((resolve) => {
		const started = Date.now();
		console.log(`\n▶ ${label}`);
		const reportFile = join(reportDir, `${label}.jsonl`);
		const child = spawn(command, commandArgs, {
			cwd: root, stdio: "inherit", env: { ...process.env, FLOWORK_TEST_REPORT_FILE: reportFile },
			shell: process.platform === "win32" && command === "npm",
		});
		child.on("exit", (code) => {
			try {
				const records = existsSync(reportFile) ? readFileSync(reportFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
				resolve(classifyResult(label, code, records, Date.now() - started));
			} catch (error) {
				console.error(error);
				resolve([{ label, status: "FAIL", reason: "无效的测试报告", ms: Date.now() - started }]);
			}
		});
		child.on("error", (error) => {
			console.error(error);
			resolve([{ label, status: "FAIL", reason: error.message, ms: Date.now() - started }]);
		});
	});
}

const suites = SUITES.filter((s) => filters.length === 0 || filters.some((f) => s.name.includes(f)));
if (!suites.length) {
	console.error(`没有匹配的回归脚本：${filters.join(", ")}（可选：${SUITES.map(s => s.name).join(", ")}）`);
	process.exit(1);
}

const results = [];
const preparedOK = () => results.every(r => r.status === "PASS");
if (!skipBuild) {
	results.push(...await run("类型检查", "npm", ["run", "typecheck"]));
	if (suites.some(s => s.needsBuild) && preparedOK()) {
		results.push(...await run("构建桌面版", "npm", ["run", "build"]));
		if (preparedOK()) results.push(...await run("构建 IPC 测试入口", "npm", ["run", "build:test"]));
	}
} else if (suites.some(s => s.needsBuild) && (!existsSync(join(root, "out/main/index.js")) || !existsSync(join(root, "out/main/pi-worker.js")) || !existsSync(join(root, "out/test-support/electron-test-host.cjs")))) {
	console.error("--no-build 但桌面回归产物不存在，请先 npm run build && npm run build:test");
	process.exit(1);
}
const prepared = preparedOK();
for (const suite of suites) {
	if (suite.needsBuild && !prepared) {
		results.push({ label: suite.name, status: "BLOCKED", ms: 0, reason: "前置类型检查或构建失败" });
		continue;
	}
	results.push(...await run(suite.name, process.execPath, [suite.file]));
}

console.log("\n──────── 汇总 ────────");
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.label}  ${(r.ms / 1000).toFixed(1)}s${r.reason ? `（${r.reason}）` : ""}`);
const counts = Object.fromEntries(["PASS", "SKIP", "FAIL", "BLOCKED"].map(status => [status, results.filter(r => r.status === status).length]));
console.log(`\nPASS ${counts.PASS} / SKIP ${counts.SKIP} / FAIL ${counts.FAIL} / BLOCKED ${counts.BLOCKED}`);
if (counts.FAIL || counts.BLOCKED || (requireAll && counts.SKIP)) {
	console.error(requireAll && counts.SKIP ? "存在跳过项，--require-all 要求全部实际执行" : "存在失败或被阻塞项");
	process.exit(1);
}
console.log(counts.SKIP ? "已执行项通过；仍有环境跳过项，不能视为全量集成验证通过" : "全部通过（无跳过项）");
