/** 从官方 npm 分发源组装已签名放行的依赖树；不依赖用户安装 Node/npm。 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KernelManifest } from "@shared/kernel";
import { extractNpmPackage, validateInstalledLayout } from "./kernel-package";

export async function requestNpm(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response> {
	for (let redirects = 0; redirects < 6; redirects++) {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.hostname !== "registry.npmjs.org" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
			throw new Error("仅允许从官方 npm HTTPS 源下载已批准的包");
		}
		const response = await fetcher(url, { redirect: "manual", signal, headers: { "User-Agent": "FloWork-Kernel-Updater", Accept: "application/octet-stream" } });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error("npm 下载跳转缺少地址");
			url = new URL(location, url).href;
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`官方 npm 下载失败（HTTP ${response.status}）`);
		}
		return response;
	}
	throw new Error("npm 下载跳转次数过多");
}

/** archiveDirectory 与 destination 必须是调用方新建、未使用过的暂存目录。 */
export async function installApprovedRuntime(options: {
	manifest: KernelManifest;
	adapterEntry: string;
	archiveDirectory: string;
	destination: string;
	fetch?: typeof fetch;
	onProgress?: (downloaded: number, total: number) => void;
	onVerifying?: () => void;
}): Promise<void> {
	const { manifest, destination, archiveDirectory } = options;
	await mkdir(archiveDirectory, { recursive: true });
	await mkdir(destination, { recursive: true });
	await copyFile(options.adapterEntry, join(destination, "pi-worker.js"));
	await writeFile(join(destination, "package.json"), JSON.stringify({ name: "flowork-approved-pi", private: true, type: "module", version: manifest.version }));
	const total = manifest.packages.reduce((sum, p) => sum + p.size, 0);
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]);
	let next = 0;
	let downloaded = 0;
	let lastProgress = 0;
	let failure: unknown;
	// 下载任务失败时等待所有流关闭后再交还清理目录，避免 Windows 上残留占用。
	await Promise.all(Array.from({ length: Math.min(6, manifest.packages.length) }, async () => {
		try {
			while (next < manifest.packages.length && !signal.aborted) {
				const index = next++;
				const p = manifest.packages[index]!;
				const response = await requestNpm(p.url, signal, options.fetch);
				if (!response.body) throw new Error("npm 下载响应为空");
				const hash = createHash("sha512");
				const output = await open(join(archiveDirectory, `${index}.tgz`), "wx");
				let size = 0;
				try {
					for await (const chunk of response.body) {
						size += chunk.byteLength;
						if (size > p.size) throw new Error("下载的 npm 包大小超出签名清单限制");
						hash.update(chunk);
						await output.writeFile(chunk);
						downloaded += chunk.byteLength;
						if (Date.now() - lastProgress > 150) { options.onProgress?.(downloaded, total); lastProgress = Date.now(); }
					}
				} finally { await output.close(); }
				if (size !== p.size || `sha512-${hash.digest("base64")}` !== p.integrity) throw new Error(`npm 包 ${p.name} 下载不完整或 SHA-512 校验失败`);
			}
		} catch (error) { failure ??= error; controller.abort(error); }
	}));
	if (failure) throw failure;
	if (signal.aborted) throw new Error("npm 下载超时");
	options.onProgress?.(downloaded, total);
	options.onVerifying?.();
	const budget = { files: 0, bytes: 0 };
	for (const [index, p] of manifest.packages.entries()) {
		const path = join(destination, p.path);
		await mkdir(path, { recursive: true });
		try { await extractNpmPackage(join(archiveDirectory, `${index}.tgz`), path, budget); }
		catch (error) { throw new Error(`npm 包 ${p.name}@${p.version} 解包失败：${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
	}
	await validateInstalledLayout(destination, manifest);
}
