import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseCatalog, readMetadata, resolveMetadata, type CatalogModel, type ModelMetadataResult, type MetadataValues } from "@shared/model-metadata";

const TTL = 24 * 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;
type CatalogSnapshot = { updatedAt: number; models: CatalogModel[] };

/** 仅缓存公开模型资料；端点凭据、URL、上游响应不落盘也不发送给 models.dev。 */
export class ModelMetadataService {
	private snapshot?: CatalogSnapshot;
	private pending?: Promise<{ snapshot?: CatalogSnapshot; status: ModelMetadataResult["catalogStatus"]; warning?: string }>;
	constructor(private readonly cachePath: string, private readonly request: typeof fetch = fetch, private readonly now = Date.now) {}

	private async catalog(force: boolean) {
		if (!this.snapshot) {
			try {
				const text = await readFile(this.cachePath, "utf8");
				if (text.length > MAX_BYTES) throw new Error("缓存过大");
				const saved = JSON.parse(text);
				const models = parseCatalog(saved.data);
				if (saved.version === 1 && Number.isFinite(saved.updatedAt) && models.length) this.snapshot = { updatedAt: saved.updatedAt, models };
			} catch { /* 缓存缺失或损坏不影响使用 */ }
		}
		if (!force && this.snapshot && this.now() - this.snapshot.updatedAt < TTL) return { snapshot: this.snapshot, status: "cached" as const };
		if (this.pending) return this.pending;
		this.pending = (async () => {
			try {
				const response = await this.request("https://models.dev/api.json", { signal: AbortSignal.timeout(15_000) });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const text = await response.text();
				if (text.length > MAX_BYTES) throw new Error("资料库过大");
				const data: unknown = JSON.parse(text);
				const models = parseCatalog(data);
				if (!models.length) throw new Error("资料库没有有效模型");
				this.snapshot = { updatedAt: this.now(), models };
				const temp = `${this.cachePath}.${randomUUID()}.tmp`;
				try {
					await mkdir(dirname(this.cachePath), { recursive: true });
					await writeFile(temp, JSON.stringify({ version: 1, updatedAt: this.snapshot.updatedAt, data }), "utf8");
					await rename(temp, this.cachePath);
				} catch { /* 只读磁盘仍可使用内存资料 */ }
				finally { await rm(temp, { force: true }).catch(() => {}); }
				return { snapshot: this.snapshot, status: "fresh" as const };
			} catch {
				return { snapshot: this.snapshot, status: this.snapshot ? "stale" as const : "unavailable" as const,
					warning: this.snapshot ? "models.dev 更新失败，使用本地缓存。" : "models.dev 暂不可用，仍可添加和使用模型。" };
			}
		})();
		try { return await this.pending; } finally { this.pending = undefined; }
	}

	async discover(input: { baseUrl: string; apiKey?: string; provider?: string; ids?: string[]; force?: boolean }): Promise<ModelMetadataResult> {
		const upstream = new Map<string, MetadataValues>();
		let warning: string | undefined;
		// 同步已有模型时，上游不可达也允许使用资料库；拉取清单时则必须成功。
		try {
			const url = new URL(`${input.baseUrl.replace(/\/+$/, "")}/models`);
			if (!["https:", "http:"].includes(url.protocol)) throw new Error("端点必须使用 HTTP 或 HTTPS");
			const response = await this.request(url, {
				headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}, signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) throw new Error(`拉取模型返回 HTTP ${response.status}`);
			const body = await response.json() as { data?: unknown; models?: unknown };
			const list = body.data ?? body.models;
			if (!Array.isArray(list)) throw new Error("模型列表响应格式无效");
			for (const item of list) {
				if (!item || typeof item !== "object") continue;
				const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
				if (id) upstream.set(id, readMetadata(item));
			}
		} catch (error) {
			if (!input.ids) throw error;
			warning = "上游模型清单暂不可用，本次仅通过 models.dev 补全。";
		}
		const catalog = await this.catalog(input.force === true);
		return {
			models: [...new Set(input.ids ?? [...upstream.keys()])].sort().map((id) => resolveMetadata(id, upstream.get(id) ?? {}, catalog.snapshot?.models ?? [], input.provider ?? "", input.baseUrl)),
			catalogStatus: catalog.status, catalogUpdatedAt: catalog.snapshot?.updatedAt,
			warning: [warning, "warning" in catalog ? catalog.warning : undefined].filter(Boolean).join(" ") || undefined,
		};
	}
}
