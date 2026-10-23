/** 纯离线回归：资料匹配、缓存降级、凭据隔离、手动值保护和配置往返。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "out"), { recursive: true });
const work = mkdtempSync(join(root, "out", "test-model-metadata-"));
const previousWindow = globalThis.window;
globalThis.window = { floworkTransport: { request() { throw new Error("不得访问真实 IPC"); }, onPush() { throw new Error("不得订阅真实 IPC"); } } };
try {
	const bundle = join(work, "metadata.mjs");
	await build({
		stdin: { contents: [
			'export * from "./src/shared/model-metadata.ts";',
			'export * from "./src/worker/model-metadata.ts";',
			'export * from "./src/renderer/src/lib/model-metadata.ts";',
			'export * from "./src/renderer/src/components/settings/ModelDialog.tsx";',
			'export * from "./src/renderer/src/components/settings/EndpointDialog.tsx";',
		].join("\n"), resolveDir: root },
		bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle,
		tsconfig: join(root, "tsconfig.renderer.json"), logLevel: "silent",
		// 配置序列化不需要启动整个 UI store / 系统主题监听。
		plugins: [{ name: "isolate-ui-store", setup(b) {
			b.onResolve({ filter: /\/store$/ }, () => ({ path: "ui-store", namespace: "test-stub" }));
			b.onLoad({ filter: /.*/, namespace: "test-stub" }, () => ({ contents: 'export const useApp = () => { throw new Error("纯配置测试不能访问 UI store"); };' }));
		} }],
	});
	const { readMetadata, parseCatalog, resolveMetadata, applyCatalogMatch, ModelMetadataService, mergeModelMetadata, protectModelEdits,
		emptyModel, toModelDraft, toModelEntry, toEndpointDraft, toEndpointConfig, emptyEndpoint, readSyncState } = await import(pathToFileURL(bundle).href);

	const fixture = { alpha: { api: "https://alpha.test/v1", models: {
		"model-1": { id: "model-1", name: "Model One", reasoning: true, limit: { context: 200000, output: 32000 },
			modalities: { input: ["text", "image"], output: ["text"] }, cost: { input: 3, output: 15, cache_read: 0.3 } },
		"unique-2": { id: "unique-2", name: "Unique", reasoning: false, limit: { context: 64000, output: 8000 } },
		"image-gen": { id: "image-gen", modalities: { input: ["text"], output: ["image"] }, limit: { output: 1024 } },
	} }, beta: { models: { "model-1": { id: "model-1", name: "Other deployment", limit: { context: 128000, output: 16000 }, cost: { input: 2, output: 10 } } } } };
	const catalog = parseCatalog(fixture);
	assert.equal(catalog.length, 3);
	assert.deepEqual(readMetadata({ name: "N", context_length: 1000, max_output_tokens: 100, reasoning: false, input: ["text"], cost: { input: 0, output: -1, cache_read: Infinity } }),
		{ name: "N", contextWindow: 1000, maxTokens: 100, reasoning: false, image: false, "cost.input": 0 });
	assert.deepEqual(readMetadata({ context_window: -1, maxTokens: NaN, limit: { context: "200K", output: 1.5 }, pricing: { prompt: "0.000001" } }), {});
	console.log("✓ 规范化已知上游字段和 models.dev 字段，保留 false / 免费价格，拒绝无效值和未知价格单位；过滤非聊天资料");

	const ambiguous = resolveMetadata("model-1", { maxTokens: 4096 }, catalog, "proxy", "https://proxy.test/v1");
	assert.equal(ambiguous.candidates.length, 2);
	assert.deepEqual(ambiguous.values, { maxTokens: 4096 });
	const confirmed = applyCatalogMatch(ambiguous, ambiguous.candidates[0]);
	assert.equal(confirmed.values.contextWindow, 200000);
	assert.equal(confirmed.values.maxTokens, 4096);
	assert.equal(confirmed.sources.maxTokens, "upstream");
	assert.equal(confirmed.sources.contextWindow, "models.dev:alpha/model-1");
	assert.equal(resolveMetadata("model-1", {}, catalog, "alpha", "https://proxy.test/v1").values.contextWindow, 200000);
	assert.equal(resolveMetadata("model-1", {}, catalog, "custom", "https://alpha.test/v2").values.contextWindow, 200000);
	assert.equal(resolveMetadata("unique-2", {}, catalog, "proxy", "https://proxy.test/v1").values.contextWindow, 64000);
	assert.equal(resolveMetadata("namespace/unique-2", {}, catalog, "proxy", "https://proxy.test/v1").candidates.length, 1);
	assert.deepEqual(resolveMetadata("namespace/unique-2", {}, catalog, "proxy", "https://proxy.test/v1").values, {});
	for (const id of ["MODEL-1", "model-1-latest", "model-1-20260101"]) assert.deepEqual(resolveMetadata(id, {}, catalog, "alpha", "https://alpha.test").values, {});
	console.log("✓ 精确匹配优先；多供应商 / 带前缀的候选必须确认；不猜版本别名；上游值覆盖资料库");

	const blank = emptyModel("model-1");
	assert.equal(mergeModelMetadata(blank, { id: "model-1", values: {}, sources: {}, candidates: [] }).sync, undefined, "无资料时不写空的同步状态");
	const auto = mergeModelMetadata(blank, confirmed, 100);
	assert.equal(auto.contextWindow, "200000"); assert.equal(auto.maxTokens, "4096");
	assert.equal(auto.reasoning, true); assert.equal(auto.image, true);
	assert.equal(blank.contextWindow, ""); assert.equal(auto.sync.updatedAt, 100);
	const updated = { ...confirmed, values: { ...confirmed.values, contextWindow: 256000, maxTokens: 8192, "cost.input": 5 } };
	assert.equal(mergeModelMetadata(auto, updated).contextWindow, "256000", "自动管理且未手改的字段应更新");
	assert.equal(mergeModelMetadata({ ...auto, contextWindow: "" }, updated).contextWindow, "", "外部清空自动字段也视为手动修改");
	assert.equal(mergeModelMetadata(auto, { ...updated, sources: { ...updated.sources, maxTokens: "models.dev:alpha/model-1" } }).maxTokens, "4096", "资料库降级不应覆盖之前的上游值");
	const manual = protectModelEdits(auto, { ...auto, contextWindow: "1M", maxTokens: "", reasoning: false, reasoningSet: true, image: false, imageSet: true, cost: { ...auto.cost, input: "0" } });
	const merged = mergeModelMetadata(manual, updated);
	assert.equal(merged.contextWindow, "1M"); assert.equal(merged.maxTokens, "");
	assert.equal(merged.reasoning, false); assert.equal(merged.image, false); assert.equal(merged.cost.input, "0");
	assert.ok(manual.sync.locked.includes("maxTokens"));
	assert.ok(!manual.sync.sources.contextWindow);
	const old = toModelDraft({ id: "model-1", contextWindow: 128000, reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
	const oldMerged = mergeModelMetadata(old, confirmed);
	assert.equal(oldMerged.contextWindow, "128000"); assert.equal(oldMerged.reasoning, false); assert.equal(oldMerged.image, false); assert.equal(oldMerged.cost.input, "1");
	const invalid = mergeModelMetadata({ ...blank, contextWindow: "invalid", advanced: '{"input":["pdf"]}' }, confirmed);
	assert.equal(invalid.contextWindow, "invalid"); assert.equal(invalid.image, false);
	console.log("✓ 自动值可更新；手填 / 手动清空 / 关闭能力 / 免费价格永久保护；既有配置不被覆盖，输入和附加字段不丢失");

	const endpoint = { ...emptyEndpoint(), key: "proxy", baseUrl: "https://proxy.test/v1", models: [manual], extra: { headers: { "X-Custom": "$HEADER" }, compat: { custom: true } } };
	const saved = toEndpointConfig(endpoint);
	assert.equal(saved.models[0].reasoning, false); assert.deepEqual(saved.models[0].input, ["text"]);
	assert.equal(saved.models[0].contextWindow, 1000000); assert.ok(!("maxTokens" in saved.models[0]));
	assert.ok(!("sync" in saved.models[0])); assert.ok(saved.modelSync["model-1"]);
	const loaded = toEndpointDraft("proxy", JSON.parse(JSON.stringify(saved)));
	assert.deepEqual(toEndpointConfig(loaded), saved);
	assert.equal(mergeModelMetadata(loaded.models[0], updated).maxTokens, "");
	assert.deepEqual(saved.headers, endpoint.extra.headers);
	assert.equal(readSyncState({ values: null, sources: {}, updatedAt: 1 }), undefined);
	const removed = toEndpointConfig({ ...loaded, models: [] }); assert.ok(!removed.modelSync);
	const { ModelConfig } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js")).href);
	const configPath = join(work, "models.json");
	writeFileSync(configPath, JSON.stringify({ providers: { proxy: saved } }));
	const actualConfig = await ModelConfig.load(configPath);
	assert.equal(actualConfig.getError(), undefined, "同步元数据不得破坏内核的真实 models.json 校验");
	assert.equal(actualConfig.getProvider("proxy").models[0].reasoning, false);
	console.log("✓ 同步来源与锁定状态跨保存保留、删除模型清理状态，headers / compat 保留，明确 false 正确往返；真实内核配置校验通过");

	const cachePath = join(work, "cache", "models-dev.json");
	let online = true, clock = 1000000, catalogCalls = 0;
	const requests = [];
	const request = async (url, options) => {
		const target = String(url); requests.push({ target, options });
		if (target === "https://models.dev/api.json") {
			catalogCalls++;
			assert.equal(options.headers, undefined, "不得向 models.dev 发送端点凭据");
			if (!online) throw new Error("offline");
			return Response.json(fixture);
		}
		assert.equal(options.headers.Authorization, "Bearer fixture-secret");
		return Response.json({ data: [{ id: "model-1", context_window: 100000 }, { id: "model-1", context_window: 100000 }, { id: "unknown" }, null] });
	};
	const service = new ModelMetadataService(cachePath, request, () => clock);
	const input = { baseUrl: "https://proxy.test/v1/", apiKey: "fixture-secret", provider: "alpha" };
	const fresh = await service.discover(input);
	assert.equal(fresh.catalogStatus, "fresh"); assert.equal(fresh.models.length, 2);
	assert.equal(fresh.models.find((m) => m.id === "model-1").values.contextWindow, 100000);
	assert.equal(catalogCalls, 1);
	const disk = readFileSync(cachePath, "utf8"); assert.ok(!disk.includes("fixture-secret")); assert.ok(!disk.includes("proxy.test"));
	assert.equal((await service.discover(input)).catalogStatus, "cached"); assert.equal(catalogCalls, 1);
	online = false;
	assert.equal((await service.discover({ ...input, force: true })).catalogStatus, "stale");
	clock += 25 * 60 * 60 * 1000;
	const restarted = new ModelMetadataService(cachePath, request, () => clock);
	const stale = await restarted.discover(input); assert.equal(stale.catalogStatus, "stale"); assert.ok(stale.warning);
	assert.equal(stale.models.find((m) => m.id === "model-1").values.maxTokens, 32000);
	const missing = new ModelMetadataService(join(work, "missing.json"), request, () => clock);
	const unavailable = await missing.discover(input); assert.equal(unavailable.catalogStatus, "unavailable"); assert.equal(unavailable.models.length, 2);
	assert.equal(unavailable.models[0].values.contextWindow, 100000);
	writeFileSync(join(work, "broken.json"), "not json");
	assert.equal((await new ModelMetadataService(join(work, "broken.json"), request).discover(input)).catalogStatus, "unavailable");
	console.log("✓ 24h 缓存、强制刷新、重启后离线降级、损坏缓存回退；资料库失败不影响拉取；凭据不外发、不缓存");

	const upstreamOffline = new ModelMetadataService(cachePath, async (url) => {
		if (String(url) !== "https://models.dev/api.json") throw new Error("upstream offline");
		return Response.json(fixture);
	}, () => clock);
	await assert.rejects(() => upstreamOffline.discover(input), /upstream offline/);
	const syncOffline = await upstreamOffline.discover({ ...input, ids: ["unique-2", "unlisted", "unique-2"], force: true });
	assert.equal(syncOffline.models.length, 2);
	assert.equal(syncOffline.models.find((m) => m.id === "unique-2").values.maxTokens, 8000);
	assert.ok(syncOffline.warning.includes("上游"));
	const badResponse = new ModelMetadataService(join(work, "bad-response.json"), async () => Response.json({ invalid: [] }));
	await assert.rejects(() => badResponse.discover(input), /格式无效/);
	console.log("✓ 清单拉取失败会报错；同步已有模型时上游故障仍可补全资料；去重、未知模型及错误响应安全处理");
	console.log("MODEL METADATA REGRESSION OK");
} finally {
	if (previousWindow === undefined) delete globalThis.window;
	else globalThis.window = previousWindow;
	rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
