/**
 * 集成测试：运维会话的远程工具（src/worker/ops-tools.ts）在真实 SSH 主机上执行。
 *
 *   node scripts/test-ops-tools.mjs
 *
 * 需要一台可以用 root + 密码登录的测试主机，通过环境变量指定（不设置时跳过并返回 0）：
 *   FLOWORK_TEST_SSH="127.0.0.1:2222"  FLOWORK_TEST_SSH_PASSWORD="..."  [FLOWORK_TEST_SSH_USER=root]
 * 多台主机用逗号分隔：FLOWORK_TEST_SSH="127.0.0.1:2222,127.0.0.1:2223"
 *
 * 只在测试主机的 /tmp/flowork-ops-test 下读写，结束时清理。不调用模型。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createChecks } from "./lib/isolated-backend.mjs";
import { reportSkip } from "./lib/test-results.mjs";

const targets = (process.env.FLOWORK_TEST_SSH ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (targets.length === 0) {
	reportSkip("未设置 FLOWORK_TEST_SSH（见脚本开头的说明）");
	process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "flowork-ops-"));
const bundle = join(root, "ops.mjs");
// pi SDK 与 esbuild 保持外部依赖，从项目 node_modules 加载
await build({
	entryPoints: [join(import.meta.dirname, "lib/ops-entry.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: bundle,
	logLevel: "silent",
	packages: "external",
	alias: { "@shared": join(import.meta.dirname, "../src/shared") },
	nodePaths: [join(import.meta.dirname, "../node_modules")],
});
// 产物在临时目录，需要从项目目录解析 node_modules：把它放回项目里再导入
const local = join(import.meta.dirname, "../out/tmp-ops-test.mjs");
const { copyFileSync, mkdirSync } = await import("node:fs");
mkdirSync(join(import.meta.dirname, "../out"), { recursive: true });
copyFileSync(bundle, local);
const ops = await import(pathToFileURL(local).href);

const checks = createChecks();
const placeholder = join(root, "placeholder");
mkdirSync(placeholder, { recursive: true });

async function runTool(tool, params, signal) {
	const updates = [];
	try {
		const result = await tool.execute(`t${Math.random()}`, params, signal, (u) => updates.push(u), { cwd: placeholder });
		return { result, updates, error: null };
	} catch (error) {
		return { result: null, updates, error };
	}
}
const text = (r) => (r?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");

try {
	for (const spec of targets) {
		const [hostName, port] = spec.split(":");
		const host = {
			id: `test-${spec}`,
			createdAt: 0,
			host: hostName,
			port: port ? Number(port) : undefined,
			user: process.env.FLOWORK_TEST_SSH_USER ?? "root",
			auth: "password",
			password: process.env.FLOWORK_TEST_SSH_PASSWORD,
		};
		const target = { host, remoteCwd: "/root", localCwd: placeholder };
		const tools = ops.createTools(target);
		console.log(`\n── ${spec} ──`);

		const profile = await ops.probeHostProfile(host);
		checks.check(`[${spec}] 主机画像：${profile.facts.os} / ${profile.facts.package_manager}`, !!profile.facts.os && !!profile.facts.package_manager);

		let r = await runTool(tools.bash, { command: "pwd; whoami; echo err >&2; exit 3" });
		// pi 把非零退出码作为 isError 结果返回（不抛错）
		const t1 = text(r.result);
		checks.check(`[${spec}] bash：cwd、stdout、stderr 与退出码`, !r.error && /^\/root\nroot\nerr/.test(t1) && /exited with code 3/.test(t1));

		r = await runTool(tools.bash, { command: "for i in 1 2 3; do echo line$i; sleep 0.4; done" });
		checks.check(`[${spec}] bash：流式输出`, !r.error && /line3/.test(text(r.result)) && r.updates.some((u) => /line1/.test(text(u)) && !/line3/.test(text(u))));

		r = await runTool(tools.bash, { command: "read x; echo got:$x" });
		checks.check(`[${spec}] bash：stdin 已关闭，交互命令不会卡住`, /got:/.test(r.error?.message ?? text(r.result)));

		const ac = new AbortController();
		const started = Date.now();
		setTimeout(() => ac.abort(), 1500);
		r = await runTool(tools.bash, { command: "echo start; sleep 30 & sleep 30; echo never" }, ac.signal);
		checks.check(`[${spec}] bash：中断在 ~1.5s 内返回`, r.error && /aborted/i.test(r.error.message) && Date.now() - started < 6000);
		await new Promise((res) => setTimeout(res, 2500));
		// [s]leep 避免匹配到执行这条检查命令的 shell 自身
		const left = await runTool(tools.bash, { command: "ps -eo cmd | grep -c '^[s]leep 30' || true" });
		checks.check(`[${spec}] bash：中断后远端进程组被结束`, text(left.result).trim().split("\n")[0] === "0");

		r = await runTool(tools.bash, { command: "sleep 10", timeout: 1 });
		checks.check(`[${spec}] bash：超时`, r.error && /timed out after 1 seconds/.test(r.error.message));

		const dir = "/tmp/flowork-ops-test";
		await runTool(tools.bash, { command: `rm -rf ${dir}; mkdir -p ${dir}` });
		r = await runTool(tools.write, { path: `${dir}/app.conf`, content: "server {\n  listen 80;\n}\n" });
		checks.check(`[${spec}] write：新文件（绝对路径），无备份`, !r.error && text(r.result).includes(`${dir}/app.conf`) && !/Backup/.test(text(r.result)));

		r = await runTool(tools.read, { path: `${dir}/app.conf` });
		checks.check(`[${spec}] read：读回内容`, !r.error && /listen 80/.test(text(r.result)));

		await runTool(tools.bash, { command: `chmod 640 ${dir}/app.conf` });
		r = await runTool(tools.edit, { path: `${dir}/app.conf`, edits: [{ oldText: "listen 80;", newText: "listen 8080;" }] });
		const backup = r.result?.details?.backupPath;
		checks.check(`[${spec}] edit：替换成功并生成备份`, !r.error && typeof backup === "string" && backup.startsWith(`${dir}/app.conf.flowork-bak-`) && /Backup of the previous version/.test(text(r.result)));
		checks.check(`[${spec}] edit：diff 可用`, typeof r.result?.details?.diff === "string" && r.result.details.diff.includes("8080"));
		const verify = await runTool(tools.bash, { command: `cat ${dir}/app.conf; echo ---; cat '${backup}'; echo ---; stat -c %a ${dir}/app.conf` });
		const out = text(verify.result);
		checks.check(`[${spec}] edit：新内容、备份内容、权限保持 640`, /listen 8080/.test(out.split("---")[0]) && /listen 80;/.test(out.split("---")[1]) && out.split("---")[2].trim() === "640");

		r = await runTool(tools.read, { path: "app-relative.txt" });
		checks.check(`[${spec}] read：相对路径按远程 cwd 解析（报文件不存在而非本地路径）`, r.error && /\/root\/app-relative\.txt/.test(r.error.message));

		r = await runTool(tools.edit, { path: `${dir}/missing.conf`, edits: [{ oldText: "a", newText: "b" }] });
		checks.check(`[${spec}] edit：文件不存在时报错`, !!r.error);

		r = await runTool(tools.write, { path: `${dir}/中文 空格.txt`, content: "你好\n" });
		const cn = await runTool(tools.read, { path: `${dir}/中文 空格.txt` });
		checks.check(`[${spec}] write / read：中文与空格路径`, !r.error && /你好/.test(text(cn.result)));

		await runTool(tools.bash, { command: `rm -rf ${dir}` });
	}
} finally {
	rmSync(root, { recursive: true, force: true });
	rmSync(local, { force: true });
}
checks.finish("OPS TOOLS INTEGRATION OK");
