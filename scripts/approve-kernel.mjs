/** 本地测试并签名放行官方 Pi；只发布兼容清单，不重新分发 Pi 运行包。 */
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildKernelAdapter } from "./lib/build-kernel-adapter.mjs";
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
const minAppVersion = argument("--min-app", pkg.version);
const maxAppVersion = argument("--max-app", minAppVersion);
const minElectronVersion = argument("--min-electron", pkg.devDependencies.electron);
for (const value of [version, minAppVersion, maxAppVersion, minElectronVersion]) {
	if (!value || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("请传入 --version x.y.z（放行批次）；应用和运行环境版本也必须为 x.y.z");
}
const keyPath = argument("--key");
const keyText = keyPath ? await readFile(resolve(keyPath), "utf8") : process.env.FLOWORK_KERNEL_SIGNING_KEY;
if (!keyText) throw new Error("请设置 FLOWORK_KERNEL_SIGNING_KEY（PEM 内容），或传入 --key <私钥文件>");
const key = createPrivateKey(keyText);
if (key.asymmetricKeyType !== "ed25519") throw new Error("放行密钥必须是 Ed25519");
const publicKey = createPublicKey(config.publicKey);
const testBytes = Buffer.from("FloWork Pi approval signing key check");
if (!verify(null, testBytes, publicKey, sign(null, testBytes, key))) throw new Error("私钥与 kernel.config.json 中的公钥不匹配");

const output = resolve(root, argument("--out", `release/kernels/${version}`));
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, ".approve-"));
try {
	const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
	// 项目测试所用的固定依赖树，只将 npm 镜像地址还原成官方源；绝不重新解析 latest。
	for (const [path, p] of Object.entries(lock.packages)) {
		if (!path || p.dev) continue;
		const name = p.name ?? path.split("node_modules/").at(-1);
		if (p.link || !p.resolved || !/^https:\/\/registry\.(?:npmjs\.org|npmmirror\.com)\//.test(p.resolved)) throw new Error(`依赖 ${path} 不是受支持的官方 npm 分发包`);
		p.resolved = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${p.version}.tgz`;
	}
	await copyFile(join(root, "package.json"), join(stage, "package.json"));
	await writeFile(join(stage, "package-lock.json"), JSON.stringify(lock));
	const npmArgs = ["ci", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"];
	const npm = process.env.npm_execpath;
	const result = npm
		? spawnSync(process.execPath, [npm, ...npmArgs], { cwd: stage, stdio: "inherit" })
		: spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`安装已锁定的官方依赖失败：${result.status}`);
	const adapter = join(stage, "adapter.js");
	if (argument("--adapter")) await copyFile(resolve(argument("--adapter")), adapter);
	else await buildKernelAdapter(root, adapter);
	// 复用客户端的下载、解包、布局验证实现；避免批准了仅 npm install 才能运行的树。
	await build({
		absWorkingDir: root,
		entryPoints: ["src/core/kernel-npm.ts", "src/core/kernel-package.ts"], outdir: join(stage, "lib"),
		bundle: true, packages: "external", platform: "node", format: "esm", alias: { "@shared": "./src/shared" }, logLevel: "silent",
	});
	const { installApprovedRuntime, requestNpm } = await import(pathToFileURL(join(stage, "lib/kernel-npm.js")).href);
	const { verifyManifest, npmTarballUrl, MAX_KERNEL_BYTES, MAX_MANIFEST_BYTES } = await import(pathToFileURL(join(stage, "lib/kernel-package.js")).href);
	const installedLock = JSON.parse(await readFile(join(stage, "node_modules/.package-lock.json"), "utf8"));
	const packages = [];
	for (const [path, p] of Object.entries(installedLock.packages)) {
		const actual = JSON.parse(await readFile(join(stage, path, "package.json"), "utf8"));
		if (actual.version !== p.version) throw new Error(`安装的 ${path} 与 lockfile 不一致`);
		packages.push({ path, name: actual.name, version: actual.version, url: npmTarballUrl(actual.name, actual.version), integrity: p.integrity, size: 0 });
	}
	packages.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const pi = JSON.parse(await readFile(join(stage, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
	const minNodeVersion = argument("--min-node", /^>=\s*(\d+\.\d+\.\d+)$/.exec(pi.engines?.node ?? "")?.[1]);
	if (!minNodeVersion || !/^\d+\.\d+\.\d+$/.test(minNodeVersion)) throw new Error("无法推导 Pi 的最低 Node 版本，请传入 --min-node x.y.z");
	const cached = new Map();
	const cacheDirectory = join(stage, "official-tarballs");
	await mkdir(cacheDirectory);
	let next = 0;
	let total = 0;
	let failure;
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]);
	console.log(`从官方 npm 验证 ${packages.length} 个固定依赖…`);
	await Promise.all(Array.from({ length: Math.min(6, packages.length) }, async () => {
		try {
			while (next < packages.length && !signal.aborted) {
				const index = next++;
				const p = packages[index];
				const response = await requestNpm(p.url, signal);
				if (!response.body) throw new Error(`npm 包 ${p.name} 返回空响应`);
				const file = join(cacheDirectory, `${index}.tgz`);
				const out = await open(file, "wx");
				const hash = createHash("sha512");
				try {
					for await (const chunk of response.body) {
						p.size += chunk.byteLength; total += chunk.byteLength;
						if (total > MAX_KERNEL_BYTES) throw new Error("官方包下载总量超出限制");
						hash.update(chunk); await out.writeFile(chunk);
					}
				} finally { await out.close(); }
				if (`sha512-${hash.digest("base64")}` !== p.integrity) throw new Error(`${p.name} 的官方 tarball 与测试 lockfile 不一致`);
				cached.set(p.url, file);
			}
		} catch (error) { failure ??= error; controller.abort(error); }
	}));
	if (failure) throw failure;
	if (signal.aborted) throw new Error("官方 npm 下载超时");
	const manifest = {
		format: 2, version, piVersion: pi.version, protocolVersion,
		platform: process.platform, arch: process.arch, minAppVersion, maxAppVersion, minNodeVersion, minElectronVersion,
		adapterSha256: createHash("sha256").update(await readFile(adapter)).digest("hex"), packages,
	};
	const bytes = Buffer.from(JSON.stringify(manifest));
	const envelope = { manifest: bytes.toString("base64"), signature: sign(null, bytes, key).toString("base64") };
	if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_MANIFEST_BYTES) throw new Error("兼容清单超出客户端大小限制");
	verifyManifest(envelope, config.publicKey);
	const runtime = join(stage, "runtime");
	await installApprovedRuntime({
		manifest, adapterEntry: adapter, destination: runtime, archiveDirectory: join(stage, "install-tarballs"),
		fetch: async (url) => {
			const file = cached.get(url);
			if (!file) throw new Error(`未缓存的官方包：${url}`);
			return new Response(Readable.toWeb(createReadStream(file)));
		},
	});
	await probeKernel(join(runtime, "pi-worker.js"), protocolVersion);
	const filename = join(output, `flowork-pi-approval-${process.platform}-${process.arch}.json`);
	// 每个平台/批次使用独立输出目录，拒绝无意覆盖已审批的文件。
	await writeFile(filename, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
	console.log(`\n✓ 已批准官方 Pi ${pi.version}，放行批次 ${version}，FloWork ${minAppVersion}–${maxAppVersion}`);
	console.log(`只上传兼容清单：${filename}`);
	console.log(`Release 标签：kernel-v${version}。无需上传 Pi 压缩包。`);
} finally { await rm(stage, { recursive: true, force: true, maxRetries: 3 }); }
