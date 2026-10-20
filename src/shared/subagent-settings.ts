/**
 * 子代理全局设置。写入 pi 的 settings.json：
 *
 *   "flowork": {
 *     "subagent": {
 *       "enabled": true,
 *       "maxTasks": 8,
 *       "maxConcurrency": 4,
 *       "defaultModel": "provider/model-id"
 *     }
 *   }
 *
 * 界面只改这个命名空间，不碰 settings.json 里的其他 pi 配置。
 */

export const MAX_SUBAGENT_TASKS = 8;
export const MAX_SUBAGENT_CONCURRENCY = 4;

/** 总开关打开、任务与并发取硬上限；未写 model 时跟随父会话。 */
export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
	enabled: true,
	maxTasks: MAX_SUBAGENT_TASKS,
	maxConcurrency: MAX_SUBAGENT_CONCURRENCY,
};

export interface SubagentSettings {
	/** 关闭后新会话不再注册 subagent 工具 */
	enabled: boolean;
	/** parallel 模式一次最多接受的任务数 */
	maxTasks: number;
	/** parallel 模式同时运行的子代理数 */
	maxConcurrency: number;
	/** agent 文件没有写 model 时使用的模型；留空则继承父会话 */
	defaultModel?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

/** 把任意配置值收拢到安全范围，避免损坏的 JSON 让工具直接不可用或突破硬上限。 */
export function normalizeSubagentSettings(value: unknown): SubagentSettings {
	const raw = asRecord(value);
	const maxTasks = intInRange(raw.maxTasks, MAX_SUBAGENT_TASKS, 1, MAX_SUBAGENT_TASKS);
	const maxConcurrency = intInRange(
		raw.maxConcurrency,
		MAX_SUBAGENT_CONCURRENCY,
		1,
		Math.min(MAX_SUBAGENT_CONCURRENCY, maxTasks),
	);
	const defaultModel = typeof raw.defaultModel === "string" && raw.defaultModel.trim() ? raw.defaultModel.trim() : undefined;
	return {
		enabled: raw.enabled !== false,
		maxTasks,
		maxConcurrency,
		...(defaultModel ? { defaultModel } : {}),
	};
}

/** 从完整的 settings.json 对象读取 flowork.subagent。 */
export function readSubagentSettings(settings: unknown): SubagentSettings {
	return normalizeSubagentSettings(asRecord(asRecord(settings).flowork).subagent);
}

/** 写回完整的 settings.json 对象；保留其他 pi 配置和 flowork 下的其他键。 */
export function writeSubagentSettings(
	settings: Record<string, unknown>,
	value: SubagentSettings,
): Record<string, unknown> {
	const normalized = normalizeSubagentSettings(value);
	const flowork = { ...asRecord(settings.flowork) };
	flowork.subagent = {
		enabled: normalized.enabled,
		maxTasks: normalized.maxTasks,
		maxConcurrency: normalized.maxConcurrency,
		...(normalized.defaultModel ? { defaultModel: normalized.defaultModel } : {}),
	};
	return { ...settings, flowork };
}
