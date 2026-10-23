/** 真实 Electron 表单 + preload / IPC 配置落盘；全部使用隔离合成数据，不调用模型。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import electron from "electron";
import { root } from "./runtime.mjs";

mkdirSync(join(root, "out"), { recursive: true });
const work = mkdtempSync(join(root, "out", "test-model-limits-desktop-"));
try {
	for (const dir of ["home", "data", "agent", "appdata", "localappdata", "project"]) mkdirSync(join(work, dir));
	const configPath = join(work, "agent", "models.json");
	writeFileSync(configPath, JSON.stringify({ providers: { "offline-fixture": {
		api: "openai-completions", baseUrl: "https://offline.invalid/v1",
		models: [{ id: "fixture-model", contextWindow: 128000, maxTokens: 16384, compat: { supportsDeveloperRole: true } }],
	} } }));
	writeFileSync(join(work, "agent", "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [] }));
	const steps = [{ js: `(async () => {
		const check = (condition, message) => { if (!condition) throw new Error(message); };
		const sleep = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
		const until = async (test, message) => {
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline) { const value = test(); if (value) return value; await sleep(); }
			throw new Error(message);
		};
		const modal = () => [...document.querySelectorAll('.fw-float')].at(-1);
		const button = (name, scope = modal()) => [...(scope ?? document).querySelectorAll('button')].find(b => b.textContent.trim() === name);
		const input = (label) => {
			const element = [...modal().querySelectorAll('label')].find(el => el.textContent.trim() === label);
			return element?.htmlFor ? document.getElementById(element.htmlFor) : element?.querySelector('input');
		};
		const fill = async (label, value) => {
			const element = input(label); check(element, '缺少输入框：' + label);
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
			element.dispatchEvent(new Event('input', { bubbles: true })); await sleep();
			check(input(label).value === value, 'React 输入状态未更新：' + label);
		};
		const group = label => modal().querySelector('[role="group"][aria-label="' + label + '快捷选项"]');
		const preset = (label, name) => button(name, group(label));
		const readConfig = async () => JSON.parse(JSON.parse(await window.floworkTransport.request('service.send', { type: 'get_config_file', name: 'models' })).text);
		const savedModel = async () => (await readConfig()).providers['offline-fixture'].models[0];
		const openEditor = async () => {
			(await until(() => button('编辑…', document), '未加载端点列表')).click();
			await until(() => modal()?.textContent.includes('编辑端点'), '未打开端点编辑器');
			button('编辑…').click();
			await until(() => group('上下文窗口'), '未打开模型编辑器');
		};
		const save = async () => {
			button('确定').click(); await until(() => !group('上下文窗口'), '模型编辑器未关闭');
			button('保存到 models.json').click(); await until(() => !modal(), '端点保存未完成');
		};
		check(window.__floworkStore, '未加载桌面测试桥');
		window.__floworkStore.setState({ view: 'settings', settingsTab: 'custom', updatedTo: null });
		await openEditor();
		check(input('上下文窗口').value === '128000', '已有上下文数值被改写');
		check(input('最大输出').value === '16384', '已有输出数值被改写');
		check(preset('上下文窗口', '128K').getAttribute('aria-pressed') === 'true', '整数未匹配预设高亮');
		check([...group('最大输出').querySelectorAll('button')].every(b => b.getAttribute('aria-pressed') === 'false'), '16384 被错误匹配为 16K');
		check(group('上下文窗口').querySelectorAll('button').length === 6, '上下文预设数量不正确');
		check(group('最大输出').querySelectorAll('button').length === 5, '最大输出预设数量不正确');
		preset('上下文窗口', '256K').click(); preset('最大输出', '32K').click(); await sleep();
		check(input('上下文窗口').value === '256K' && input('最大输出').value === '32K', '点击预设未填入对应字段');
		check(preset('上下文窗口', '256K').getAttribute('aria-pressed') === 'true', '选中的上下文未高亮');
		check(preset('上下文窗口', '128K').getAttribute('aria-pressed') === 'false', '旧预设没有取消高亮');
		check(preset('最大输出', '32K').getAttribute('aria-pressed') === 'true', '选中的输出未高亮');
		check(modal().textContent.includes('32,000 token'), '缺少精确换算结果');
		await fill('上下文窗口', '1.5'); button('确定').click(); await sleep();
		check(group('上下文窗口') && modal().textContent.includes('上下文窗口必须是正整数'), '无效输入没有阻止提交');
		check((await savedModel()).maxTokens === 16384, '校验失败不应改写配置');
		await fill('上下文窗口', ' 1m '); await fill('最大输出', '128k');
		check(preset('上下文窗口', '1M').getAttribute('aria-pressed') === 'true', '手动小写 / 空格输入未高亮');
		check(preset('最大输出', '128K').getAttribute('aria-pressed') === 'true', '手动输入未匹配输出预设');
		await save();
		const persisted = await savedModel();
		check(persisted.contextWindow === 1000000 && persisted.maxTokens === 128000, 'K / M 没有通过真实 IPC 保存为整数');
		check(persisted.compat?.supportsDeveloperRole === true, '保存破坏了其他模型字段');
		await openEditor();
		check(input('上下文窗口').value === '1000000' && input('最大输出').value === '128000', '重开未读取已保存整数');
		check(preset('上下文窗口', '1M').getAttribute('aria-pressed') === 'true', '重开后预设高亮丢失');
		await fill('上下文窗口', ''); await fill('最大输出', '');
		check([...group('上下文窗口').querySelectorAll('button')].every(b => b.getAttribute('aria-pressed') === 'false'), '留空不应选中默认值');
		await save();
		const cleared = await savedModel();
		check(!('contextWindow' in cleared) && !('maxTokens' in cleared), '留空没有删除显式配置');
		await openEditor();
		check(input('上下文窗口').value === '' && input('最大输出').value === '', '留空重开后被填入默认值');
		check(modal().textContent.includes('留空用默认值 128000') && modal().textContent.includes('留空用默认值 16384'), '原默认行为提示丢失');
		check(modal().textContent.includes('16K = 16000') && modal().textContent.includes('不会扩展模型能力'), '缺少单位差异或供应商上限提示');
		preset('上下文窗口', '1M').click(); preset('最大输出', '128K').click(); await sleep();
		const rect = group('上下文窗口').getBoundingClientRect();
		check(rect.width > 0 && rect.right <= window.innerWidth, '预设布局溢出窗口');
		await sleep(300);
		check(group('上下文窗口') && input('上下文窗口').value === '1M' && input('最大输出').value === '128K', '最终模型弹窗未稳定显示');
		return { initialExactValuesPreserved: true, presetsAndInput: true, persisted, blankDeletesOverride: true };
	})()`, wait: 100 }];
	const stepsFile = join(work, "steps.json"); writeFileSync(stepsFile, JSON.stringify(steps));
	const systemKeys = new Set(["path", "systemroot", "windir", "comspec", "temp", "tmp", "pathext", "systemdrive", "programfiles", "programfiles(x86)"]);
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toLowerCase()))),
		HOME: join(work, "home"), USERPROFILE: join(work, "home"), APPDATA: join(work, "appdata"), LOCALAPPDATA: join(work, "localappdata"),
		FLOWORK_DATA_DIR: join(work, "data"), FLOWORK_PI_AGENT_DIR: join(work, "agent"), PI_CODING_AGENT_DIR: join(work, "agent"),
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", SHOT_STEPS_FILE: stepsFile,
		SHOT_OUT: process.env.FLOWORK_TEST_SCREENSHOT ?? join(root, "out", "model-limits-desktop.png"), SHOT_WAIT: "500", SHOT_SHOW: "1" };
	// 发行版禁止截图测试桥；可用开发 Electron 加载 app.asar 验证同一份打包资源，不放宽该安全边界。
	const appRoot = process.env.FLOWORK_TEST_APP_ROOT ?? root;
	const result = spawnSync(electron, [appRoot, "--ui-screenshot"], { cwd: join(work, "project"), env, encoding: "utf8", timeout: 60000 });
	assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
	const model = JSON.parse(readFileSync(configPath, "utf8")).providers["offline-fixture"].models[0];
	assert.ok(!("contextWindow" in model)); assert.ok(!("maxTokens" in model));
	assert.equal(model.compat.supportsDeveloperRole, true);
	console.log("MODEL LIMITS DESKTOP REGRESSION OK（预设点击 / 高亮、手动 K/M、原值保留、错误拦截、真实 IPC 整数保存与重开、留空恢复默认；隔离配置，未调用模型）");
} finally {
	rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
