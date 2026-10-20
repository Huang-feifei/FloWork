/**
 * 子代理回归：agent 发现、项目信任与工具注册，不调用模型。
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
