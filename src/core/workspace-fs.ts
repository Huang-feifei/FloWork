/**
 * 工作区文件浏览：按目录懒加载列出条目、读取文件用于预览。
 * 所有路径都必须位于工作区根目录之内。
 */
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import {
	type FilePreview,
	type FileSearchResult,
	WRITE_CONFLICT_PREFIX,
	type WorkspaceDirListing,
	type WorkspaceEntry,
} from "@shared/protocol";

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

export async function writeWorkspaceFile(
	root: string,
	path: string,
	content: string,
	expectedMtime?: number,
): Promise<FilePreview> {
	const { abs } = resolveInside(root, path);
	if (expectedMtime !== undefined) {
		let current: number | undefined;
		try {
			current = (await stat(abs)).mtimeMs;
		} catch {
			current = undefined;
		}
		// mtime 精度在不同文件系统上不同，允许 1ms 误差
		if (current === undefined || Math.abs(current - expectedMtime) > 1) {
			throw new Error(`${WRITE_CONFLICT_PREFIX}文件在你打开之后已被修改（可能是 AI 或其他程序），为避免覆盖已取消保存`);
		}
	}
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content, "utf8");
	invalidateSearchIndex(root);
	return readWorkspaceFile(root, path);
}

// ----- 全项目文件搜索 -----

const MAX_INDEXED_FILES = 50_000;
const INDEX_TTL_MS = 15_000;
const indexCache = new Map<string, { at: number; files: string[]; truncated: boolean }>();

async function buildIndex(root: string): Promise<{ files: string[]; truncated: boolean }> {
	const rootAbs = resolve(root);
	const matcher = await getIgnore(rootAbs);
	const files: string[] = [];
	const queue: string[] = [""];
	let truncated = false;
	while (queue.length > 0) {
		const rel = queue.shift() as string;
		let dirents: import("node:fs").Dirent[];
		try {
			dirents = await readdir(rel ? join(rootAbs, rel) : rootAbs, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const d of dirents) {
			const entryRel = rel ? `${rel}/${d.name}` : d.name;
			if (d.isDirectory()) {
				if (!matcher.ignores(`${entryRel}/`)) queue.push(entryRel);
			} else if (d.isFile() && !matcher.ignores(entryRel)) {
				files.push(entryRel);
				if (files.length >= MAX_INDEXED_FILES) {
					truncated = true;
					return { files, truncated };
				}
			}
		}
	}
	return { files, truncated };
}

/** 子序列匹配得分：连续、单词开头得分更高；不匹配返回 -1 */
function subsequenceScore(text: string, q: string): number {
	let score = 0;
	let from = 0;
	let prev = -2;
	for (const ch of q) {
		const found = text.indexOf(ch, from);
		if (found < 0) return -1;
		if (found === prev + 1) score += 8;
		const before = text[found - 1];
		if (found === 0 || before === "/" || before === "-" || before === "_" || before === "." || before === " ") score += 6;
		prev = found;
		from = found + 1;
	}
	return score;
}

/**
 * 模糊匹配路径，按以下优先级：文件名包含查询串 > 路径包含查询串 > 查询是文件名的子序列 > 查询是路径的子序列。
 * 同级内路径越短得分越高。
 */
export function fuzzyScore(path: string, query: string): number {
	const p = path.toLowerCase();
	const q = query.toLowerCase().replace(/\s+/g, "");
	if (!q) return 0;
	const baseStart = p.lastIndexOf("/") + 1;
	const base = p.slice(baseStart);
	const lengthPenalty = p.length * 0.1;
	const inBase = base.indexOf(q);
	if (inBase >= 0) return 1000 + (inBase === 0 ? 100 : 0) - base.length - lengthPenalty;
	if (p.includes(q)) return 700 - lengthPenalty;
	const baseScore = subsequenceScore(base, q);
	if (baseScore >= 0) return 400 + baseScore - lengthPenalty;
	const pathScore = subsequenceScore(p, q);
	return pathScore >= 0 ? pathScore - lengthPenalty : -1;
}

export async function searchWorkspaceFiles(root: string, query: string, limit = 50, fresh = false): Promise<FileSearchResult> {
	const key = resolve(root).toLowerCase();
	let entry = indexCache.get(key);
	if (fresh || !entry || Date.now() - entry.at > INDEX_TTL_MS) {
		const built = await buildIndex(root);
		entry = { at: Date.now(), ...built };
		indexCache.set(key, entry);
	}
	const matches: Array<{ path: string; score: number }> = [];
	for (const path of entry.files) {
		const score = fuzzyScore(path, query);
		if (score >= 0 || (query.trim() === "" && matches.length < limit)) matches.push({ path, score });
	}
	matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
	return { matches: matches.slice(0, limit), total: entry.files.length, truncated: entry.truncated };
}

/** 写入或外部变化后让搜索索引失效 */
export function invalidateSearchIndex(root: string): void {
	indexCache.delete(resolve(root).toLowerCase());
}
