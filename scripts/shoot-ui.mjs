/**
 * 开发辅助：对网页版开发服务器（npm run dev:web）的几个典型界面截图，检查样式。
 *
 *   node scripts/shoot-ui.mjs <输出目录> [前缀]
 *
 * 会注入 scripts/mock-transcript.js 中的示例会话；不会调用模型，也不修改配置。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { root } from "./web-build-options.mjs";

const outDir = resolve(process.argv[2] ?? join(root, "out/shots"));
const prefix = process.argv[3] ?? "ui";
mkdirSync(outDir, { recursive: true });

const mock = readFileSync(join(root, "scripts/mock-transcript.js"), "utf8");
const cwd = root;
const clickText = (selector, text) =>
	`[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.includes(${JSON.stringify(text)}))?.click()`;

const scenes = {
	empty: [`localStorage.removeItem("flowork.lastCwd"); location.reload()`],
	chat: [`localStorage.setItem("flowork.lastCwd", ${JSON.stringify(cwd)}); location.reload()`, mock],
	chatTop: [
		`localStorage.setItem("flowork.lastCwd", ${JSON.stringify(cwd)}); location.reload()`,
		mock,
		`document.querySelector(".term.overflow-y-auto").scrollTop = 0`,
	],
	settings: [clickText("aside button", "设置")],
	custom: [clickText("aside button", "设置"), clickText("main button", "自定义端点"), clickText("main button", "硅基流动")],
};

const electronCli = join(root, "node_modules/electron/cli.js");
for (const [name, steps] of Object.entries(scenes)) {
	const stepsFile = join(tmpdir(), `flowork-shot-${name}.json`);
	writeFileSync(stepsFile, JSON.stringify(steps));
	const out = join(outDir, `${prefix}-${name}.png`);
	const r = spawnSync(process.execPath, [electronCli, join(root, "scripts/screenshot.cjs")], {
		env: {
			...process.env,
			SHOT_URL: "http://127.0.0.1:5173/",
			SHOT_OUT: out,
			SHOT_STEPS_FILE: stepsFile,
			SHOT_WAIT: "2000",
			SHOT_SIZE: "1360x880",
		},
		encoding: "utf8",
		timeout: 60_000,
	});
	console.log(r.status === 0 ? `✓ ${out}` : `✗ ${name}: ${r.stderr || r.stdout}`);
}
