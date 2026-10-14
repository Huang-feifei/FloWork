/**
 * pi 配置文件（settings.json / models.json）的并发安全读写。
 *
 * 命令处理不排队（worker 收到就 void 执行），界面保存整份文本与资源页的「读 → 改 → 写」可能同时到达：
 * 各自覆盖写会丢掉对方的修改，写入中途被打断还会留下半截 JSON。
 * 这里把同一路径的所有写入排进一条 promise 链，并统一用「同目录临时文件 + rename」替换。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_MTIME_CONFLICT } from "@shared/protocol";

/** 每个路径一条队列；不同路径互不阻塞 */
const queues = new Map<string, Promise<unknown>>();

/** 把任务接到该路径队列末尾；前一个任务失败不会卡住后续任务 */
function withQueue<T>(path: string, task: () => Promise<T>): Promise<T> {
	const key = resolve(path);
	const previous = queues.get(key) ?? Promise.resolve();
	const run = previous.then(task);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, settled);
	void settled.then(() => {
		// 队列排空后清理，避免处理过的路径一直留在 Map 里
		if (queues.get(key) === settled) queues.delete(key);
	});
	return run;
}

/** 写同目录临时文件再 rename 覆盖，保证读到的要么是旧内容要么是新内容 */
async function atomicWrite(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
	try {
		await writeFile(tmp, text, "utf8");
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** 文件不存在时返回 0，与协议里的 mtime 约定一致 */
async function currentMtime(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return 0;
	}
}

export interface WriteConfigFileOptions {
	/** 保存前要求的磁盘 mtime（文件不存在为 0）；不一致说明已被外部改动。不传则不校验（兼容旧调用） */
	expectedMtime?: number;
	/** 冲突提示里显示的文件名，默认取路径的文件名 */
	label?: string;
}

export async function writeConfigFile(path: string, text: string, options: WriteConfigFileOptions = {}): Promise<void> {
	await withQueue(path, async () => {
		if (options.expectedMtime !== undefined) {
			const actual = await currentMtime(path);
			// 不同文件系统的 mtime 精度不同，允许 1ms 误差
			if (Math.abs(actual - options.expectedMtime) > 1) {
				throw new Error(`${options.label ?? basename(path)} ${CONFIG_MTIME_CONFLICT}，请重新加载后再保存`);
			}
		}
		await atomicWrite(path, text);
	});
}

export interface UpdateConfigFileOptions {
	/** 自定义序列化；默认 JSON.stringify(data, null, 2) + 换行 */
	serialize?: (data: Record<string, unknown>) => string;
}

/**
 * 读 → 解析 → 改 → 写 整体在临界区内完成，中间不会插入别的写入。
 * mutate 收到解析后的对象，可以原地修改，也可以返回新对象。
 */
export async function updateConfigFile(
	path: string,
	mutate: (data: Record<string, unknown>) => Record<string, unknown> | void,
	options: UpdateConfigFileOptions = {},
): Promise<void> {
	await withQueue(path, async () => {
		const data = await readObject(path);
		const next = mutate(data) ?? data;
		const serialize = options.serialize ?? ((value: Record<string, unknown>) => `${JSON.stringify(value, null, 2)}\n`);
		await atomicWrite(path, serialize(next));
	});
}

/** 读并解析配置文件；不存在按 {} 处理（读失败仍然抛错，避免把不可读的文件当成空配置覆盖） */
async function readObject(path: string): Promise<Record<string, unknown>> {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`${basename(path)} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${basename(path)} 顶层必须是对象`);
	return parsed as Record<string, unknown>;
}
