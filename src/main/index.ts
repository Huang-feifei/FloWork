import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { Backend } from "../core/backend";
import { registerIpc } from "./ipc";
import { runSmokeTest } from "./smoke";
import { spawnUtilityWorker } from "./spawn";

const isSmoke = process.argv.includes("--smoke");
let mainWindow: BrowserWindow | undefined;

const backend = new Backend({
	shell: "electron",
	version: app.getVersion(),
	spawnWorker: spawnUtilityWorker,
	pickFolder: async () => {
		const options = { properties: ["openDirectory" as const] };
		const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	},
	pickFolders: async () => {
		const options = { properties: ["openDirectory" as const, "multiSelections" as const] };
		const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
		return result.canceled ? [] : result.filePaths;
	},
});

/** 标题栏高度，与渲染进程 TitleBar 的 h-10 保持一致 */
const TITLE_BAR_HEIGHT = 40;

function createWindow(show = true): BrowserWindow {
	const isMac = process.platform === "darwin";
	const win = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 900,
		minHeight: 600,
		show: false,
		title: "FloWork",
		backgroundColor: "#faf9f6",
		autoHideMenuBar: true,
		// 自绘标题栏：Windows / Linux 保留系统窗口按钮（支持贴靠布局），macOS 保留红绿灯
		titleBarStyle: "hidden",
		...(isMac
			? { trafficLightPosition: { x: 14, y: 13 } }
			: { titleBarOverlay: { color: "#ebe8e1", symbolColor: "#1f1e1b", height: TITLE_BAR_HEIGHT } }),
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (show) win.once("ready-to-show", () => win.show());

	// 外部链接（包括 OAuth 授权页）用系统浏览器打开
	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});

	const devUrl = process.env.ELECTRON_RENDERER_URL;
	if (devUrl) void win.loadURL(devUrl);
	else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));

	win.on("closed", () => {
		if (mainWindow === win) mainWindow = undefined;
	});
	return win;
}

app.whenReady().then(async () => {
	registerIpc(backend, () => mainWindow);
	mainWindow = createWindow(!isSmoke);

	if (isSmoke) {
		const code = await runSmokeTest(backend, mainWindow);
		await backend.shutdown();
		app.exit(code);
		return;
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (event) => {
	if (quitting) return;
	quitting = true;
	event.preventDefault();
	void backend.shutdown().finally(() => app.quit());
});
