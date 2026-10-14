import { lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSummary } from "@shared/protocol";
import { displayUserText } from "@shared/skill-text";

function samePath(a: string, b: string): boolean {
	const normalize = (path: string) => resolve(path).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
}

function checkFile(cwd: string, path: string): { path: string; id: string } {
	if (!cwd || !path || !isAbsolute(cwd) || !isAbsolute(path)) throw new Error("工作区与会话路径必须是绝对路径");
	const root = resolve(getAgentDir(), "sessions");
	const target = resolve(path);
	const rel = relative(root, target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !target.endsWith(".jsonl")) {
		throw new Error("仅允许操作 FloWork 会话目录内的 JSONL 会话");
	}
	let current = root;
	for (const part of ["", ...rel.split(sep)]) {
		if (part) current = join(current, part);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch {
			throw new Error("会话文件不存在或无法访问");
		}
		if (stat.isSymbolicLink()) throw new Error("不能操作符号链接会话或目录");
		if (samePath(current, target) ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) {
			throw new Error("会话必须是普通文件，且不能包含链接目录");
		}
	}
	const realRoot = realpathSync(root);
	const realTarget = realpathSync(target);
	const realRel = relative(realRoot, realTarget);
	if (!realRel || realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error("会话真实路径越界");
	let entries: Array<Record<string, unknown>>;
	try {
		entries = readFileSync(target, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
	} catch {
		throw new Error("会话不是有效的 JSONL 文件");
	}
	const header = entries[0];
	if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id ||
		typeof header.cwd !== "string" || !samePath(header.cwd, cwd) ||
		typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp)) ||
		entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.type !== "string")) {
		throw new Error("会话格式无效或不属于此工作区");
	}
	return { path: target, id: header.id };
}

export async function validateSession(cwd: string, path: string): Promise<SessionSummary> {
	const target = checkFile(cwd, path);
	const info = (await SessionManager.list(cwd)).find((session) => samePath(session.path, target.path) && samePath(session.cwd, cwd) && session.id === target.id);
	if (!info) throw new Error("会话不在此工作区的 FloWork 历史列表中");
	checkFile(cwd, target.path);
	return {
		path: target.path,
		id: info.id,
		cwd: info.cwd,
		name: info.name,
		firstMessage: displayUserText(info.firstMessage),
		messageCount: info.messageCount,
		created: info.created.getTime(),
		modified: info.modified.getTime(),
		parentSessionPath: info.parentSessionPath,
	};
}

export async function renameSession(cwd: string, path: string, name: string): Promise<void> {
	const target = await validateSession(cwd, path);
	checkFile(cwd, target.path);
	SessionManager.open(target.path).appendSessionInfo(name.trim());
}

export async function deleteSession(cwd: string, path: string): Promise<void> {
	const target = await validateSession(cwd, path);
	checkFile(cwd, target.path);
	unlinkSync(target.path);
}
