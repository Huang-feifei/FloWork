import type { Transport } from "@shared/protocol";

declare global {
	interface Window {
		/** 仅桌面版存在；网页版使用 WebSocket 传输层 */
		floworkTransport?: Transport;
		/** 仅桌面版存在：自绘标题栏的窗口按钮 */
		floworkWindow?: {
			minimize: () => Promise<void>;
			toggleMaximize: () => Promise<void>;
			close: () => Promise<void>;
		};
	}
}
