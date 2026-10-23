/** token 输入与模型序列化的纯离线回归，不读用户配置，不调用模型。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "out"), { recursive: true });
const work = mkdtempSync(join(root, "out", "test-model-limits-"));
const previousWindow = globalThis.window;
globalThis.window = { floworkTransport: {
	request() { throw new Error("纯数值回归不能访问桌面 IPC"); },
	onPush() { throw new Error("纯数值回归不能订阅桌面 IPC"); },
} };
try {
	const bundle = join(work, "models.mjs");
	await build({
		stdin: { contents: 'export * from "./src/renderer/src/lib/token-limit.ts"; export * from "./src/renderer/src/components/settings/ModelDialog.tsx";', resolveDir: root },
		bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle,
		tsconfig: join(root, "tsconfig.renderer.json"), logLevel: "silent",
	});
	const { parseTokenLimit, CONTEXT_WINDOW_PRESETS, MAX_OUTPUT_PRESETS, emptyModel, toModelDraft, toModelEntry, validateModel } = await import(pathToFileURL(bundle).href);
	for (const [input, expected] of [
		["128000", 128000], ["16384", 16384], ["128k", 128000], ["128K", 128000], ["1m", 1000000],
		["1M", 1000000], [" 1.5 M ", 1500000], ["16k", 16000], ["1.001K", 1001],
		["0.001k", 1], ["0.000001M", 1], ["1.001000k", 1001], ["128.00", 128], ["00016K", 16000],
		["9007199254740991", Number.MAX_SAFE_INTEGER],
	]) assert.equal(parseTokenLimit(input), expected, input);
	for (const input of ["", " ", "0", "0K", "-128K", "Infinity", "NaN", "abc", "16KB", "1e6", "0x100", "1,000", "1.5", "0.0001K", "0.0000001M", "1.0011K", "9007199254740992", "999999999999999999M"]) {
		assert.equal(parseTokenLimit(input), undefined, input);
	}
	for (const preset of [...CONTEXT_WINDOW_PRESETS, ...MAX_OUTPUT_PRESETS]) assert.equal(parseTokenLimit(preset.label), preset.tokens);
	assert.deepEqual(CONTEXT_WINDOW_PRESETS.map((p) => p.label), ["128K", "200K", "256K", "400K", "512K", "1M"]);
	assert.deepEqual(MAX_OUTPUT_PRESETS.map((p) => p.label), ["8K", "16K", "32K", "64K", "128K"]);
	console.log("✓ 十进制 K / M、大小写、空格、小数精确换算和安全整数；拒绝无效或不足 1 token 的数值");

	const original = { id: "fixture-model", name: "Fixture", contextWindow: 128000, maxTokens: 16384,
		reasoning: true, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		thinkingLevelMap: { high: "high", max: null }, compat: { supportsDeveloperRole: true }, headers: { "X-Fixture": "retained" } };
	const originalCopy = structuredClone(original);
	const draft = toModelDraft(original);
	assert.equal(draft.contextWindow, "128000"); assert.equal(draft.maxTokens, "16384");
	assert.equal(validateModel(draft), undefined);
	assert.deepEqual(toModelEntry(draft), original);
	assert.deepEqual(original, originalCopy);
	assert.ok(!MAX_OUTPUT_PRESETS.some((p) => p.tokens === parseTokenLimit(draft.maxTokens)), "16384 不能错误匹配或取整成 16K");
	console.log("✓ 既有 128000 / 16384 和其他模型配置原样往返，不自动套用或舍入到预设");

	const compact = { ...draft, contextWindow: " 1m ", maxTokens: "128k" };
	assert.equal(validateModel(compact), undefined);
	const entry = toModelEntry(compact);
	assert.equal(entry.contextWindow, 1000000); assert.equal(entry.maxTokens, 128000);
	assert.equal(typeof entry.contextWindow, "number"); assert.equal(typeof entry.maxTokens, "number");
	assert.equal(JSON.parse(JSON.stringify(entry)).maxTokens, 128000);
	const blank = { ...draft, contextWindow: " ", maxTokens: "", advanced: '{"contextWindow":999,"maxTokens":888,"compat":{"retained":true}}' };
	assert.equal(validateModel(blank), undefined);
	assert.ok(!("contextWindow" in toModelEntry(blank))); assert.ok(!("maxTokens" in toModelEntry(blank)));
	assert.deepEqual(toModelEntry(blank).compat, { retained: true });
	assert.ok(!("contextWindow" in toModelEntry(emptyModel("new"))));
	assert.ok(!("maxTokens" in toModelEntry(emptyModel("new"))));
	for (const key of ["contextWindow", "maxTokens"]) for (const value of ["bad", "0", "-1K", "1.5", "Infinity", "9007199254740992"]) {
		const bad = { ...draft, [key]: value };
		assert.ok(validateModel(bad)?.includes(key === "contextWindow" ? "上下文窗口" : "最大输出"));
		assert.throws(() => toModelEntry(bad), /正整数 token 数/, "序列化也要拦截无效值，不能保存 NaN / null");
	}
	console.log("✓ K / M 保存为整数；清空字段真正删除覆盖值并保留默认行为；校验和序列化双重拒绝无效值");
	console.log("MODEL LIMITS REGRESSION OK");
} finally {
	if (previousWindow === undefined) delete globalThis.window;
	else globalThis.window = previousWindow;
	rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
