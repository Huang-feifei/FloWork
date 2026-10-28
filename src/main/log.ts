/**
 * 主进程日志：写入 <数据目录>/logs/main.log，超过上限时把上一份轮换为 main.log.1。
 *
 * 崩溃与未捕获异常路径里必须先把日志落盘，因此用同步写；磁盘不可写时静默放弃，
 * 日志失败绝不能打断应用本身。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getFloworkDataDir } from "../core/paths";

const MAX_BYTES = 2 * 1024 * 1024;

let logFile: string | undefined;

function logDir(): string {
	return join(getFloworkDataDir(), "logs");
}

function logPath(): string {
	if (!logFile) logFile = join(logDir(), "main.log");
	return logFile;
}

/** 当前日志文件路径；崩溃提示里直接展示，省得用户自己找 */
export function currentLogFile(): string {
	return logPath();
}

/** 写一行日志；同时回显到 stderr，便于开发模式直接在终端看到 */
export function logLine(scope: string, message: string): void {
	const line = `${new Date().toISOString()} [${scope}] ${message}`;
	console.error(line);
	try {
		mkdirSync(logDir(), { recursive: true });
		const path = logPath();
		try {
			if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
		} catch {
			/* 文件还不存在，或轮换失败：继续追加 */
		}
		appendFileSync(path, `${line}\n`, "utf8");
	} catch {
		/* 磁盘不可写：放弃写盘，保留上面的 stderr 输出 */
	}
}

export function errorText(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}

/** 记录异常（含堆栈） */
export function logError(scope: string, error: unknown): void {
	logLine(scope, errorText(error));
}
