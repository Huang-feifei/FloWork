import { type BrowserWindow, ipcMain } from "electron";
import { type BackendMethod, ELECTRON_CHANNELS } from "@shared/protocol";
import type { Backend } from "../core/backend";

/** 桌面版传输层：渲染进程的 request 走 ipcMain.handle，推送走 webContents.send */
export function registerIpc(backend: Backend, getWindow: () => BrowserWindow | undefined): void {
	ipcMain.handle(ELECTRON_CHANNELS.request, (_e, method: BackendMethod, params: unknown) =>
		backend.handle(method, params as never),
	);

	// 自绘标题栏的窗口按钮（Windows / Linux 上标题栏里是自绘按钮）
	ipcMain.handle(ELECTRON_CHANNELS.windowControl, (_e, action: string) => {
		const win = getWindow();
		if (!win || win.isDestroyed()) return;
		if (action === "minimize") win.minimize();
		else if (action === "toggleMaximize") (win.isMaximized() ? win.unmaximize() : win.maximize());
		else if (action === "close") win.close();
	});

	backend.onPush((push) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ELECTRON_CHANNELS.push, push);
	});
}
