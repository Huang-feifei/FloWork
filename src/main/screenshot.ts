/** 开发辅助：使用完整桌面应用（真实 preload / IPC）拍摄隔离的示例界面，不调用模型。 */
import { readFile, writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";

type Step = string | { js?: string; wait?: number; shot?: string | number; result?: string };
export async function runUIScreenshot(win: BrowserWindow): Promise<number> {
	try {
		// 性能压测需要真实帧时钟，隐藏窗口不会持续派发 requestAnimationFrame。
		if (process.env.SHOT_SHOW === "1") win.showInactive();
		if (win.webContents.isLoading()) await new Promise<void>((resolve, reject) => {
			win.webContents.once("did-finish-load", () => resolve());
			win.webContents.once("did-fail-load", (_e, code, text) => reject(new Error(`${code}: ${text}`)));
		});
		const out = process.env.SHOT_OUT;
		if (!out) throw new Error("缺少 SHOT_OUT");
		const steps: Step[] = JSON.parse(process.env.SHOT_STEPS_FILE
			? await readFile(process.env.SHOT_STEPS_FILE, "utf8") : process.env.SHOT_STEPS ?? "[]");
		const wait = Number(process.env.SHOT_WAIT ?? 1500);
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		await sleep(wait);
		const capture = async (n: string | number) => {
			// 按需加载的设置/评审视图不能把 Suspense 占位当作成功截图。
			const deadline = Date.now() + 15_000;
			while (await win.webContents.executeJavaScript(`document.querySelector("main")?.textContent.trim() === "加载中…"`)) {
				if (Date.now() >= deadline) throw new Error("截图视图加载超时");
				await sleep(100);
			}
			const path = out.replace("{n}", String(n));
			await writeFile(path, (await win.webContents.capturePage()).toPNG());
			console.log(`saved ${path}`);
		};
		const named = steps.some((step) => typeof step === "object" && step.shot !== undefined);
		if (out.includes("{n}") && !named) await capture(0);
		for (const [i, value] of steps.entries()) {
			const step = typeof value === "string" ? { js: value } : value;
			if (step.js) {
				const result: unknown = await win.webContents.executeJavaScript(step.js);
				if (step.result) await writeFile(step.result, JSON.stringify(result, null, 2));
			}
			await sleep(step.wait ?? wait);
			if (step.shot !== undefined) await capture(step.shot);
			else if (out.includes("{n}") && !named) await capture(i + 1);
		}
		if (!out.includes("{n}")) await capture(0);
		return 0;
	} catch (error) {
		console.error(error);
		return 1;
	}
}
