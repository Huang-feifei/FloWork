import { type BrowserWindow, ipcMain } from "electron";
import { type BackendMethod, ELECTRON_CHANNELS } from "@shared/protocol";
import type { Backend } from "../core/backend";

/** 桌面版传输层：渲染进程的 request 走 ipcMain.handle，推送走 webContents.send */
export function registerIpc(backend: Backend, getWindow: () => BrowserWindow | undefined): void {
	ipcMain.handle(ELECTRON_CHANNELS.request, (_e, method: BackendMethod, params: unknown) =>
		backend.handle(method, params as never),
	);

	backend.onPush((push) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ELECTRON_CHANNELS.push, push);
	});
}
