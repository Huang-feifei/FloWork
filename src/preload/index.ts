/**
 * 桌面版传输层与窗口控制：与网页版的 WebSocket 传输层实现同一个 Transport 接口。
 * 窗口控制只在桌面版存在（自绘标题栏的窗口按钮）。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { type BackendPush, ELECTRON_CHANNELS, type Transport } from "@shared/protocol";

const transport: Transport = {
	request: (method, params) => ipcRenderer.invoke(ELECTRON_CHANNELS.request, method, params),
	onPush: (listener) => {
		const handler = (_e: IpcRendererEvent, push: BackendPush) => listener(push);
		ipcRenderer.on(ELECTRON_CHANNELS.push, handler);
		return () => ipcRenderer.off(ELECTRON_CHANNELS.push, handler);
	},
};

const windowControls = {
	minimize: () => ipcRenderer.invoke(ELECTRON_CHANNELS.windowControl, "minimize") as Promise<void>,
	toggleMaximize: () => ipcRenderer.invoke(ELECTRON_CHANNELS.windowControl, "toggleMaximize") as Promise<void>,
	close: () => ipcRenderer.invoke(ELECTRON_CHANNELS.windowControl, "close") as Promise<void>,
};

contextBridge.exposeInMainWorld("floworkTransport", transport);
contextBridge.exposeInMainWorld("floworkWindow", windowControls);
