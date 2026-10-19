import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KERNEL_PROTOCOL_VERSION } from "@shared/kernel";
import { WorkerClient } from "../core/worker-manager";
import { utilityProcess } from "electron";
import type { MainToWorker, WorkerToMain } from "@shared/protocol";
import type { WorkerSpawner } from "../core/worker-process";

const WORKER_PATH = join(import.meta.dirname, "pi-worker.js");

/** 桌面版：以 Electron utilityProcess 启动 pi worker（使用 Electron 自带的 Node） */
export const createUtilitySpawner = (entry: string): WorkerSpawner => ({ serviceName, env }) => {
	const proc = utilityProcess.fork(entry, [], { serviceName, stdio: "pipe", env });
	return {
		postMessage: (message: MainToWorker) => proc.postMessage(message),
		onMessage: (listener) => void proc.on("message", (message: WorkerToMain) => listener(message)),
		onSpawn: (listener) => void proc.once("spawn", listener),
		onExit: (listener) => void proc.on("exit", listener),
		kill: () => void proc.kill(),
		stdout: proc.stdout,
		stderr: proc.stderr,
	};
};

export const spawnUtilityWorker = createUtilitySpawner(WORKER_PATH);
export const bundledWorkerEntry = WORKER_PATH;

/** 隔离配置目录，确认完整 Worker 可导入、协议一致且请求/响应可用；不调用模型。 */
export async function probeUtilityKernel(entry: string): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "flowork-kernel-probe-"));
	let client: WorkerClient | undefined;
	try {
		const spawn = createUtilitySpawner(entry);
		const started = await WorkerClient.start((options) => spawn({
			...options,
			env: { ...options.env, FLOWORK_DATA_DIR: directory, FLOWORK_PI_AGENT_DIR: directory, PI_CODING_AGENT_DIR: directory },
		}), { role: "service", cwd: directory });
		client = started.client;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				client.send({ type: "ping" }),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("内核自检响应超时")), 10_000); }),
			]) as { protocolVersion?: number };
			if (result.protocolVersion !== KERNEL_PROTOCOL_VERSION) throw new Error("内核自检失败：Worker 协议版本不一致");
		} finally { clearTimeout(timer); }
	} finally {
		try { await client?.shutdown(); }
		finally { await rm(directory, { recursive: true, force: true }); }
	}
}
