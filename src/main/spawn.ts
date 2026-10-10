import { join } from "node:path";
import { utilityProcess } from "electron";
import type { MainToWorker, WorkerToMain } from "@shared/protocol";
import type { WorkerSpawner } from "../core/worker-process";

const WORKER_PATH = join(import.meta.dirname, "pi-worker.js");

/** 桌面版：以 Electron utilityProcess 启动 pi worker（使用 Electron 自带的 Node） */
export const spawnUtilityWorker: WorkerSpawner = ({ serviceName, env }) => {
	const proc = utilityProcess.fork(WORKER_PATH, [], { serviceName, stdio: "pipe", env });
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
