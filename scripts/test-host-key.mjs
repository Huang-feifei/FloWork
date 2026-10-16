/**
 * 集成测试：主机密钥变化的检测与更新（src/core/host-key.ts）。
 *   node scripts/test-host-key.mjs
 *
 * 需要一台 Docker 测试容器，通过环境变量指定（不设置时跳过）：
 *   FLOWORK_TEST_SSH="127.0.0.1:2222"  FLOWORK_TEST_SSH_PASSWORD="..."  FLOWORK_TEST_SSH_CONTAINER="flowork-ubuntu"
 * 测试会在容器里重新生成 SSH 主机密钥（模拟重装系统）。
 *
 * 不会碰你真实的 ~/.ssh/known_hosts：通过临时 ssh 配置（FLOWORK_SSH_CONFIG）把 UserKnownHostsFile 指到临时文件。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createChecks } from "./lib/isolated-backend.mjs";

const spec = (process.env.FLOWORK_TEST_SSH ?? "").split(",")[0]?.trim();
const container = process.env.FLOWORK_TEST_SSH_CONTAINER;
if (!spec || !container) {
	console.log("跳过：需要 FLOWORK_TEST_SSH 与 FLOWORK_TEST_SSH_CONTAINER（见脚本开头的说明）");
	process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "flowork-hostkey-"));
const knownHosts = join(root, "known_hosts");
const sshConfig = join(root, "ssh_config");
writeFileSync(knownHosts, "");
writeFileSync(sshConfig, `Host *\n  UserKnownHostsFile ${knownHosts.replace(/\\/g, "/")}\n  GlobalKnownHostsFile NUL\n`);
process.env.FLOWORK_SSH_CONFIG = sshConfig;

const bundle = join(import.meta.dirname, "../out/tmp-hostkey-test.mjs");
await build({
	entryPoints: [join(import.meta.dirname, "lib/host-key-entry.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: bundle,
	logLevel: "silent",
	alias: { "@shared": join(import.meta.dirname, "../src/shared") },
});
const { inspectHostKey, acceptHostKey, sshRun } = await import(pathToFileURL(bundle).href);

const [hostName, port] = spec.split(":");
const host = { id: "hk-test", createdAt: 0, host: hostName, port: Number(port), user: "root", auth: "password", password: process.env.FLOWORK_TEST_SSH_PASSWORD };
const checks = createChecks();
const regenerate = () => execFileSync("docker", ["exec", container, "sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && kill -HUP 1 2>/dev/null || true"]);

try {
	// 1. 首次连接：accept-new 自动记录
	await sshRun(host, "true");
	const first = await inspectHostKey(host);
	checks.check(`首次连接后已记录（${first.known.length} 条），无变化`, first.known.length > 0 && !first.changed);

	// 2. 服务器重新生成主机密钥 → 连接报主机密钥变化，错误带前缀与 hostId
	regenerate();
	await new Promise((r) => setTimeout(r, 1500));
	const err = await sshRun(host, "true").then(() => null, (e) => e);
	checks.check("密钥变化后连接失败，错误带 FLOWORK_HOST_KEY_CHANGED 前缀与 hostId", err?.message.startsWith(`FLOWORK_HOST_KEY_CHANGED:${host.id}\n`));

	// 3. 检测：旧指纹与新指纹不同
	const report = await inspectHostKey(host);
	const ed = (list) => list.find((k) => k.type === "ssh-ed25519")?.fingerprint;
	checks.check(`检测到变化：${ed(report.known)} → ${ed(report.current)}`, report.changed && ed(report.known) !== ed(report.current) && report.target === `[${hostName}]:${port}`);

	// 4. 用错误的指纹确认 → 拒绝，known_hosts 不变
	const before = readFileSync(knownHosts, "utf8");
	const bad = await acceptHostKey(host, ["SHA256:not-the-real-one"]).then(() => null, (e) => e);
	checks.check("确认的指纹与服务器不符时拒绝更新", !!bad && readFileSync(knownHosts, "utf8") === before);

	// 5. 用正确的指纹确认 → 旧记录删除，新指纹写入，可以重新连接
	await acceptHostKey(host, report.current.map((c) => c.fingerprint));
	const after = await inspectHostKey(host);
	checks.check("更新后本机记录与服务器一致", !after.changed && ed(after.known) === ed(report.current));
	checks.check("更新后可以重新连接", (await sshRun(host, "echo ok")).trim() === "ok");
	checks.check("known_hosts 里没有残留的旧指纹", !readFileSync(knownHosts, "utf8").includes(before.split("\n").find((l) => l.includes("ssh-ed25519"))?.split(" ")[2] ?? "@@none@@"));
} finally {
	rmSync(root, { recursive: true, force: true });
	rmSync(bundle, { force: true });
}
checks.finish("HOST KEY REGRESSION OK（临时 known_hosts）");
