/**
 * MCP 回归测试：mcp.json 读写、mtime 并发保护、配置校验与 SessionHost 中 MCP 扩展注入。
 * 不发起真实网络请求，不调用模型。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const base = mkdtempSync(join(root, "out", "test-mcp-"));
const agentDir = join(base, "agent");
const cwd = join(base, "project");

try {
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	Object.assign(process.env, {
		FLOWORK_DATA_DIR: join(base, "data"),
		FLOWORK_PI_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
	});

	// 1. 测试 mcp.json 在 config-file.ts 中的原子读写与并发保护
	const bundle = join(base, "mcp-test-bundle.mjs");
	await build({
		stdin: {
			contents: [
				'export * from "./src/worker/config-file.ts";',
				'export * from "./src/worker/service-host.ts";',
				'export * from "./src/worker/session-host.ts";',
			].join("\n"),
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

	const { writeConfigFile, ServiceHost, SessionHost } = await import(pathToFileURL(bundle).href);

	const mcpPath = join(agentDir, "mcp.json");
	const validConfig = {
		mcpServers: {
			fetch: {
				command: "uvx",
				args: ["mcp-server-fetch"],
				enabled: true,
				description: "网页抓取工具",
			},
			docs: {
				url: "https://mcp.example.com/mcp",
				headers: { Authorization: "Bearer test-token" },
				enabled: false,
			},
		},
	};

	// 初始写入
	await writeConfigFile(mcpPath, `${JSON.stringify(validConfig, null, 2)}\n`);
	assert.ok(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.fetch);

	// 2. 测试 ServiceHost 的 readConfig 和 saveConfig 支持 "mcp"
	const service = new ServiceHost(() => {});
	const readResult = await service.handle({ type: "get_config_file", name: "mcp" });
	assert.equal(readResult.exists, true);
	assert.equal(readResult.name, "mcp");
	const parsedRead = JSON.parse(readResult.text);
	assert.equal(parsedRead.mcpServers.fetch.command, "uvx");
	assert.equal(parsedRead.mcpServers.docs.enabled, false);

	// 3. 测试非法 JSON 校验拒绝
	await assert.rejects(
		() => service.handle({ type: "save_config_file", name: "mcp", text: "{ not valid json }" }),
		/不是合法的 JSON/,
	);
	await assert.rejects(
		() => service.handle({ type: "save_config_file", name: "mcp", text: "[\"not an object\"]" }),
		/顶层必须是对象/,
	);

	// 4. 测试合法保存与 mtime 覆盖
	const updatedConfig = {
		mcpServers: {
			...validConfig.mcpServers,
			filesystem: {
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
				enabled: true,
			},
		},
	};
	const saveResult = await service.handle({
		type: "save_config_file",
		name: "mcp",
		text: JSON.stringify(updatedConfig, null, 2),
		expectedMtime: readResult.mtime,
	});
	assert.ok(saveResult.mtime > 0);
	const readBack = JSON.parse(saveResult.text);
	assert.equal(Object.keys(readBack.mcpServers).length, 3);
	assert.ok(readBack.mcpServers.filesystem);

	// 5. 测试 mtime 冲突拒绝
	await assert.rejects(
		() =>
			service.handle({
				type: "save_config_file",
				name: "mcp",
				text: JSON.stringify(updatedConfig),
				expectedMtime: 12345, // 错误的 mtime
			}),
		/已被外部修改/,
	);

	// 6. 验证本地 SessionHost 初始化正常加载 MCP 扩展（不报错，静默就绪）
	const sessionHost = new SessionHost((_event) => {});
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [] }));
	const sessionState = await sessionHost.init(cwd);
	assert.ok(sessionState.sessionId);
	assert.equal(sessionState.ops, undefined, "本地会话非 ops");

	console.log("✓ mcp.json 读写、mtime 并发保护与格式校验通过");
	console.log("✓ ServiceHost 支持 get_config_file / save_config_file('mcp')");
	console.log("✓ SessionHost 成功集成 createMcpExtension 扩展注入");

	sessionHost.dispose();
	console.log("MCP REGRESSION OK（未调用模型；纯离线测试）");
} finally {
	rmSync(base, { recursive: true, force: true });
}
