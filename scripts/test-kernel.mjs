/** 离线回归：GitHub 只模拟放行清单；SDK/依赖只模拟官方 npm tarball。 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as tar from "tar";

const root = await mkdtemp(join(tmpdir(), "flowork-kernel-test-"));
let count = 0;
async function test(name, run) { await run(); count++; console.log(`✓ ${name}`); }
try {
	await build({ entryPoints: [join(import.meta.dirname, "../src/core/kernel-updater.ts"), join(import.meta.dirname, "../src/core/kernel-package.ts")],
		outdir: join(root, "lib"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
		alias: { "@shared": join(import.meta.dirname, "../src/shared") } });
	const { KernelUpdater } = await import(pathToFileURL(join(root, "lib/kernel-updater.js")).href);
	const { verifyManifest, compareVersions, extractNpmPackage, incompatibility, npmTarballUrl } = await import(pathToFileURL(join(root, "lib/kernel-package.js")).href);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const pem = publicKey.export({ type: "spki", format: "pem" });
	const repository = "example/flowork";
	const requests = [];
	const responses = new Map();
	const adapterEntry = join(root, "bundled-adapter.js");
	const workerText = 'console.log("built-in test adapter");';
	await writeFile(adapterEntry, workerText);
	const adapterSha256 = createHash("sha256").update(workerText).digest("hex");
	const packages = [];
	const archives = new Map();
	for (const [index, name, version, path] of [
		[0, "@earendil-works/pi-coding-agent", "1.2.0", "node_modules/@earendil-works/pi-coding-agent"],
		[1, "typebox", "1.3.27", "node_modules/typebox"],
		[2, "fixture-dependency", "2.0.0", "node_modules/@earendil-works/pi-coding-agent/node_modules/fixture-dependency"],
	]) {
		const stage = join(root, `fixture-${index}`); await mkdir(stage);
		await writeFile(join(stage, "package.json"), JSON.stringify({ name, version, scripts: { postinstall: `node -e "require('fs').writeFileSync('${join(root, "LIFECYCLE_RAN").replace(/\\/g, "/")}', 'bad')"` } }));
		await writeFile(join(stage, "index.js"), "export const fixture = true;");
		const file = join(root, `${index}.tgz`);
		await tar.c({ cwd: stage, file, prefix: "package", gzip: true, portable: true }, ["package.json", "index.js"]);
		const bytes = await readFile(file);
		const p = { path, name, version, url: npmTarballUrl(name, version), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, size: bytes.length };
		packages.push(p); archives.set(p.url, bytes); responses.set(p.url, () => new Response(bytes));
	}
	const manifest = {
		format: 2, version: "1.0.1", piVersion: "1.2.0", protocolVersion: 1, platform: "win32", arch: "x64",
		minAppVersion: "1.0.8", maxAppVersion: "1.0.8", minNodeVersion: "22.19.0", minElectronVersion: "44.0.0", adapterSha256, packages,
	};
	const envelope = (value) => {
		const bytes = Buffer.from(JSON.stringify(value));
		return { manifest: bytes.toString("base64"), signature: sign(null, bytes, privateKey).toString("base64") };
	};
	const base = `https://github.com/${repository}/releases/download/kernel-v1.0.1/`;
	const manifestName = "flowork-pi-approval-win32-x64.json";
	const approvalUrl = `${base}${manifestName}`;
	const release = { tag_name: "kernel-v1.0.1", draft: false, prerelease: false, body: "已测试并批准 Pi 1.2.0", assets: [{ name: manifestName, browser_download_url: approvalUrl }] };
	const releaseApi = `https://api.github.com/repos/${repository}/releases?per_page=100`;
	const releaseTagApi = `https://api.github.com/repos/${repository}/releases/tags/kernel-v1.0.1`;
	responses.set(releaseApi, () => Response.json([release]));
	responses.set(releaseTagApi, () => Response.json(release));
	responses.set(approvalUrl, () => Response.json(envelope(manifest)));
	const options = (name, overrides = {}) => ({
		directory: () => join(root, name), repository, publicKey: pem, adapterEntry,
		appVersion: "1.0.8", nodeVersion: "24.21.0", electronVersion: "44.7.0", platform: "win32", arch: "x64",
		bundled: { version: "1.0.0", piVersion: "1.1.0", entry: "bundled/pi-worker.js" },
		probe: async (entry) => { assert.equal(await readFile(entry, "utf8"), workerText); },
		fetch: async (url) => { requests.push(url); const respond = responses.get(url); assert.ok(respond, `unexpected URL: ${url}`); return respond(); },
		...overrides,
	});
	await test("签名、稳定版本、官方来源和固定依赖边界", async () => {
		assert.equal(verifyManifest(envelope(manifest), pem).manifest.piVersion, "1.2.0");
		assert.throws(() => verifyManifest({ ...envelope(manifest), manifest: Buffer.from("{}").toString("base64") }, pem), /签名/);
		assert.throws(() => verifyManifest(envelope({ ...manifest, version: "../../escape" }), pem), /清单/);
		assert.throws(() => verifyManifest(envelope({ ...manifest, format: 1 }), pem), /清单/);
		assert.ok(compareVersions("1.10.0", "1.9.99") > 0);
		assert.throws(() => compareVersions("01.1.0", "1.0.0"));
		for (const change of [{ url: "https://evil.example/pi.tgz" }, { version: "latest" }, { path: "../escape" }, { integrity: "sha1-bad" }, { size: -1 }]) {
			assert.throws(() => verifyManifest(envelope({ ...manifest, packages: [{ ...packages[0], ...change }] }), pem));
		}
		assert.throws(() => verifyManifest(envelope({ ...manifest, packages: [packages[0], packages[0]] }), pem), /重复/);
		assert.throws(() => verifyManifest(envelope({ ...manifest, packages: [packages[2]] }), pem), /父包/);
	});
	await test("应用范围、协议、运行环境与内置适配层必须全部获批", async () => {
		const env = { ...options("unused"), adapterSha256 };
		assert.match(incompatibility({ ...manifest, protocolVersion: 2 }, env), /协议/);
		assert.match(incompatibility({ ...manifest, minNodeVersion: "25.0.0" }, env), /运行环境/);
		assert.match(incompatibility(manifest, { ...env, appVersion: "1.0.9" }), /FloWork 版本/);
		assert.match(incompatibility(manifest, { ...env, adapterSha256: "0".repeat(64) }), /适配层/);
	});
	const updater = new KernelUpdater(options("normal"));
	await updater.initialize();
	await test("首次启动内置版不访问任何网络", async () => {
		assert.equal(updater.workerEntry, "bundled/pi-worker.js"); assert.equal(requests.length, 0);
	});
	await test("官方即使有新版，维护者未放行也不提供更新、不查询 npm latest", async () => {
		responses.set(releaseApi, () => Response.json([]));
		const before = requests.length;
		assert.equal((await updater.check()).latest, undefined);
		await assert.rejects(updater.install(), /先检查/);
		assert.ok(requests.slice(before).every((url) => url.startsWith("https://api.github.com/")));
		responses.set(releaseApi, () => Response.json([release]));
	});
	await test("只接受正式签名放行，忽略应用标签与预发布", async () => {
		responses.set(releaseApi, () => Response.json([{ ...release, tag_name: "v99.0.0" }, { ...release, tag_name: "kernel-v99.0.0", prerelease: true }, release]));
		const status = await updater.check(); assert.equal(status.latest.piVersion, "1.2.0"); assert.equal(status.current.source, "bundled");
	});
	await test("安装前重新确认放行；撤回或修改清单后不能沿用缓存安装", async () => {
		responses.set(releaseTagApi, () => Response.json({ ...release, draft: true }));
		await assert.rejects(updater.install(), /撤回/);
		responses.set(releaseTagApi, () => Response.json(release));
		responses.set(approvalUrl, () => Response.json(envelope({ ...manifest, minNodeVersion: "23.0.0" })));
		await assert.rejects(updater.install(), /内容已变更/);
		responses.set(approvalUrl, () => Response.json(envelope(manifest)));
	});
	await test("从官方 npm 下载固定依赖并组装，适配层来自应用自身，不执行安装脚本", async () => {
		const events = []; const off = updater.onChange((status) => events.push(status.phase)); const before = requests.length;
		const status = await updater.install(); off();
		assert.equal(status.pending.piVersion, "1.2.0"); assert.equal(status.current.source, "bundled");
		assert.equal(updater.workerEntry, "bundled/pi-worker.js");
		assert.ok(events.includes("downloading") && events.includes("verifying") && events.includes("ready"));
		assert.equal(status.downloadedBytes, packages.reduce((sum, p) => sum + p.size, 0));
		assert.deepEqual(requests.slice(before).filter((url) => url.startsWith("https://registry.npmjs.org/")).sort(), packages.map((p) => p.url).sort());
		assert.ok(!requests.slice(before).some((url) => url.includes("flowork-kernel-") || url.includes("/latest")));
		await assert.rejects(readFile(join(root, "LIFECYCLE_RAN")), { code: "ENOENT" });
		assert.equal(JSON.parse(await readFile(join(root, "normal/1.0.1", packages[2].path, "package.json"), "utf8")).version, "2.0.0");
	});
	const restarted = new KernelUpdater(options("normal", { fetch: async () => { throw new Error("启动不得访问网络"); } }));
	await test("重启离线验签、检查适配层/依赖、自检后才激活", async () => {
		await restarted.initialize(); assert.equal(restarted.status().current.source, "downloaded");
		assert.equal(restarted.status().current.version, "1.0.1"); assert.equal(restarted.status().pending, undefined);
		assert.equal(restarted.workerEntry, join(root, "normal/1.0.1/pi-worker.js"));
	});
	await test("恢复内置版、取消待生效版本与不可变安装复用", async () => {
		await restarted.useBundled(); assert.equal(restarted.status().pending.source, "bundled");
		const restored = new KernelUpdater(options("normal")); await restored.initialize();
		assert.equal(restored.status().current.source, "bundled");
		await restored.check(); await restored.install(); await restored.useBundled(); assert.equal(restored.status().pending, undefined);
		const next = new KernelUpdater(options("normal")); await next.initialize(); assert.equal(next.status().current.source, "bundled");
	});
	await test("新内核启动自检失败回退，清除 pending", async () => {
		const staging = new KernelUpdater(options("normal")); await staging.initialize(); await staging.check(); await staging.install();
		const failed = new KernelUpdater(options("normal", { probe: async () => { throw new Error("模拟启动失败"); } }));
		await failed.initialize(); assert.equal(failed.status().current.source, "bundled"); assert.match(failed.status().message, /回退/);
		assert.equal(JSON.parse(await readFile(join(root, "normal/active.json"), "utf8")).pending, undefined);
	});
	await test("下载损坏、超长、截断均拒绝，不留下 pending", async () => {
		const p = packages[0]; const archive = archives.get(p.url);
		for (const bad of [Buffer.alloc(archive.length, 1), Buffer.concat([archive, Buffer.from("extra")]), archive.subarray(0, archive.length - 1)]) {
			const item = new KernelUpdater(options(`bad-${bad.length}`)); await item.initialize(); await item.check();
			responses.set(p.url, () => new Response(bad)); await assert.rejects(item.install(), /校验|大小|完整/);
			assert.equal(item.status().pending, undefined); assert.equal(item.status().phase, "error");
		}
		responses.set(p.url, () => new Response(archive));
	});
	await test("官方 npm 失败与跨源跳转不可转为任意 URL 下载", async () => {
		const p = packages[0]; const item = new KernelUpdater(options("npm-http")); await item.initialize(); await item.check();
		responses.set(p.url, () => new Response("missing", { status: 404 })); await assert.rejects(item.install(), /HTTP 404/);
		for (const location of ["https://evil.example/pi.tgz", "https://github.com/evil/pi.tgz", "http://registry.npmjs.org/pi.tgz", "https://registry.npmjs.org:444/pi.tgz"]) {
			responses.set(p.url, () => new Response(null, { status: 302, headers: { location } })); await assert.rejects(item.install(), /官方 npm HTTPS/);
		}
		responses.set(p.url, () => new Response(archives.get(p.url)));
	});
	await test("错误签名、旧整包格式与不匹配适配层不提供安装", async () => {
		const item = new KernelUpdater(options("signature")); await item.initialize();
		const bad = envelope(manifest); bad.manifest = Buffer.from(JSON.stringify({ ...manifest, version: "1.0.2" })).toString("base64");
		responses.set(approvalUrl, () => Response.json(bad)); await assert.rejects(item.check(), /签名/); await assert.rejects(item.install(), /先检查/);
		responses.set(approvalUrl, () => Response.json(envelope({ ...manifest, format: 1 }))); await assert.rejects(item.check(), /清单/);
		responses.set(approvalUrl, () => Response.json(envelope({ ...manifest, adapterSha256: "0".repeat(64) })));
		const status = await item.check(); assert.equal(status.latest, undefined); assert.match(status.message, /适配层/);
		responses.set(approvalUrl, () => Response.json(envelope(manifest)));
	});
	await test("GitHub 限流与恶意跳转提示错误", async () => {
		const item = new KernelUpdater(options("http")); await item.initialize();
		responses.set(releaseApi, () => new Response("limited", { status: 403 })); await assert.rejects(item.check(), /受限/);
		responses.set(releaseApi, () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })); await assert.rejects(item.check(), /GitHub HTTPS/);
		responses.set(releaseApi, () => Response.json([release]));
	});
	await test("未配置公钥、损坏选择文件、缺失适配层均不会阻止内置版启动", async () => {
		const item = new KernelUpdater(options("unconfigured", { repository: "", publicKey: "" })); await item.initialize();
		assert.equal(item.status().configured, false); await assert.rejects(item.check(), /配置/);
		await mkdir(join(root, "corrupt")); await writeFile(join(root, "corrupt/active.json"), '{"active":"../../escape","previous":null}');
		const corrupt = new KernelUpdater(options("corrupt")); await corrupt.initialize(); assert.equal(corrupt.status().current.source, "bundled"); assert.match(corrupt.status().message, /损坏/);
		const missing = new KernelUpdater(options("missing", { adapterEntry: join(root, "does-not-exist.js") })); await missing.initialize();
		assert.equal(missing.status().supported, false); assert.equal(missing.status().current.source, "bundled");
	});
	await test("应用升级导致适配层变化时，旧的外置 SDK 不自动继续使用", async () => {
		const old = new KernelUpdater(options("app-upgrade")); await old.initialize(); await old.check(); await old.install();
		const changed = join(root, "new-adapter.js"); await writeFile(changed, "// new application adapter");
		const next = new KernelUpdater(options("app-upgrade", { adapterEntry: changed })); await next.initialize();
		assert.equal(next.status().current.source, "bundled"); assert.match(next.status().message, /适配层/);
	});
	await test("已安装的依赖缺失/版本损坏或适配层被改写时回退", async () => {
		for (const kind of ["adapter", "dependency"]) {
			const name = `tamper-${kind}`; const item = new KernelUpdater(options(name)); await item.initialize(); await item.check(); await item.install();
			if (kind === "adapter") await writeFile(join(root, name, "1.0.1/pi-worker.js"), "// changed");
			else await writeFile(join(root, name, "1.0.1", packages[1].path, "package.json"), '{"name":"typebox","version":"99.0.0"}');
			const next = new KernelUpdater(options(name)); await next.initialize(); assert.equal(next.status().current.source, "bundled"); assert.match(next.status().message, /回退/);
		}
	});
	await test("同一批次不能替换内容；操作互斥", async () => {
		const item = new KernelUpdater(options("immutable")); await item.initialize(); await item.check(); await item.install(); await item.useBundled();
		responses.set(approvalUrl, () => Response.json(envelope({ ...manifest, minElectronVersion: "44.1.0" })));
		await item.check(); await assert.rejects(item.install(), /同一放行批次/); responses.set(approvalUrl, () => Response.json(envelope(manifest)));
		let releaseRequest; const waiting = new Promise((resolve) => { releaseRequest = resolve; });
		const mutex = new KernelUpdater(options("mutex", { fetch: async () => { await waiting; return Response.json([]); } })); await mutex.initialize();
		const first = mutex.check(); await assert.rejects(mutex.check(), /正在执行/); releaseRequest(); await first;
	});
	await test("npm 安全解包拒绝路径逃逸、链接和未授权的捆绑 node_modules", async () => {
		const stage = join(root, "fixture-0"); const malicious = join(root, "evil.tar"); const destination = join(root, "unpack"); await mkdir(destination);
		await tar.c({ cwd: stage, file: malicious, prefix: "package/../../escape" }, ["package.json"]); await assert.rejects(extractNpmPackage(malicious, destination), /路径/);
		await tar.c({ cwd: stage, file: malicious, prefix: "package/node_modules/hidden" }, ["package.json"]); await assert.rejects(extractNpmPackage(malicious, destination), /捆绑/);
		const linked = join(root, "links"); await mkdir(linked); await writeFile(join(linked, "package.json"), "{}"); await link(join(linked, "package.json"), join(linked, "index.js"));
		await tar.c({ cwd: linked, file: malicious, prefix: "package" }, ["package.json", "index.js"]); await assert.rejects(extractNpmPackage(malicious, destination), /链接/);
	});
	await test("兼容官方包的单层包名根目录和无害 ./ 路径", async () => {
		const stage = join(root, "fixture-0"); const archive = join(root, "wrapper.tar"); const dest = join(root, "wrapper"); await mkdir(dest);
		await tar.c({ cwd: stage, file: archive, prefix: "types-fixture/." }, ["index.js"]);
		await extractNpmPackage(archive, dest); assert.equal(await readFile(join(dest, "index.js"), "utf8"), "export const fixture = true;");
	});
	await test("仅允许字节/模式相同的规范化副本；冲突或大小写别名必须拒绝", async () => {
		const stage = join(root, "fixture-0"); const other = join(root, "duplicate-source"); await mkdir(other);
		const archive = join(root, "duplicate.tar"); const dest = join(root, "duplicate-dest"); await mkdir(dest);
		await tar.c({ cwd: stage, file: archive, prefix: "package" }, ["index.js"]);
		await tar.r({ cwd: stage, file: archive, prefix: "package/." }, ["index.js"]);
		await extractNpmPackage(archive, dest); assert.equal(await readFile(join(dest, "index.js"), "utf8"), "export const fixture = true;");
		await writeFile(join(other, "index.js"), "different content");
		await tar.r({ cwd: other, file: archive, prefix: "package/." }, ["index.js"]);
		await assert.rejects(extractNpmPackage(archive, dest), /冲突/);
		await writeFile(join(other, "INDEX.js"), "export const fixture = true;");
		await tar.c({ cwd: stage, file: archive, prefix: "package" }, ["index.js"]);
		await tar.r({ cwd: other, file: archive, prefix: "package" }, ["INDEX.js"]);
		await assert.rejects(extractNpmPackage(archive, dest), /冲突/);
	});
	console.log(`\n官方 Pi 兼容放行回归：${count} 项全部通过`);
} finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
