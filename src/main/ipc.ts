import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent, nativeTheme } from "electron";
import { BROWSER_CHANNELS } from "@shared/browser";
import { type BackendMethod, ELECTRON_CHANNELS } from "@shared/protocol";
import type { Backend } from "../core/backend";
import type { BrowserManager } from "./browser";

/** 窗口背景色：只在页面渲染前可见，需与 styles.css 的 --color-window 一致 */
const DARK_WINDOW_BG = "#0d1222";
const LIGHT_WINDOW_BG = "#eef1f6";

/** 桌面版传输层：渲染进程的 request 走 ipcMain.handle，推送走 webContents.send */
export function registerIpc(
	backend: Backend,
	getWindow: () => BrowserWindow | undefined,
	getBrowser: (win: BrowserWindow) => BrowserManager | undefined,
	isAppUrl: (url: string) => boolean,
): void {
	const requireAppFrame = (event: IpcMainInvokeEvent): BrowserWindow => {
		const win = getWindow();
		if (!win || win.isDestroyed() || event.sender !== win.webContents ||
			event.senderFrame !== win.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) {
			throw new Error("IPC 请求必须来自 FloWork 应用主框架。");
		}
		return win;
	};

	// 请求与推送都先序列化成字符串再跨进程：contextBridge 只允许 1000 层嵌套，
	// 而会话树这种「每多一条记录就深一层」的数据很容易越界（实测 330 层左右就报错）。
	// 将结果序列化后跨 contextBridge，避免长会话树触发对象嵌套深度限制。
	ipcMain.handle(ELECTRON_CHANNELS.request, async (event, method: BackendMethod, params: unknown) => {
		requireAppFrame(event);
		if (typeof method !== "string") throw new Error("无效后端请求。");
		return JSON.stringify(await backend.handle(method, params as never));
	});

	ipcMain.handle(BROWSER_CHANNELS.command, (event, command: unknown) => {
		const manager = getBrowser(requireAppFrame(event));
		if (!manager) throw new Error("浏览器窗口不可用。");
		return manager.command(command);
	});

	// 自绘标题栏的窗口按钮（Windows / Linux 上标题栏里是自绘按钮）
	ipcMain.handle(ELECTRON_CHANNELS.windowControl, (event, action: string) => {
		const win = requireAppFrame(event);
		if (action === "minimize") win.minimize();
		else if (action === "toggleMaximize") (win.isMaximized() ? win.unmaximize() : win.maximize());
		else if (action === "close") win.close();
	});

	// 界面主题：同步 nativeTheme（影响原生控件与系统深浅色判断）并更新窗口背景色
	ipcMain.handle(ELECTRON_CHANNELS.theme, (event, mode: unknown) => {
		if (mode !== "dark" && mode !== "light" && mode !== "system") throw new Error("无效主题。");
		const win = requireAppFrame(event);
		nativeTheme.themeSource = mode;
		win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_WINDOW_BG : LIGHT_WINDOW_BG);
	});

	backend.onPush((push) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ELECTRON_CHANNELS.push, JSON.stringify(push));
	});
}
