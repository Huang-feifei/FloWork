/** 完整内核包仅包含固定依赖，不从网络替换 FloWork 的 Worker 适配代码。 */
import { createReadStream } from "node:fs";
import { finished } from "node:stream/promises";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";
import type { ArchiveKernelManifest } from "@shared/kernel";
import { validateInstalledLayout } from "./kernel-package";

/** 先完整扫描归档，再解包到新目录；禁止链接、路径别名和未声明的依赖。 */
export async function extractKernelRuntime(archive: string, destination: string, manifest: ArchiveKernelManifest, adapterEntry: string): Promise<void> {
	let error: string | undefined, files = 0, bytes = 0;
	const paths = new Map<string, { path: string; directory: boolean }>();
	const packages = manifest.packages.map(p => p.path).sort((a, b) => b.length - a.length);
	const containers = new Set<string>();
	for (const path of packages) {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) containers.add(parts.slice(0, i).join("/"));
	}
	const parser = tar.t({
		strict: true,
		onReadEntry(entry) {
			const path = entry.path.replace(/\/$/, ""), parts = path.split("/");
			const directory = entry.type === "Directory";
			if (parts[0] !== "runtime" || /[\\:\x00-\x1f]/.test(path) ||
				parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) error ??= "内核包包含不安全的路径";
			if (!directory && entry.type !== "File") error ??= "内核包不允许包含链接或特殊文件";
			if (entry.mode && (entry.mode & 0o6000)) error ??= "内核包不允许特殊权限";
			const relative = parts.slice(1).join("/");
			const owner = packages.find(p => relative.startsWith(`${p}/`));
			const allowed = (!relative && directory) || (relative === "package.json" && !directory) ||
				(containers.has(relative) && directory) || (owner && !relative.slice(owner.length + 1).split("/").includes("node_modules"));
			if (!allowed || parts.includes(".bin")) error ??= "内核包包含未声明的依赖或不允许的文件";
			const canonical = path.toLowerCase();
			if (paths.has(canonical)) error ??= "内核包包含重复路径或大小写冲突";
			paths.set(canonical, { path, directory });
			bytes += entry.size;
			if (++files > 150_000 || bytes > 2 * 1024 * 1024 * 1024) error ??= "内核包解压总量超出限制";
			if (error) parser.abort(new Error(error));
		},
	});
	const input = createReadStream(archive);
	try {
		await new Promise<void>((resolve, reject) => {
			parser.once("end", resolve); parser.once("error", reject); input.once("error", reject);
			input.pipe(parser);
		});
	} finally { input.destroy(); await finished(input).catch(() => undefined); }
	const ancestors = new Map<string, string>();
	for (const { path } of paths.values()) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const prefix = parts.slice(0, i).join("/"), canonical = prefix.toLowerCase();
			const ancestor = paths.get(canonical), implicit = ancestors.get(canonical);
			if ((ancestor && (!ancestor.directory || ancestor.path !== prefix)) || (implicit && implicit !== prefix)) error ??= "内核包包含冲突的父目录";
			ancestors.set(canonical, prefix);
		}
	}
	if (error) throw new Error(error);
	await mkdir(destination);
	await tar.x({ file: archive, cwd: destination, strip: 1, strict: true, preservePaths: false, preserveOwner: false, noMtime: true });
	// 始终使用目标应用内置的适配层，完整包不包含可替换适配代码。
	await copyFile(adapterEntry, join(destination, "pi-worker.js"));
	await validateInstalledLayout(destination, manifest);
}
