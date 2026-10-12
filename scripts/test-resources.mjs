/**
 * 开发辅助：对运行中的后端测试项目信任与技能管理（不调用模型）。
 * 在临时目录中创建测试项目与测试技能，结束时清理（包括复制到配置目录的技能与 trust.json 中的记录）。
 *   node scripts/test-resources.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const port = Number(process.env.FLOWORK_PORT ?? 17321);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
let seq = 0;
const pending = new Map();
ws.on("message", (data) => {
	const f = JSON.parse(String(data));
	if (!f.id) return;
	const p = pending.get(f.id);
	pending.delete(f.id);
	f.ok ? p.resolve(f.result) : p.reject(new Error(f.error));
});
const call = (method, params) =>
	new Promise((resolve, reject) => {
		const id = String(++seq);
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
const service = (command) => call("service.send", command);
const check = (label, cond) => console.log(`${cond ? "✓" : "✗"} ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on("open", async () => {
	const base = join(tmpdir(), `flowork-res-test-${Date.now()}`);
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
	let handleId;
	let importedPath;
	try {
		// 1. 未决定信任：项目扩展不应被执行
		const opened = await call("session.open", { cwd: project });
		handleId = opened.handleId;
		await sleep(500);
		check("未决定时状态为 untrusted 且列出 .pi/extensions", opened.state.trust?.state === "untrusted" && opened.state.trust.items.includes(".pi/extensions"));
		check("未信任时项目扩展没有执行", !existsSync(marker));

		// 2. 信任后重新加载，扩展被执行
		const trusted = await call("session.send", { handleId, command: { type: "set_project_trust", trusted: true } });
		await sleep(500);
		check("信任后状态为 trusted", trusted.trust?.state === "trusted" && trusted.trust.decided);
		check("信任后项目扩展被加载", existsSync(marker));

		// 3. 导入技能（用户级）
		const imported = await service({ type: "import_resource", cwd: project, kind: "skill", sourcePath: skillSrc, scope: "user" });
		importedPath = imported.path;
		let res = await service({ type: "list_resources", cwd: project });
		const skill = res.resources.find((r) => r.kind === "skill" && r.name === "hello-flowork");
		check("导入的技能出现在列表中且可删除", !!skill && skill.enabled && skill.removable && skill.description?.includes("测试用"));
		const ext = res.resources.find((r) => r.kind === "extension" && r.path.endsWith("marker.ts"));
		check("项目扩展出现在列表中（scope=project）", ext?.scope === "project");
		await sleep(1500);
		let cmds = await call("session.send", { handleId, command: { type: "get_commands" } });
		check("会话已重新加载，斜杠命令包含 /skill:hello-flowork", cmds.some((c) => c.name === "skill:hello-flowork"));

		// 4. 重复导入应被拒绝
		const dup = await service({ type: "import_resource", cwd: project, kind: "skill", sourcePath: skillSrc, scope: "user" }).catch((e) => e);
		check("重复导入被拒绝", dup instanceof Error);

		// 5. 禁用
		await service({ type: "set_resource_enabled", cwd: project, kind: "skill", path: skill.path, enabled: false });
		res = await service({ type: "list_resources", cwd: project });
		check("禁用后 enabled=false", res.resources.find((r) => r.path === skill.path)?.enabled === false);
		await sleep(1500);
		cmds = await call("session.send", { handleId, command: { type: "get_commands" } });
		check("禁用后斜杠命令中不再有该技能", !cmds.some((c) => c.name === "skill:hello-flowork"));

		// 6. 删除
		await service({ type: "remove_resource", cwd: project, kind: "skill", path: skill.path });
		check("删除后副本目录不存在", !existsSync(importedPath));
		res = await service({ type: "list_resources", cwd: project });
		check("删除后列表中不再有该技能", !res.resources.some((r) => r.name === "hello-flowork"));

		// 7. 越界删除应被拒绝
		const bad = await service({ type: "remove_resource", cwd: project, kind: "skill", path: skillSrc }).catch((e) => e);
		check("不能删除配置目录以外的资源", bad instanceof Error && existsSync(skillSrc));
	} catch (e) {
		console.error("测试失败：", e.message);
	} finally {
		if (handleId) {
			// 记为不信任，避免临时目录残留为“信任”
			await call("session.send", { handleId, command: { type: "set_project_trust", trusted: false } }).catch(() => undefined);
			await call("session.close", { handleId }).catch(() => undefined);
		}
		if (importedPath && existsSync(importedPath)) rmSync(importedPath, { recursive: true, force: true });
		rmSync(base, { recursive: true, force: true });
		// 清理该临时项目的会话记录与信任记录
		const agentDir = process.env.FLOWORK_PI_AGENT_DIR || join(homedir(), ".flowork", "agent");
		const tag = base.split(/[\\/]/).pop();
		const sessDir = join(agentDir, "sessions");
		if (existsSync(sessDir)) for (const d of readdirSync(sessDir)) if (d.includes(tag)) rmSync(join(sessDir, d), { recursive: true, force: true });
		const trustFile = join(agentDir, "trust.json");
		if (existsSync(trustFile)) {
			const t = JSON.parse(readFileSync(trustFile, "utf8"));
			for (const k of Object.keys(t)) if (k.includes(tag)) delete t[k];
			writeFileSync(trustFile, `${JSON.stringify(t, null, 2)}\n`);
		}
		ws.close();
		console.log(`清理完成：${base}`);
	}
});
