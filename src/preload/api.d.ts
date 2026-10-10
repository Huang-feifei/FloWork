import type { Transport } from "@shared/protocol";

declare global {
	interface Window {
		/** 仅桌面版存在；网页版使用 WebSocket 传输层 */
		floworkTransport?: Transport;
	}
}
