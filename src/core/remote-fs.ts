/**
 * 远程工作区文件操作：全部通过 ssh 执行一段 sh 脚本完成。
 *
 * 与本地实现（workspace-fs.ts）保持同样的输入输出形状，因此上层的
 * workspace.* 接口只需按项目所属主机分流即可。为了让文件名不受空格 /
 * 特殊字符影响，目录列表把文件名做 base64 编码后传输；文件内容同样走 base64。
 */
import { posix } from "node:path";
import ignore, { type Ignore } from "ignore";
import {
	type FilePreview,
	type FileSearchResult,
	type ServerDirListing,
	WRITE_CONFLICT_PREFIX,
	type SshHost,
	type WorkspaceDirListing,
	type WorkspaceEntry,
} from "@shared/protocol";
import { fuzzyScore } from "./workspace-fs";
import { shQuote, sshExec, sshRun } from "./ssh";

const ALWAYS_DIMMED = ["node_modules/", ".git/", "out/", "dist/", "build/", ".next/", "__pycache__/", ".venv/", "target/"];
/** 不读 .gitignore 时用的匹配器（服务器目录场景） */
const ALWAYS_DIMMED_MATCHER = ignore().add(ALWAYS_DIMMED);
const MAX_PREVIEW_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_INDEXED_FILES = 20_000;
const INDEX_TTL_MS = 15_000;

/** 远程路径一律 POSIX 语义；返回绝对路径与相对根目录的路径 */
export function remoteResolve(root: string, path?: string): { abs: string; rel: string } {
	const rootAbs = posix.resolve(root);
	const abs = posix.resolve(rootAbs, path ?? ".");
	const rel = posix.relative(rootAbs, abs);
	if (rel.startsWith("..") || posix.isAbsolute(rel)) throw new Error(`路径不在工作区内：${path}`);
	return { abs, rel };
}

/** 取远程 stat 的 POSIX 兼容写法：GNU stat 失败时回退 BSD stat */
const STAT_MTIME = `stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || echo 0`;

/** 远程是否存在的目录 */
export async function remoteIsDirectory(host: SshHost, path: string): Promise<boolean> {
	const script = `p=${shQuote(path)}\n[ -d "$p" ] && echo yes || echo no`;
	try {
		return (await sshRun(host, script, { timeoutMs: 15_000 })).trim() === "yes";
	} catch (error) {
		// 连接本身失败（主机密钥变化、认证失败等）要让调用方看到真正的原因
		if (error instanceof Error && /^FLOWORK_HOST_KEY_CHANGED:|认证失败|连接被拒绝|连接超时|无法解析/.test(error.message)) throw error;
		return false;
	}
}

// ----- 忽略规则（.gitignore），按根目录缓存 -----

const ignoreCache = new Map<string, { at: number; matcher: Ignore }>();

async function getIgnore(host: SshHost, root: string): Promise<Ignore> {
	const key = `${host.id}\0${root}`;
	const cached = ignoreCache.get(key);
	if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.matcher;
	let text = "";
	try {
		text = await sshRun(host, `cat ${shQuote(posix.join(root, ".gitignore"))} 2>/dev/null || true`, { timeoutMs: 15_000 });
	} catch {
		text = "";
	}
	const matcher = ignore().add(ALWAYS_DIMMED).add(text);
	ignoreCache.set(key, { at: Date.now(), matcher });
	return matcher;
}

export async function listWorkspaceDir(
	host: SshHost,
	root: string,
	path?: string,
	options: { ignore?: boolean } = {},
): Promise<WorkspaceDirListing> {
	const { abs, rel } = remoteResolve(root, path);
	const script = [
		`cd ${shQuote(abs)} 2>/dev/null || { echo "__ERR__"; exit 1; }`,
		"for e in * .*; do",
		'  case "$e" in .|..) continue;; esac',
		'  [ -e "$e" ] || [ -L "$e" ] || continue',
		'  if [ -d "$e" ]; then t=d; s=0; else t=f; s=$(wc -c < "$e" 2>/dev/null || echo 0); fi',
		'  printf \'%s\\t%s\\t%s\\n\' "$t" "$s" "$(printf \'%s\' "$e" | base64 | tr -d \'\\n\')"',
		"done",
	].join("\n");
	const stdout = await sshRun(host, script, { timeoutMs: 30_000 });
	const matcher = options.ignore === false ? ALWAYS_DIMMED_MATCHER : await getIgnore(host, posix.resolve(root));
	const entries: WorkspaceEntry[] = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const [type, size, name64] = line.split("\t");
		if (!name64) continue;
		const name = Buffer.from(name64, "base64").toString("utf8");
		const isDir = type === "d";
		const entryRel = rel ? `${rel}/${name}` : name;
		entries.push({
			name,
			path: entryRel,
			type: isDir ? "dir" : "file",
			size: isDir ? undefined : Number(size) || 0,
			ignored: matcher.ignores(isDir ? `${entryRel}/` : entryRel),
		});
	}
	entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	return { path: rel, entries };
}

export async function readWorkspaceFile(host: SshHost, root: string, path: string): Promise<FilePreview> {
	const { abs, rel } = remoteResolve(root, path);
	const script = [
		`p=${shQuote(abs)}`,
		'if [ ! -f "$p" ]; then echo "__ERR__:不是文件"; exit 3; fi',
		'sz=$(wc -c < "$p")',
		`mt=$(${STAT_MTIME})`,
		`printf 'M %s %s\\n' "$sz" "$mt"`,
		`head -c ${MAX_PREVIEW_BYTES} "$p" | base64 | tr -d '\\n'`,
		"printf '\\n'",
	].join("\n");
	const stdout = await sshRun(host, script, { timeoutMs: 60_000 });
	const newline = stdout.indexOf("\n");
	if (newline < 0 || !stdout.startsWith("M ")) throw new Error(`读取远程文件失败：${stdout.trim() || "无输出"}`);
	const [sizeText, mtimeSec] = stdout.slice(2, newline).split(" ");
	const size = Number(sizeText) || 0;
	const buffer = Buffer.from(stdout.slice(newline + 1).replace(/\s+/g, ""), "base64");
	const binary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
	return {
		path: rel,
		absolutePath: abs,
		size,
		mtime: (Number(mtimeSec) || 0) * 1000,
		binary,
		truncated: size > MAX_PREVIEW_BYTES,
		text: binary ? "" : buffer.toString("utf8"),
	};
}

export async function writeWorkspaceFile(
	host: SshHost,
	root: string,
	path: string,
	content: string,
	expectedMtime?: number,
): Promise<FilePreview> {
	const { abs } = remoteResolve(root, path);
	const tmp = `${abs}.flowork-tmp-${Date.now()}`;
	const expectedSec = expectedMtime !== undefined ? Math.floor(expectedMtime / 1000) : undefined;
	const script = [
		`p=${shQuote(abs)}`,
		`tmp=${shQuote(tmp)}`,
		...(expectedSec !== undefined
			? [`if [ -f "$p" ]; then cur=$(${STAT_MTIME}); else cur=; fi`, `if [ "$cur" != "${expectedSec}" ]; then echo "__CONFLICT__"; exit 4; fi`]
			: []),
		'mkdir -p "$(dirname "$p")" || exit 1',
		`base64 -d > "$tmp" && mv -f "$tmp" "$p" || { rm -f "$tmp"; exit 1; }`,
	].join("\n");
	const result = await sshExec(host, script, {
		timeoutMs: 60_000,
		stdin: Buffer.from(content, "utf8").toString("base64"),
	});
	if (result.code === 4 || result.stdout.includes("__CONFLICT__")) {
		throw new Error(`${WRITE_CONFLICT_PREFIX}文件在你打开之后已被修改（可能是 AI 或其他程序），为避免覆盖已取消保存`);
	}
	if (result.code !== 0) throw new Error(`保存远程文件失败：${result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`}`);
	invalidateSearchIndex(host.id, root);
	return readWorkspaceFile(host, root, path);
}

// ----- 重命名 / 新建 / 删除 / 移动 -----

function assertEntryName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("名称不能为空");
	if (trimmed === "." || trimmed === "..") throw new Error("名称无效");
	if (/[\\/]/.test(trimmed)) throw new Error("名称不能包含路径分隔符");
	if (/[\u0000-\u001f]/.test(trimmed)) throw new Error("名称包含非法字符");
	return trimmed;
}

/** 在远程执行一次「成功后回显 ok」的操作，失败时把 stderr 抛出 */
async function remoteAction(host: SshHost, script: string, timeoutMs = 30_000): Promise<void> {
	const result = await sshExec(host, `${script}\nprintf '__OK__\\n'`, { timeoutMs });
	if (result.code !== 0 || !result.stdout.includes("__OK__")) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || "远程操作失败");
	}
}

export async function renameWorkspaceEntry(host: SshHost, root: string, path: string, name: string): Promise<{ path: string }> {
	const { abs, rel } = remoteResolve(root, path);
	if (!rel) throw new Error("不能重命名工作区根目录");
	const target = assertEntryName(name);
	const parent = posix.dirname(rel);
	const nextRel = parent === "." ? target : `${parent}/${target}`;
	const next = remoteResolve(root, nextRel).abs;
	if (next === abs) return { path: rel };
	await remoteAction(host, [`[ -e ${shQuote(next)} ] && { echo "「${target}」已存在" >&2; exit 1; }`, `mv ${shQuote(abs)} ${shQuote(next)}`].join("\n"));
	invalidateSearchIndex(host.id, root);
	return { path: nextRel };
}

export async function createWorkspaceEntry(host: SshHost, root: string, path: string, type: "file" | "dir"): Promise<{ path: string }> {
	const { abs, rel } = remoteResolve(root, path);
	if (!rel) throw new Error("名称不能为空");
	const name = assertEntryName(rel.split("/").pop() ?? "");
	const script =
		type === "dir"
			? [`[ -e ${shQuote(abs)} ] && { echo "「${name}」已存在" >&2; exit 1; }`, `mkdir ${shQuote(abs)}`].join("\n")
			: [
					`[ -e ${shQuote(abs)} ] && { echo "「${name}」已存在" >&2; exit 1; }`,
					`mkdir -p ${shQuote(posix.dirname(abs))}`,
					`: > ${shQuote(abs)}`,
				].join("\n");
	await remoteAction(host, script);
	invalidateSearchIndex(host.id, root);
	return { path: rel };
}

/** 远程删除：没有回收站，一律永久删除，因此界面需要二次确认 */
export async function deleteWorkspaceEntry(host: SshHost, root: string, path: string): Promise<{ trashed: boolean }> {
	const { abs, rel } = remoteResolve(root, path);
	if (!rel) throw new Error("不能删除工作区根目录");
	await remoteAction(host, `rm -rf ${shQuote(abs)}`);
	invalidateSearchIndex(host.id, root);
	return { trashed: false };
}

export async function moveWorkspaceEntry(host: SshHost, root: string, path: string, targetDir: string): Promise<{ path: string }> {
	const { abs, rel } = remoteResolve(root, path);
	if (!rel) throw new Error("不能移动工作区根目录");
	const target = remoteResolve(root, targetDir);
	if (target.rel === rel || target.rel.startsWith(`${rel}/`)) throw new Error("不能移动到自身或其子目录");
	const name = rel.split("/").pop() as string;
	const nextRel = target.rel ? `${target.rel}/${name}` : name;
	if (nextRel === rel) return { path: rel };
	const next = remoteResolve(root, nextRel).abs;
	await remoteAction(
		host,
		[
			`[ -d ${shQuote(target.abs)} ] || { echo "目标目录不存在" >&2; exit 1; }`,
			`[ -e ${shQuote(next)} ] && { echo "目标目录已有「${name}」" >&2; exit 1; }`,
			`mv ${shQuote(abs)} ${shQuote(next)}`,
		].join("\n"),
	);
	invalidateSearchIndex(host.id, root);
	return { path: nextRel };
}

// ----- 全项目文件搜索 -----

const indexCache = new Map<string, { at: number; files: string[]; truncated: boolean }>();

const PRUNE_DIRS = ["node_modules", ".git", "out", "dist", "build", ".next", "__pycache__", ".venv", "target"];

async function buildIndex(host: SshHost, root: string): Promise<{ files: string[]; truncated: boolean }> {
	const prune = PRUNE_DIRS.map((d) => `-name ${shQuote(d)}`).join(" -o ");
	const script = [
		`cd ${shQuote(posix.resolve(root))} 2>/dev/null || exit 1`,
		`find . -type d \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | head -n ${MAX_INDEXED_FILES + 1}`,
	].join("\n");
	const stdout = await sshRun(host, script, { timeoutMs: 60_000 });
	const files = stdout
		.split("\n")
		.map((line) => line.replace(/^\.\//, ""))
		.filter(Boolean);
	const truncated = files.length > MAX_INDEXED_FILES;
	return { files: truncated ? files.slice(0, MAX_INDEXED_FILES) : files, truncated };
}

export async function searchWorkspaceFiles(host: SshHost, root: string, query: string, limit = 50, fresh = false): Promise<FileSearchResult> {
	const key = `${host.id}\0${posix.resolve(root)}`;
	let entry = indexCache.get(key);
	if (fresh || !entry || Date.now() - entry.at > INDEX_TTL_MS) {
		entry = { at: Date.now(), ...(await buildIndex(host, root)) };
		indexCache.set(key, entry);
	}
	const matcher = await getIgnore(host, posix.resolve(root));
	const matches: Array<{ path: string; score: number }> = [];
	for (const path of entry.files) {
		if (matcher.ignores(path)) continue;
		const score = fuzzyScore(path, query);
		if (score >= 0 || (query.trim() === "" && matches.length < limit)) matches.push({ path, score });
	}
	matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
	return { matches: matches.slice(0, limit), total: entry.files.length, truncated: entry.truncated };
}

export function invalidateSearchIndex(hostId: string, root: string): void {
	indexCache.delete(`${hostId}\0${posix.resolve(root)}`);
}

/** 浏览远程目录（用于挑选远程项目路径） */
export async function listRemoteDirs(host: SshHost, path?: string): Promise<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }>; home: string }> {
	const script = [
		`home=$HOME`,
		`p=${path ? shQuote(path) : '"$home"'}`,
		'[ -d "$p" ] || p="$home"',
		'cd "$p" 2>/dev/null || { echo "__ERR__"; exit 1; }',
		"pwd",
		`for e in * .[!.]*; do`,
		'  [ -d "$e" ] || continue',
		'  printf \'%s\\n\' "$(printf \'%s\' "$e" | base64 | tr -d \'\\n\')"',
		"done",
	].join("\n");
	const stdout = await sshRun(host, script, { timeoutMs: 20_000 });
	const lines = stdout.split("\n");
	const home = lines[0]?.trim() ?? "";
	// 第一行是 home，第二行是当前目录 pwd
	const cwd = lines[1]?.trim() ?? home;
	const entries = lines
		.slice(2)
		.filter(Boolean)
		.map((line) => {
			const name = Buffer.from(line, "base64").toString("utf8");
			return { name, path: posix.join(cwd, name) };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	const parent = cwd === "/" ? null : posix.dirname(cwd);
	return { path: cwd, parent: parent === cwd ? null : parent, entries, home };
}

// ----- 服务器目录：绝对路径，不限定在项目根内 -----

/**
 * 服务器目录把根固定为 /：现有实现都经过 remoteResolve(root, path)，
 * 以 / 为根时任意绝对路径都算在根内，于是可以直接复用上面那些脚本，
 * 只在进出边界把「相对 / 的路径」与「绝对路径」互转。
 */
const SERVER_ROOT = "/";
/** 单次上传 / 下载的大小上限：内容整块经过 base64 传输，过大既慢又占内存 */
export const SERVER_TRANSFER_LIMIT = 32 * 1024 * 1024;

function serverAbs(path: string): string {
	return posix.resolve(SERVER_ROOT, path);
}

export async function listServerDir(host: SshHost, path?: string): Promise<ServerDirListing> {
	const abs = path ? serverAbs(path) : SERVER_ROOT;
	const listing = await listWorkspaceDir(host, SERVER_ROOT, abs, { ignore: false });
	return {
		path: abs,
		parent: abs === SERVER_ROOT ? null : posix.dirname(abs),
		entries: listing.entries.map((entry) => ({ ...entry, path: posix.join(SERVER_ROOT, entry.path) })),
	};
}

export async function readServerFile(host: SshHost, path: string): Promise<FilePreview> {
	const abs = serverAbs(path);
	const preview = await readWorkspaceFile(host, SERVER_ROOT, abs);
	return { ...preview, path: abs };
}

export async function writeServerFile(host: SshHost, path: string, content: string, expectedMtime?: number): Promise<FilePreview> {
	const abs = serverAbs(path);
	const preview = await writeWorkspaceFile(host, SERVER_ROOT, abs, content, expectedMtime);
	return { ...preview, path: abs };
}

export async function createServerEntry(host: SshHost, path: string, type: "file" | "dir"): Promise<{ path: string }> {
	const abs = serverAbs(path);
	await createWorkspaceEntry(host, SERVER_ROOT, abs, type);
	return { path: abs };
}

export async function renameServerEntry(host: SshHost, path: string, name: string): Promise<{ path: string }> {
	const abs = serverAbs(path);
	await renameWorkspaceEntry(host, SERVER_ROOT, abs, name);
	return { path: posix.join(posix.dirname(abs), name.trim()) };
}

export async function deleteServerEntry(host: SshHost, path: string): Promise<{ trashed: boolean }> {
	return deleteWorkspaceEntry(host, SERVER_ROOT, serverAbs(path));
}

export async function moveServerEntry(host: SshHost, path: string, targetDir: string): Promise<{ path: string }> {
	const abs = serverAbs(path);
	const dir = serverAbs(targetDir);
	await moveWorkspaceEntry(host, SERVER_ROOT, abs, dir);
	return { path: posix.join(dir, posix.basename(abs)) };
}

/** 上传：本地字节经 base64 → stdin 写到 dir/name；目标同名文件已存在时拒绝 */
export async function uploadServerFile(host: SshHost, dir: string, name: string, data: Buffer): Promise<{ path: string }> {
	if (data.byteLength > SERVER_TRANSFER_LIMIT) {
		throw new Error(`文件超过 ${Math.round(SERVER_TRANSFER_LIMIT / 1024 / 1024)} MB，暂不支持上传`);
	}
	const folder = serverAbs(dir);
	const target = posix.join(folder, assertEntryName(name));
	const script = [
		`p=${shQuote(target)}`,
		`[ -d ${shQuote(folder)} ] || { echo "目标目录不存在" >&2; exit 1; }`,
		`[ -e "$p" ] && { echo "目标目录已有同名文件" >&2; exit 1; }`,
		'base64 -d > "$p" || exit 1',
	].join("\n");
	const result = await sshExec(host, script, { timeoutMs: 300_000, stdin: data.toString("base64") });
	if (result.code !== 0) throw new Error(`上传失败：${result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`}`);
	return { path: target };
}

/** 下载：把远端文件内容以 base64 返回（超过上限时直接拒绝，不传输） */
export async function downloadServerFile(host: SshHost, path: string): Promise<{ name: string; dataBase64: string; size: number }> {
	const abs = serverAbs(path);
	const limitMb = Math.round(SERVER_TRANSFER_LIMIT / 1024 / 1024);
	const script = [
		`p=${shQuote(abs)}`,
		'[ -f "$p" ] || { echo "不是文件" >&2; exit 3; }',
		'sz=$(wc -c < "$p")',
		`[ "$sz" -gt ${SERVER_TRANSFER_LIMIT} ] && { echo "文件超过 ${limitMb} MB，暂不支持下载" >&2; exit 4; }`,
		`printf 'M %s\\n' "$sz"`,
		`base64 < "$p" | tr -d '\\n'`,
		`printf '\\n'`,
	].join("\n");
	const stdout = await sshRun(host, script, { timeoutMs: 300_000 });
	const newline = stdout.indexOf("\n");
	if (newline < 0 || !stdout.startsWith("M ")) throw new Error(`下载失败：${stdout.trim().slice(0, 200) || "无输出"}`);
	const size = Number(stdout.slice(2, newline)) || 0;
	return { name: posix.basename(abs), size, dataBase64: stdout.slice(newline + 1).replace(/\s+/g, "") };
}
