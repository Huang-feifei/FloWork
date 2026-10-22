/**
 * Markdown 渲染回归：相对图片 / 链接解析、原始 HTML 过滤、GFM 表格与代码块不回归。
 * 用 esbuild 把渲染层模块打成一个 Node 可导入的临时 bundle，不依赖桌面构建产物。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "out");
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(out, "test-markdown-"));
const bundle = join(work, "markdown.mjs");

try {
	await build({
		stdin: {
			contents:
				'export { Markdown } from "./src/renderer/src/components/terminal/Markdown.tsx";\n' +
				'export { MarkdownDocument } from "./src/renderer/src/components/terminal/MarkdownDocument.tsx";\n' +
				'export * from "./src/renderer/src/lib/markdown-url.ts";',
			resolveDir: root,
			loader: "tsx",
		},
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outfile: bundle,
		logLevel: "silent",
		tsconfig: join(root, "tsconfig.renderer.json"),
	});

	const { Markdown, MarkdownDocument, imageMimeType, resolveMarkdownAssetUrl, resolveMarkdownPath } = await import(pathToFileURL(bundle).href);
	const renderDoc = (props) => renderToStaticMarkup(createElement(MarkdownDocument, props));
	const renderTerm = (props) => renderToStaticMarkup(createElement(Markdown, props));

	// 本地相对路径
	assert.equal(resolveMarkdownPath("docs/README.md", "./guide.md#start"), "docs/guide.md");
	assert.equal(resolveMarkdownPath("docs/README.md", "../images/a b.png"), "images/a b.png");
	assert.equal(resolveMarkdownPath("README.md", "/assets/logo.svg"), "assets/logo.svg");
	assert.equal(resolveMarkdownAssetUrl("http://127.0.0.1:1234", "docs/README.md", "../images/a b.png"), "http://127.0.0.1:1234/images/a%20b.png");
	assert.equal(resolveMarkdownAssetUrl(undefined, "docs/README.md", "images/a.png"), "images/a.png");

	// 远程绝对路径、外链与越界
	assert.equal(resolveMarkdownPath("/opt/app/docs/README.md", "../img/logo.png"), "/opt/app/img/logo.png");
	assert.equal(resolveMarkdownPath("/opt/app/README.md", "/static/logo.png"), "/static/logo.png");
	assert.equal(resolveMarkdownPath("README.md", "https://example.com/a.md"), null);
	assert.equal(resolveMarkdownPath("README.md", "//example.com/a.md"), null);
	assert.equal(resolveMarkdownPath("README.md", "#anchor"), null);
	assert.equal(resolveMarkdownPath("README.md", "../../secret.txt"), null);

	assert.equal(imageMimeType("logo.SVG"), "image/svg+xml");
	assert.equal(imageMimeType("notes.txt"), null);

	// 相对图片交给预览服务
	const imageHtml = renderDoc({
		variant: "document",
		text: "![logo](../images/a%20b.png)",
		resolveImage: (src) => resolveMarkdownAssetUrl("http://127.0.0.1:1234", "docs/README.md", src),
	});
	assert.match(imageHtml, /src="http:\/\/127\.0\.0\.1:1234\/images\/a%20b\.png"/);
	assert.match(imageHtml, /alt="logo"/);

	// 原始 HTML：保留常见排版，过滤脚本 / 事件 / 危险 URL
	const html = renderDoc({
		variant: "document",
		text: [
			'<div align="center"><img src="asset.png" width="120" onerror="alert(1)"><a href="javascript:alert(1)">bad</a></div>',
			"",
			"<script>alert(1)</script>",
			"",
			"| A | B |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"```ts",
			"const x = 1;",
			"```",
		].join("\n"),
	});
	assert.match(html, /align="center"/);
	assert.match(html, /width="120"/);
	assert.match(html, /<table>/);
	assert.match(html, /const x = 1;/);
	assert.doesNotMatch(html, /<script/i);
	assert.doesNotMatch(html, /onerror/i);
	assert.doesNotMatch(html, /javascript:/i);

	// 对话里的终端风格不解析原始 HTML，避免把 HTML 当页面注入
	const terminalHtml = renderTerm({ text: "<script>alert(1)</script>" });
	assert.doesNotMatch(terminalHtml, /<script/i);

	console.log("MARKDOWN REGRESSION OK");
} finally {
	rmSync(work, { recursive: true, force: true });
}
