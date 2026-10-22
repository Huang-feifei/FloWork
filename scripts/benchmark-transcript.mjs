/** 隔离 Electron 生产 renderer 压测；先 npm run build，结果与截图写入 out/。不调用模型。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, release } from "node:os";
import { join, resolve } from "node:path";
import electron from "electron";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "flowork-transcript-bench-"));
try {
	for (const dir of ["home", "data", "agent", "workspace"]) mkdirSync(join(work, dir));
	mkdirSync(join(root, "out"), { recursive: true });
	const output = join(root, "out/transcript-performance.json");
	const stepsFile = join(work, "steps.json");
	writeFileSync(stepsFile, JSON.stringify([{ js: readFileSync(join(root, "scripts/fixtures/benchmark-transcript.js"), "utf8"), result: output, wait: 50 }]));
	const env = { ...process.env, HOME: join(work, "home"), USERPROFILE: join(work, "home"), FLOWORK_DATA_DIR: join(work, "data"),
		FLOWORK_PI_AGENT_DIR: join(work, "agent"), PI_CODING_AGENT_DIR: join(work, "agent"), PI_SKIP_VERSION_CHECK: "1",
		SHOT_SHOW: "1", SHOT_STEPS_FILE: stepsFile, SHOT_OUT: join(root, "out/transcript-performance.png"), SHOT_WAIT: "500" };
	delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
	const r = spawnSync(electron, [root, "--ui-screenshot"], { cwd: join(work, "workspace"), env, encoding: "utf8", timeout: 120000 });
	assert.equal(r.status, 0, `${r.error ?? ""}\n${r.stdout}\n${r.stderr}`);
	const report = JSON.parse(readFileSync(output, "utf8"));
	report.machine = { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() };
	report.notes = ["生产构建、真实 Electron DOM；直接注入消息，不含磁盘读取或跨 IPC 传输历史消息的耗时", "显示隔离窗口并关闭 backgroundThrottling；更新耗时量到 DOM 提交，不等于实际屏幕绘制耗时", "每场景 150 次约 30Hz 流式更新，每 10 次追加完成消息；工具结果约 3.6KB/条", "heapUsedBytes 未强制 GC，包含各场景累积与浏览器缓存，不作为泄漏结论", "运行时指标不设跨机器硬阈值，消息挂载窗口超过 80 条视为回归失败"];
	writeFileSync(output, JSON.stringify(report, null, 2));
	console.table(report.scenarios.map(s => ({ messages:s.messages, mountMs:s.mountMs.toFixed(1), updateP95:s.updateMs.p95.toFixed(1), appendP95:s.appendMs.p95.toFixed(1), frameP95:s.frameGapMs.p95.toFixed(1), longTasks:s.longTasks.length, mountedRows:s.mountedRows })));
	console.log(`完整压测记录：${output}`);
} finally { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
