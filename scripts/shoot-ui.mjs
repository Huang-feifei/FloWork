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
import { imageLibraryRegression } from "./image-library-fixtures.mjs";

const outDir = resolve(process.argv[2] ?? join(root, "out/shots"));
const prefix = process.argv[3] ?? "ui";
mkdirSync(outDir, { recursive: true });

const mock = readFileSync(join(root, "scripts/mock-transcript.js"), "utf8");
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
	const key = (value, control = false) => window.dispatchEvent(new KeyboardEvent('keydown', { key: value, ctrlKey: control, bubbles: true, cancelable: true }));
	if (!key('p', true)) throw new Error('Ctrl+P 仍被旧弹窗拦截');
	await pause();
	if (document.querySelector('input[placeholder^="搜索项目文件（模糊匹配"]')) throw new Error('Ctrl+P 仍打开旧弹窗');
	key('k', true);
	const palette = await waitFor(() => document.querySelector('input[placeholder^="搜索文件、会话、命令"]'), 'Ctrl+K 未打开命令面板');
	if (palette.closest('.fw-float')?.textContent.includes('快速打开文件')) throw new Error('命令面板仍显示旧入口');
	if (!/(展开|折叠)思考与工具调用/.test(palette.closest('.fw-float')?.textContent ?? '')) throw new Error('折叠执行过程的操作没有保留在命令面板');
	key('Escape');
	await waitFor(() => !document.contains(palette), '命令面板未关闭');
	const tools = () => document.querySelector('.fw-session-tools');
	const panel = () => document.getElementById('conversation-tools');
	const tab = () => panel()?.querySelector('.fw-inspector-trigger');
	const menu = () => panel()?.querySelector('[role="menu"][aria-label="切换工具页签"]');
	const toolsShortcut = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true, cancelable: true }));
	if (document.querySelectorAll('.fw-session-toolbar button').length !== 2) throw new Error('会话顶部仍有重复按钮');
	const previousPanel = store.getState().rightPanel;
	open('设置'); await heading('设置');
	toolsShortcut();
	if (store.getState().rightPanel !== previousPanel) throw new Error('在设置页误改了会话工具面板状态');
	open('项目文件'); await heading('修复 relativeTime 的边界问题');
	await waitFor(() => tab()?.dataset.panel === 'files' && document.querySelector('input[placeholder="搜索整个项目"]'), '从设置页打开项目文件失败');
	const search = document.querySelector('input[placeholder="搜索整个项目"]');
	const searchFor = (value) => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, value);
		search.dispatchEvent(new Event('input', { bubbles: true }));
	};
	searchFor('useFileSearch.ts');
	await waitFor(() => panel()?.querySelector('button[title="src/renderer/src/lib/useFileSearch.ts"]'), '项目搜索未返回匹配的文件');
	searchFor('no-such-flowork-test-file-qz98');
	await waitFor(() => panel()?.textContent.includes('正在搜索') && !panel()?.querySelector('button[title="src/renderer/src/lib/useFileSearch.ts"]'), '新查询仍暴露上次搜索结果');
	search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	if (store.getState().preview) throw new Error('搜索期间的回车打开了旧结果');
	await waitFor(() => panel()?.textContent.includes('没有找到匹配的文件'), '没有搜索无结果提示');
	tab().click();
	const checked = await waitFor(() => menu()?.querySelector('[role="menuitemradio"][aria-checked="true"]'), '工具菜单未标记当前项');
	if (checked.dataset.panel !== 'files' || document.activeElement !== checked || menu().querySelectorAll('[role="menuitemradio"]').length !== 4) throw new Error('本地工具菜单当前项或焦点不正确');
	checked.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	await waitFor(() => !menu() && document.activeElement === tab(), 'Esc 关闭菜单后未恢复焦点');
	tab().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	await waitFor(() => document.activeElement === menu()?.querySelector('[aria-checked="true"]'), '键盘未打开工具菜单');
	document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	if (document.activeElement.dataset.panel !== 'execution') throw new Error('方向键未切换焦点');
	document.activeElement.click();
	await waitFor(() => tab()?.dataset.panel === 'execution' && !menu() && document.activeElement === tab(), '无法切换到执行树并恢复焦点');
	panel().querySelector('button[aria-label="收起工具面板"]').click();
	await waitFor(() => !panel() && tools()?.getAttribute('aria-expanded') === 'false', '收起后工具按钮状态不符');
	toolsShortcut();
	await waitFor(() => tab()?.dataset.panel === 'execution' && tools()?.getAttribute('aria-expanded') === 'true', '快捷键未恢复上次使用的执行树页签');
	if (localStorage.getItem('flowork.lastRightPanel') !== 'execution') throw new Error('工具页签未记住');
	toolsShortcut();
	await waitFor(() => !panel(), '快捷键未收起面板');
	tools().click();
	await waitFor(() => tab()?.dataset.panel === 'execution', '工具按钮未恢复上次使用的执行树页签');
	store.getState().setRightPanel('session');
	await waitFor(() => tab()?.dataset.panel === 'session' && panel()?.textContent.includes('已修改 1 个文件'), '会话文件列表或改动统计被影响');
	const chat = document.querySelector('main[data-view="chat"]');
	if (!chat.textContent.includes('本轮修改 · 1 个文件')) throw new Error('本轮修改摘要被影响');
	if ([...chat.querySelectorAll('button')].some(button => /^(查看会话改动|查看文件改动)$/.test(button.textContent.trim()))) throw new Error('会话内仍有重复的改动入口');
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

const verifyUpdateDownload = `(() => {
	const trigger = document.querySelector('.fw-app-rail .fw-update-trigger');
	const settings = document.querySelector('.fw-app-rail [title="设置"]');
	if (!trigger || trigger.dataset.phase !== 'downloading' || !settings || trigger.getBoundingClientRect().bottom > settings.getBoundingClientRect().top) throw new Error('更新入口没有放在左下角设置上方');
	if (document.querySelector('#fw-update-popover')) throw new Error('后台下载不应主动弹出浮层');
	const progress = trigger.querySelector('progress');
	if (progress?.value !== 45 || progress.max !== 100 || !trigger.textContent.includes('45%') || !progress.getBoundingClientRect().height) throw new Error('左下角没有直接显示下载进度');
})()`;
const verifyUpdateProgress = `(() => {
	const panel = document.querySelector('#fw-update-popover');
	const progress = panel?.querySelector('progress');
	if (progress?.value !== 45 || progress?.max !== 100 || panel.textContent.includes('重启安装')) throw new Error('下载安装前的进度或动作不正确');
	const rect = panel.getBoundingClientRect();
	if (rect.left >= 100 || rect.bottom <= innerHeight - 100) throw new Error('更新浮层没有贴近左下角');
})()`;
const verifyUpdateReady = `(async () => {
	const button = label => [...document.querySelectorAll('#fw-update-popover button')].find(node => node.textContent.trim() === label);
	const trigger = document.querySelector('.fw-app-rail .fw-update-trigger');
	if (trigger?.dataset.phase !== 'ready' || !button('重启安装') || !button('稍后')) throw new Error('校验完成后未提示可以重启安装');
	button('稍后').click();
	await new Promise(resolve => setTimeout(resolve, 60));
	if (document.querySelector('#fw-update-popover') || !trigger.isConnected) throw new Error('稍后应收起详情，保留左下角入口');
	trigger.click();
})()`;

const verifyComposerLayout = `(async () => {
	const store = window.__floworkStore;
	const current = store.getState().state;
	const model = { ...current.model, provider: 'workbuddy', id: 'deepseek-v4.1-flash-long-provider-variant', name: 'workbuddy/deepseek-v4.1-flash-long-provider-variant' };
	store.setState({ isRunning: true, approvalMode: 'auto', state: { ...current, model, thinkingLevel: 'high' } });
	const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	await tick();
	const toolbar = document.querySelector('.fw-composer-tools');
	const composer = toolbar?.closest('.fw-composer');
	const modelButton = toolbar?.querySelector('.fw-model-trigger');
	const stop = toolbar?.querySelector('.fw-composer-stop');
	if (!composer || !modelButton || !stop) throw new Error('未进入长模型名的运行中状态');
	if (!modelButton.title.includes(model.id)) throw new Error('完整模型名称无法查看');
	for (const width of [690, 440, 300, 230]) {
		composer.style.width = width + 'px';
		await tick();
		const row = toolbar.getBoundingClientRect();
		const controls = [...toolbar.querySelectorAll('button')].map(button => button.getBoundingClientRect());
		if (controls.some(box => box.left < row.left - 1 || box.right > row.right + 1 || Math.abs(box.top - controls[0].top) > 1)) {
			throw new Error('输入工具栏在 ' + width + ' px 下发生换行或溢出');
		}
	}
	const approval = toolbar.querySelector('button[aria-label^="审批"]');
	approval.click();
	await tick();
	if (!toolbar.querySelector('.fw-picker-panel')?.textContent.includes('审批：全部工具')) throw new Error('窄工具栏丢失完整审批选项');
	approval.click();
	await tick();
	modelButton.click();
	await tick();
	if (!toolbar.querySelector('.fw-model-panel')) throw new Error('窄工具栏未打开模型与推理');
	document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	await tick();
	if (toolbar.querySelector('.fw-model-panel') || document.activeElement !== modelButton) throw new Error('模型面板关闭后未恢复焦点');
	composer.style.removeProperty('width');
})()`;

const remoteHosts = [
	{ id: "sample-build", name: "构建服务器", host: "build.example.invalid", user: "deploy" },
	{ id: "sample-test", name: "测试环境", host: "staging.example.invalid", user: "devops", port: 2222 },
	{ id: "sample-data", name: "数据备份", host: "backup.example.invalid", user: "backup" },
].map((host) => ({ ...host, auth: "agent", createdAt: Date.now() }));

const verifyRemoteWorkspace = `(async () => {
	const store = window.__floworkStore;
	const wait = async (test, message) => {
		for (let i = 0; i < 60; i++) {
			const found = test();
			if (found) return found;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		throw new Error(message);
	};
	const byLabel = (label, root = document) => [...root.querySelectorAll('button')].find(button => button.textContent.trim() === label);
	const setInput = (input, text) => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const catalog = () => document.querySelector('main[data-view="remote"]');
	const dialog = () => document.querySelector('[role="dialog"]');
	const cards = (section) => catalog()?.querySelectorAll('section[aria-label="' + section + '"] article');
	const key = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(96), ctrlKey: true, cancelable: true }));
	await wait(() => store.getState().hosts.length === 3, '测试主机未加载');
	const time = Date.now();
	store.setState({ view: 'chat', recentRemoteHosts: { 'sample-build': time - 360000, 'sample-test': time - 2400000 }, projects: {
		groups: [{ id: 'test-group', name: '基础设施' }], projects: [{ id: 'test-project', hostId: 'sample-build', groupId: 'test-group', path: '/srv/build', order: 0, addedAt: time }],
	} });
	await wait(() => document.querySelector('.fw-app-rail [title="远程主机（SSH）"]'), '缺少远程工作台入口').then(button => button.click());
	await wait(() => cards('全部主机')?.length === 3, '主机没有显示在目录里');
	if (cards('最近连接').length !== 2 || dialog() || document.querySelector('.fw-context-sidebar')) throw new Error('最近连接没有渲染，或仍在使用旧弹窗/项目栏');
	catalog().querySelector('section[aria-label="项目分组"] .fw-remote-card').click();
	await wait(() => cards('分组：基础设施')?.length === 1, '分组筛选失败');
	byLabel('返回全部主机', catalog()).click();
	const search = catalog().querySelector('[aria-label="查找主机"]');
	setInput(search, 'devops 2222');
	await wait(() => cards('搜索结果')?.length === 1, '未按用户名与端口筛选');
	setInput(search, 'no-match');
	await wait(() => catalog().textContent.includes('没有找到匹配的主机'), '缺少无结果提示');
	catalog().querySelector('[aria-label="清空搜索"]').click();
	await wait(() => cards('全部主机')?.length === 3, '清空搜索没有恢复主机');
	byLabel('新建主机', catalog()).click();
	await wait(dialog, '新增主机表单未出现');
	setInput(dialog().querySelector('input[placeholder="例如 测试机"]'), '临时测试主机');
	setInput(dialog().querySelector('input[placeholder="IP 地址或域名"]'), 'temp.example.invalid');
	await wait(() => !byLabel('保存', dialog())?.disabled && byLabel('保存', dialog()), '新增表单未启用保存').then(button => button.click());
	await wait(() => !dialog() && cards('全部主机')?.length === 4, '保存主机后目录没有更新');
	catalog().querySelector('[aria-label="主机操作：临时测试主机"]').click();
	await wait(() => byLabel('编辑 / 测试连接…'), '主机操作菜单未显示').then(button => button.click());
	await wait(dialog, '编辑主机表单没有出现');
	setInput(dialog().querySelector('input[placeholder="例如 测试机"]'), '已修改的主机');
	byLabel('保存', dialog()).click();
	await wait(() => !dialog() && catalog()?.querySelector('[aria-label="主机操作：已修改的主机"]'), '编辑结果没有刷新').then(button => button.click());
	await wait(() => byLabel('删除主机…'), '缺少删除菜单项').then(button => button.click());
	await wait(dialog, '缺少删除确认');
	byLabel('删除主机', dialog()).click();
	await wait(() => !dialog() && cards('全部主机')?.length === 3, '删除数据后目录没有更新');
	key();
	await wait(() => catalog().querySelector('#fw-remote-terminal')?.textContent.includes('没有打开的远程终端'), '终端快捷键没有打开独立终端');
	key();
	await wait(() => cards('全部主机')?.length === 3, '终端快捷键没有返回主机目录');
	if (catalog().scrollWidth > catalog().clientWidth + 1) throw new Error('远程工作台发生横向溢出');
})()`;

const scenes = {
	welcome: [setView("welcome")],
	empty: [`window.__floworkStore.setState({ view: "chat", activeProjectId: null, cwd: null, handleId: null, messages: [], state: null })`],
	chat: [mock, showSessionFiles, { js: verifyWorkspace, wait: 80 }, { js: chatTop, wait: 80 }],
	"chat-dark": [mock, showSessionFiles, `document.documentElement.dataset.theme = "dark"`, { js: chatTop, wait: 80 }],
	"tools-menu-dark": [mock, `window.__floworkStore.getState().setRightPanel('files'); document.documentElement.dataset.theme = 'dark'`, { js: `document.querySelector('.fw-inspector-trigger').click()`, wait: 80 }],
	"composer-running-dark": [mock, showSessionFiles, modelExamples, `document.documentElement.dataset.theme = "dark"`, { js: verifyComposerLayout, wait: 100 }],
	"app-update": [mock, showSessionFiles, `document.documentElement.dataset.theme = "dark"`,
		{ appUpdate: { phase: "downloading", version: "1.1.10", downloaded: 45, total: 100 }, wait: 100 },
		{ js: verifyUpdateDownload, wait: 100 }, { js: `document.querySelector('.fw-update-trigger').click()`, wait: 80 }, { js: verifyUpdateProgress, wait: 80 },
		{ appUpdate: { phase: "ready", version: "1.1.10" }, wait: 100 }, { js: verifyUpdateReady, wait: 100 }],
	"app-update-download": [mock, showSessionFiles, `document.documentElement.dataset.theme = "dark"`,
		{ appUpdate: { phase: "downloading", version: "1.1.10", downloaded: 45, total: 100 }, wait: 100 },
		{ js: verifyUpdateDownload, wait: 80 }],
	thinking: [mock, showSessionFiles, modelExamples, { js: verifyThinking, wait: 100 }, { js: openThinking, wait: 100 }],
	"thinking-dark": [mock, showSessionFiles, modelExamples, `document.documentElement.dataset.theme = "dark"`, { js: openThinking, wait: 100 }],
	review: [mock, `document.querySelector('.fw-review-link').click()`, { js: waitForReview, wait: 120 }],
	"review-empty": [mock, `window.__floworkStore.setState({ view: 'review', messages: [] })`, { js: waitForReview, wait: 120 }],
	"settings-image-only": [setView("settings"), { js: verifyImageOnlyEndpoint, wait: 120 }],
	palette: [mock, `window.__floworkStore.getState().setPalette(true)`],
	remote: ["window.__floworkStore.getState().setTheme('light')", { js: verifyRemoteWorkspace, wait: 150 }],
	"remote-dark": ["window.__floworkStore.getState().setTheme('dark')", { js: verifyRemoteWorkspace, wait: 150 }],
	terminal: [mock, { js: `(async () => {
		const pause = () => new Promise(resolve => setTimeout(resolve, 50));
		const until = async (test, message) => { for (let i = 0; i < 60; i++) { const value = test(); if (value) return value; await pause(); } throw new Error(message); };
		const button = () => document.querySelector('.fw-titlebar [aria-label^="打开终端面板"], .fw-titlebar [aria-label^="收起终端面板"]');
		const panel = () => document.getElementById('fw-terminal-panel');
		const trigger = await until(button, '标题栏缺少终端入口');
		if (document.querySelector('.fw-app-rail [title="终端"]')) throw new Error('左栏仍有终端入口');
		const minimize = document.querySelector('.fw-titlebar [title="最小化"]');
		if (minimize && trigger.getBoundingClientRect().right > minimize.getBoundingClientRect().left) throw new Error('终端入口未与窗口按钮分组排列');
		trigger.click();
		await until(() => panel() && button().getAttribute('aria-expanded') === 'true', '点击标题栏未打开终端');
		window.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(96), ctrlKey: true, cancelable: true }));
		await until(() => !panel() && button().getAttribute('aria-expanded') === 'false', '原快捷键未收起终端');
		button().click();
		await until(panel, '未能再次打开终端');
	})()`, wait: 100 }],
	settings: [setView("settings")],
	database: [setView("database")],
	imagegen: [setView("imagegen")],
	"imagegen-regression": [{ js: imageStudioRegression, wait: 120 }],
	"imagegen-regression-dark": [`document.documentElement.dataset.theme = "dark"`, { js: imageStudioRegression, wait: 120 }],
	gallery: [setView("gallery")],
	"gallery-populated": [setView("gallery")],
	"gallery-regression": [setView("gallery"), { js: imageLibraryRegression, wait: 120 }],
	"database-dialog": [setView("database"), { js: `(() => { const button = [...document.querySelectorAll('main button')].find(node => node.textContent.includes('新建连接')); if (!button) throw new Error('找不到新建连接'); button.click(); })()`, wait: 120 }],
};

if (!existsSync(join(root, "out/main/index.js"))) throw new Error("请先 npm run build");
const requested = process.argv.slice(4);
const selectedScenes = Object.entries(scenes).filter(([name]) => requested.length === 0 || requested.includes(name));
if (requested.some((name) => !Object.hasOwn(scenes, name))) throw new Error(`未知场景，可选：${Object.keys(scenes).join("、")}`);
for (const [name, steps] of selectedScenes) {
	const temp = mkdtempSync(join(tmpdir(), "flowork-shot-"));
	const isRemoteScene = name === "remote" || name === "remote-dark";
	try {
		for (const dir of ["home", "data", "agent"]) mkdirSync(join(temp, dir), { recursive: true });
		if (isRemoteScene) {
			writeFileSync(join(temp, "data", "hosts.json"), JSON.stringify({ version: 1, hosts: remoteHosts }));
		}
		if (name.startsWith("imagegen-regression") || name === "gallery-populated" || name === "gallery-regression") seedImageStudioCache(join(temp, "agent"));
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
			// 隐藏窗口可能拍到交互回归过程中的旧帧。
			...(isRemoteScene ? { SHOT_SHOW: "1" } : {}),
		};
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.ELECTRON_RENDERER_URL;
		const r = spawnSync(electronPath, [root, "--ui-screenshot"], { env, cwd: root, encoding: "utf8", timeout: 60_000 });
		console.log(r.status === 0 ? `✓ ${out}` : `✗ ${name}: ${r.error || r.stderr || r.stdout}`);
		if (r.status !== 0) process.exitCode = 1;
	} finally { rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
