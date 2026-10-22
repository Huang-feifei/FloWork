/** PASS / SKIP / FAIL 协议回归，含跨运行时子进程继承。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyResult } from "./lib/test-results.mjs";

assert.equal(classifyResult("suite", 0)[0].status, "PASS");
assert.equal(classifyResult("suite", 1)[0].status, "FAIL");
assert.equal(classifyResult("suite", null)[0].status, "FAIL");
const skip = { status: "SKIP", reason: "missing env" };
assert.equal(classifyResult("suite", 0, [skip])[0].status, "SKIP");
assert.equal(classifyResult("suite", 1, [skip])[0].status, "FAIL", "失败不能被跳过记录掩盖");
const partial = classifyResult("db", 0, [{ ...skip, name: "network" }]);
assert.deepEqual(partial.map(r => r.status), ["PASS", "SKIP"]);
assert.equal(partial[1].label, "db / network");

const work = mkdtempSync(join(tmpdir(), "flowork-test-results-"));
try {
	const file = join(work, "report.jsonl");
	const lib = pathToFileURL(resolve(import.meta.dirname, "lib/test-results.mjs")).href;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {reportSkip} from ${JSON.stringify(lib)}; reportSkip('未配置测试环境');`],
		{ env: { ...process.env, FLOWORK_TEST_REPORT_FILE: file }, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	const records = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(classifyResult("child", child.status, records)[0].status, "SKIP");
	const runner = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--no-build", "--require-all", "host-key"],
		{ cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, FLOWORK_TEST_SSH: "", FLOWORK_TEST_SSH_CONTAINER: "" }, encoding: "utf8" });
	assert.equal(runner.status, 1, runner.stdout + runner.stderr);
	assert.match(runner.stdout, /PASS 0 \/ SKIP 1 \/ FAIL 0 \/ BLOCKED 0/);
	assert.doesNotMatch(runner.stdout, /全部通过/);
	console.log("TEST RESULTS REGRESSION OK（整套跳过 / 部分跳过 / 失败优先 / 严格模式）");
} finally { rmSync(work, { recursive: true, force: true }); }
