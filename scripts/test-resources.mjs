/**
 * 开发辅助：在隔离后端（out/ 下的临时数据目录与空闲端口，不碰 ~/.flowork）测试项目信任与技能管理（不调用模型）。
 * 测试项目与技能都放在隔离目录里，随隔离后端一起删除，无需手工回滚真实配置。
 *   node scripts/test-resources.mjs（需先 npm run build && npm run build:test）
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, createChecks, startIsolatedBackend } from "./lib/isolated-backend.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(checks) {
	const backend = await startIsolatedBackend({ label: "resources" });
	const base = join(backend.root, "fixtures");
	const project = join(base, "proj");
	const marker = join(base, "extension-loaded.txt");
	mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
	// 项目扩展：加载时写一个标记文件，用来判断它是否被执行
	writeFileSync(
		join(project, ".pi", "extensions", "marker.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }\n`,
	);
	const skillSrc = join(base, "hello-flowork");
	mkdirSync(skillSrc, { recursive: true });
	writeFileSync(
		join(skillSrc, "SKILL.md"),
		"---\nname: hello-flowork\ndescription: 测试用技能，回复固定问候语。\n---\n\n# Hello\n\n用户请求问候时，回复“你好，来自 FloWork 技能”。\n",
	);
	let client;
	let handleId;
	let importedPath;
	const call = (method, params) => client.call(method, params);
	const service = (command) => call("service.send", command);
	try {
		client = await connect(await backend.waitReady());

		// 1. 未决定信任：项目扩展不应被执行
		const opened = await call("session.open", { cwd: project });
		handleId = opened.handleId;
		await sleep(500);
		checks.check("未决定时状态为 untrusted 且列出 .pi/extensions", opened.state.trust?.state === "untrusted" && opened.state.trust.items.includes(".pi/extensions"));
		checks.check("未信任时项目扩展没有执行", !existsSync(marker));

		// 2. 信任后重新加载，扩展被执行
		const trusted = await call("session.send", { handleId, command: { type: "set_project_trust", trusted: true } });
		await sleep(500);
		checks.check("信任后状态为 trusted", trusted.trust?.state === "trusted" && trusted.trust.decided);
		checks.check("信任后项目扩展被加载", existsSync(marker));

		// 3. 导入技能（用户级）
		const imported = await service({ type: "import_resource", cwd: project, kind: "skill", sourcePath: skillSrc, scope: "user" });
		importedPath = imported.path;
		let res = await service({ type: "list_resources", cwd: project });
		const skill = res.resources.find((r) => r.kind === "skill" && r.name === "hello-flowork");
		checks.check("导入的技能出现在列表中且可删除", !!skill && skill.enabled && skill.removable && skill.description?.includes("测试用"));
		const ext = res.resources.find((r) => r.kind === "extension" && r.path.endsWith("marker.ts"));
		checks.check("项目扩展出现在列表中（scope=project）", ext?.scope === "project");
		await sleep(1500);
		let cmds = await call("session.send", { handleId, command: { type: "get_commands" } });
		checks.check("会话已重新加载，斜杠命令包含 /skill:hello-flowork", cmds.some((c) => c.name === "skill:hello-flowork"));

		// 4. 重复导入应被拒绝
		const dup = await service({ type: "import_resource", cwd: project, kind: "skill", sourcePath: skillSrc, scope: "user" }).catch((e) => e);
		checks.check("重复导入被拒绝", dup instanceof Error);

		// 5. 禁用
		await service({ type: "set_resource_enabled", cwd: project, kind: "skill", path: skill.path, enabled: false });
		res = await service({ type: "list_resources", cwd: project });
		checks.check("禁用后 enabled=false", res.resources.find((r) => r.path === skill.path)?.enabled === false);
		await sleep(1500);
		cmds = await call("session.send", { handleId, command: { type: "get_commands" } });
		checks.check("禁用后斜杠命令中不再有该技能", !cmds.some((c) => c.name === "skill:hello-flowork"));

		// 6. 删除
		await service({ type: "remove_resource", cwd: project, kind: "skill", path: skill.path });
		checks.check("删除后副本目录不存在", !existsSync(importedPath));
		res = await service({ type: "list_resources", cwd: project });
		checks.check("删除后列表中不再有该技能", !res.resources.some((r) => r.name === "hello-flowork"));

		// 7. 越界删除应被拒绝
		const bad = await service({ type: "remove_resource", cwd: project, kind: "skill", path: skillSrc }).catch((e) => e);
		checks.check("不能删除配置目录以外的资源", bad instanceof Error && existsSync(skillSrc));
	} finally {
		if (handleId && client) {
			// 记为不信任，避免隔离目录残留为“信任”
			await call("session.send", { handleId, command: { type: "set_project_trust", trusted: false } }).catch(() => undefined);
			await call("session.close", { handleId }).catch(() => undefined);
		}
		await client?.close();
		await backend.stop();
	}
}

const checks = createChecks();
await main(checks).then(
	() => checks.finish("RESOURCES REGRESSION OK（隔离后端；未调用模型）"),
	(error) => {
		console.error(`RESOURCES REGRESSION FAILED\n${error?.stack ?? error}`);
		process.exitCode = 1;
	},
);
