/**
 * 开发辅助：启动隔离的桌面应用，对几个典型界面截图（需先 npm run build）。
 *
 *   node scripts/shoot-ui.mjs <输出目录> [前缀] [场景名…]
 *
 * 会注入 scripts/mock-transcript.js 中的示例会话；不会调用模型，也不修改配置。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import electronPath from "electron";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { root } from "./runtime.mjs";
import { imageStudioRegression, seedImageStudioCache } from "./image-studio-fixtures.mjs";

const outDir = resolve(process.argv[2] ?? join(root, "out/shots"));
const prefix = process.argv[3] ?? "ui";
mkdirSync(outDir, { recursive: true });

const mock = readFileSync(join(root, "scripts/mock-transcript.js"), "utf8");
const clickTitle = (title) => `(() => { const button = document.querySelector(${JSON.stringify(`button[title='${title}']`)}); if (!button) throw new Error(${JSON.stringify(`找不到截图按钮：${title}`)}); button.click(); })()`;
/** 切到某个视图（截图辅助：直接改界面状态，不经过交互） */
const setView = (view) => `window.__floworkStore.setState({ view: ${JSON.stringify(view)} })`;
const showSessionFiles = `window.__floworkStore.setState({ rightPanel: "session", railVisible: false })`;
const modelExamples = `(() => {
	const store = window.__floworkStore;
	const active = store.getState().state.model;
	const examples = [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false },
		{ provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true },
		{ provider: 'deepseek', id: 'deepseek-v3.2', name: 'DeepSeek V3.2', reasoning: true },
		{ provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true }, active,
		{ provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1', reasoning: false },
		{ provider: 'anthropic', id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true }];
	store.setState({ models: examples, state: { ...store.getState().state, availableThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] } });
})()`;
const openThinking = `(async () => {
	const button = document.querySelector('.fw-model-trigger');
	button.focus();
	button.click();
	await new Promise(resolve => setTimeout(resolve, 80));
	const panel = document.querySelector('.fw-model-panel');
	if (!panel || panel.getBoundingClientRect().top < 0) throw new Error('模型与推理浮层未出现或超出窗口');
})()`;
const verifyThinking = `(() => {
	const store = window.__floworkStore;
	const { state: savedState, setModel, setThinkingLevel, loadModels } = store.getState();
	let refreshed = 0;
	const nextPaint = () => new Promise(resolve => setTimeout(resolve, 65));
	const assert = (condition, message) => { if (!condition) throw new Error(message); };
	const trigger = () => document.querySelector('.fw-model-trigger');
	const options = group => [...document.querySelectorAll('[data-choice=' + group + ']')];
	const key = value => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
	return (async () => {
		store.setState({ state: { ...savedState },
			setModel: async model => {
				await nextPaint();
				store.setState({ state: { ...savedState, model, thinkingLevel: model.reasoning ? 'medium' : 'off', availableThinkingLevels: model.reasoning ? savedState.availableThinkingLevels : ['off'] } });
			},
			setThinkingLevel: async level => store.setState({ state: { ...store.getState().state, thinkingLevel: level } }),
			loadModels: async () => { refreshed += 1; },
		});
		trigger().focus();
		key('ArrowDown');
		await nextPaint();
		assert(document.activeElement.tagName === 'INPUT', '打开后没有聚焦搜索');
		assert(options('model').length === 7 && options('thinking').length === savedState.availableThinkingLevels.length, '模型列表或档位不符合当前会话');
		assert(document.querySelector('.fw-model-guide').textContent.includes('日常编码'), '缺少当前档位的建议');
		document.querySelector('button[title="刷新模型"]').click();
		await nextPaint();
		assert(refreshed === 1, '刷新按钮没有调用模型刷新');
		document.querySelector('.fw-model-save').click();
		await nextPaint();
		document.querySelector('.fw-model-favorites').click();
		await nextPaint();
		assert(options('model').length === 1 && options('model')[0].title === 'deepseek-chat', '收藏没有正确筛选');
		assert(localStorage.getItem('flowork.favoriteModels')?.includes('deepseek/deepseek-chat'), '收藏没有保存在本机');
		document.querySelector('.fw-model-save').click();
		await nextPaint();
		assert(!options('model').length, '取消收藏后仍显示该模型');
		document.querySelector('.fw-model-filter[aria-pressed="false"]').click();
		const provider = document.querySelector('[aria-label="筛选供应商"]');
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(provider, 'deepseek');
		provider.dispatchEvent(new Event('change', { bubbles: true }));
		document.querySelector('[aria-label="搜索模型或供应商"]').focus();
		await nextPaint();
		assert(options('model').length === 5, '供应商筛选未生效');
		key('ArrowDown');
		key('ArrowRight');
		assert(document.activeElement.getAttribute('data-choice') === 'thinking' && document.activeElement.getAttribute('aria-checked') === 'true', '横向切换没有定位到当前档位');
		key('ArrowDown');
		document.activeElement.click();
		await nextPaint();
		assert(store.getState().state.thinkingLevel === 'high' && document.querySelector('.fw-model-guide').textContent.includes('跨文件改动'), '选档没有更新当前会话和档位说明');
		const search = document.querySelector('[aria-label="搜索模型或供应商"]');
		search.focus();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'openai 4.1');
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await nextPaint();
		assert(options('model').length === 1 && options('model')[0].title === 'gpt-4.1', '未按模型及供应商搜索');
		key('Enter');
		await nextPaint();
		await nextPaint();
		assert(store.getState().state.model.id === 'gpt-4.1' && !options('thinking').length && trigger().getAttribute('aria-expanded') === 'true', '切换模型后浮层关闭或保留了旧档位');
		assert(document.querySelector('.fw-model-details').textContent.includes('不提供可调档位'), '没有明确说明模型不可调');
		key('Escape');
		await nextPaint();
		assert(!document.querySelector('.fw-model-panel') && document.activeElement === trigger(), 'Esc 没有收起浮层并恢复焦点');
	})().finally(() => store.setState({ state: savedState, setModel, setThinkingLevel, loadModels }));
})()`;

const chatTop = `document.querySelector('.fw-conversation .overflow-y-auto')?.scrollTo(0, 0)`;
const verifyWorkspace = `(async () => {
	const navigation = document.querySelector('.fw-app-rail');
	const pause = () => new Promise(resolve => setTimeout(resolve, 50));
	const waitFor = async (test, message) => {
		for (let attempt = 0; attempt < 60; attempt++) {
			const result = test();
			if (result) return result;
			await pause();
		}
		throw new Error(message);
	};
	const open = title => navigation.querySelector('button[title="' + title + '"]').click();
	const heading = async title => {
		await waitFor(() => [...document.querySelectorAll('main h1')].some(node => node.getClientRects().length && node.textContent === title), '页面标题未更新：' + title);
		if (document.querySelector('.fw-app-rail') !== navigation) throw new Error('切页时导航未保持');
		if (document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth + 1) throw new Error('页面横向溢出：' + title);
	};
	open('图片生成'); await heading('图片生成');
	open('图片库'); await heading('图片库');
	open('设置'); await heading('设置');
	if (document.querySelector('.fw-context-sidebar')) throw new Error('设置页仍显示项目栏');
	open('数据库'); await heading('数据库');
	const create = [...document.querySelectorAll('main button')].find(button => button.textContent.includes('新建连接'));
	create.click();
	const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), '数据库连接弹窗未打开');
	dialog.querySelector('button[aria-label="关闭对话框"]').click();
	await waitFor(() => !document.querySelector('[role="dialog"]'), '数据库连接弹窗未关闭');
	if (navigation.querySelector('button[title="本会话的修改"]')) throw new Error('已移除的全局改动入口仍然可见');
	open('会话'); await heading('修复 relativeTime 的边界问题');
	document.querySelector('.fw-review-link').click(); await heading('本会话的文件改动');
	if (!document.querySelector('[aria-label="改动文件"] button[aria-pressed="true"]')) throw new Error('未选中改动文件');
	[...document.querySelectorAll('main button')].find(button => button.textContent.includes('返回会话')).click();
	await heading('修复 relativeTime 的边界问题');
	const store = window.__floworkStore;
	const messages = store.getState().messages;
	store.setState({ messages: [] });
	await waitFor(() => !document.querySelector('.fw-review-link'), '无改动的会话仍显示文件改动入口');
	store.setState({ messages });
})()`;

const verifyImageOnlyEndpoint = `(async () => {
	const waitFor = async (check, message) => {
		for (let attempt = 0; attempt < 50; attempt++) {
			const result = check();
			if (result) return result;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		throw new Error(message);
	};
	const card = await waitFor(() => [...document.querySelectorAll('main article')].find(node => node.textContent.includes('image-demo')), '未加载仅图片端点');
	const chat = card.querySelector('[aria-label="聊天模型"]');
	const images = card.querySelector('[aria-label="图片模型"]');
	if (!chat?.textContent.includes('未添加聊天模型') || !images?.textContent.includes('image-example') || !images?.textContent.includes('1 个') || images.textContent.includes('图片生成已停用')) throw new Error('聊天和图片模型状态混淆');
	const disabled = [...document.querySelectorAll('main article')].find(node => node.textContent.includes('paused-demo'));
	if (!disabled?.querySelector('[aria-label="图片模型"]')?.textContent.includes('图片生成已停用')) throw new Error('未显示图片生成停用状态');
	images.querySelector('button').click();
	const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), '未打开端点编辑弹窗');
	if (!dialog.textContent.includes('提供这个端点的图片模型')) throw new Error('管理图片模型没有直达图片模型页');
	dialog.querySelector('[aria-label="关闭对话框"]').click();
	await waitFor(() => !document.querySelector('[role="dialog"]'), '关闭编辑弹窗失败');
})()`;

const waitForReview = `(async () => {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (document.querySelector('main h1')?.textContent === '本会话的文件改动') return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error('文件改动页面未加载');
})()`;

const scenes = {
	welcome: [setView("welcome")],
	empty: [`window.__floworkStore.setState({ view: "chat", activeProjectId: null, cwd: null, handleId: null, messages: [], state: null })`],
	chat: [mock, showSessionFiles, { js: verifyWorkspace, wait: 80 }, { js: chatTop, wait: 80 }],
	"chat-dark": [mock, showSessionFiles, `document.documentElement.dataset.theme = "dark"`, { js: chatTop, wait: 80 }],
	thinking: [mock, showSessionFiles, modelExamples, { js: verifyThinking, wait: 100 }, { js: openThinking, wait: 100 }],
	"thinking-dark": [mock, showSessionFiles, modelExamples, `document.documentElement.dataset.theme = "dark"`, { js: openThinking, wait: 100 }],
	review: [mock, `document.querySelector('.fw-review-link').click()`, { js: waitForReview, wait: 120 }],
	"review-empty": [mock, `window.__floworkStore.setState({ view: 'review', messages: [] })`, { js: waitForReview, wait: 120 }],
	"settings-image-only": [setView("settings"), { js: verifyImageOnlyEndpoint, wait: 120 }],
	palette: [mock, `window.__floworkStore.getState().setPalette(true)`],
	terminal: [mock, clickTitle("终端")],
	settings: [setView("settings")],
	database: [setView("database")],
	imagegen: [setView("imagegen")],
	"imagegen-regression": [{ js: imageStudioRegression, wait: 120 }],
	"imagegen-regression-dark": [`document.documentElement.dataset.theme = "dark"`, { js: imageStudioRegression, wait: 120 }],
	gallery: [setView("gallery")],
	"database-dialog": [setView("database"), { js: `(() => { const button = [...document.querySelectorAll('main button')].find(node => node.textContent.includes('新建连接')); if (!button) throw new Error('找不到新建连接'); button.click(); })()`, wait: 120 }],
};

if (!existsSync(join(root, "out/main/index.js"))) throw new Error("请先 npm run build");
const requested = process.argv.slice(4);
const selectedScenes = Object.entries(scenes).filter(([name]) => requested.length === 0 || requested.includes(name));
if (requested.some((name) => !Object.hasOwn(scenes, name))) throw new Error(`未知场景，可选：${Object.keys(scenes).join("、")}`);
for (const [name, steps] of selectedScenes) {
	const temp = mkdtempSync(join(tmpdir(), "flowork-shot-"));
	try {
		for (const dir of ["home", "data", "agent"]) mkdirSync(join(temp, dir), { recursive: true });
		if (name.startsWith("imagegen-regression")) seedImageStudioCache(join(temp, "agent"));
		if (name === "settings-image-only") {
			const endpoint = { api: "openai-responses", baseUrl: "https://example.invalid/v1", apiKey: "example-only", models: [], imageModels: [{ id: "image-example", name: "图片生成示例" }] };
			writeFileSync(join(temp, "agent", "models.json"), JSON.stringify({ providers: { "image-demo": endpoint, "paused-demo": { ...endpoint, imageEnabled: false } } }));
		}
		const stepsFile = join(temp, "steps.json");
		writeFileSync(stepsFile, JSON.stringify(steps));
		const out = join(outDir, `${prefix}-${name}.png`);
		const env = {
			...process.env,
			HOME: join(temp, "home"),
			USERPROFILE: join(temp, "home"),
			FLOWORK_DATA_DIR: join(temp, "data"),
			FLOWORK_PI_AGENT_DIR: join(temp, "agent"),
			PI_CODING_AGENT_DIR: join(temp, "agent"),
			PI_SKIP_VERSION_CHECK: "1",
			SHOT_OUT: out,
			SHOT_STEPS_FILE: stepsFile,
			SHOT_WAIT: "2000",
		};
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.ELECTRON_RENDERER_URL;
		const r = spawnSync(electronPath, [root, "--ui-screenshot"], { env, cwd: root, encoding: "utf8", timeout: 60_000 });
		console.log(r.status === 0 ? `✓ ${out}` : `✗ ${name}: ${r.error || r.stderr || r.stdout}`);
		if (r.status !== 0) process.exitCode = 1;
	} finally { rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
