/**
 * 开发辅助：在隔离后端测试本地预览服务（preview.serve）。
 *   node scripts/test-preview.mjs（需先 npm run build && npm run build:test）
 *
 * 覆盖：静态文件与目录 index.html、MIME、404、路径越界、跨站与伪造 Host 拦截、方法限制、端口复用。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { connect, createChecks, startIsolatedBackend } from "./lib/isolated-backend.mjs";

function request(url, { method = "GET", headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method, headers }, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function main(checks) {
	const backend = await startIsolatedBackend({ label: "preview" });
	let client;
	try {
		const base = join(backend.root, "fixtures");
		const other = join(backend.root, "other");
		for (const dir of [base, other, join(base, "sub")]) mkdirSync(dir, { recursive: true });
		// 根目录之外的“机密”文件，用于验证越界被拦
		writeFileSync(join(backend.root, "secret.txt"), "TOP SECRET");
		writeFileSync(join(base, "index.html"), "<h1>hello preview</h1>");
		writeFileSync(join(base, "style.css"), "body{color:red}");
		writeFileSync(join(base, "app.js"), "export const x = 1;");
		writeFileSync(join(base, "sub", "index.html"), "<h1>sub</h1>");
		writeFileSync(join(other, "index.html"), "<h1>other</h1>");

		client = await connect(await backend.waitReady());
		const { origin } = await client.call("preview.serve", { root: base });
		checks.check("返回回环地址与随机端口", /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));

		const root = await request(`${origin}/`);
		checks.check("根路径默认 index.html", root.status === 200 && root.body.includes("hello preview"));
		checks.check("HTML 的 MIME 带 charset", String(root.headers["content-type"]).startsWith("text/html"));

		const sub = await request(`${origin}/sub/`);
		checks.check("子目录默认 index.html", sub.status === 200 && sub.body.includes("sub"));

		const css = await request(`${origin}/style.css`);
		checks.check("静态资源按扩展名给 MIME", css.status === 200 && String(css.headers["content-type"]).includes("text/css"));
		const js = await request(`${origin}/app.js`);
		checks.check("ES module 的 MIME 正确", js.status === 200 && String(js.headers["content-type"]).includes("javascript"));

		const missing = await request(`${origin}/nope.html`);
		checks.check("不存在的文件返回 404", missing.status === 404);

		const traversal = await request(`${origin}/%2e%2e/secret.txt`);
		checks.check("编码的目录穿越取不到根外文件", traversal.status !== 200 && !traversal.body.includes("SECRET"));

		const crossSite = await request(`${origin}/index.html`, { headers: { "sec-fetch-site": "cross-site" } });
		checks.check("跨站请求被拒（防 DNS rebinding）", crossSite.status === 403);

		const foreignHost = await request(`${origin}/index.html`, { headers: { Host: "evil.example.com" } });
		checks.check("非本机 Host 被拒", foreignHost.status === 403);

		const post = await request(`${origin}/index.html`, { method: "POST" });
		checks.check("只允许 GET / HEAD", post.status === 405);

		const head = await request(`${origin}/index.html`, { method: "HEAD" });
		checks.check("HEAD 返回头部且无响应体", head.status === 200 && head.body === "" && Number(head.headers["content-length"]) > 0);

		const again = await client.call("preview.serve", { root: base });
		checks.check("同一根目录复用端口", again.origin === origin);
		const otherSite = await client.call("preview.serve", { root: other });
		checks.check("不同根目录各自一个端口", otherSite.origin !== origin);
		const otherRoot = await request(`${otherSite.origin}/`);
		checks.check("第二个根目录互不串台", otherRoot.status === 200 && otherRoot.body.includes("other"));

		// 根目录被删除后不应崩溃，只是 404
		rmSync(other, { recursive: true, force: true });
		const gone = await request(`${otherSite.origin}/`);
		checks.check("根目录消失后返回 404 而非崩溃", gone.status === 404);
	} finally {
		await client?.close();
		await backend.stop();
	}
}

const checks = createChecks();
await main(checks).then(
	() => checks.finish("PREVIEW REGRESSION OK（隔离后端；未调用模型）"),
	(error) => {
		console.error(`PREVIEW REGRESSION FAILED\n${error?.stack ?? error}`);
		process.exitCode = 1;
	},
);
