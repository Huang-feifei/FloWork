import { METADATA_KEYS, type MetadataKey, type MetadataValues, type ModelMetadata, type ModelSyncState } from "@shared/model-metadata";
import type { ModelDraft } from "../components/settings/ModelDialog";
import { parseTokenLimit } from "./token-limit";

export function draftMetadata(draft: ModelDraft): MetadataValues {
	const values: MetadataValues = {};
	if (draft.name.trim()) values.name = draft.name;
	for (const key of ["contextWindow", "maxTokens"] as const) {
		const n = parseTokenLimit(draft[key]);
		if (n !== undefined) values[key] = n;
	}
	if (draft.reasoning || draft.reasoningSet) values.reasoning = draft.reasoning;
	if (draft.image || draft.imageSet) values.image = draft.image;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (draft.cost[key].trim()) values[`cost.${key}`] = Number(draft.cost[key]);
	}
	return values;
}

export function readSyncState(value: unknown): ModelSyncState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const s = value as ModelSyncState;
	if (!s.values || !s.sources || !Number.isFinite(s.updatedAt)) return undefined;
	const values: MetadataValues = {};
	const sources: ModelSyncState["sources"] = {};
	for (const key of METADATA_KEYS) {
		const v = s.values[key];
		if ((typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) && typeof s.sources[key] === "string") {
			values[key] = v;
			sources[key] = s.sources[key];
		}
	}
	return { values, sources, updatedAt: s.updatedAt, locked: Array.isArray(s.locked) ? s.locked.filter((key) => METADATA_KEYS.includes(key)) : [] };
}

/** 用户改动（含清空和明确关闭）永久退出自动管理。 */
export function protectModelEdits(before: ModelDraft, after: ModelDraft): ModelDraft {
	if (before.id.trim() !== after.id.trim()) return { ...after, sync: undefined };
	const a = draftMetadata(before), b = draftMetadata(after);
	const sync = structuredClone(after.sync ?? { values: {}, sources: {}, updatedAt: 0 });
	const locked = new Set(sync.locked ?? []);
	for (const key of METADATA_KEYS) {
		if (a[key] !== b[key]) {
			locked.add(key);
			delete sync.values[key];
			delete sync.sources[key];
		}
	}
	sync.locked = [...locked];
	return { ...after, sync: Object.keys(sync.values).length || locked.size ? sync : undefined };
}

export function mergeModelMetadata(draft: ModelDraft, metadata: ModelMetadata, now = Date.now()): ModelDraft {
	const next = { ...draft, cost: { ...draft.cost } };
	const current = draftMetadata(draft);
	const sync = structuredClone(draft.sync ?? { values: {}, sources: {}, updatedAt: 0 });
	const locked = new Set<MetadataKey>(sync.locked ?? []);
	for (const key of METADATA_KEYS) {
		const value = metadata.values[key];
		if (value === undefined || locked.has(key)) continue;
		// 非空的手填值、无效输入、附加 JSON 中的 input 都不能被自动覆盖。
		if (sync.values[key] !== undefined ? current[key] !== sync.values[key] : current[key] !== undefined) continue;
		// 离线降级不能用参考资料覆盖先前从真实端点取得的值。
		if (sync.sources[key] === "upstream" && metadata.sources[key] !== "upstream") continue;
		if ((key === "contextWindow" || key === "maxTokens") && next[key].trim() && current[key] === undefined) continue;
		if (key === "image" && next.advanced.trim()) {
			try { if (JSON.parse(next.advanced).input !== undefined) continue; } catch { continue; }
		}
		if (key.startsWith("cost.")) next.cost[key.slice(5) as keyof ModelDraft["cost"]] = String(value);
		else if (key === "reasoning" || key === "image") {
			next[key] = value === true;
			if (key === "reasoning") next.reasoningSet = true;
			else next.imageSet = true;
		} else next[key as "name" | "contextWindow" | "maxTokens"] = String(value);
		sync.values[key] = value;
		sync.sources[key] = metadata.sources[key];
		sync.updatedAt = now;
	}
	next.sync = Object.keys(sync.values).length || sync.locked?.length ? sync : undefined;
	return next;
}
