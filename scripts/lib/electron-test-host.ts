/** 仅供回归测试的 Electron 主进程：通过父子进程 IPC 调用真实桌面 Backend，不监听端口。 */
import { app } from "electron";
import { join } from "node:path";
import { Backend } from "../../src/core/backend";
import { createUtilitySpawner } from "../../src/main/spawn";
import type { BackendMethod } from "../../src/shared/protocol";

app.setPath("userData", join(process.env.FLOWORK_DATA_DIR!, "electron"));
const clients = new Set<string>();
let closing = false;
const backend = new Backend({
	shell: "electron",
	version: app.getVersion(),
	spawnWorker: createUtilitySpawner(join(import.meta.dirname, "../main/pi-worker.js")),
});
const send = (frame: unknown) => {
	if (process.connected) process.send?.(JSON.stringify(frame));
};
backend.onPush((push) => send({ push }));

async function shutdown(code = 0): Promise<void> {
	if (closing) return;
	closing = true;
	try { await backend.shutdown(); }
	catch (error) { console.error(error); code = 1; }
	app.exit(code);
}

process.on("message", (payload: string) => {
	void (async () => {
		const frame = JSON.parse(payload) as { id: string; kind: string; clientId: string; method: BackendMethod; params: never };
		try {
			if (frame.kind === "shutdown") { await shutdown(); return; }
			let result: unknown = null;
			if (frame.kind === "connect") clients.add(frame.clientId);
			else if (frame.kind === "close") {
				clients.delete(frame.clientId);
				await backend.releaseClient(frame.clientId);
			} else if (frame.kind === "request") {
				if (!clients.has(frame.clientId)) throw new Error("测试客户端已关闭");
				result = await backend.handle(frame.method, frame.params, frame.clientId);
			} else throw new Error("未知测试 IPC 消息");
			send({ id: frame.id, ok: true, result });
		} catch (error) {
			send({ id: frame.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	})().catch((error) => { console.error(error); void shutdown(1); });
});
process.on("disconnect", () => void shutdown());
app.whenReady().then(() => send({ ready: true })).catch((error) => {
	console.error(error);
	void shutdown(1);
});
