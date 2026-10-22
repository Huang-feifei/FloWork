/** 生产 CSP 下的真实 Electron Markdown 图片回归；隔离 HOME / agent / data，不调用模型。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";
import { root } from "./runtime.mjs";

const work = mkdtempSync(join(tmpdir(), "flowork-markdown-"));
try {
	for (const dir of ["home", "data", "agent", "project/docs", "project/images", "outside"]) mkdirSync(join(work, dir), { recursive: true });
	const project = join(work, "project");
	writeFileSync(join(project, "docs/README.md"), '![local](../images/a%20b.png)\n\n<img src="../images/shape.svg" width="12">\n\n![missing](missing.png)\n\n```js\nconst number = 42;\n```');
	writeFileSync(join(project, "images/a b.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=", "base64"));
	writeFileSync(join(project, "images/shape.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="green"/></svg>');
	writeFileSync(join(project, "images/large.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
	writeFileSync(join(work, "outside/secret.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
	// Windows 无需创建文件 symlink 的管理员权限：目录 junction 同样覆盖真实路径越界。
	symlinkSync(join(work, "outside"), join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
	const steps = [{ js: `(async () => {
		const store = window.__floworkStore;
		if (!store) throw new Error("未加载截图测试桥");
		const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content;
		if (!csp?.includes("img-src 'self' data: blob:") || /img-src[^;]*https?:/.test(csp)) throw new Error("未使用受限的生产 CSP");
		if (document.querySelector('link[rel="modulepreload"][href*="code-highlight-"]')) throw new Error("未打开代码块时提前加载高亮依赖");
		const root = ${JSON.stringify(project)};
		const call = (path) => window.floworkTransport.request("workspace.image", {root, path}).then(JSON.parse);
		for (const path of ["../outside/secret.svg", "escape/secret.svg", "docs/README.md", "images/large.png"]) {
			let rejected = false; try { await call(path); } catch { rejected = true; }
			if (!rejected) throw new Error("未拒绝图片路径：" + path);
		}
		store.setState({view:"chat",activeProjectId:"markdown-fixture",cwd:root,handleId:null,state:null,preview:"docs/README.md",previewHostId:null,connecting:false,railVisible:false,messages:[]});
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const imgs = [...document.querySelectorAll('.markdown-doc img')];
			if (imgs.length === 2 && imgs.every(i => i.src.startsWith('data:image/') && i.complete && i.naturalWidth > 0)
				&& document.querySelector('.markdown-doc')?.textContent.includes('图片不可用')
				&& document.querySelector('.markdown-doc pre code span')
				&& document.querySelector('link[rel="modulepreload"][href*="code-highlight-"]')) return;
			await new Promise(r => setTimeout(r, 100));
		}
		throw new Error("生产 CSP 下 Markdown 图片未完成加载：" + document.querySelector('.markdown-doc')?.innerHTML);
	})()`, wait: 50 }];
	const stepsFile = join(work, "steps.json");
	writeFileSync(stepsFile, JSON.stringify(steps));
	const env = { ...process.env, HOME: join(work, "home"), USERPROFILE: join(work, "home"), FLOWORK_DATA_DIR: join(work, "data"),
		FLOWORK_PI_AGENT_DIR: join(work, "agent"), PI_CODING_AGENT_DIR: join(work, "agent"), PI_SKIP_VERSION_CHECK: "1",
		SHOT_STEPS_FILE: stepsFile, SHOT_OUT: join(work, "markdown.png"), SHOT_WAIT: "500" };
	delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
	const r = spawnSync(electron, [root, "--ui-screenshot"], { cwd: project, env, encoding: "utf8", timeout: 45000 });
	assert.equal(r.status, 0, `${r.error ?? ""}\n${r.stdout}\n${r.stderr}`);
	console.log("MARKDOWN DESKTOP REGRESSION OK（生产 CSP、PNG / SVG 实际解码、缺图提示、越界 / junction / 大小 / 格式限制、高亮按需加载）");
} finally {
	rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
