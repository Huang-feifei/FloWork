/** 真实 Zustand store 的延迟响应回归；仅替换桌面桥与展示层副作用，不启动模型。 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
mkdirSync(join(root, "out"), { recursive: true });
const work = mkdtempSync(join(root, "out/test-store-"));
const requests = [];
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { floworkTransport: {
	request: async (method, params) => {
		if (method === "projects.touch") return JSON.stringify({ projects: [], groups: [] });
		return new Promise((resolve) => requests.push({ method, params, resolve: (data) => resolve(JSON.stringify(data)) }));
	},
	onPush: () => () => {},
} };
try {
	const bundle = join(work, "store.mjs");
	await build({
		stdin: { contents: 'export { useApp } from "./src/renderer/src/store.ts"; export { emptySlice, pickSlice } from "./src/renderer/src/session-slice.ts";', resolveDir: root },
		bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "silent",
		tsconfig: join(root, "tsconfig.renderer.json"), define: { "import.meta.env.DEV": "false" },
		plugins: [{ name: "ui-effects", setup(b) {
			const stubs = {
				"./components/ConfirmDialog": 'export const askConfirm = async () => true;',
				"./components/terminal/terminal-disposer": 'export const disposeTerminal = () => {};',
				"./theme": 'export const storedTheme=()=>"system", resolveTheme=()=>"dark", applyTheme=()=>{}, storeTheme=()=>{}, syncDesktopTheme=()=>{}, watchSystemTheme=()=>{};',
				"./appearance": 'export const storedAppearance=()=>({bgImage:""}), applyAppearance=()=>{}, normalizeAppearance=x=>x, storeAppearance=()=>{};',
				"./background-image": 'export const loadStoredImage=async()=>null, saveStoredImage=async()=>{};',
			};
			b.onResolve({ filter: /^\.\// }, (a) => a.importer.endsWith("store.ts") && stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined);
			b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path] }));
		} }],
	});
	const { useApp: store, emptySlice, pickSlice } = await import(pathToFileURL(bundle).href);
	const state = (id) => ({ sessionId: id, sessionFile: `/${id}.jsonl`, cwd: "/project", thinkingLevel: "off" });
	const setup = () => {
		requests.length = 0;
		store.setState({ ...emptySlice("/project"), handleId: "A", state: state("a"), activeProjectId: "p", railVisible: false,
			background: { B: { ...emptySlice("/project"), handleId: "B", state: state("b") } },
			projectHandles: { p: ["A", "B"] }, projectActive: { p: "A" }, draft: { text: "", seq: 0 },
			projects: { projects: [{ id: "p", path: "/project" }], groups: [] },
		});
	};
	const switchToB = () => {
		const s = store.getState();
		store.setState({ ...s.background.B, background: { A: pickSlice(s) } });
	};
	const take = (type) => {
		const request = requests.find((r) => r.params?.command?.type === type);
		assert.ok(request, `发出了 ${type} 请求`);
		requests.splice(requests.indexOf(request), 1);
		return request;
	};
	for (const [action, command, result] of [
		[() => store.getState().setModel({ provider: "test", id: "m" }), "set_model", { ...state("a"), model: { id: "m" } }],
		[() => store.getState().setThinkingLevel("high"), "set_thinking_level", { ...state("a"), thinkingLevel: "high" }],
		[() => store.getState().setWorkMode("plan"), "set_work_mode", { ...state("a"), workMode: "plan" }],
	]) {
		setup();
		const pending = action();
		const req = take(command);
		switchToB(); req.resolve(result); await pending;
		assert.equal(store.getState().state.sessionId, "b");
		assert.deepEqual(store.getState().background.A.state, result);
	}
	setup();
	const tree = store.getState().loadTree(); const req = take("get_tree"); switchToB();
	req.resolve({ tree: [{ id: "root-a", parentId: null, children: [] }], leafId: "root-a" }); await tree;
	assert.equal(store.getState().leafId, null);
	assert.equal(store.getState().background.A.leafId, "root-a");
	setup();
	const old = store.getState().loadTree(); const oldReq = take("get_tree");
	const recent = store.getState().loadTree(); const recentReq = take("get_tree");
	recentReq.resolve({ tree: [], leafId: "new" }); await recent;
	oldReq.resolve({ tree: [], leafId: "old" }); await old;
	assert.equal(store.getState().leafId, "new", "晚到的旧树不能覆盖新树");
	for (const closed of [false, true]) {
		setup(); const pending = store.getState().setThinkingLevel("high"); const request = take("set_thinking_level"); switchToB();
		store.setState({ background: closed ? {} : { A: { ...store.getState().background.A, state: state("replacement") } } });
		request.resolve(state("a")); await pending;
		assert.equal(store.getState().state.sessionId, "b");
		assert.equal(store.getState().background.A?.state.sessionId, closed ? undefined : "replacement");
	}
	setup();
	const dequeue = store.getState().dequeue(); const queued = take("clear_queue"); switchToB();
	queued.resolve({ steering: [{ text: "queued for A", images: [{ mimeType: "image/png", data: "abc" }] }], followUp: [] }); await dequeue;
	assert.equal(store.getState().draft.text, "");
	store.getState().activateSession("A");
	assert.equal(store.getState().draft.text, "queued for A", "切回原标签后恢复取回的消息，不丢失");
	assert.equal(store.getState().draft.images.length, 1);
	console.log("SESSION STORE REGRESSION OK（跨标签、同 worker 换记录、关闭、乱序树和队列草稿）");
} finally {
	rmSync(work, { recursive: true, force: true });
	delete globalThis.window;
	delete globalThis.localStorage;
}
