import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { BROWSER_CHANNELS } from "@shared/browser";
import { type BackendMethod, ELECTRON_CHANNELS } from "@shared/protocol";
import type { Backend } from "../core/backend";
import type { BrowserManager } from "./browser";

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

	ipcMain.handle(ELECTRON_CHANNELS.request, (event, method: BackendMethod, params: unknown) => {
		requireAppFrame(event);
		if (typeof method !== "string") throw new Error("无效后端请求。");
		return backend.handle(method, params as never);
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

	backend.onPush((push) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ELECTRON_CHANNELS.push, push);
	});
}
