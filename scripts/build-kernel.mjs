/** 构建独立运行包：固定依赖、Worker 适配层、平台运行依赖与签名清单。 */
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import * as tar from "tar";
import { probeKernel } from "./lib/kernel-probe.mjs";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
function argument(name, fallback) {
	const index = args.indexOf(name);
	if (index === -1) return fallback;
	if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} 缺少参数`);
	return args[index + 1];
}
const config = JSON.parse(await readFile(resolve(root, argument("--config", "kernel.config.json")), "utf8"));
const protocolSource = await readFile(join(root, "src/shared/kernel.ts"), "utf8");
const protocolVersion = Number(/KERNEL_PROTOCOL_VERSION = (\d+)/.exec(protocolSource)?.[1]);
if (!Number.isSafeInteger(protocolVersion)) throw new Error("无法读取内核协议版本");
const version = argument("--version");
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("请传入 --version x.y.z（独立内核版本，不是 Pi 版本）");
const minAppVersion = argument("--min-app", pkg.version);
const maxAppVersion = argument("--max-app");
const minElectronVersion = argument("--min-electron", pkg.devDependencies.electron);
for (const value of [minAppVersion, maxAppVersion, minElectronVersion].filter(Boolean)) {
	if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("应用和运行环境版本必须为 x.y.z");
}
const keyPath = argument("--key");
const keyText = keyPath ? await readFile(resolve(keyPath), "utf8") : process.env.FLOWORK_KERNEL_SIGNING_KEY;
if (!keyText) throw new Error("请设置 FLOWORK_KERNEL_SIGNING_KEY（PEM 内容），或传入 --key <私钥文件>");
const key = createPrivateKey(keyText);
if (key.asymmetricKeyType !== "ed25519") throw new Error("发行密钥必须是 Ed25519");
const publicKey = createPublicKey(config.publicKey);
const testBytes = Buffer.from("FloWork kernel signing key check");
if (!verify(null, testBytes, publicKey, sign(null, testBytes, key))) throw new Error("私钥与 kernel.config.json 中的公钥不匹配");

const output = resolve(root, argument("--out", "release/kernels"));
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, ".build-"));
try {
	// 使用项目 lockfile，确保直接和传递依赖均可复现；不在用户电脑上执行 npm。
	await copyFile(join(root, "package.json"), join(stage, "package.json"));
	await copyFile(join(root, "package-lock.json"), join(stage, "package-lock.json"));
	const npmArgs = ["ci", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"];
	const npm = process.env.npm_execpath;
	const result = npm
		? spawnSync(process.execPath, [npm, ...npmArgs], { cwd: stage, stdio: "inherit" })
		: spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`安装固定生产依赖失败：${result.status}`);
	await build({
		absWorkingDir: root, entryPoints: ["src/worker/index.ts"], outfile: join(stage, "pi-worker.js"),
		bundle: true, platform: "node", format: "esm", target: "node22", packages: "external",
		alias: { "@shared": "./src/shared" }, logLevel: "info",
	});
	await writeFile(join(stage, "package.json"), JSON.stringify({ name: "flowork-kernel", version, private: true, type: "module" }));
	const pi = JSON.parse(await readFile(join(stage, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
	const minNodeVersion = argument("--min-node", /^>=\s*(\d+\.\d+\.\d+)$/.exec(pi.engines?.node ?? "")?.[1]);
	if (!minNodeVersion || !/^\d+\.\d+\.\d+$/.test(minNodeVersion)) throw new Error("无法推导 Pi 的最低 Node 版本，请传入 --min-node x.y.z");
	await probeKernel(join(stage, "pi-worker.js"), protocolVersion);
	const archive = `flowork-kernel-${version}-${process.platform}-${process.arch}.tar.gz`;
	const archivePath = join(output, archive);
	await tar.c({ cwd: stage, file: archivePath, gzip: true, portable: true, follow: true }, ["pi-worker.js", "package.json", "node_modules"]);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
	const manifest = {
		format: 1, version, piVersion: pi.version, protocolVersion,
		platform: process.platform, arch: process.arch, minAppVersion,
		...(maxAppVersion ? { maxAppVersion } : {}), minNodeVersion, minElectronVersion,
		archive, sha256: hash.digest("hex"), size: (await stat(archivePath)).size,
	};
	const bytes = Buffer.from(JSON.stringify(manifest));
	const envelope = { manifest: bytes.toString("base64"), signature: sign(null, bytes, key).toString("base64") };
	const manifestName = `flowork-kernel-${process.platform}-${process.arch}.json`;
	await writeFile(join(output, manifestName), `${JSON.stringify(envelope, null, 2)}\n`);
	console.log(`\n内核 ${version}（Pi ${pi.version}）已构建。创建公开 Release：kernel-v${version}`);
	console.log(`上传附件：\n  ${archivePath}\n  ${join(output, manifestName)}`);
} finally {
	await rm(stage, { recursive: true, force: true });
}
