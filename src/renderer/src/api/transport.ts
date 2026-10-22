/** 桌面应用唯一传输层：preload 暴露的 Electron IPC。 */
import type { BackendPush, Transport } from "@shared/protocol";

const bridge = window.floworkTransport;
if (!bridge) throw new Error("FloWork 需要通过桌面应用启动，Electron preload 桥未加载。");

// contextBridge 限制对象嵌套深度；结果和推送以 JSON 字符串跨桥，在此解析。
export const transport: Transport = {
	request: async (method, params) => JSON.parse(await bridge.request(method, params)) as unknown,
	onPush: (listener) => bridge.onPush((payload) => listener(JSON.parse(payload) as BackendPush)),
};
