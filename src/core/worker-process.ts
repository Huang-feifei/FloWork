/**
 * Electron utilityProcess worker 的最小接口，可在单元测试中注入替身。
 */
import type { MainToWorker, WorkerToMain } from "@shared/protocol";

/** 只用到 on("data")，同时兼容 Node 的 Readable 与 Electron utilityProcess 的输出流 */
interface OutputStream {
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
}

export interface WorkerProcess {
	postMessage(message: MainToWorker): void;
	onMessage(listener: (message: WorkerToMain) => void): void;
	onSpawn(listener: () => void): void;
	onExit(listener: (code: number) => void): void;
	kill(): void;
	stdout?: OutputStream | null;
	stderr?: OutputStream | null;
}

export type WorkerSpawner = (options: { serviceName: string; env: NodeJS.ProcessEnv }) => WorkerProcess;
