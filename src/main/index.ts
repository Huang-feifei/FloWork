import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from "electron";
import kernelConfig from "../../kernel.config.json";
import appPackage from "../../package.json";
import { Backend } from "../core/backend";
import { KernelUpdater } from "../core/kernel-updater";
import { BrowserManager } from "./browser";
import { registerIpc } from "./ipc";
import { runSmokeTest } from "./smoke";
import { runUIScreenshot } from "./screenshot";
import { bundledAdapterEntry, bundledWorkerEntry, createUtilitySpawner, probeUtilityKernel } from "./spawn";

const isSmoke = process.argv.includes("--smoke");
const isUIShot = process.argv.includes("--ui-screenshot");
// 测试和截图隔离 Electron 自身的数据，不读取真实用户的缓存与内核选择。
if (process.env.FLOWORK_DATA_DIR) app.setPath("userData", join(process.env.FLOWORK_DATA_DIR, "electron"));
if (isUIShot && (app.isPackaged || !process.env.FLOWORK_DATA_DIR)) throw new Error("界面截图仅支持隔离数据目录下的未打包应用");
let mainWindow: BrowserWindow | undefined;
const browsers = new WeakMap<BrowserWindow, BrowserManager>();

/** 开发模式下的窗口图标；打包后 exe 图标由 electron-builder 从 build/icon.ico 设置，窗口自动沿用 */
const windowIcon = (() => {
	const candidate = join(import.meta.dirname, "../../build/icon.ico");
	return existsSync(candidate) ? candidate : undefined;
})();

/** 应用自身地址：开发模式是 Vite dev server，生产是打包进 asar 的 index.html */
const devUrl = process.env.ELECTRON_RENDERER_URL;
const appUrl = devUrl ?? pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href;

/** 只允许 http/https 交给系统浏览器：页面里的链接与 OAuth 跳转都可能带 file:、自定义 scheme 等协议 */
function openExternalIfAllowed(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		console.warn(`[flowork] 已拒绝打开无法解析的链接：${url}`);
		return;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		console.warn(`[flowork] 已拒绝打开非 http(s) 链接：${url}`);
		return;
	}
	void shell.openExternal(parsed.toString());
}

/** 页面导航是否留在应用自身：生产只认那一个本地文件，开发认 Vite dev server 的同源地址 */
function isAppUrl(url: string): boolean {
	try {
		const target = new URL(url);
		const self = new URL(appUrl);
		if (self.protocol === "file:") return target.protocol === "file:" && target.pathname === self.pathname;
		return target.origin === self.origin;
	} catch {
		return false;
	}
}

// 私有仓库测试凭据只留在主进程更新器内，不继承到 Pi / 数据库等子进程。
const kernelGithubToken = process.env.FLOWORK_KERNEL_GITHUB_TOKEN;
delete process.env.FLOWORK_KERNEL_GITHUB_TOKEN;
const kernelUpdates = new KernelUpdater({
	directory: () => join(app.getPath("userData"), "kernels"),
	repository: kernelConfig.repository,
	publicKey: kernelConfig.publicKey,
	githubToken: kernelGithubToken,
	appVersion: app.getVersion(),
	nodeVersion: process.versions.node,
	electronVersion: process.versions.electron,
	platform: process.platform,
	arch: process.arch,
	bundled: { version: kernelConfig.bundledVersion, piVersion: appPackage.dependencies["@earendil-works/pi-coding-agent"], entry: bundledWorkerEntry },
	adapterEntry: bundledAdapterEntry,
	probe: probeUtilityKernel,
});

const backend = new Backend({
	shell: "electron",
	version: app.getVersion(),
	spawnWorker: (options) => createUtilitySpawner(kernelUpdates.workerEntry)(options),
	kernelUpdates,
	restartForKernel: async () => {
		const options = {
			type: "question" as const,
			buttons: ["取消", "重启并应用内核"], defaultId: 0, cancelId: 0,
			message: "重启 FloWork 以切换内核？",
			detail: "打开的会话将关闭，终端连接与尚未完成的登录会中断。已保存的会话记录和配置不会删除。",
		};
		const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
		if (result.response !== 1) return;
		if (backend.workers.hasBusySessions()) throw new Error("有会话正在运行，请先结束或中断任务");
		// 先让 IPC 返回；before-quit 会统一释放 worker 与终端。
		setTimeout(() => {
			if (backend.workers.hasBusySessions()) return; // IPC 返回后若又开始了任务，不打断新任务。
			app.relaunch(); app.quit();
		}, 200);
	},
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
	// 挑选 SSH 私钥文件
	pickFile: async () => {
		const options = {
			properties: ["openFile" as const],
			filters: [{ name: "私钥", extensions: ["pem", "key", "ppk", "*"] }],
		};
		const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	},
	pickDatabaseFile: async () => {
		const options = { properties: ["openFile" as const], filters: [{ name: "SQLite 数据库", extensions: ["db", "sqlite", "sqlite3", "db3"] }, { name: "所有文件", extensions: ["*"] }] };
		const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	},
	// 下载远端文件时选保存位置
	pickSavePath: async (defaultName?: string) => {
		const options = { defaultPath: defaultName };
		const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
		return result.canceled || !result.filePath ? null : result.filePath;
	},
	// SSH 密码落盘前用系统加密（Windows 上是 DPAPI，绑定当前系统用户）
	secrets: {
		available: () => app.isReady() && safeStorage.isEncryptionAvailable(),
		encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
		decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, "base64")),
	},
	// 删除走系统回收站，可恢复
	trashItem: (abs) => shell.trashItem(abs),
	// 在资源管理器中定位
	revealItem: (abs) => shell.showItemInFolder(abs),
	// 在系统终端中打开所在目录（文件则用其父目录）
	openTerminal: (abs) => {
		let dir = abs;
		try {
			if (!statSync(abs).isDirectory()) dir = dirname(abs);
		} catch {
			dir = dirname(abs);
		}
		const command = process.platform === "win32" ? "cmd.exe" : (process.env.TERMINAL ?? "x-terminal-emulator");
		const args = process.platform === "win32" ? ["/c", "start", "cmd.exe"] : [];
		spawn(command, args, { cwd: dir, detached: true, stdio: "ignore" }).unref();
	},
});

function createWindow(show = true): BrowserWindow {
	const isMac = process.platform === "darwin";
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1000,
		minHeight: 640,
		show: false,
		title: "FloWork",
		...(windowIcon ? { icon: windowIcon } : {}),
		// 页面渲染前可见的窗口底色，需与 styles.css 的 --color-window 一致
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#141417" : "#f5f5f7",
		autoHideMenuBar: true,
		// 自绘标题栏：整条栏为拖拽区，最小化 / 最大化 / 关闭由界面自绘（与设计稿一致），
		// 因此 Windows / Linux 不再使用系统 titleBarOverlay；macOS 保留红绿灯。
		titleBarStyle: "hidden",
		...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : {}),
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			additionalArguments: isUIShot ? ["--flowork-ui-screenshot"] : [],
			// 隐藏的截图窗口也要提交 React 的异步视图，不能被后台帧率限制挂起。
			backgroundThrottling: !isUIShot,
		},
	});

	if (show) win.once("ready-to-show", () => win.show());

	// 外部链接（包括 OAuth 授权页）用系统浏览器打开，其它协议一律拒绝
	win.webContents.setWindowOpenHandler(({ url }) => {
		openExternalIfAllowed(url);
		return { action: "deny" };
	});

	// 页面内跳转只允许留在应用自身；其余一律拦下，能开就交给系统浏览器（避免应用窗口被导航到外部页面）
	win.webContents.on("will-navigate", (event, url) => {
		if (isAppUrl(url)) return;
		event.preventDefault();
		openExternalIfAllowed(url);
	});

	browsers.set(win, new BrowserManager(win, appUrl));
	if (devUrl) void win.loadURL(devUrl);
	else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));

	win.on("closed", () => {
		browsers.delete(win);
		if (mainWindow === win) mainWindow = undefined;
	});
	return win;
}

app.whenReady().then(async () => {
	await kernelUpdates.initialize();
	registerIpc(backend, () => mainWindow, (win) => browsers.get(win), isAppUrl);
	mainWindow = createWindow(!isSmoke && !isUIShot);

	if (isSmoke || isUIShot) {
		const code = isUIShot ? await runUIScreenshot(mainWindow) : await runSmokeTest(backend, mainWindow);
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
