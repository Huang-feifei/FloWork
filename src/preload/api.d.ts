import type { Transport } from "@shared/protocol";
import type { BrowserBridge } from "@shared/browser";

declare global {
	interface Window {
		/** 仅桌面版存在；网页版使用 WebSocket 传输层 */
		floworkTransport?: Transport;
		floworkBrowser?: BrowserBridge;
		/** 仅桌面版存在：自绘标题栏的窗口按钮 */
		floworkWindow?: {
			minimize: () => Promise<void>;
			toggleMaximize: () => Promise<void>;
			close: () => Promise<void>;
		};
		/** 仅桌面版存在：把界面主题同步给主进程（nativeTheme + 窗口背景色） */
		floworkTheme?: {
			set: (mode: "dark" | "light" | "system") => Promise<void>;
		};
	}
}
