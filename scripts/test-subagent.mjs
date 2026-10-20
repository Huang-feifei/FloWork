/**
 * 子代理回归：agent 发现、项目信任、single/parallel/chain 编排与工具注册，不调用模型。
 *   node scripts/test-subagent.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const base = mkdtempSync(join(root, "out", "test-subagent-"));
const agentDir = join(base, "agent");
const cwd = join(base, "project");

try {
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	Object.assign(process.env, {
		FLOWORK_DATA_DIR: join(base, "data"),
		FLOWORK_PI_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1",
	});
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [] }));
	writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: 用户级侦察\n---\n\nBe a scout.\n");
	writeFileSync(join(agentDir, "agents", "shared.md"), "---\nname: shared\ndescription: 用户级同名\n---\n\nUser version.\n");
	writeFileSync(
		join(cwd, ".pi", "agents", "reviewer.md"),
		"---\nname: reviewer\ndescription: 项目级审查\ntools: read, grep\n---\n\nBe a reviewer.\n",
	);
	writeFileSync(join(cwd, ".pi", "agents", "shared.md"), "---\nname: shared\ndescription: 项目级同名\n---\n\nProject version.\n");

	const bundle = join(base, "subagent.mjs");
	await build({
		stdin: {
			contents: 'export * from "./src/worker/subagent.ts"; export * from "./src/worker/trust.ts"; export * from "./src/worker/session-host.ts";',
			resolveDir: root,
			loader: "ts",
		},
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outfile: bundle,
		logLevel: "silent",
		tsconfig: join(root, "tsconfig.node.json"),
	});
	const mod = await import(pathToFileURL(bundle).href);

	const usageZero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
	const agentResult = (agent, output, extra = {}) => ({
		agent,
		agentSource: "user",
		task: output,
		output,
		usage: usageZero(),
		...extra,
	});
	const detailsFor = (mode) => (results) => ({ mode, agentScope: "both", projectAgentsDir: null, results });

	// 用户级 / 项目级发现，项目级覆盖同名用户级
	const user = mod.discoverAgents(cwd, "user");
	assert.deepEqual(user.agents.map((a) => a.name).sort(), ["scout", "shared"]);
	assert.equal(user.agents.find((a) => a.name === "shared")?.source, "user");
	const project = mod.discoverAgents(cwd, "project");
	assert.deepEqual(project.agents.map((a) => a.name).sort(), ["reviewer", "shared"]);
	assert.equal(project.agents.find((a) => a.name === "reviewer")?.source, "project");
	assert.deepEqual(project.agents.find((a) => a.name === "reviewer")?.tools, ["read", "grep"]);
	const both = mod.discoverAgents(cwd, "both");
	assert.deepEqual(both.agents.map((a) => a.name).sort(), ["reviewer", "scout", "shared"]);
	assert.equal(both.agents.find((a) => a.name === "shared")?.source, "project", "项目级覆盖同名用户级");

	// .pi/agents 属于需要信任的项目资源
	assert.equal(mod.getProjectTrust(cwd).state, "untrusted");
	assert.equal(mod.isProjectTrusted(cwd), false);
	mod.setProjectTrust(cwd, true);
	assert.equal(mod.getProjectTrust(cwd).state, "trusted");
	assert.equal(mod.isProjectTrusted(cwd), true);

	// single / parallel / chain 执行编排（不调用模型）
	const singleCalls = [];
	const single = await mod.runSingle(
		{ agent: "scout", task: "inspect" },
		{
			runStep: async (options) => {
				singleCalls.push(options);
				return agentResult(options.agentName, "single output");
			},
			modeDetails: detailsFor("single"),
		},
	);
	assert.equal(singleCalls.length, 1);
	assert.equal(singleCalls[0].agentName, "scout");
	assert.equal(singleCalls[0].task, "inspect");
	assert.equal(singleCalls[0].step, undefined);
	assert.equal(single.content[0].text, "single output");
	assert.equal(single.details.mode, "single");
	assert.equal(single.details.results[0].output, "single output");
	assert.equal(single.isError, undefined);

	const singleFailed = await mod.runSingle(
		{ agent: "scout", task: "fail" },
		{
			runStep: async (options) => agentResult(options.agentName, "", { error: "boom" }),
			modeDetails: detailsFor("single"),
		},
	);
	assert.match(singleFailed.content[0].text, /子代理 scout 失败/);
	assert.match(singleFailed.content[0].text, /boom/);
	assert.equal(singleFailed.isError, true);

	let active = 0;
	let maxActive = 0;
	const parallelCalls = [];
	const parallel = await mod.runParallel(
		["a", "b", "c", "d", "e", "f"].map((agent) => ({ agent, task: `task-${agent}` })),
		{
			runStep: async (options) => {
				parallelCalls.push(options.agentName);
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return agentResult(options.agentName, `out-${options.agentName}`);
			},
			modeDetails: detailsFor("parallel"),
		},
	);
	assert.equal(parallelCalls.length, 6);
	assert.equal(maxActive, 4, "并行上限为 4");
	assert.match(parallel.content[0].text, /并行子代理：6\/6 成功/);
	assert.deepEqual(parallel.details.results.map((result) => result.agent), ["a", "b", "c", "d", "e", "f"]);
	assert.equal(parallel.isError, undefined);

	let tooManyCalls = 0;
	const tooMany = await mod.runParallel(
		Array.from({ length: 9 }, (_, index) => ({ agent: `agent-${index}`, task: "x" })),
		{
			runStep: async () => {
				tooManyCalls += 1;
				return agentResult("unexpected", "x");
			},
			modeDetails: detailsFor("parallel"),
		},
	);
	assert.equal(tooManyCalls, 0);
	assert.match(tooMany.content[0].text, /最多 8 个/);
	assert.equal(tooMany.isError, true);

	const partial = await mod.runParallel(
		[{ agent: "ok1", task: "1" }, { agent: "bad", task: "2" }, { agent: "ok2", task: "3" }],
		{
			runStep: async (options) =>
				options.agentName === "bad"
					? agentResult("bad", "", { error: "nope" })
					: agentResult(options.agentName, `out-${options.agentName}`),
			modeDetails: detailsFor("parallel"),
		},
	);
	assert.match(partial.content[0].text, /2\/3 成功/);
	assert.match(partial.content[0].text, /### \[bad\] 失败/);
	assert.equal(partial.isError, true);
	assert.deepEqual(partial.details.results.map((result) => result.agent), ["ok1", "bad", "ok2"]);

	const chainCalls = [];
	const chain = await mod.runChain(
		[
			{ agent: "first", task: "collect" },
			{ agent: "second", task: "use {previous} twice: {previous}" },
		],
		{
			runStep: async (options) => {
				chainCalls.push(options);
				return agentResult(
					options.agentName,
					options.agentName === "first" ? "A" : `B(${options.task})`,
				);
			},
			modeDetails: detailsFor("chain"),
		},
	);
	assert.deepEqual(chainCalls.map((options) => options.agentName), ["first", "second"]);
	assert.deepEqual(chainCalls.map((options) => options.step), [1, 2]);
	assert.equal(chainCalls[1].task, "use A twice: A");
	assert.equal(chain.content[0].text, "B(use A twice: A)");
	assert.deepEqual(chain.details.results.map((result) => result.output), ["A", "B(use A twice: A)"]);
	assert.equal(chain.isError, undefined);

	let chainFailCalls = 0;
	const chainFailed = await mod.runChain(
		[{ agent: "first", task: "x" }, { agent: "second", task: "y" }],
		{
			runStep: async (options) => {
				chainFailCalls += 1;
				return agentResult(options.agentName, "", { error: "stop" });
			},
			modeDetails: detailsFor("chain"),
		},
	);
	assert.equal(chainFailCalls, 1);
	assert.match(chainFailed.content[0].text, /第 1 步（first）失败/);
	assert.equal(chainFailed.isError, true);
	assert.equal(chainFailed.details.results.length, 1);

	// 本地会话注册 subagent；计划模式下被阻止
	const { SessionHost } = mod;
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const events = [];
	const host = new SessionHost((event) => events.push(event), "auto");
	try {
		await host.init(cwd, manager.getSessionFile());
		assert.ok(host.session.getActiveToolNames().includes("subagent"), "本地会话启用 subagent");
		assert.ok(host.session.extensionRunner.getToolDefinition("subagent"), "subagent 工具已注册");
		await host.handle({ type: "set_work_mode", mode: "plan" });
		const blocked = await host.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolCallId: "test-subagent-plan",
			toolName: "subagent",
			input: { agent: "scout", task: "check" },
		});
		assert.equal(blocked?.block, true, "计划模式阻止 subagent");
	} finally {
		await host.dispose();
	}
	console.log("SUBAGENT REGRESSION OK（未调用模型）");
} finally {
	rmSync(base, { recursive: true, force: true });
}
