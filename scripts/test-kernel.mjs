/** 完全离线的更新回归：真实签名/归档，模拟 GitHub 响应，不改真实配置。 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as tar from "tar";

const root = await mkdtemp(join(tmpdir(), "flowork-kernel-test-"));
let count = 0;
async function test(name, run) { await run(); count++; console.log(`✓ ${name}`); }
try {
	// tar 打进测试 bundle，避免临时目录中的模块解析依赖仓库外的 node_modules。
	await build({ entryPoints: [join(import.meta.dirname, "../src/core/kernel-updater.ts"), join(import.meta.dirname, "../src/core/kernel-package.ts")],
		outdir: join(root, "lib"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
		alias: { "@shared": join(import.meta.dirname, "../src/shared") } });
	const { KernelUpdater } = await import(pathToFileURL(join(root, "lib/kernel-updater.js")).href);
	const { verifyManifest, compareVersions, extractKernel, incompatibility } = await import(pathToFileURL(join(root, "lib/kernel-package.js")).href);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const pem = publicKey.export({ type: "spki", format: "pem" });
	const repository = "example/flowork";
	const requests = [];
	const responses = new Map();
	const base = `https://github.com/${repository}/releases/download/kernel-v1.0.1/`;
	const stage = join(root, "package");
	await mkdir(join(stage, "node_modules/@earendil-works/pi-coding-agent"), { recursive: true });
	await writeFile(join(stage, "package.json"), '{"type":"module"}');
	await writeFile(join(stage, "pi-worker.js"), 'console.log("test worker");');
	await writeFile(join(stage, "node_modules/@earendil-works/pi-coding-agent/package.json"), '{"version":"1.1.0"}');
	const archiveName = "flowork-kernel-1.0.1-win32-x64.tar.gz";
	const archivePath = join(root, archiveName);
	await tar.c({ cwd: stage, file: archivePath, gzip: true, portable: true }, ["package.json", "pi-worker.js", "node_modules"]);
	const archive = await readFile(archivePath);
	const manifest = {
		format: 1, version: "1.0.1", piVersion: "1.1.0", protocolVersion: 1, platform: "win32", arch: "x64",
		minAppVersion: "1.0.8", minNodeVersion: "22.19.0", minElectronVersion: "44.0.0", archive: archiveName,
		sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length,
	};
	const envelope = (value) => {
		const bytes = Buffer.from(JSON.stringify(value));
		return { manifest: bytes.toString("base64"), signature: sign(null, bytes, privateKey).toString("base64") };
	};
	const manifestName = "flowork-kernel-win32-x64.json";
	const release = { tag_name: "kernel-v1.0.1", draft: false, prerelease: false, body: "更新说明", assets: [archiveName, manifestName].map((name) => ({ name, browser_download_url: `${base}${name}` })) };
	const releaseApi = `https://api.github.com/repos/${repository}/releases?per_page=100`;
	responses.set(releaseApi, () => Response.json([release]));
	responses.set(`${base}${manifestName}`, () => Response.json(envelope(manifest)));
	responses.set(`${base}${archiveName}`, () => new Response(archive));
	let probes = [];
	const options = (name, overrides = {}) => ({
		directory: () => join(root, name), repository, publicKey: pem,
		appVersion: "1.0.8", nodeVersion: "24.21.0", electronVersion: "44.7.0", platform: "win32", arch: "x64",
		bundled: { version: "1.0.0", piVersion: "1.1.0", entry: "bundled/pi-worker.js" },
		probe: async (entry) => { probes.push(entry); assert.ok((await readFile(entry, "utf8")).includes("test worker")); },
		fetch: async (url) => { requests.push(url); const respond = responses.get(url); assert.ok(respond, `unexpected URL: ${url}`); return respond(); },
		...overrides,
	});
	await test("签名、版本比较与兼容性边界", async () => {
		assert.equal(verifyManifest(envelope(manifest), pem).manifest.version, "1.0.1");
		assert.throws(() => verifyManifest({ ...envelope(manifest), manifest: Buffer.from("{}").toString("base64") }, pem), /签名/);
		assert.throws(() => verifyManifest(envelope({ ...manifest, version: "../../escape" }), pem), /清单/);
		assert.ok(compareVersions("1.10.0", "1.9.99") > 0);
		assert.throws(() => compareVersions("01.1.0", "1.0.0"));
		assert.match(incompatibility({ ...manifest, protocolVersion: 2 }, options("unused")), /协议/);
		assert.match(incompatibility({ ...manifest, minNodeVersion: "25.0.0" }, options("unused")), /运行环境/);
		assert.match(incompatibility({ ...manifest, maxAppVersion: "1.0.7" }, options("unused")), /FloWork 版本/);
	});
	const updater = new KernelUpdater(options("normal"));
	await updater.initialize();
	await test("首次启动使用内置版，不访问网络", async () => {
		assert.equal(updater.workerEntry, "bundled/pi-worker.js");
		assert.equal(requests.length, 0);
	});
	await test("检查稳定内核 Release，忽略应用版本和预发布", async () => {
		responses.set(releaseApi, () => Response.json([{ ...release, tag_name: "v99.0.0" }, { ...release, tag_name: "kernel-v99.0.0", prerelease: true }, release]));
		const status = await updater.check();
		assert.equal(status.latest.version, "1.0.1");
		assert.equal(status.current.source, "bundled");
	});
	await test("下载、真实解包与自检通过，只安排重启不切换当前内核", async () => {
		const events = [];
		const off = updater.onChange((status) => events.push(status.phase));
		const status = await updater.install();
		off();
		assert.equal(status.pending.version, "1.0.1");
		assert.equal(status.current.source, "bundled");
		assert.equal(updater.workerEntry, "bundled/pi-worker.js");
		assert.ok(probes.length > 0);
		assert.ok(events.includes("downloading") && events.includes("verifying") && events.includes("ready"));
	});
	const restarted = new KernelUpdater(options("normal"));
	await test("重启激活外置内核并在启动时重新验签和自检", async () => {
		await restarted.initialize();
		assert.equal(restarted.status().current.source, "downloaded");
		assert.equal(restarted.status().current.version, "1.0.1");
		assert.equal(restarted.status().pending, undefined);
		assert.equal(restarted.workerEntry, join(root, "normal/1.0.1/pi-worker.js"));
		assert.equal((await restarted.check()).latest, undefined);
	});
	await test("恢复内置版同样在下次启动生效", async () => {
		await restarted.useBundled();
		assert.equal(restarted.status().current.source, "downloaded");
		assert.equal(restarted.status().pending.source, "bundled");
		const restored = new KernelUpdater(options("normal"));
		await restored.initialize();
		assert.equal(restored.status().current.source, "bundled");
	});
	await test("可取消待生效更新，已安装版本可安全复用", async () => {
		const restored = new KernelUpdater(options("normal"));
		await restored.initialize();
		await restored.check();
		await restored.install();
		await restored.useBundled();
		assert.equal(restored.status().pending, undefined);
		const next = new KernelUpdater(options("normal"));
		await next.initialize();
		assert.equal(next.status().current.source, "bundled");
	});
	await test("新内核在下次启动自检失败，回退内置版并清除 pending", async () => {
		const staging = new KernelUpdater(options("normal"));
		await staging.initialize(); await staging.check(); await staging.install();
		const failed = new KernelUpdater(options("normal", { probe: async () => { throw new Error("模拟启动失败"); } }));
		await failed.initialize();
		assert.equal(failed.status().current.source, "bundled");
		assert.match(failed.status().message, /回退/);
		assert.equal(JSON.parse(await readFile(join(root, "normal/active.json"), "utf8")).pending, undefined);
	});
	await test("下载损坏、超长、截断都拒绝，且不留下 pending", async () => {
		for (const bad of [Buffer.alloc(archive.length, 1), Buffer.concat([archive, Buffer.from("extra")]), archive.subarray(0, archive.length - 1)]) {
			const item = new KernelUpdater(options(`bad-${bad.length}`));
			await item.initialize(); await item.check();
			responses.set(`${base}${archiveName}`, () => new Response(bad));
			await assert.rejects(item.install(), /校验|大小|完整/);
			assert.equal(item.status().pending, undefined);
			assert.equal(item.status().phase, "error");
		}
		responses.set(`${base}${archiveName}`, () => new Response(archive));
	});
	await test("发行者签名错误时不能更新", async () => {
		const bad = envelope(manifest); bad.manifest = Buffer.from(JSON.stringify({ ...manifest, version: "1.0.2" })).toString("base64");
		responses.set(`${base}${manifestName}`, () => Response.json(bad));
		const item = new KernelUpdater(options("signature")); await item.initialize();
		await assert.rejects(item.check(), /签名/);
		await assert.rejects(item.install(), /先检查/);
		responses.set(`${base}${manifestName}`, () => Response.json(envelope(manifest)));
	});
	await test("不兼容版本只提示更新应用，不提供安装", async () => {
		responses.set(`${base}${manifestName}`, () => Response.json(envelope({ ...manifest, protocolVersion: 2 })));
		const item = new KernelUpdater(options("incompatible")); await item.initialize();
		const status = await item.check();
		assert.equal(status.latest, undefined); assert.match(status.message, /协议/);
		responses.set(`${base}${manifestName}`, () => Response.json(envelope(manifest)));
	});
	await test("HTTP 限流和非 GitHub 重定向给出错误", async () => {
		const item = new KernelUpdater(options("http")); await item.initialize();
		responses.set(releaseApi, () => new Response("limited", { status: 403 }));
		await assert.rejects(item.check(), /受限/);
		responses.set(releaseApi, () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
		await assert.rejects(item.check(), /GitHub HTTPS/);
		responses.set(releaseApi, () => Response.json([release]));
	});
	await test("未配置密钥时不可下载；损坏的选择文件不能路径逃逸", async () => {
		const item = new KernelUpdater(options("unconfigured", { repository: "", publicKey: "" })); await item.initialize();
		assert.equal(item.status().configured, false); await assert.rejects(item.check(), /配置/);
		await mkdir(join(root, "corrupt"));
		await writeFile(join(root, "corrupt/active.json"), '{"active":"../../escape","previous":null}');
		const corrupt = new KernelUpdater(options("corrupt")); await corrupt.initialize();
		assert.equal(corrupt.status().current.source, "bundled"); assert.match(corrupt.status().message, /损坏/);
	});
	await test("互斥更新操作，不能同时检查和下载", async () => {
		let releaseRequest;
		const waiting = new Promise((resolve) => { releaseRequest = resolve; });
		const item = new KernelUpdater(options("mutex", { fetch: async () => { await waiting; return Response.json([]); } }));
		await item.initialize();
		const first = item.check();
		await assert.rejects(item.check(), /正在执行/);
		releaseRequest(); await first;
	});
	await test("解包拒绝越界路径和链接", async () => {
		// 用 tar 的 prefix 构造未被本地系统规范化掉的恶意路径。
		const malicious = join(root, "evil.tar.gz");
		await tar.c({ cwd: stage, file: malicious, prefix: "../escape" }, ["pi-worker.js"]);
		const destination = join(root, "unpack"); await mkdir(destination);
		await assert.rejects(extractKernel(malicious, destination), /路径/);
		const linked = join(root, "links"); await mkdir(linked);
		await writeFile(join(linked, "package.json"), "{}");
		// 硬链接在 Windows 无需管理员权限，能够覆盖链接类型拒绝逻辑。
		const { link } = await import("node:fs/promises");
		await link(join(linked, "package.json"), join(linked, "pi-worker.js"));
		await tar.c({ cwd: linked, file: malicious }, ["package.json", "pi-worker.js"]);
		await assert.rejects(extractKernel(malicious, destination), /链接/);
	});
	console.log(`\n内核更新回归：${count} 项全部通过`);
} finally { await rm(root, { recursive: true, force: true }); }
