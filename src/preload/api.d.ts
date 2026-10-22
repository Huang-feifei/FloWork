import type { ElectronBridge } from "@shared/protocol";
import type { BrowserBridge } from "@shared/browser";

declare global {
	interface Window {
		/** 仅隔离截图模式：允许注入示例界面状态 */
		floworkScreenshot?: boolean;
		/** Electron IPC，跨桥的载荷是 JSON 字符串 */
		floworkTransport: ElectronBridge;
		floworkBrowser: BrowserBridge;
		/** 自绘标题栏的窗口按钮 */
		floworkWindow: {
			minimize: () => Promise<void>;
			toggleMaximize: () => Promise<void>;
			close: () => Promise<void>;
		};
		/** 把界面主题同步给主进程（nativeTheme + 窗口背景色） */
		floworkTheme: {
			set: (mode: "dark" | "light" | "system") => Promise<void>;
		};
	}
}
