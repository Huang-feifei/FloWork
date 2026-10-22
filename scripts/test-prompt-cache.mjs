/** 离线缓存回归：仅构造请求和消费内存 SSE；不连接中转、不调用任何模型、不读取用户配置。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "out"), { recursive: true });
const base = mkdtempSync(join(root, "out", "test-prompt-cache-"));
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error("缓存回归禁止网络请求"); };
try {
	const bundle = join(base, "cache.mjs");
	await build({
		stdin: { contents: 'export * from "./src/worker/planning.ts"; export * from "./src/worker/adapter.ts"; export * from "./src/renderer/src/lib/usage.ts";', resolveDir: root, loader: "ts" },
		bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "silent", tsconfig: join(root, "tsconfig.node.json"),
	});
	const { createPlanningExtension, toChatMessage, summarizeUsage } = await import(pathToFileURL(bundle).href);
	let mode = "execute";
	const handlers = new Map();
	createPlanningExtension({ getMode: () => mode })({
		on: (name, handler) => handlers.set(name, handler),
		registerTool: () => {},
	});
	const transform = (messages) => handlers.get("context")({ messages }).messages;
	const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
	const model = {
		id: "offline-fixture", provider: "offline-fixture", api: "anthropic-messages", baseUrl: "https://offline.invalid",
		reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024,
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	};
	const assistant = (id) => ({
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "fixture.txt" } }], stopReason: "toolUse", timestamp: 0,
	});
	const result = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `result ${id}` }], isError: false, timestamp: 0 });
	const tools = [{ name: "read", description: "Read a local fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
	const system = { role: "system", content: "Stable system prompt", toolsAdded: tools, timestamp: 0 };
	const usage = { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 5157, cache_creation_input_tokens: 26887 };
	const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
	async function payload(messages, retention = "short") {
		let captured;
		// 完全替代 SDK transport，只有内存 Response，没有 socket 或真实凭据。
		const client = { beta: { messages: { create: (params) => {
			captured = structuredClone(params);
			return { asResponse: async () => new Response(
				sse("message_start", { message: { id: "offline", model: model.id, usage } }) +
				sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }) +
				sse("message_stop", {}),
				{ headers: { "content-type": "text/event-stream" } },
			) };
		} } } };
		const output = await anthropicStream(model, { messages: [system, ...messages] }, { client, cacheRetention: retention }).result();
		assert.equal(output.stopReason, "stop", output.errorMessage);
		return { params: captured, output };
	}
	const stripCache = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));
	const history = [user("Inspect fixture"), assistant("read-1"), result("read-1")];
	const extended = [...history, assistant("read-2"), result("read-2")];
	for (const workMode of ["execute", "plan"]) {
		mode = workMode;
		const before = structuredClone(history);
		const firstContext = transform(history);
		assert.deepEqual(history, before, "扩展不能修改会话历史");
		assert.deepEqual(transform(history), firstContext, "相同历史必须生成稳定的上下文");
		const first = await payload(firstContext);
		const next = await payload(transform(extended));
		assert.deepEqual(next.params.system, first.params.system);
		assert.deepEqual(next.params.tools, first.params.tools);
		assert.deepEqual(
			stripCache(next.params.messages.slice(0, first.params.messages.length)), stripCache(first.params.messages),
			`${workMode}: 后续工具请求必须完整保留上一请求的消息前缀，不能移动临时工作流提示`,
		);
		assert.equal(first.params.messages.at(-1).content.at(-1).cache_control.type, "ephemeral");
		assert.equal(next.params.messages.at(-1).content.at(-1).type, "tool_result", "缓存断点应落在真实历史的末尾");
		const followUp = await payload(transform([...extended, { ...assistant("unused"), content: [{ type: "text", text: "Done" }], stopReason: "stop" }, user("Continue")]));
		assert.deepEqual(stripCache(followUp.params.messages.slice(0, next.params.messages.length)), stripCache(next.params.messages), "跨用户轮次也应保持缓存前缀");
	}
	console.log("✓ 计划/执行模式：连续工具请求、后续用户轮次保持 Anthropic 缓存前缀，上下文不污染历史");
	mode = "execute";
	const execute = transform(history);
	mode = "plan";
	assert.match(JSON.stringify(transform(history)), /计划模式/);
	assert.notDeepEqual(transform(history), execute, "模式切换必须立即反映在同一轮的请求中");
	const disabled = await payload(transform(history), "none");
	assert.ok(!JSON.stringify(disabled.params).includes("cache_control"));
	const normal = await payload(transform(history));
	assert.deepEqual(toChatMessage(normal.output).usage, {
		input: 4, output: 7, cacheRead: 5157, cacheWrite: 26887, totalTokens: 32055,
		cost: { total: normal.output.usage.cost.total },
	});
	console.log("✓ 模式实时更新、禁用缓存，以及 SSE → SDK → FloWork 的缓存读写用量透传");
	const message = toChatMessage(normal.output);
	const totals = summarizeUsage([user("ignored"), message, { ...message, usage: undefined }, message]);
	assert.equal(totals.input, 2 * (4 + 5157 + 26887), "累计输入必须包括未缓存输入、缓存读、缓存写");
	assert.equal(totals.output, 14);
	assert.equal(totals.cacheRead, 10314);
	assert.equal(totals.cacheWrite, 53774);
	assert.equal(totals.cost, normal.output.usage.cost.total * 2);
	assert.equal(totals.lastContext, 32055, "上下文占用取最近请求，不使用累计用量");
	assert.deepEqual(summarizeUsage([]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastContext: 0 });
	console.log("✓ 状态栏累计输入包含缓存写入，缓存读写明细与最近上下文统计正确");
	assert.equal(networkCalls, 0);
	console.log("PROMPT CACHE REGRESSION OK（纯内存传输，零网络、零模型调用）");
} finally {
	globalThis.fetch = originalFetch;
	rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
