/**
 * 桌面 IPC 桥与窗口控制：通过 contextBridge 暴露受限的主进程能力。
 * 包括自绘标题栏的窗口控制。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { type ElectronBridge, ELECTRON_CHANNELS } from "@shared/protocol";
import { BROWSER_CHANNELS, type BrowserBridge, type BrowserState } from "@shared/browser";
import { APP_UPDATE_CHANNELS, type AppUpdateBridge, type AppUpdateState } from "@shared/app-update";

// 只做转发：跨 contextBridge 的载荷一律是 JSON 字符串，解析在渲染进程侧做（见 api/transport.ts）。
// 原因是 contextBridge 不允许超过 1000 层的嵌套，深层对象（如长会话的会话树）必须走字符串。
const transport: ElectronBridge = {
	request: (method, params) => ipcRenderer.invoke(ELECTRON_CHANNELS.request, method, params) as Promise<string>,
	onPush: (listener) => {
		const handler = (_e: IpcRendererEvent, payload: string) => listener(payload);
		ipcRenderer.on(ELECTRON_CHANNELS.push, handler);
		return () => ipcRenderer.off(ELECTRON_CHANNELS.push, handler);
	},
};

const windowControls = {
	minimize: () => ipcRenderer.invoke(ELECTRON_CHANNELS.windowControl, "minimize") as Promise<void>,
	toggleMaximize: () => ipcRenderer.invoke(ELECTRON_CHANNELS.windowControl, "toggleMaximize") as Promise<void>,
	close: () => ipcRenderer.invoke(ELECTRON_CHANNELS.windowControl, "close") as Promise<void>,
};

const browser: BrowserBridge = {
	command: (command) => ipcRenderer.invoke(BROWSER_CHANNELS.command, command),
	onState: (listener) => {
		const handler = (_event: IpcRendererEvent, state: BrowserState) => listener(state);
		ipcRenderer.on(BROWSER_CHANNELS.state, handler);
		return () => ipcRenderer.off(BROWSER_CHANNELS.state, handler);
	},
	onFocusAddress: (listener) => {
		const handler = () => listener();
		ipcRenderer.on(BROWSER_CHANNELS.focusAddress, handler);
		return () => ipcRenderer.off(BROWSER_CHANNELS.focusAddress, handler);
	},
};

const theme = {
	set: (mode: "dark" | "light" | "system") => ipcRenderer.invoke(ELECTRON_CHANNELS.theme, mode) as Promise<void>,
};

contextBridge.exposeInMainWorld("floworkBrowser", browser);
contextBridge.exposeInMainWorld("floworkTransport", transport);
contextBridge.exposeInMainWorld("floworkWindow", windowControls);
contextBridge.exposeInMainWorld("floworkTheme", theme);
const appUpdate: AppUpdateBridge = {
	check: (manual = false) => ipcRenderer.invoke(APP_UPDATE_CHANNELS.check, manual),
	open: (version) => ipcRenderer.invoke(APP_UPDATE_CHANNELS.open, version),
	status: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.status),
	onStatus: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => listener(state);
		ipcRenderer.on(APP_UPDATE_CHANNELS.changed, handler);
		return () => ipcRenderer.off(APP_UPDATE_CHANNELS.changed, handler);
	},
	install: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.install),
};
contextBridge.exposeInMainWorld("floworkAppUpdate", appUpdate);
// 仅由未打包应用的隔离截图模式传入，不在普通桌面运行时暴露调试状态。
if (process.argv.includes("--flowork-ui-screenshot")) contextBridge.exposeInMainWorld("floworkScreenshot", true);
