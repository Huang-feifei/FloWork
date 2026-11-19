import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=";

function previewImage(tint) {
	const width = 48, height = 32;
	const chunk = (type, data) => {
		const input = Buffer.concat([Buffer.from(type), data]);
		let crc = 0xffffffff;
		for (const byte of input) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		const buffer = Buffer.alloc(input.length + 8);
		buffer.writeUInt32BE(data.length);
		input.copy(buffer, 4);
		buffer.writeUInt32BE((~crc) >>> 0, input.length + 4);
		return buffer;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const stride = width * 3 + 1;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = y * stride + 1 + x * 3;
			const ridge = 13 + 4 * Math.sin(x / 8) + 3 * Math.cos(x / 5);
			const light = y > ridge + 3 ? 22 + y : y > ridge ? 53 + 2 * y : 126 + 2 * y;
			pixels[offset] = light + tint;
			pixels[offset + 1] = light + 16;
			pixels[offset + 2] = light + 24 - tint / 2;
		}
	}
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

const previews = [previewImage(2), previewImage(28)];
const models = [
	{ key: "fixture/fixed", provider: "fixture", id: "fixed", name: "固定尺寸 · 文生图", sizes: ["1024x1024"], edits: false },
	{ key: "fixture/multi", provider: "fixture", id: "multi", name: "多尺寸 · 支持参考图", sizes: ["512x512", "1536x1024", "1024x1536"], edits: true },
];
const prompt = "雾中的山脊，宽幅构图";
const results = models.map((model, index) => ({
	id: `studio-regression-${index}.png`, prompt, model: model.key, size: model.sizes[index], quality: "standard",
	bytes: previews[index].length, createdAt: 1700000000000 + index, edited: index === 1,
}));

/** 只在截图进程使用的临时代理目录内写缓存；UI 通过真实只读 IPC 加载这些图片。 */
export function seedImageStudioCache(agentDir) {
	const cache = join(agentDir, "images");
	mkdirSync(cache, { recursive: true });
	for (const [index, result] of results.entries()) writeFileSync(join(cache, result.id), previews[index]);
	writeFileSync(join(cache, "index.json"), JSON.stringify({ version: 1, items: results }));
}

/** 这个函数会被序列化到隔离的 Electron 渲染进程，不能引用外部变量。 */
async function verifyImageStudio({ models, prompt, png, results, previews }) {
	const store = window.__floworkStore;
	const previous = store.getState();
	const calls = [];
	let request;
	const check = (condition, message) => { if (!condition) throw new Error(message); };
	const pause = () => new Promise(resolve => setTimeout(resolve, 40));
	const waitFor = async (test, message) => {
		for (let attempt = 0; attempt < 125; attempt++) {
			const result = test();
			if (result) return result;
			await pause();
		}
		throw new Error(message);
	};
	const main = () => document.querySelector('main[data-view="imagegen"]');
	const find = selector => main()?.querySelector(selector);
	const name = node => node.getAttribute("aria-label") || [...(node.labels ?? [])].map(label => label.textContent.trim()).join(" ") || node.textContent.trim();
	const editor = () => [...(main()?.querySelectorAll("textarea") ?? [])].find(node => name(node) === "提示词");
	const submit = () => find('button[type="submit"]');
	const stage = () => find("[data-image-stage]");
	const waitState = state => waitFor(() => stage()?.dataset.state === state, `画布未进入预期状态：${state}`);
	const addReference = () => [...(main()?.querySelectorAll("button") ?? [])].find(button => name(button) === "添加参考图");
	const unavailable = button => !button || button.matches(":disabled") || button.getAttribute("aria-disabled") === "true";
	const sizeButtons = () => [...main().querySelectorAll("button[data-image-size]")];
	const choice = () => find('select[aria-label="图片模型"]');
	const hasSizeOptions = () => [...main().querySelectorAll("select option")].some(option => models.some(model => model.sizes.includes(option.value)));
	const stageImages = () => [...(stage()?.querySelectorAll("img") ?? [])];
	const setText = text => {
		const area = editor();
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, text);
		area.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const setModel = async model => {
		const select = choice();
		select.value = model.key;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await waitFor(() => choice()?.value === model.key, `切换模型失败：${model.name}`);
	};
	const resolveCall = (error, result) => {
		check(request, "没有可完成的测试请求");
		const finish = request;
		request = undefined;
		if (error) finish.reject(error);
		else {
			const stored = store.getState().images.filter(item => item.id !== result.id);
			store.setState({ images: [result, ...stored] });
			finish.resolve([result]);
		}
	};
	const begin = async (model, size, reference, hasPrevious = false) => {
		const before = calls.length;
		check(!unavailable(submit()), "填写提示词后仍无法生成");
		submit().click();
		await waitState("generating");
		check(calls.length === before + 1, "没有且仅有一次生成请求");
		const payload = calls.at(-1);
		check(payload.model === model.key && payload.size === size && payload.prompt.trim() === prompt, "生成请求未使用所选模型、尺寸或提示词");
		if (reference) check(payload.reference?.mimeType === "image/png" && payload.reference?.dataBase64 === png, "生成请求缺少所选参考图");
		else check(!payload.reference, "不支持参考图的模型收到了参考图");
		check(editor().matches(":disabled") && unavailable(submit()), "生成期间未禁用输入或提交");
		if (hasPrevious) check(stageImages().length > 0, "再次生成时上次结果被清空");
	};
	const checkFailed = async () => {
		resolveCall(new Error("模拟生成失败：图片服务暂时不可用"));
		await waitState("error");
		check(editor().value.trim() === prompt && !editor().matches(":disabled"), "失败后未保留提示词或恢复编辑");
	};
	const checkReady = async index => {
		resolveCall(null, { ...results[index], size: calls.at(-1).size });
		await waitState("ready");
		await waitFor(() => stageImages().some(image => image.naturalWidth > 0 && image.currentSrc.endsWith(previews[index])), "成功后没有在画布显示本次生成的缓存图片");
	};

	store.setState({
		view: "imagegen", images: [], imageModels: models, imageBusy: false,
		loadImages: async () => { store.setState({ imageModels: models }); },
		generateImages: async input => {
			calls.push(input);
			store.setState({ imageBusy: true });
			try { return await new Promise((resolve, reject) => { request = { resolve, reject }; }); }
			finally { store.setState({ imageBusy: false }); }
		},
	});
	try {
		await waitFor(() => find("h1")?.textContent.trim() === "图片生成" && editor() && submit() && choice(), "未加载生图工作台");
		await waitState("idle");
		await waitFor(() => find("[data-image-size-fixed]"), "没有直接显示模型的唯一尺寸");
		check(!hasSizeOptions() && sizeButtons().length === 0, "唯一尺寸仍然显示为下拉或选项按钮");
		check(unavailable(addReference()), "文生图模型仍可添加参考图");
		check(unavailable(submit()), "空提示词仍可提交");
		submit().click();
		setText("   ");
		await pause();
		check(unavailable(submit()) && calls.length === 0, "纯空格提示词未禁止提交");

		await setModel(models[1]);
		await waitFor(() => sizeButtons().length === models[1].sizes.length && !unavailable(addReference()), "多尺寸选项或参考图入口未显示");
		check(!hasSizeOptions() && !find("[data-image-size-fixed]"), "多尺寸没有切换至选项按钮");
		check(JSON.stringify(sizeButtons().map(button => button.dataset.imageSize)) === JSON.stringify(models[1].sizes), "尺寸选项未按模型声明显示");
		const preferred = sizeButtons().find(button => button.dataset.imageSize === "1536x1024");
		preferred.click();
		await waitFor(() => preferred.getAttribute("aria-pressed") === "true", "尺寸选中态未更新");
		const input = find('input[type="file"]');
		check(input?.accept.includes("image"), "没有接受图片的参考图输入");
		const transfer = new DataTransfer();
		transfer.items.add(new File([Uint8Array.from(atob(png), char => char.charCodeAt(0))], "reference.png", { type: "image/png" }));
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await waitFor(() => find('img[alt*="参考图"], img[data-image-reference]'), "没有显示参考图预览");
		setText(prompt);
		await waitFor(() => !unavailable(submit()), "已填写的提示词未解锁提交");
		await begin(models[1], "1536x1024", true);
		await checkFailed();

		await setModel(models[0]);
		await waitFor(() => find("[data-image-size-fixed]") && unavailable(addReference()), "切换模型后没有更新尺寸或能力");
		await begin(models[0], "1024x1024", false);
		await checkReady(0);

		await setModel(models[1]);
		const selected = await waitFor(() => find('button[data-image-size="1536x1024"][aria-pressed="true"]'), "返回多尺寸模型后未恢复之前选择的尺寸");
		await begin(models[1], selected.dataset.imageSize, true, true);
		await checkFailed();
		check(stageImages().some(image => image.naturalWidth > 0), "失败后上次生成图片被清空");
		await begin(models[1], selected.dataset.imageSize, true, true);
		await checkReady(1);

		const sidebarOpen = store.getState().sidebarOpen;
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
		check(store.getState().sidebarOpen === sidebarOpen, "生图页快捷键不应改变其他页面的左栏偏好");
		store.getState().setView("gallery");
		await waitFor(() => document.querySelector('main[data-view="gallery"]'), "未能切换到图片库");
		store.getState().setView("imagegen");
		await waitState("ready");
		check(editor().value === prompt && find('img[alt="参考图预览"]'), "切回生图页后草稿或参考图丢失");

		const studio = find(".fw-image-studio");
		studio.style.width = "680px";
		try {
			const form = find(".fw-studio-form").getBoundingClientRect();
			const canvas = stage().getBoundingClientRect();
			check(form.bottom <= canvas.top && Math.abs(form.width - studio.clientWidth) < 24, "窄布局的参数栏与画布未纵向排列");
		} finally { studio.style.removeProperty("width"); }
	} finally {
		if (request) resolveCall(new Error("生图测试收尾"));
		store.setState({ generateImages: previous.generateImages, loadImages: previous.loadImages, imageBusy: false });
	}
}

export const imageStudioRegression = `(${verifyImageStudio})(${JSON.stringify({ models, prompt, png: PNG, results, previews: previews.map(image => image.toString("base64")) })})`;
