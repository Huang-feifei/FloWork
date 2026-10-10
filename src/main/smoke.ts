/**
 * 桌面版冒烟测试：`npm run smoke`。不调用模型，验证三条链路：
 * 1. 渲染进程加载成功且 preload 暴露了 window.floworkTransport；
 * 2. service worker 能运行 pi SDK（ping、列出供应商与会话）；
 * 3. session worker 能创建 pi 会话并返回状态与会话树。
 * 加 `--screenshot <path.png>` 时额外保存空白页与打开工作区后的截图。
 */
import { writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type { Backend } from "../core/backend";
import { runCoreChecks } from "../core/smoke-checks";

export async function runSmokeTest(backend: Backend, win: BrowserWindow): Promise<number> {
	const report: Record<string, unknown> = {};
	try {
		await new Promise<void>((resolve, reject) => {
			if (!win.webContents.isLoading()) return resolve();
			win.webContents.once("did-finish-load", () => resolve());
			win.webContents.once("did-fail-load", (_e, code, desc) => reject(new Error(`renderer 加载失败：${code} ${desc}`)));
		});
		report.rendererBridge = await win.webContents.executeJavaScript("typeof window.floworkTransport");
		if (report.rendererBridge !== "object") throw new Error("preload 未暴露 window.floworkTransport");

		Object.assign(report, await runCoreChecks(backend));

		const shotIndex = process.argv.indexOf("--screenshot");
		const shotPath = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined;
		if (shotPath) {
			await writeFile(shotPath, (await win.webContents.capturePage()).toPNG());
			// 以当前目录为工作区重新加载，走一遍 渲染进程 → 主进程 → session worker 的完整链路
			await win.webContents.executeJavaScript(
				`localStorage.setItem("flowork.lastCwd", ${JSON.stringify(process.cwd())}); location.reload();`,
			);
			await new Promise((r) => setTimeout(r, 5000));
			const workspaceShot = shotPath.replace(/\.png$/i, "-workspace.png");
			await writeFile(workspaceShot, (await win.webContents.capturePage()).toPNG());
			// 设置页（模型供应商）
			await win.webContents.executeJavaScript(
				`[...document.querySelectorAll("aside button")].find((b) => b.textContent.includes("设置"))?.click()`,
			);
			await new Promise((r) => setTimeout(r, 2500));
			const settingsShot = shotPath.replace(/\.png$/i, "-settings.png");
			await writeFile(settingsShot, (await win.webContents.capturePage()).toPNG());
			await win.webContents.executeJavaScript(`localStorage.removeItem("flowork.lastCwd")`);
			report.screenshots = [shotPath, workspaceShot, settingsShot];
		}

		console.log(`SMOKE OK ${JSON.stringify(report, null, 2)}`);
		return 0;
	} catch (error) {
		console.error(`SMOKE FAILED ${error instanceof Error ? error.stack : String(error)}`);
		console.error(JSON.stringify(report, null, 2));
		return 1;
	}
}
