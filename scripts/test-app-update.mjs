import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const bundle = await build({ entryPoints: ["src/main/app-update.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { appReleasePage, selectAppUpdate, createAppUpdateChecker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const release = (version) => ({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: `FloWork-${version}-x64-setup.exe`, state: "uploaded", size: 101 }] });
const feed = [
	{ ...release("99.0.0"), tag_name: "kernel-v99.0.0" },
	{ ...release("99.0.1"), draft: true },
	{ ...release("99.0.2"), prerelease: true },
	{ ...release("99.0.3"), assets: [] },
	{ ...release("99.0.4"), assets: [{ ...release("99.0.4").assets[0], state: "starter" }] },
	release("1.2.0"), release("1.10.0"), release("1.1.5"), null,
];
assert.deepEqual(selectAppUpdate(feed, "1.1.6"), { status: "available", version: "1.10.0", current: "1.1.6" });
assert.deepEqual(selectAppUpdate(feed, "1.10.0"), { status: "current", current: "1.10.0" });
assert.equal(selectAppUpdate(feed, "1.0.0-dev").status, "unsupported");
assert.equal(appReleasePage("1.10.0"), "https://github.com/Huang-feifei/FloWork/releases/tag/v1.10.0");
for (const invalid of ["https://example.invalid", "1.0.0/../../path", "1.0.0\n", null]) assert.throws(() => appReleasePage(invalid));

let calls = 0;
let clock = 0;
const check = createAppUpdateChecker("1.1.6", async (url, options) => {
	calls++;
	assert.match(url, /^https:\/\/api\.github\.com\/repos\/Huang-feifei\/FloWork\/releases\?per_page=30&page=1$/);
	assert.equal(options.redirect, "error");
	assert.ok(options.signal);
	return Response.json(feed);
}, () => clock);
const first = check(false);
assert.equal(check(true), first, "重复检查应合并");
assert.equal((await first).status, "available");
await check(false);
assert.equal(calls, 1);
clock += 61_000;
await check(false);
assert.equal(calls, 1, "自动检查应复用缓存");
await check(true);
assert.equal(calls, 2, "主动检查可提前更新缓存");
let attempts = 0;
const recover = createAppUpdateChecker("1.1.6", async () => ++attempts === 1 ? new Response(null, { status: 403 }) : Response.json(feed), () => clock);
assert.equal((await recover(false)).status, "unavailable");
assert.equal((await recover(true)).status, "unavailable");
clock += 61_000;
assert.equal((await recover(false)).status, "available");
const pagination = createAppUpdateChecker("1.1.6", async (url) => url.endsWith("page=1")
	? Response.json(Array(30).fill(feed[0]), { headers: { Link: '<https://example.invalid>; rel="next"' } })
	: Response.json([release("1.1.7")]));
assert.equal((await pagination(false)).version, "1.1.7");
const downloadBundle = await build({ entryPoints: ["src/main/app-update-download.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { AppUpdateDownload } = await import(`data:text/javascript;base64,${Buffer.from(downloadBundle.outputFiles[0].text).toString("base64")}`);
const payload = Buffer.from("MZ isolated test payload, never executed");
const digest = createHash("sha256").update(payload).digest("hex");
const signedRelease = release("1.1.7");
Object.assign(signedRelease.assets[0], { size: payload.length, digest: `sha256:${digest}`, browser_download_url: "https://example.invalid/never-used" });
const stable = selectAppUpdate([signedRelease], "1.1.6");
assert.equal(stable.installer.sha256, digest);
assert.equal(selectAppUpdate([release("1.1.7")], "1.1.6").installer, undefined);
assert.equal(selectAppUpdate([{ ...signedRelease, assets: [{ ...signedRelease.assets[0], size: 1024 ** 3 }] }], "1.1.6").installer, undefined);

await mkdir("out", { recursive: true });
const root = await mkdtemp("out/app-update-test-");
try {
	const events = [];
	const urls = [];
	let response = () => new Response(payload);
	const fetchAsset = async (url, options) => {
		urls.push(url);
		assert.equal(options.redirect, "manual");
		assert.equal(options.credentials, "omit");
		if (url.startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/test" } });
		assert.equal(url, "https://release-assets.githubusercontent.com/test");
		return response();
	};
	const options = { directory: root, publish: state => events.push(state), fetchAsset };
	const control = new AppUpdateDownload(options);
	await assert.rejects(control.install(async () => true, () => assert.fail("不能提前安装")), /尚未准备好/);
	await control.prepare(selectAppUpdate([release("1.1.7")], "1.1.6"), false);
	assert.equal(control.status().phase, "manual");
	assert.equal(urls.length, 0);
	const firstDownload = control.prepare(stable, false);
	assert.equal(control.status().phase, "downloading");
	assert.equal(control.prepare(stable, true), firstDownload);
	await firstDownload;
	assert.deepEqual(urls, ["https://github.com/Huang-feifei/FloWork/releases/download/v1.1.7/FloWork-1.1.7-x64-setup.exe", "https://release-assets.githubusercontent.com/test"]);
	assert.ok(events.some(state => state.phase === "downloading" && state.downloaded === payload.length));
	assert.equal(control.status().phase, "ready");
	const local = join(root, "pending-installer.exe");
	assert.deepEqual(await readFile(local), payload);
	const restarted = new AppUpdateDownload(options);
	await restarted.prepare(stable, false);
	assert.equal(restarted.status().phase, "ready", "已验证的缓存可以复用");
	assert.equal(urls.length, 2);
	await restarted.install(async () => false, () => assert.fail("取消不得启动安装"));
	assert.equal(restarted.status().phase, "ready");
	await assert.rejects(restarted.install(async () => true, () => { throw new Error("有会话正在运行"); }), /会话正在运行/);
	assert.equal(restarted.status().phase, "ready", "运行中会话拦截后仍可稍后安装");
	await assert.rejects(restarted.install(async () => {
		await writeFile(local, Buffer.alloc(payload.length, 1));
		return true;
	}, () => assert.fail("被修改的缓存不能安装")), /未通过校验/);
	assert.equal(restarted.status().phase, "failed");
	await restarted.prepare(stable, false);
	assert.equal(urls.length, 2, "自动重试应限流");
	for (const invalid of [Buffer.alloc(payload.length), payload.subarray(0, 4), Buffer.concat([payload, payload])]) {
		response = () => new Response(invalid);
		await restarted.prepare(stable, true);
		assert.equal(restarted.status().phase, "failed");
		assert.ok(!(await readdir(root)).some(name => name.endsWith(".part")));
	}
	response = () => new Response(payload);
	await restarted.prepare(stable, true);
	let scheduled;
	await restarted.install(async version => { assert.equal(version, "1.1.7"); return true; }, path => { scheduled = path; });
	assert.equal(scheduled, local);
	assert.equal(restarted.status().phase, "installing");
	await assert.rejects(restarted.install(async () => true, () => assert.fail("不能重复安排安装")));

	const bad = new AppUpdateDownload({ ...options, directory: join(root, "bad"), fetchAsset: async () => new Response(null, { status: 302, headers: { location: "https://example.invalid/exe" } }) });
	await bad.prepare(stable, true);
	assert.equal(bad.status().phase, "failed");
	assert.deepEqual(await readdir(join(root, "bad")), []);
	const newest = new AppUpdateDownload(options);
	await newest.prepare({ status: "current", current: "1.1.7" }, false);
	assert.deepEqual(await readdir(root), ["bad"], "新版应清理本地安装包");
} finally { await rm(root, { recursive: true, force: true }); }
console.log("应用更新回归通过：版本筛选、后台下载、校验、缓存、重试与确认安装交接。");
