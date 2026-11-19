import assert from "node:assert/strict";
import { build } from "esbuild";

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
console.log("应用更新回归通过：版本筛选、更新入口、合并检查、失败恢复与分页。");
