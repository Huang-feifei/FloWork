import { fork } from "node:child_process";
import { join } from "node:path";
import type { MainToWorker, WorkerToMain } from "@shared/protocol";
import type { WorkerSpawner } from "../core/worker-process";

const WORKER_PATH = join(import.meta.dirname, "pi-worker.js");

/** 网页版：以 Node 子进程启动 pi worker */
export const spawnNodeWorker: WorkerSpawner = ({ env }) => {
	const child = fork(WORKER_PATH, [], {
		env,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		serialization: "advanced",
	});
	return {
		postMessage: (message: MainToWorker) => {
			if (child.connected) child.send(message);
		},
		onMessage: (listener) => child.on("message", (message) => listener(message as WorkerToMain)),
		onSpawn: (listener) => child.once("spawn", listener),
		onExit: (listener) => child.on("exit", (code) => listener(code ?? 1)),
		kill: () => child.kill(),
		stdout: child.stdout,
		stderr: child.stderr,
	};
};
