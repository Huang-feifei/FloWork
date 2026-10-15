/**
 * 传输层选择：桌面版使用 preload 暴露的 window.floworkTransport（Electron IPC），
 * 网页版使用 WebSocket 连接本地后端（src/server）。两者实现同一个 Transport 接口。
 */
import type { BackendMethod, BackendPush, ClientFrame, ServerFrame, Transport } from "@shared/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface ManagedTransport extends Transport {
	onStatus(listener: (status: ConnectionStatus) => void): () => void;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

class WebSocketTransport implements ManagedTransport {
	private socket: WebSocket | undefined;
	private readonly pending = new Map<string, Pending>();
	private readonly queue: string[] = [];
	private readonly pushListeners = new Set<(push: BackendPush) => void>();
	private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
	private retryDelay = 500;

	constructor(private readonly url: string) {
		this.connect();
	}

	private setStatus(status: ConnectionStatus): void {
		for (const listener of this.statusListeners) listener(status);
	}

	private connect(): void {
		this.setStatus("connecting");
		const socket = new WebSocket(this.url);
		this.socket = socket;
		socket.onopen = () => {
			this.retryDelay = 500;
			for (const frame of this.queue.splice(0)) socket.send(frame);
			this.setStatus("open");
		};
		socket.onmessage = (event) => {
			const frame = JSON.parse(String(event.data)) as ServerFrame;
			if ("push" in frame) {
				for (const listener of this.pushListeners) listener(frame.push);
				return;
			}
			const pending = this.pending.get(frame.id);
			if (!pending) return;
			this.pending.delete(frame.id);
			if (frame.ok) pending.resolve(frame.result);
			else pending.reject(new Error(frame.error));
		};
		socket.onclose = () => {
			for (const pending of this.pending.values()) pending.reject(new Error("与本地后端的连接已断开"));
			this.pending.clear();
			this.setStatus("closed");
			setTimeout(() => this.connect(), this.retryDelay);
			this.retryDelay = Math.min(this.retryDelay * 2, 5000);
		};
	}

	request(method: BackendMethod, params: unknown): Promise<unknown> {
		const id = crypto.randomUUID();
		const frame: ClientFrame = { id, method, params };
		const text = JSON.stringify(frame);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
			else this.queue.push(text);
		});
	}

	onPush(listener: (push: BackendPush) => void): () => void {
		this.pushListeners.add(listener);
		return () => this.pushListeners.delete(listener);
	}

	onStatus(listener: (status: ConnectionStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}
}

function createTransport(): ManagedTransport {
	const electron = window.floworkTransport;
	if (electron) {
		// 桌面版：主进程与 preload 只传 JSON 字符串（contextBridge 不允许超过 1000 层嵌套，
		// 长会话的会话树会越界），解析放在渲染进程侧，与网页版的 WebSocket 形态一致。
		return {
			request: async (method, params) => JSON.parse(await electron.request(method, params)) as unknown,
			onPush: (listener) => electron.onPush((payload) => listener(JSON.parse(payload) as BackendPush)),
			onStatus: () => () => undefined,
		};
	}
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return new WebSocketTransport(`${protocol}//${location.host}/ws`);
}

export const transport = createTransport();
