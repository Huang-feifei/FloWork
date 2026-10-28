/**
 * 桌面加固回归（纯离线，不启动 Electron、不调用模型）：
 *   1. 窗口底色常量与 styles.css 的 --color-window 一致（历史上两处曾各写一套值）
 *   2. 主进程日志写到 <数据目录>/logs/main.log，超限轮换
 *   3. 图库收藏落盘到 localStorage，清空图片缓存后仍保留
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "out"), { recursive: true });
const work = mkdtempSync(join(root, "out/test-hardening-"));

// ---------- 1. 窗口底色：常量 ⇄ CSS ----------
{
	const { WINDOW_COLORS, windowColor } = await import(pathToFileURL(join(root, "src/shared/window-colors.ts")).href).catch(async () => {
		// Node 无法直接 import .ts：用 esbuild 现场打包
		const out = join(work, "window-colors.mjs");
		await build({ entryPoints: [join(root, "src/shared/window-colors.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
		return import(pathToFileURL(out).href);
	});
	const css = readFileSync(join(root, "src/renderer/src/styles.css"), "utf8");
	const light = /--color-window:\s*(#[0-9a-fA-F]{3,8})/.exec(css)?.[1]?.toLowerCase();
	const darkBlock = css.slice(css.indexOf('html[data-theme="dark"]'));
	const dark = /--color-window:\s*(#[0-9a-fA-F]{3,8})/.exec(darkBlock)?.[1]?.toLowerCase();
	assert.ok(light, "styles.css 里找不到浅色 --color-window");
	assert.ok(dark, "styles.css 深色主题里找不到 --color-window");
	assert.equal(WINDOW_COLORS.light.toLowerCase(), light, "浅色窗口底色与 styles.css 不一致");
	assert.equal(WINDOW_COLORS.dark.toLowerCase(), dark, "深色窗口底色与 styles.css 不一致");
	assert.equal(windowColor(false), WINDOW_COLORS.light);
	assert.equal(windowColor(true), WINDOW_COLORS.dark);
	console.log("✓ 窗口底色常量与 styles.css 的 --color-window 一致");
}

// ---------- 2. 主进程日志 ----------
{
	const dataDir = join(work, "data");
	process.env.FLOWORK_DATA_DIR = dataDir;
	const log = await import(pathToFileURL(join(work, "main-log.mjs")).href).catch(async () => {
		const out = join(work, "main-log.mjs");
		await build({ entryPoints: [join(root, "src/main/log.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
		return import(pathToFileURL(out).href);
	});
	log.logLine("test", "第一条");
	log.logError("test", new Error("崩溃演示"));
	const file = join(dataDir, "logs/main.log");
	assert.ok(existsSync(file), "日志文件未创建");
	const text = readFileSync(file, "utf8");
	assert.match(text, /\[test\] 第一条/);
	assert.match(text, /\[test\] Error: 崩溃演示/);
	// 超限轮换：把文件撑到 2 MiB 以上，再写一行，应生成 main.log.1
	writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 1));
	log.logLine("test", "轮换后");
	assert.ok(existsSync(`${file}.1`), "超过上限后未轮换为 main.log.1");
	assert.match(readFileSync(file, "utf8"), /\[test\] 轮换后/);
	console.log("✓ 主进程日志落盘、含堆栈、超限轮换");
}

// ---------- 3. 图库收藏持久化 ----------
{
	const memory = new Map();
	globalThis.localStorage = {
		getItem: (key) => (memory.has(key) ? memory.get(key) : null),
		setItem: (key, value) => void memory.set(key, String(value)),
		removeItem: (key) => void memory.delete(key),
	};
	globalThis.window = {
		floworkTransport: {
			request: async () => JSON.stringify(null),
			onPush: () => () => {},
		},
	};
	memory.set("flowork.imageFavorites", JSON.stringify({ keep: true, dropped: false }));
	const bundle = join(work, "store.mjs");
	await build({
		stdin: { contents: 'export { useApp } from "./src/renderer/src/store.ts";', resolveDir: root },
		bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "silent",
		tsconfig: join(root, "tsconfig.renderer.json"), define: { "import.meta.env.DEV": "false" },
		plugins: [{ name: "ui-effects", setup(b) {
			const stubs = {
				"./components/ConfirmDialog": "export const askConfirm = async () => true;",
				"./components/terminal/terminal-disposer": "export const disposeTerminal = () => {};",
				"./theme": 'export const storedTheme=()=>"system", resolveTheme=()=>"dark", applyTheme=()=>{}, storeTheme=()=>{}, syncDesktopTheme=()=>{}, watchSystemTheme=()=>{};',
				"./appearance": 'export const storedAppearance=()=>({bgImage:""}), applyAppearance=()=>{}, normalizeAppearance=x=>x, storeAppearance=()=>{};',
				"./background-image": "export const loadStoredImage=async()=>null, saveStoredImage=async()=>{};",
			};
			b.onResolve({ filter: /^\.\// }, (a) => a.importer.endsWith("store.ts") && stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined);
			b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path] }));
		} }],
	});
	const { useApp } = await import(pathToFileURL(bundle).href);
	// 启动时只保留 true，避免旧数据里的 false 长期占位
	assert.deepEqual(useApp.getState().imageFavorites, { keep: true }, "启动时应过滤掉非 true 的收藏");

	useApp.getState().toggleImageFavorite("img-new");
	assert.deepEqual(useApp.getState().imageFavorites, { keep: true, "img-new": true });
	assert.deepEqual(JSON.parse(memory.get("flowork.imageFavorites")), { keep: true, "img-new": true }, "收藏应立刻落盘");

	useApp.getState().toggleImageFavorite("keep");
	assert.deepEqual(useApp.getState().imageFavorites, { "img-new": true });
	assert.deepEqual(JSON.parse(memory.get("flowork.imageFavorites")), { "img-new": true }, "取消收藏也要落盘，不能留下 false");

	// 清空图片缓存只清 images，不影响收藏
	useApp.setState({ images: [] });
	assert.deepEqual(useApp.getState().imageFavorites, { "img-new": true }, "清空缓存不应清掉收藏");

	// 模拟重启：重新执行模块，收藏从 localStorage 恢复
	const { useApp: restarted } = await import(`${pathToFileURL(bundle).href}?restart=1`);
	assert.deepEqual(restarted.getState().imageFavorites, { "img-new": true }, "重启后应恢复收藏");
	console.log("✓ 图库收藏落盘、取消收藏不残留、重启可恢复");
}

rmSync(work, { recursive: true, force: true });
delete globalThis.window;
delete globalThis.localStorage;
delete process.env.FLOWORK_DATA_DIR;
console.log("DESKTOP HARDENING REGRESSION OK（离线；未启动 Electron，未调用模型）");
