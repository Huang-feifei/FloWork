/**
 * 回归：SSH 主机注册表的口令加密（src/core/hosts.ts）。
 *   node scripts/test-hosts.mjs（不需要先构建：脚本用 esbuild 现场打包 hosts.ts）
 *
 * 用一个可逆的假 codec 代替 Electron safeStorage，在临时目录里验证：
 * 新增加密落盘、旧明文自动迁移、重启后解密、无法解密时保留密文、换认证方式后清除密文、无 codec 时明文。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createChecks } from "./lib/isolated-backend.mjs";

const root = mkdtempSync(join(tmpdir(), "flowork-hosts-"));
const bundle = join(root, "hosts.mjs");
await build({
	entryPoints: [new URL("../src/core/hosts.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: bundle,
	logLevel: "silent",
});
// paths.ts 读 FLOWORK_DATA_DIR；这里显式传文件路径，同时把数据目录指到临时目录兜底
process.env.FLOWORK_DATA_DIR = root;
const { HostStore } = await import(pathToFileURL(bundle).href);

/** 假 codec：反转字符串再 base64，足以区分明文 / 密文 */
const codec = (available = true) => ({
	available: () => available,
	encrypt: (plain) => Buffer.from(`x${[...plain].reverse().join("")}`).toString("base64"),
	decrypt: (cipher) => {
		const text = Buffer.from(cipher, "base64").toString();
		if (!text.startsWith("x")) throw new Error("bad cipher");
		return [...text.slice(1)].reverse().join("");
	},
});
// 模拟换了系统用户：能加密新数据，但旧密文解不开
const brokenCodec = { ...codec(), decrypt: () => { throw new Error("cannot decrypt"); } };
const disk = (file) => JSON.parse(readFileSync(file, "utf8"));

const checks = createChecks();
try {
	// 1. 新增：落盘只有密文，接口返回明文
	const fileA = join(root, "a.json");
	const storeA = new HostStore(fileA, codec());
	const added = await storeA.add({ host: "example.com", auth: "password", password: "s3cret" });
	const savedA = disk(fileA).hosts[0];
	checks.check("新增后落盘无明文口令", savedA.password === undefined && savedA.passwordEnc?.startsWith("enc:v1:"));
	checks.check("新增返回解密后的口令", added.password === "s3cret" && !("passwordEnc" in added));

	// 2. 重启（新实例）后能解密
	const reopened = await new HostStore(fileA, codec()).require(added.id);
	checks.check("重新加载后解密成功", reopened.password === "s3cret");

	// 3. 旧明文自动迁移
	const fileB = join(root, "b.json");
	writeFileSync(fileB, JSON.stringify({ version: 1, hosts: [{ id: "h1", createdAt: 1, host: "old", auth: "password", password: "plain" }] }));
	const listB = await new HostStore(fileB, codec()).list();
	const savedB = disk(fileB).hosts[0];
	checks.check("旧明文口令读取后迁移为密文", listB[0].password === "plain" && savedB.password === undefined && !!savedB.passwordEnc);

	// 4. 无法解密：保留密文，不覆盖；require 给出可读错误
	const storeC = new HostStore(fileA, brokenCodec);
	await storeC.setPlatform(added.id, "linux");
	checks.check("无法解密时密文原样保留", disk(fileA).hosts[0].passwordEnc === savedA.passwordEnc);
	const err = await storeC.require(added.id).then(() => null, (e) => e);
	checks.check("无法解密时 require 报可读错误", /重新填写密码/.test(err?.message ?? ""));

	// 5. 填写新口令后恢复可用（覆盖旧密文）
	await storeC.update(added.id, { password: "fresh" });
	checks.check("重新填写口令后可用", (await new HostStore(fileA, codec()).require(added.id)).password === "fresh");

	// 6. 改成密钥认证：密文与口令一并清除
	const storeD = new HostStore(fileA, codec());
	await storeD.update(added.id, { auth: "agent" });
	const savedD = disk(fileA).hosts[0];
	checks.check("改为 agent 认证后不再保存口令", savedD.password === undefined && savedD.passwordEnc === undefined);

	// 7. 无 codec（隔离测试 / 系统加密不可用）：保持明文
	const fileE = join(root, "e.json");
	await new HostStore(fileE).add({ host: "web", auth: "password", password: "pw" });
	checks.check("无 codec 时明文保存", disk(fileE).hosts[0].password === "pw");
} finally {
	rmSync(root, { recursive: true, force: true });
}
checks.finish("HOSTS REGRESSION OK（临时目录；未连接任何主机）");
