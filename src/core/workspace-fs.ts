/**
 * 工作区文件浏览：按目录懒加载列出条目、读取文件用于预览。
 * 所有路径都必须位于工作区根目录之内。
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FilePreview, WorkspaceDirListing, WorkspaceEntry } from "@shared/protocol";

/** 即使没有 .gitignore 也按“忽略”置灰显示的目录 */
const ALWAYS_DIMMED = ["node_modules/", ".git/", "out/", "dist/", "build/", ".next/", "__pycache__/", ".venv/", "target/"];
const MAX_PREVIEW_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

const ignoreCache = new Map<string, { mtimeMs: number; matcher: Ignore }>();

async function getIgnore(root: string): Promise<Ignore> {
	const gitignore = join(root, ".gitignore");
	let mtimeMs = 0;
	let text = "";
	try {
		mtimeMs = (await stat(gitignore)).mtimeMs;
		text = await readFile(gitignore, "utf8");
	} catch {
		// 没有 .gitignore
	}
	const cached = ignoreCache.get(root);
	if (cached && cached.mtimeMs === mtimeMs) return cached.matcher;
	const matcher = ignore().add(ALWAYS_DIMMED).add(text);
	ignoreCache.set(root, { mtimeMs, matcher });
	return matcher;
}

/** 解析并校验路径位于根目录之内，返回绝对路径与相对路径（/ 分隔） */
export function resolveInside(root: string, path: string | undefined): { abs: string; rel: string } {
	const rootAbs = resolve(root);
	const abs = resolve(rootAbs, path ?? ".");
	const rel = relative(rootAbs, abs);
	// 跨盘符时 relative 返回绝对路径；向上越界时以 .. 开头
	if (isAbsolute(rel) || rel.split(sep)[0] === "..") {
		throw new Error(`路径不在工作区内：${path}`);
	}
	return { abs, rel: rel.split(sep).join("/") };
}

export async function listWorkspaceDir(root: string, path?: string): Promise<WorkspaceDirListing> {
	const { abs, rel } = resolveInside(root, path);
	const matcher = await getIgnore(resolve(root));
	const dirents = await readdir(abs, { withFileTypes: true });
	const entries: WorkspaceEntry[] = [];
	for (const d of dirents) {
		const isDir = d.isDirectory();
		if (!isDir && !d.isFile() && !d.isSymbolicLink()) continue;
		const entryRel = rel ? `${rel}/${d.name}` : d.name;
		let size: number | undefined;
		if (!isDir) {
			try {
				size = (await stat(join(abs, d.name))).size;
			} catch {
				size = undefined;
			}
		}
		entries.push({
			name: d.name,
			path: entryRel,
			type: isDir ? "dir" : "file",
			size,
			ignored: matcher.ignores(isDir ? `${entryRel}/` : entryRel),
		});
	}
	entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	return { path: rel, entries };
}

export async function readWorkspaceFile(root: string, path: string): Promise<FilePreview> {
	const { abs, rel } = resolveInside(root, path);
	const info = await stat(abs);
	if (!info.isFile()) throw new Error(`不是文件：${path}`);
	const handle = await open(abs, "r");
	try {
		const length = Math.min(info.size, MAX_PREVIEW_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, 0);
		const binary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
		return {
			path: rel,
			absolutePath: abs,
			size: info.size,
			mtime: info.mtimeMs,
			binary,
			truncated: info.size > MAX_PREVIEW_BYTES,
			text: binary ? "" : buffer.toString("utf8"),
		};
	} finally {
		await handle.close();
	}
}
