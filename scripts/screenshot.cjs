/**
 * 界面截图工具（开发辅助）：用 Electron 打开页面并截图，便于在无人值守环境检查样式。
 * 参数通过环境变量传入（命令行参数会被 Chromium 当作开关解析）：
 *
 *   SHOT_URL=http://127.0.0.1:5173/ SHOT_OUT=out.png [SHOT_STEPS='["js1","js2"]'] [SHOT_WAIT=1500] [SHOT_SIZE=1280x820] \
 *     node node_modules/electron/cli.js scripts/screenshot.cjs
 *
 * SHOT_STEPS 中每段脚本执行后等待 SHOT_WAIT 毫秒；若 SHOT_OUT 含 {n}，每一步都截一张图。
 * 步骤也可以写成对象 { js, wait, shot }：自定义等待时长；shot 指定时只在该步截图并以它替换 {n}。
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");

const url = process.env.SHOT_URL;
const out = process.env.SHOT_OUT;
const steps = process.env.SHOT_STEPS_FILE
	? JSON.parse(require("node:fs").readFileSync(process.env.SHOT_STEPS_FILE, "utf8"))
	: JSON.parse(process.env.SHOT_STEPS || "[]");
const wait = Number(process.env.SHOT_WAIT || 1500);
const [width, height] = (process.env.SHOT_SIZE || "1280x820").split("x").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
	const win = new BrowserWindow({ width, height, show: false });
	try {
		await win.loadURL(url);
		await sleep(wait);
		const capture = async (n) => {
			const path = out.replace("{n}", String(n));
			writeFileSync(path, (await win.webContents.capturePage()).toPNG());
			console.log(`saved ${path}`);
		};
		const named = steps.some((s) => typeof s === "object" && s.shot);
		if (out.includes("{n}") && !named) await capture(0);
		for (let i = 0; i < steps.length; i++) {
			const step = typeof steps[i] === "string" ? { js: steps[i] } : steps[i];
			if (step.js) await win.webContents.executeJavaScript(step.js);
			await sleep(step.wait ?? wait);
			if (step.shot) await capture(step.shot);
			else if (out.includes("{n}") && !named) await capture(i + 1);
		}
		if (!out.includes("{n}")) await capture(0);
		app.exit(0);
	} catch (error) {
		console.error(error);
		app.exit(1);
	}
});
