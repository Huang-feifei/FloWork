import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { type BackendPush, ELECTRON_CHANNELS, type Transport } from "@shared/protocol";

/** 桌面版传输层：与网页版的 WebSocket 传输层实现同一个 Transport 接口 */
const transport: Transport = {
	request: (method, params) => ipcRenderer.invoke(ELECTRON_CHANNELS.request, method, params),
	onPush: (listener) => {
		const handler = (_e: IpcRendererEvent, push: BackendPush) => listener(push);
		ipcRenderer.on(ELECTRON_CHANNELS.push, handler);
		return () => ipcRenderer.off(ELECTRON_CHANNELS.push, handler);
	},
};

contextBridge.exposeInMainWorld("floworkTransport", transport);
