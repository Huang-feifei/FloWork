/**
 * 图片生成：读 models.json 里各供应商声明的图片模型，调用 OpenAI 兼容的
 * /images/generations（纯文生图）与 /images/edits（带参考图），把结果落到本机缓存目录。
 *
 * - 缓存目录：<pi agent dir>/images，同目录下有一份 index.json 记录提示词、模型、尺寸等元数据
 *   （图片文件本身不含这些信息，删除/列举都靠这份索引）；
 * - 凭据优先级与设置页一致：models.json 的 apiKey（支持 $环境变量名）→ 供应商相关的环境变量；
 * - 不写回任何配置，也不改动项目文件。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GeneratedImage, ImageModelInfo } from "@shared/protocol";
import { getPiAgentDir } from "./paths";

/** 单张图片的上限：接口返回超过这个大小就拒绝（避免把内存撑爆） */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** 缓存目录里最多保留多少张；超出时按时间删最旧的 */
const MAX_CACHED_IMAGES = 200;

interface ProviderConfig {
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	imageEnabled?: boolean;
	imageModels?: Array<{ id?: string; name?: string; sizes?: string[]; edits?: boolean; price?: number }>;
}

interface ImageIndex {
	version: 1;
	items: GeneratedImage[];
}

export function imageCacheDir(): string {
	return join(getPiAgentDir(), "images");
}

function indexPath(): string {
	return join(imageCacheDir(), "index.json");
}

/** 读取 models.json；不存在或解析失败时当作没有自定义供应商 */
async function readProviders(): Promise<Record<string, ProviderConfig>> {
	try {
		const text = await readFile(join(getPiAgentDir(), "models.json"), "utf8");
		const parsed = JSON.parse(text) as { providers?: Record<string, ProviderConfig> };
		return parsed.providers ?? {};
	} catch {
		return {};
	}
}

/** 解析 apiKey：支持 `$环境变量名`，其余按字面量 */
function resolveKey(provider: string, raw: string | undefined): string | undefined {
	if (!raw) {
		const env =
			process.env[`${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`] ??
			(provider === "openai" ? process.env.OPENAI_API_KEY : undefined);
		return env && env.trim() ? env.trim() : undefined;
	}
	const value = raw.trim();
	if (value.startsWith("$")) {
		const name = value.slice(1).trim();
		const env = process.env[name];
		if (!env) throw new Error(`环境变量 ${name} 没有值，无法调用图片接口`);
		return env.trim();
	}
	if (value.startsWith("!")) throw new Error("图片生成暂不支持用命令读取 API Key，请在自定义端点里直接填写或改成 $环境变量名");
	return value;
}

/** 已配置的图片模型（供生成工作台的下拉与设置页展示） */
export async function listImageModels(): Promise<ImageModelInfo[]> {
	const providers = await readProviders();
	const out: ImageModelInfo[] = [];
	for (const [provider, config] of Object.entries(providers)) {
		if (config.imageEnabled === false) continue;
		for (const model of config.imageModels ?? []) {
			const id = String(model.id ?? "").trim();
			if (!id) continue;
			out.push({
				key: `${provider}/${id}`,
				provider,
				id,
				name: String(model.name ?? id),
				sizes: (model.sizes ?? ["1024x1024"]).map(String),
				edits: model.edits === true,
				price: typeof model.price === "number" ? model.price : undefined,
			});
		}
	}
	return out;
}

async function readIndex(): Promise<ImageIndex> {
	try {
		const text = await readFile(indexPath(), "utf8");
		const parsed = JSON.parse(text) as Partial<ImageIndex>;
		return { version: 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
	} catch {
		return { version: 1, items: [] };
	}
}

async function writeIndex(index: ImageIndex): Promise<void> {
	await mkdir(imageCacheDir(), { recursive: true });
	await writeFile(indexPath(), `${JSON.stringify(index, null, "\t")}\n`, "utf8");
}

/** 生成记录（新→旧） */
export async function listImages(): Promise<GeneratedImage[]> {
	const index = await readIndex();
	return [...index.items].sort((a, b) => b.createdAt - a.createdAt);
}

/** 图片内容（base64，不带 data URL 前缀）；id 必须存在于索引里 */
export async function readImage(id: string): Promise<{ id: string; mimeType: string; dataBase64: string; bytes: number }> {
	const index = await readIndex();
	const item = index.items.find((i) => i.id === id);
	if (!item) throw new Error("这张图片已经不在缓存里了");
	const data = await readFile(join(imageCacheDir(), item.id));
	return {
		id,
		mimeType: item.id.endsWith(".jpg") || item.id.endsWith(".jpeg") ? "image/jpeg" : "image/png",
		dataBase64: data.toString("base64"),
		bytes: data.byteLength,
	};
}

export async function removeImage(id: string): Promise<void> {
	const index = await readIndex();
	const item = index.items.find((i) => i.id === id);
	if (!item) return;
	await rm(join(imageCacheDir(), item.id), { force: true });
	index.items = index.items.filter((i) => i.id !== id);
	await writeIndex(index);
}

export async function clearImages(): Promise<{ removed: number }> {
	const index = await readIndex();
	let removed = 0;
	for (const item of index.items) {
		await rm(join(imageCacheDir(), item.id), { force: true });
		removed += 1;
	}
	await writeIndex({ version: 1, items: [] });
	return { removed };
}

/** 新文件名：时间戳 + 随机串，避免同名覆盖 */
function newId(mimeType: string): string {
	const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

/** 接口可能返回 b64_json，也可能返回一个临时 url；两种都支持 */
async function bytesOf(entry: { b64_json?: string; url?: string }): Promise<{ data: Buffer; mimeType: string }> {
	if (entry.b64_json) {
		const data = Buffer.from(entry.b64_json, "base64");
		if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("接口返回的图片超过 16MB，已拒绝");
		return { data, mimeType: "image/png" };
	}
	if (entry.url) {
		const response = await fetch(entry.url);
		if (!response.ok) throw new Error(`下载生成的图片失败：HTTP ${response.status}`);
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("接口返回的图片超过 16MB，已拒绝");
		return { data: buffer, mimeType: response.headers.get("content-type") ?? "image/png" };
	}
	throw new Error("接口没有返回图片数据");
}

export interface GenerateInput {
	model?: string;
	prompt: string;
	size?: string;
	quality?: "standard" | "hd";
	count?: number;
	reference?: { dataBase64: string; mimeType: string };
}

/** 生成图片：结果写入缓存并追加到索引，返回这次的生成记录 */
export async function generateImages(input: GenerateInput): Promise<GeneratedImage[]> {
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("提示词不能为空");

	const models = await listImageModels();
	const chosen = input.model ? models.find((m) => m.key === input.model) : models[0];
	if (!chosen) {
		throw new Error("还没有配置图片模型：到「设置 › 自定义端点」里给某个供应商添加图片模型");
	}
	if (input.reference && !chosen.edits) {
		throw new Error(`${chosen.id} 没有开启参考图（图生图），去掉参考图或换一个模型`);
	}

	const providers = await readProviders();
	const config = providers[chosen.provider];
	if (!config?.baseUrl) throw new Error(`供应商 ${chosen.provider} 缺少 Base URL`);
	const key = resolveKey(chosen.provider, config.apiKey);
	if (!key) throw new Error(`供应商 ${chosen.provider} 没有可用的 API Key`);

	const base = config.baseUrl.replace(/\/+$/, "");
	const count = Math.min(Math.max(input.count ?? 1, 1), 4);
	const size = input.size ?? chosen.sizes[0] ?? "1024x1024";

	let entries: Array<{ b64_json?: string; url?: string }>;
	if (input.reference) {
		const form = new FormData();
		form.append("model", chosen.id);
		form.append("prompt", prompt);
		form.append("n", String(count));
		form.append("size", size);
		form.append("image", new Blob([Buffer.from(input.reference.dataBase64, "base64")], { type: input.reference.mimeType }), "reference.png");
		const response = await fetch(`${base}/images/edits`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: form,
		});
		if (!response.ok) throw new Error(`生成失败：HTTP ${response.status} ${await response.text().catch(() => "")}`.trim());
		entries = ((await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> }).data ?? [];
	} else {
		const response = await fetch(`${base}/images/generations`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ model: chosen.id, prompt, n: count, size, ...(input.quality ? { quality: input.quality } : {}) }),
		});
		if (!response.ok) throw new Error(`生成失败：HTTP ${response.status} ${await response.text().catch(() => "")}`.trim());
		entries = ((await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> }).data ?? [];
	}
	if (entries.length === 0) throw new Error("接口没有返回任何图片");

	await mkdir(imageCacheDir(), { recursive: true });
	const index = await readIndex();
	const created: GeneratedImage[] = [];
	for (const entry of entries) {
		const { data, mimeType } = await bytesOf(entry);
		const id = newId(mimeType);
		await writeFile(join(imageCacheDir(), id), data);
		const record: GeneratedImage = {
			id,
			prompt,
			model: chosen.key,
			size,
			quality: input.quality ?? "standard",
			bytes: data.byteLength,
			createdAt: Date.now(),
			edited: Boolean(input.reference),
		};
		index.items.push(record);
		created.push(record);
	}

	// 超出上限时删最旧的
	index.items.sort((a, b) => a.createdAt - b.createdAt);
	while (index.items.length > MAX_CACHED_IMAGES) {
		const oldest = index.items.shift();
		if (oldest) await rm(join(imageCacheDir(), oldest.id), { force: true });
	}
	await writeIndex(index);

	return created;
}

/** 缓存占用（设置页与图片库底部展示） */
export async function imageCacheStats(): Promise<{ count: number; bytes: number }> {
	const index = await readIndex();
	const files = await readdir(imageCacheDir()).catch(() => [] as string[]);
	const onDisk = new Set(files);
	const items = index.items.filter((i) => onDisk.has(i.id));
	return { count: items.length, bytes: items.reduce((sum, i) => sum + i.bytes, 0) };
}
