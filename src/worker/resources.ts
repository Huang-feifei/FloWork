/**
 * 技能 / 扩展 / 提示模板管理。
 *
 * - 列表：pi 的 DefaultPackageManager.resolve() 返回所有资源及其启用状态（包括被禁用的）。
 * - 启用 / 禁用：在全局 settings.json 的 skills / extensions / prompts 数组中加入或移除 `-<绝对路径>`，
 *   这是 pi 的“精确排除”语法，对约定目录中自动发现的资源同样有效。
 * - 导入：把本地文件或文件夹复制到 pi 的约定目录（用户级 <配置目录>/skills 等，项目级 <项目>/.pi/skills 等）。
 * - pi 包：通过 npm / git 安装，记录在 settings.json 的 packages 中。
 */
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ResourceInfo, ResourceKind, ResourcesResult } from "@shared/protocol";
import { getProjectTrust, isProjectTrusted } from "./trust";

const DIR_NAME: Record<ResourceKind, string> = { skill: "skills", extension: "extensions", prompt: "prompts" };
const SETTINGS_KEY: Record<ResourceKind, "skills" | "extensions" | "prompts"> = {
	skill: "skills",
	extension: "extensions",
	prompt: "prompts",
};

function dirs(cwd: string) {
	const agentDir = getAgentDir();
	const user = {} as Record<ResourceKind, string>;
	const project = {} as Record<ResourceKind, string>;
	for (const kind of Object.keys(DIR_NAME) as ResourceKind[]) {
		user[kind] = join(agentDir, DIR_NAME[kind]);
		project[kind] = join(cwd, ".pi", DIR_NAME[kind]);
	}
	return { user, project };
}

function packageManager(cwd: string) {
	const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: isProjectTrusted(cwd) });
	return new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager });
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !/^[a-zA-Z]:/.test(rel);
}

/** 解析 SKILL.md / 提示模板的 frontmatter 中的 name 与 description */
async function readFrontmatter(file: string): Promise<{ name?: string; description?: string }> {
	try {
		const text = await readFile(file, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		if (!match?.[1]) return {};
		const pick = (key: string) => {
			const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(match[1] as string);
			return m?.[1]?.trim().replace(/^["']|["']$/g, "");
		};
		return { name: pick("name"), description: pick("description") };
	} catch {
		return {};
	}
}

function displayName(kind: ResourceKind, path: string): string {
	const base = basename(path);
	if (kind === "extension" && /^index\.(ts|js|mjs)$/.test(base)) return basename(dirname(path));
	if (kind === "skill" && base.toLowerCase() === "skill.md") return basename(dirname(path));
	return base.replace(/\.(ts|js|mjs|md)$/, "");
}

export async function listResources(cwd: string): Promise<ResourcesResult> {
	const pm = packageManager(cwd);
	const resolved = await pm.resolve(async () => "skip");
	const d = dirs(cwd);
	const removableRoots = [...Object.values(d.user), ...Object.values(d.project), join(cwd, ".agents", "skills")];
	const resources: ResourceInfo[] = [];
	const add = async (kind: ResourceKind, list: typeof resolved.skills) => {
		for (const r of list) {
			let name = displayName(kind, r.path);
			let description: string | undefined;
			if (kind === "skill" || kind === "prompt") {
				const file = kind === "skill" && !r.path.toLowerCase().endsWith(".md") ? join(r.path, "SKILL.md") : r.path;
				const fm = await readFrontmatter(file);
				if (fm.name && kind === "skill") name = fm.name;
				description = fm.description;
			}
			resources.push({
				kind,
				name,
				description,
				path: r.path,
				enabled: r.enabled,
				scope: r.metadata.scope,
				source: r.metadata.source,
				origin: r.metadata.origin,
				removable: r.metadata.origin === "top-level" && removableRoots.some((root) => isInside(root, r.path)),
			});
		}
	};
	await add("skill", resolved.skills);
	await add("extension", resolved.extensions);
	await add("prompt", resolved.prompts);
	return {
		resources,
		packages: pm.listConfiguredPackages().map((p) => ({ source: p.source, scope: p.scope, installedPath: p.installedPath })),
		trust: getProjectTrust(cwd),
		dirs: d,
	};
}

// ----- 启用 / 禁用 -----

async function readSettings(): Promise<{ file: string; data: Record<string, unknown> }> {
	const file = join(getAgentDir(), "settings.json");
	if (!existsSync(file)) return { file, data: {} };
	const data = JSON.parse(await readFile(file, "utf8")) as unknown;
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("settings.json 顶层必须是对象");
	return { file, data: data as Record<string, unknown> };
}

async function writeSettings(file: string, data: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function setResourceEnabled(kind: ResourceKind, path: string, enabled: boolean): Promise<void> {
	const { file, data } = await readSettings();
	const key = SETTINGS_KEY[kind];
	const current = data[key];
	if (current !== undefined && !Array.isArray(current)) {
		throw new Error(`settings.json 中的 ${key} 不是数组（可能是旧格式），请先在“配置文件”页手动调整`);
	}
	const list = ((current as string[] | undefined) ?? []).filter((p) => p !== `-${path}` && p !== `+${path}`);
	if (!enabled) list.push(`-${path}`);
	if (list.length > 0) data[key] = list;
	else delete data[key];
	await writeSettings(file, data);
}

// ----- 导入 / 删除 -----

function validateSource(kind: ResourceKind, sourcePath: string): { from: string; name: string } {
	const abs = resolve(sourcePath);
	if (!existsSync(abs)) throw new Error(`路径不存在：${sourcePath}`);
	const isDir = statSync(abs).isDirectory();
	switch (kind) {
		case "skill": {
			// 可以选择技能文件夹（含 SKILL.md）或直接选择 SKILL.md
			const dir = isDir ? abs : basename(abs).toLowerCase() === "skill.md" ? dirname(abs) : null;
			if (!dir || !existsSync(join(dir, "SKILL.md"))) throw new Error("技能需要是包含 SKILL.md 的文件夹");
			return { from: dir, name: basename(dir) };
		}
		case "extension": {
			if (isDir) {
				const ok = ["index.ts", "index.js", "index.mjs", "package.json"].some((f) => existsSync(join(abs, f)));
				if (!ok) throw new Error("扩展文件夹需要包含 index.ts / index.js 或 package.json");
				return { from: abs, name: basename(abs) };
			}
			if (![".ts", ".js", ".mjs"].includes(extname(abs))) throw new Error("扩展需要是 .ts / .js 文件或扩展文件夹");
			return { from: abs, name: basename(abs) };
		}
		case "prompt": {
			if (isDir || extname(abs).toLowerCase() !== ".md") throw new Error("提示模板需要是 .md 文件");
			return { from: abs, name: basename(abs) };
		}
	}
}

export async function importResource(
	cwd: string,
	kind: ResourceKind,
	sourcePath: string,
	scope: "user" | "project",
): Promise<{ path: string; name: string }> {
	const { from, name } = validateSource(kind, sourcePath);
	const targetDir = dirs(cwd)[scope][kind];
	const target = join(targetDir, name);
	if (resolve(from) === resolve(target)) throw new Error("该资源已经在目标目录中");
	if (existsSync(target)) throw new Error(`目标位置已存在同名资源：${target}`);
	await mkdir(targetDir, { recursive: true });
	await cp(from, target, {
		recursive: true,
		// 不复制依赖与版本库目录
		filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(relative(from, src) ? `/${relative(from, src)}` : ""),
	});
	return { path: target, name };
}

export async function removeResource(cwd: string, kind: ResourceKind, path: string): Promise<void> {
	const d = dirs(cwd);
	const roots = [d.user[kind], d.project[kind], ...(kind === "skill" ? [join(cwd, ".agents", "skills")] : [])];
	const root = roots.find((r) => isInside(r, path));
	if (!root) throw new Error("只能删除位于配置目录或项目 .pi 目录中的资源；其他位置的资源请改为禁用");
	// 删除根目录下的第一级条目（技能文件夹、扩展文件或文件夹）
	const first = relative(root, resolve(path)).split(sep)[0] as string;
	await rm(join(root, first), { recursive: true, force: true });
	// 同时清除可能存在的禁用记录
	await setResourceEnabled(kind, path, true).catch(() => undefined);
}

// ----- pi 包 -----

export async function installPackage(cwd: string, source: string, scope: "user" | "project"): Promise<void> {
	if (scope === "project" && !isProjectTrusted(cwd)) throw new Error("请先信任该项目，再安装项目级的 pi 包");
	await packageManager(cwd).installAndPersist(source.trim(), { local: scope === "project" });
}

export async function removePackage(cwd: string, source: string, scope: "user" | "project"): Promise<void> {
	await packageManager(cwd).removeAndPersist(source, { local: scope === "project" });
}
