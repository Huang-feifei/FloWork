/**
 * 工作区文件浏览：按目录懒加载列出条目、读取文件用于预览。
 * 所有路径都必须位于工作区根目录之内。
 */
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

// ----- 文件操作（重命名 / 新建 / 删除 / 移动） -----

/** 校验单个条目名：非空、不含路径分隔符、不是 . / .. */
function assertEntryName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("名称不能为空");
	if (trimmed === "." || trimmed === "..") throw new Error("名称无效");
	if (/[\\/]/.test(trimmed)) throw new Error("名称不能包含路径分隔符");
	if (/[\u0000-\u001f]/.test(trimmed)) throw new Error("名称包含非法字符");
	return trimmed;
}

async function pathExists(abs: string): Promise<boolean> {
	try {
		await stat(abs);
		return true;
	} catch {
		return false;
	}
}

/** 重命名（同目录改名）；目标已存在时拒绝 */
export async function renameWorkspaceEntry(root: string, path: string, name: string): Promise<{ path: string }> {
	const { abs, rel } = resolveInside(root, path);
	if (!rel) throw new Error("不能重命名工作区根目录");
	const target = assertEntryName(name);
	const parent = dirname(rel);
	const nextRel = parent === "." ? target : `${parent.split(sep).join("/")}/${target}`;
	const next = resolveInside(root, nextRel).abs;
	if (next === abs) return { path: rel };
	if (await pathExists(next)) throw new Error(`「${target}」已存在`);
	await rename(abs, next);
	invalidateSearchIndex(root);
	return { path: nextRel };
}

/** 新建文件或文件夹；path 为工作区内的相对路径 */
export async function createWorkspaceEntry(root: string, path: string, type: "file" | "dir"): Promise<{ path: string }> {
	const { abs, rel } = resolveInside(root, path);
	if (!rel) throw new Error("名称不能为空");
	assertEntryName(rel.split("/").pop() ?? "");
	if (await pathExists(abs)) throw new Error(`「${rel.split("/").pop()}」已存在`);
	if (type === "dir") {
		await mkdir(abs, { recursive: false });
	} else {
		await mkdir(dirname(abs), { recursive: true });
		// wx：已存在则失败，避免覆盖已有文件
		await writeFile(abs, "", { flag: "wx" });
	}
	invalidateSearchIndex(root);
	return { path: rel };
}

/** 删除：优先移入系统回收站（trash 由桌面版外壳注入），否则永久删除 */
export async function deleteWorkspaceEntry(
	root: string,
	path: string,
	trash?: (abs: string) => Promise<void>,
): Promise<{ trashed: boolean }> {
	const { abs, rel } = resolveInside(root, path);
	if (!rel) throw new Error("不能删除工作区根目录");
	if (trash) {
		await trash(abs);
		invalidateSearchIndex(root);
		return { trashed: true };
	}
	await rm(abs, { recursive: true, force: false });
	invalidateSearchIndex(root);
	return { trashed: false };
}

/** 移动到工作区内的另一个目录（targetDir 为相对路径，"" 表示根） */
export async function moveWorkspaceEntry(root: string, path: string, targetDir: string): Promise<{ path: string }> {
	const { abs, rel } = resolveInside(root, path);
	if (!rel) throw new Error("不能移动工作区根目录");
	const target = resolveInside(root, targetDir);
	if (target.rel === rel || target.rel.startsWith(`${rel}/`)) throw new Error("不能移动到自身或其子目录");
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(target.abs);
	} catch {
		throw new Error(`目标目录不存在：${targetDir || "（工作区根目录）"}`);
	}
	if (!info.isDirectory()) throw new Error(`不是目录：${targetDir}`);
	const name = rel.split("/").pop() as string;
	const nextRel = target.rel ? `${target.rel}/${name}` : name;
	if (nextRel === rel) return { path: rel };
	const next = resolveInside(root, nextRel).abs;
	if (await pathExists(next)) throw new Error(`目标目录已有「${name}」`);
	await rename(abs, next);
	invalidateSearchIndex(root);
	return { path: nextRel };
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
