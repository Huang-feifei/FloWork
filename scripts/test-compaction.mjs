/** 离线压缩回归：合成历史 + 内存 stream + 隔离 SDK 会话；不读真实配置、不调用模型或外网。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { backendRuntime } from "./runtime.mjs";

const runtime = await backendRuntime();
if (runtime.command !== process.execPath || (runtime.env?.ELECTRON_RUN_AS_NODE === "1" && !process.versions.electron)) {
	const result = spawnSync(runtime.command, [import.meta.filename], { stdio: "inherit", env: { ...process.env, ...runtime.env } });
	process.exit(result.status ?? 1);
}
const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "out"), { recursive: true });
const base = mkdtempSync(join(root, "out", "test-compaction-"));
const env = { ...process.env };
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error("压缩回归禁止网络请求"); };
const hosts = [];
try {
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	Object.assign(process.env, { HOME: join(base, "home"), USERPROFILE: join(base, "home"),
		FLOWORK_DATA_DIR: join(base, "data"), FLOWORK_PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [],
		defaultProvider: "offline-fixture", defaultModel: "fixture", defaultThinkingLevel: "high",
		retry: { enabled: false }, compaction: { modelOverrides: { "offline-fixture/fixture": { reserveTokens: 20480 } } } }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "offline-fixture": {
		baseUrl: "https://offline.invalid", api: "openai-responses", apiKey: "offline-test-only", authHeader: true, headers: { "X-Provider-Fixture": "preserved" },
		models: [{ id: "fixture", name: "Offline fixture", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16384 }],
	} } }));
	const bundle = join(base, "compaction.mjs");
	await build({
		stdin: { contents: 'export * from "./src/worker/compaction.ts"; export * from "./src/worker/session-host.ts";', resolveDir: root, loader: "ts" },
		bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "silent", tsconfig: join(root, "tsconfig.node.json"),
	});
	const { prepareCompactionInput, createCompactionExtension, SessionHost } = await import(pathToFileURL(bundle).href);
	const { SessionManager, serializeConversation, convertToLlm } = await import("@earendil-works/pi-coding-agent");
	const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
	const { streamSimple } = await import("@earendil-works/pi-ai/compat");
	const model = { id: "fixture", provider: "offline-fixture", api: "openai-responses", baseUrl: "https://offline.invalid",
		reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const usage = { ...zero, input: 11, output: 7, reasoning: 2, totalTokens: 18 };
	const user = (text) => ({ role: "user", content: text, timestamp: 0 });
	const assistant = (content, stopReason = "stop", used = zero) => ({ role: "assistant", content, stopReason, usage: used,
		api: model.api, provider: model.provider, model: model.id, timestamp: 0 });
	const text = (value) => ({ type: "text", text: value });
	const thinking = (value) => ({ type: "thinking", thinking: value, thinkingSignature: "opaque-replay-fixture" });
	const call = { type: "toolCall", id: "write-1", name: "write", arguments: { path: "changed.ts", content: "implemented fixture" } };
	const toolResult = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [text("tool-result-fixture\n" + "x".repeat(4000))], isError: false, timestamp: 0 };
	const history = [user("Preserve user constraints"), assistant([thinking("historical-reasoning-fixture".repeat(13000)), text("Preserve final decision"), call], "toolUse"), toolResult];
	const settings = { enabled: true, reserveTokens: 20480, keepRecentTokens: 20000 };
	const event = (split = false) => ({ type: "session_before_compact", preparation: {
		firstKeptEntryId: "kept-id", tokensBefore: 119000, previousSummary: "Previous goals and constraints",
		messagesToSummarize: history, turnPrefixMessages: split ? [user("Current request"), assistant([thinking("prefix-reasoning-fixture"), text("Prefix progress")])] : [],
		isSplitTurn: split, fileOps: { read: new Set(["read.ts"]), written: new Set(["changed.ts"]), edited: new Set() }, settings,
	}, branchEntries: [], customInstructions: "Preserve exact error text", reason: "manual", willRetry: false, signal: new AbortController().signal });
	const promptText = (context) => JSON.stringify(context.messages);
	const responseStream = (response) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => { stream.push({ type: "done", reason: response.stopReason, message: response }); stream.end(); });
		return stream;
	};
	const makeHook = ({ respond = () => assistant([text("Complete structured summary")], "stop", usage), selected = model, route } = {}) => {
		const requests = [], notices = [];
		let hook;
		const session = { thinkingLevel: "high", messages: history, agent: { streamFunction: streamSimple },
			settingsManager: { getRetrySettings: () => ({ enabled: false }) }, modelRuntime: { resolveModel: route } };
		createCompactionExtension(() => session)({ on: (name, handler) => { assert.equal(name, "session_before_compact"); hook = handler; } });
		const ctx = { model: selected, ui: { notify: (message, level) => notices.push({ message, level }) }, modelRegistry: {
			streamSimple: (target, context, options) => { requests.push({ target, context, options }); return responseStream(respond(requests.length, options)); },
		} };
		return { run: (value) => hook(value, ctx), requests, notices, session };
	};

	const source = event(true), before = structuredClone(source.preparation);
	const prepared = prepareCompactionInput(source);
	const serialized = serializeConversation(convertToLlm(prepared.messagesToSummarize));
	assert.ok(JSON.stringify(prepared.messagesToSummarize).length < JSON.stringify(history).length / 10);
	assert.doesNotMatch(serialized, /historical-reasoning-fixture|opaque-replay-fixture|Assistant thinking/);
	for (const value of ["Preserve user constraints", "Preserve final decision", "changed.ts", "implemented fixture", "tool-result-fixture"]) assert.ok(serialized.includes(value), value);
	assert.equal(prepared.previousSummary, before.previousSummary);
	assert.equal(prepared.firstKeptEntryId, before.firstKeptEntryId);
	assert.equal(prepared.tokensBefore, before.tokensBefore);
	assert.deepEqual(source.preparation, before, "精简只作用于副本，原始消息、签名、边界和文件集合不能变化");
	assert.doesNotMatch(serializeConversation(convertToLlm(prepared.turnPrefixMessages)), /prefix-reasoning-fixture/);
	assert.deepEqual(prepareCompactionInput({ ...event(), preparation: { ...event().preparation, messagesToSummarize: [assistant([thinking("only-thinking")])] } }).messagesToSummarize[0].content, []);
	console.log("✓ 历史与轮次前缀均移除 thinking；正文、工具参数/结果、旧摘要、边界、原始历史不变");

	for (const reason of ["manual", "threshold", "overflow"]) {
		const fixture = event(true); fixture.reason = reason; fixture.willRetry = reason === "overflow";
		const test = makeHook();
		const result = await test.run(fixture);
		assert.ok(result.compaction);
		assert.equal(test.requests.length, 2, "分段摘要保留历史 / 前缀两个阶段");
		assert.equal(test.requests[0].target.maxTokens, 16384);
		for (const request of test.requests) {
			assert.equal(request.options.reasoning, "high", "不暗改用户思考档位");
			assert.equal(request.options.signal, fixture.signal);
			assert.equal(request.options.cacheRetention, "none");
			assert.ok(request.options.sessionId);
			assert.doesNotMatch(promptText(request.context), /historical-reasoning-fixture|prefix-reasoning-fixture/);
		}
		assert.match(promptText(test.requests[0].context), /Previous goals and constraints/);
		assert.match(promptText(test.requests[0].context), /Preserve exact error text/);
		assert.match(promptText(test.requests[0].context), /more characters truncated/, "工具结果继续采用 Pi 原来的截短策略");
		assert.equal(result.compaction.firstKeptEntryId, "kept-id");
		assert.equal(result.compaction.tokensBefore, 119000);
		assert.equal(result.compaction.usage.totalTokens, 36);
		assert.equal(result.compaction.usage.reasoning, 4);
		assert.deepEqual(result.compaction.details, { readFiles: ["read.ts"], modifiedFiles: ["changed.ts"], floworkCompaction: 1 });
		assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
		assert.equal(test.notices.length, 0);
	}
	console.log("✓ 手动 / 阈值 / 溢出入口复用原预算、分段摘要、文件清单、取消信号、缓存策略及合并用量");

	for (const [stop, content, error] of [
		["length", [text("incomplete summary")], /token cap/],
		["error", [text("partial")], /offline provider failure/],
		["aborted", [text("cancelled partial")], /未正常完成/],
		["deferred", [text("deferred partial")], /未正常完成/],
		["stop", [text("  \n")], /空摘要/],
		["stop", [text("tool call is not a summary"), call], /attempted to call a tool/],
	]) {
		const test = makeHook({ respond: () => ({ ...assistant(content, stop), errorMessage: "offline provider failure" }) });
		assert.deepEqual(await test.run(event()), { cancel: true });
		assert.equal(test.requests.length, 1, "失败不能回落到第二次未精简请求");
		assert.match(test.notices[0].message, error);
		assert.equal(test.notices[0].level, "error");
	}
	const partialSplit = makeHook({ respond: (n) => assistant([text(n === 1 ? "valid history" : "truncated prefix")], n === 1 ? "stop" : "length", usage) });
	assert.deepEqual(await partialSplit.run(event(true)), { cancel: true }, "前缀失败不能保存已完成的历史摘要");
	assert.equal(partialSplit.requests.length, 2);
	const cancelled = event(); const controller = new AbortController(); cancelled.signal = controller.signal;
	const cancelTest = makeHook({ respond: () => { controller.abort(); return assistant([text("late response")]); } });
	assert.deepEqual(await cancelTest.run(cancelled), { cancel: true });
	assert.equal(cancelTest.notices.length, 0, "用户取消不误报模型故障");
	const preCancelled = makeHook(); assert.deepEqual(await preCancelled.run(cancelled), { cancel: true }); assert.equal(preCancelled.requests.length, 0);
	console.log("✓ 截断、服务错误、空摘要、工具调用、前缀失败及取消均拒绝保存，不重复发送原历史");

	const routedModel = { ...model, maxTokens: 6000 };
	let routes = 0;
	const routed = makeHook({ selected: { ...model, api: "pi-virtual", maxTokens: 999999 }, route: async (_selected, messages, options) => {
		routes++; assert.equal(options.reason, "direct"); assert.equal(options.thinkingLevel, "high"); assert.equal(messages.length, history.length);
		return { model: routedModel, thinkingLevel: "low" };
	} });
	assert.ok((await routed.run(event())).compaction);
	assert.equal(routes, 1);
	assert.equal(routed.requests[0].target, routedModel);
	assert.equal(routed.requests[0].target.maxTokens, 6000);
	assert.equal(routed.requests[0].options.reasoning, "low");
	const routeFailure = makeHook({ selected: { ...model, api: "pi-virtual" }, route: async () => { throw new Error("offline routing failed"); } });
	assert.deepEqual(await routeFailure.run(event()), { cancel: true }); assert.equal(routeFailure.requests.length, 0);
	console.log("✓ 虚拟模型先路由，使用实际模型的输出上限与思考等级；路由失败不继续请求");

	const transient = makeHook({ respond: (n) => n === 1
		? { ...assistant([], "error"), errorMessage: "503 service unavailable" }
		: assistant([text("Complete retried summary")], "stop", usage) });
	transient.session.settingsManager.getRetrySettings = () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 });
	assert.ok((await transient.run(event())).compaction);
	assert.equal(transient.requests.length, 2);
	for (const request of transient.requests) assert.doesNotMatch(promptText(request.context), /historical-reasoning-fixture/);
	const custom = makeHook();
	let customRequest;
	custom.session.agent.streamFunction = (target, context, options) => {
		customRequest = { target, context, options }; return responseStream(assistant([text("Custom transport summary")], "stop", usage));
	};
	custom.session.modelRuntime.getAuth = async (target, options) => {
		assert.equal(target, model); assert.ok(options.signal);
		return { auth: { baseUrl: "https://offline-auth.invalid", apiKey: "synthetic-request-key", headers: { "X-Fixture": "kept", "X-Deleted": null } }, env: { SYNTHETIC_ENV: "kept" } };
	};
	assert.ok((await custom.run(event())).compaction);
	assert.equal(custom.requests.length, 0, "显式传输不能被 registry 替换");
	assert.equal(customRequest.target.baseUrl, "https://offline-auth.invalid");
	assert.equal(customRequest.options.apiKey, "synthetic-request-key");
	assert.deepEqual(customRequest.options.headers, { "X-Fixture": "kept" });
	assert.deepEqual(customRequest.options.env, { SYNTHETIC_ENV: "kept" });
	custom.session.modelRuntime.getAuth = async () => { throw new Error("Offline transport supplies its own auth"); };
	assert.ok((await custom.run(event())).compaction, "自带认证的离线传输仍可运行");
	assert.equal(customRequest.options.apiKey, undefined);
	console.log("✓ 保留有界重试；自定义传输继承请求时 baseURL / 认证头 / 环境，也可完全自带认证");

	const startHost = async () => {
		const manager = SessionManager.create(cwd);
		manager.appendModelChange(model.provider, model.id);
		manager.appendThinkingLevelChange("high");
		manager.appendMessage(history[0]); manager.appendMessage(history[1]); manager.appendMessage(toolResult);
		manager.appendMessage({ role: "toolResult", toolCallId: "nested", toolName: "codemode", content: [text("nested read complete")], isError: false, timestamp: 0,
			nestedCalls: { calls: [{ id: "nested-read", name: "read", arguments: { path: "nested-read.ts" }, status: "ok", durationMs: 1 }], complete: true } });
		const keep = manager.appendMessage(user("CURRENT_USER_REQUEST\n" + "k".repeat(88000)));
		manager.appendMessage(assistant([thinking("RECENT_THINKING_MUST_SURVIVE"), text("Recent final response")]));
		const events = [], requests = [];
		const host = new SessionHost((e) => events.push(e), "auto"); hosts.push(host);
		await host.init(cwd, manager.getSessionFile());
		const sdkEvents = [];
		host.session.subscribe((e) => sdkEvents.push(e));
		let answer = () => assistant([text("Complete fixture summary")], "stop", usage);
		host.session.agent.streamFunction = (target, context, options) => {
			const isSummary = promptText(context).includes("You are a context summarization assistant.");
			requests.push({ target, context, options, isSummary });
			return responseStream(isSummary ? answer() : assistant([text("Offline continuation")], "stop", usage));
		};
		return { host, events, sdkEvents, requests, file: manager.getSessionFile(), keep, answer: (fn) => { answer = fn; } };
	};
	const manual = await startHost();
	const originalRecords = readFileSync(manual.file, "utf8").trim().split("\n").map(JSON.parse);
	const originalHistory = originalRecords.filter((e) => e.type === "message");
	const result = await manual.host.session.compact("keep constraints");
	assert.equal(result.firstKeptEntryId, manual.keep);
	assert.deepEqual(result.usage, usage);
	assert.equal(result.details.floworkCompaction, 1);
	assert.ok(result.details.readFiles.includes("nested-read.ts"));
	assert.ok(result.details.modifiedFiles.includes("changed.ts"));
	assert.ok(manual.sdkEvents.some((e) => e.type === "compaction_end" && e.result));
	assert.equal(manual.requests.length, 1, "真实 SessionHost 必须安装并运行精简扩展，不能再调用默认摘要");
	assert.doesNotMatch(promptText(manual.requests[0].context), /historical-reasoning-fixture/);
	assert.ok(JSON.stringify(manual.host.session.messages).includes("RECENT_THINKING_MUST_SURVIVE"), "最近保留的上下文仍有原始思考和签名");
	const savedRecords = () => readFileSync(manual.file, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(savedRecords().filter((e) => e.type === "message"), originalHistory, "原始 JSONL 消息不能被重写或删除");
	assert.deepEqual(savedRecords().slice(0, originalRecords.length), originalRecords, "压缩只能追加新记录");
	const saved = savedRecords().at(-1); assert.equal(saved.type, "compaction"); assert.equal(saved.fromHook, true);
	manual.host.session.sessionManager.appendMessage(user("NEW_CURRENT_REQUEST\n" + "n".repeat(88000)));
	manual.host.session.sessionManager.appendMessage(assistant([text("New response")]));
	const second = await manual.host.session.compact();
	assert.deepEqual(second.details.readFiles, result.details.readFiles, "重复压缩不能丢失 fromHook 摘要的累积文件清单");
	assert.deepEqual(second.details.modifiedFiles, result.details.modifiedFiles);
	assert.match(promptText(manual.requests.at(-1).context), /Complete fixture summary/, "旧摘要传入下一次压缩");
	assert.ok(manual.events.every((e) => e.type !== "notice" || e.level !== "error"));
	console.log("✓ 真实 SessionHost 手动压缩 / 重复压缩：追加摘要、保持原历史与最近思考、继承嵌套文件操作和用量");

	const registry = await startHost();
	registry.host.session.agent.streamFunction = streamSimple;
	const provider = registry.host.session.modelRuntime.getProvider(model.provider);
	const providerStream = provider.streamSimple;
	let registryRequest;
	try {
		provider.streamSimple = (target, context, options) => {
			registryRequest = { target, context, options };
			return responseStream(assistant([text("Registry transport summary")], "stop", usage));
		};
		assert.ok((await registry.host.session.compact()).summary);
		assert.equal(registry.requests.length, 0);
		assert.equal(registryRequest.options.apiKey, "offline-test-only");
		assert.equal(registryRequest.options.headers["X-Provider-Fixture"], "preserved");
		assert.equal(registryRequest.options.headers.Authorization, "Bearer offline-test-only");
		assert.equal(registryRequest.target.baseUrl, "https://offline.invalid");
		assert.doesNotMatch(promptText(registryRequest.context), /historical-reasoning-fixture/);
	} finally { provider.streamSimple = providerStream; }
	console.log("✓ 真实默认 registry 传输保持供应商认证、请求头和 baseURL，不绕过运行时配置");

	for (const mode of ["length", "error", "aborted", "empty", "cancel"]) {
		const failure = await startHost();
		failure.answer(() => {
			if (mode === "cancel") failure.host.session.abortCompaction();
			return { ...assistant([text(mode === "empty" ? " " : "partial fixture summary")], ["empty", "cancel"].includes(mode) ? "stop" : mode), errorMessage: "offline provider error" };
		});
		const failureBefore = readFileSync(failure.file);
		await assert.rejects(failure.host.session.compact(), /Compaction cancelled/);
		assert.deepEqual(readFileSync(failure.file), failureBefore, `${mode}：失败时会话文件必须逐字节不变`);
		assert.equal(failure.requests.length, 1);
		if (mode !== "cancel") assert.ok(failure.events.some((e) => e.type === "notice" && e.level === "error"));
		assert.ok(!failure.sdkEvents.some((e) => e.type === "compaction_end" && e.result));
		assert.ok(!failure.events.some((e) => e.type === "notice" && e.text === "上下文压缩完成"), "失败后不能误报压缩成功");
	}
	console.log("✓ 真实 SDK 截断 / 服务错误 / aborted / 空摘要 / 用户取消均不追加记录、不误报成功、不回落重发");

	const automatic = await startHost();
	await automatic.host.session.prompt("Continue the existing task");
	const entries = readFileSync(automatic.file, "utf8").trim().split("\n").map(JSON.parse);
	assert.ok(entries.some((e) => e.type === "compaction" && e.details?.floworkCompaction === 1), "真实自动阈值路径使用同一扩展");
	assert.ok(automatic.sdkEvents.some((e) => e.type === "compaction_start" && e.reason === "threshold"));
	const summaryRequests = automatic.requests.filter((r) => r.isSummary);
	assert.equal(summaryRequests.length, 1);
	assert.doesNotMatch(promptText(summaryRequests[0].context), /historical-reasoning-fixture/);
	const normal = automatic.requests.filter((r) => !r.isSummary);
	assert.ok(normal.length > 0);
	assert.ok(normal.some((r) => promptText(r.context).includes("RECENT_THINKING_MUST_SURVIVE")), "正常对话请求不能被精简历史思考的摘要策略污染");
	assert.equal(networkCalls, 0);
	console.log("✓ 真实自动阈值压缩成功，后续对话请求继续保留最近思考，零网络 / 零模型调用");
	console.log("COMPACTION REGRESSION OK");
} finally {
	for (const host of hosts) await host.dispose();
	globalThis.fetch = originalFetch;
	for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
	Object.assign(process.env, env);
	rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
