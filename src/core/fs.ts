import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import type { DirListing } from "@shared/protocol";

function listRoots(): string[] {
	if (process.platform !== "win32") return ["/"];
	const roots: string[] = [];
	for (let code = 67; code <= 90; code++) {
		const drive = `${String.fromCharCode(code)}:\\`;
		if (existsSync(drive)) roots.push(drive);
	}
	return roots;
}

/** 列出目录下的子目录，供网页版的文件夹选择器使用（只返回目录名，不读文件内容） */
export async function listDirs(path?: string): Promise<DirListing> {
	const target = resolve(path?.trim() || homedir());
	const dirents = await readdir(target, { withFileTypes: true });
	const entries = dirents
		.filter((d) => d.isDirectory() && !d.name.startsWith("$") && d.name !== "System Volume Information")
		.map((d) => ({ name: d.name, path: join(target, d.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const isRoot = parse(target).root === target;
	return {
		path: target,
		parent: isRoot ? null : dirname(target),
		entries,
		roots: listRoots(),
		home: homedir(),
	};
}
