/** 模型元数据只描述能力，不推断端点协议、headers 或思考参数映射。 */
export const METADATA_KEYS = ["name", "contextWindow", "maxTokens", "reasoning", "image", "cost.input", "cost.output", "cost.cacheRead", "cost.cacheWrite"] as const;
export type MetadataKey = (typeof METADATA_KEYS)[number];
export type MetadataValues = Partial<Record<MetadataKey, string | number | boolean>>;
export interface CatalogModel {
	provider: string;
	id: string;
	api?: string;
	values: MetadataValues;
}
export interface ModelMetadata {
	id: string;
	values: MetadataValues;
	sources: Partial<Record<MetadataKey, string>>;
	/** 不确定的匹配只能经用户选择后使用。 */
	candidates: CatalogModel[];
}
export interface ModelMetadataResult {
	models: ModelMetadata[];
	catalogStatus: "fresh" | "cached" | "stale" | "unavailable";
	catalogUpdatedAt?: number;
	warning?: string;
}
/** 与模型条目分开存在 provider.modelSync 中，不传给模型协议。 */
export interface ModelSyncState {
	locked?: MetadataKey[];
	values: MetadataValues;
	sources: Partial<Record<MetadataKey, string>>;
	updatedAt: number;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readMetadata(value: unknown): MetadataValues {
	const m = record(value);
	const result: MetadataValues = {};
	if (typeof m.name === "string" && m.name.trim()) result.name = m.name;
	const limit = record(m.limit);
	for (const [key, candidates] of [
		["contextWindow", [m.contextWindow, m.context_window, m.context_length, limit.context]],
		["maxTokens", [m.maxTokens, m.max_output_tokens, m.max_completion_tokens, limit.output]],
	] as const) {
		const n = candidates.find((n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0);
		if (typeof n === "number") result[key] = n;
	}
	if (typeof m.reasoning === "boolean") result.reasoning = m.reasoning;
	const input = record(m.modalities).input ?? m.input;
	if (Array.isArray(input) && input.length > 0 && input.every((v) => typeof v === "string")) result.image = input.includes("image");
	const cost = record(m.cost);
	for (const [key, alias] of [["input", "input"], ["output", "output"], ["cacheRead", "cache_read"], ["cacheWrite", "cache_write"]] as const) {
		const n = cost[key] ?? cost[alias];
		if (typeof n === "number" && Number.isFinite(n) && n >= 0) result[`cost.${key}`] = n;
	}
	return result;
}

export function parseCatalog(value: unknown): CatalogModel[] {
	const result: CatalogModel[] = [];
	for (const [provider, raw] of Object.entries(record(value))) {
		const p = record(raw);
		for (const [key, model] of Object.entries(record(p.models))) {
			const m = record(model);
			const id = typeof m.id === "string" ? m.id : key;
			const modalities = record(m.modalities);
			// 图片生成、音频等模型不误当作聊天模型补全。
			if (Array.isArray(modalities.output) && !modalities.output.includes("text")) continue;
			const values = readMetadata(m);
			if (id && Object.keys(values).length) result.push({ provider, id, api: typeof p.api === "string" ? p.api : undefined, values });
		}
	}
	return result;
}

function host(url?: string): string | undefined {
	try { return new URL(url ?? "").hostname.toLowerCase(); } catch { return undefined; }
}

export function resolveMetadata(id: string, upstream: MetadataValues, catalog: CatalogModel[], provider: string, baseUrl: string): ModelMetadata {
	const result: ModelMetadata = { id, values: { ...upstream }, sources: {}, candidates: [] };
	for (const key of METADATA_KEYS) if (upstream[key] !== undefined) result.sources[key] = "upstream";
	let matches = catalog.filter((m) => m.id === id);
	const preferred = matches.filter((m) => m.provider === provider || (host(baseUrl) !== undefined && host(m.api) === host(baseUrl)));
	if (preferred.length === 1) matches = preferred;
	if (matches.length === 1) return applyCatalogMatch(result, matches[0]!);
	// 只提供确切 ID / 去掉一个命名空间后的候选；绝不猜版本、日期、latest 别名。
	const suffix = id.includes("/") ? id.slice(id.indexOf("/") + 1) : undefined;
	result.candidates = matches.length ? matches : suffix ? catalog.filter((m) => m.id === suffix) : [];
	return result;
}

export function applyCatalogMatch(metadata: ModelMetadata, candidate: CatalogModel): ModelMetadata {
	const result = { ...metadata, values: { ...metadata.values }, sources: { ...metadata.sources }, candidates: [] };
	for (const key of METADATA_KEYS) {
		if (result.values[key] === undefined && candidate.values[key] !== undefined) {
			result.values[key] = candidate.values[key];
			result.sources[key] = `models.dev:${candidate.provider}/${candidate.id}`;
		}
	}
	return result;
}
