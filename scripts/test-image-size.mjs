import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/core/image-gen.ts"], bundle: true, platform: "node", format: "esm", write: false, alias: { "@shared": resolve("src/shared") } });
const { generateImages, listImageModels } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
await mkdir("out", { recursive: true });
const root = await mkdtemp("out/image-size-test-");
const oldDir = process.env.FLOWORK_PI_AGENT_DIR;
const realFetch = globalThis.fetch;
try {
	process.env.FLOWORK_PI_AGENT_DIR = resolve(root);
	await writeFile(join(root, "models.json"), JSON.stringify({ providers: { demo: {
		baseUrl: "https://example.invalid/v1", apiKey: "offline-fixture", imageModels: [
			{ id: "preset", sizes: ["1024x1024", "auto"], edits: true }, { id: "default", edits: true },
		],
	} } }));
	const calls = [];
	globalThis.fetch = async (url, options) => {
		assert.match(url, /^https:\/\/example\.invalid\/v1\/images\/(generations|edits)$/);
		calls.push(options.body instanceof FormData ? Object.fromEntries(options.body) : JSON.parse(options.body));
		return Response.json({ data: [{ b64_json: Buffer.from("isolated fixture").toString("base64") }] });
	};
	const models = await listImageModels();
	assert.deepEqual(models[0].sizes, ["1024x1024", "auto"]);
	assert.deepEqual(models[1].sizes, []);
	const base = { model: "demo/preset", prompt: "隔离测试" };
	const reference = { dataBase64: "AA==", mimeType: "image/png" };
	const [custom] = await generateImages({ ...base, size: "1920 × 1080" });
	assert.equal(calls.at(-1).size, "1920x1080");
	assert.equal(custom.size, "1920x1080");
	await generateImages({ ...base, size: "1080*1920", reference });
	assert.equal(calls.at(-1).size, "1080x1920");
	assert.ok(calls.at(-1).image);
	await generateImages({ ...base, size: "auto" });
	assert.equal(calls.at(-1).size, "auto");
	for (const model of models) {
		const [automatic] = await generateImages({ ...base, model: model.key });
		assert.ok(!Object.hasOwn(calls.at(-1), "size"));
		assert.equal(automatic.size, "服务商默认");
		await generateImages({ ...base, model: model.key, size: " ", reference });
		assert.ok(!Object.hasOwn(calls.at(-1), "size"));
	}
	const before = calls.length;
	await assert.rejects(generateImages({ ...base, size: "0x1080" }), /尺寸格式无效/);
	assert.equal(calls.length, before);
	console.log("图片尺寸回归通过：预设、自定义文生图与图生图、默认省略尺寸、无效格式拦截。");
} finally {
	globalThis.fetch = realFetch;
	if (oldDir === undefined) delete process.env.FLOWORK_PI_AGENT_DIR;
	else process.env.FLOWORK_PI_AGENT_DIR = oldDir;
	await rm(root, { recursive: true, force: true });
}
