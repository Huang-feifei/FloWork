/**
 * 开发辅助：启动隔离的桌面应用，对几个典型界面截图（需先 npm run build）。
 *
 *   node scripts/shoot-ui.mjs <输出目录> [前缀]
 *
 * 会注入 scripts/mock-transcript.js 中的示例会话；不会调用模型，也不修改配置。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import electronPath from "electron";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { root } from "./runtime.mjs";

const outDir = resolve(process.argv[2] ?? join(root, "out/shots"));
const prefix = process.argv[3] ?? "ui";
mkdirSync(outDir, { recursive: true });

const mock = readFileSync(join(root, "scripts/mock-transcript.js"), "utf8");
const clickTitle = (title) => `(() => { const button = document.querySelector(${JSON.stringify(`button[title='${title}']`)}); if (!button) throw new Error(${JSON.stringify(`找不到截图按钮：${title}`)}); button.click(); })()`;
/** 切到某个视图（截图辅助：直接改界面状态，不经过交互） */
const setView = (view) => `window.__floworkStore.setState({ view: ${JSON.stringify(view)} })`;

const scenes = {
	welcome: [setView("welcome")],
	empty: [`window.__floworkStore.setState({ view: "chat", activeProjectId: null, cwd: null, handleId: null, messages: [], state: null })`],
	chat: [mock],
	review: [mock, clickTitle("本会话的修改")],
	palette: [mock, `window.__floworkStore.getState().setPalette(true)`],
	terminal: [mock, clickTitle("终端")],
	settings: [setView("settings")],
};

if (!existsSync(join(root, "out/main/index.js"))) throw new Error("请先 npm run build");
for (const [name, steps] of Object.entries(scenes)) {
	const temp = mkdtempSync(join(tmpdir(), "flowork-shot-"));
	try {
		for (const dir of ["home", "data", "agent"]) mkdirSync(join(temp, dir), { recursive: true });
		const stepsFile = join(temp, "steps.json");
		writeFileSync(stepsFile, JSON.stringify(steps));
		const out = join(outDir, `${prefix}-${name}.png`);
		const env = {
			...process.env,
			HOME: join(temp, "home"),
			USERPROFILE: join(temp, "home"),
			FLOWORK_DATA_DIR: join(temp, "data"),
			FLOWORK_PI_AGENT_DIR: join(temp, "agent"),
			PI_CODING_AGENT_DIR: join(temp, "agent"),
			PI_SKIP_VERSION_CHECK: "1",
			SHOT_OUT: out,
			SHOT_STEPS_FILE: stepsFile,
			SHOT_WAIT: "2000",
		};
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.ELECTRON_RENDERER_URL;
		const r = spawnSync(electronPath, [root, "--ui-screenshot"], { env, cwd: root, encoding: "utf8", timeout: 60_000 });
		console.log(r.status === 0 ? `✓ ${out}` : `✗ ${name}: ${r.error || r.stderr || r.stdout}`);
		if (r.status !== 0) process.exitCode = 1;
	} finally { rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
