/**
 * 桌面项目注册表：保存在 ~/.flowork/projects.json。
 * 只记录文件夹路径与显示信息，移除项目不会删除任何文件。
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import type { Project, ProjectGroup, ProjectPatch, ProjectsState } from "@shared/protocol";
import { getFloworkDataDir } from "./paths";

interface StoredState {
	version: 1;
	projects: Omit<Project, "missing">[];
	groups: ProjectGroup[];
}

function samePath(a: string, b: string): boolean {
	const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** 远程路径一律用 POSIX 语义：不能走 resolve()，否则 Windows 上会把 /home/x 变成 E:\\home\\x */
export function normalizeRemotePath(path: string): string {
	const normalized = posix.normalize(path.trim().replace(/\/{2,}/g, "/"));
	return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export class ProjectStore {
	private state: StoredState | undefined;
	/** 串行化写入，避免并发修改互相覆盖 */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly file = join(getFloworkDataDir(), "projects.json")) {}

	private async load(): Promise<StoredState> {
		if (this.state) return this.state;
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoredState>;
			this.state = {
				version: 1,
				projects: Array.isArray(parsed.projects) ? parsed.projects : [],
				groups: Array.isArray(parsed.groups) ? parsed.groups : [],
			};
		} catch {
			this.state = { version: 1, projects: [], groups: [] };
		}
		return this.state;
	}

	private async persist(): Promise<void> {
		if (!this.state) return;
		await mkdir(getFloworkDataDir(), { recursive: true });
		const tmp = `${this.file}.tmp`;
		await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
		await rename(tmp, this.file);
	}

	private snapshot(state: StoredState): ProjectsState {
		return {
			groups: state.groups.map((g) => ({ ...g })),
			// 远程项目的路径在服务器上，不能用本地 existsSync 判断（Windows 上 /root 会被当成 E:\root）
			projects: state.projects.map((p) => ({ ...p, missing: p.hostId ? false : !existsSync(p.path) })),
		};
	}

	private mutate<T>(fn: (state: StoredState) => T): Promise<{ state: ProjectsState; result: T }> {
		const run = this.queue.then(async () => {
			const state = await this.load();
			const result = fn(state);
			await this.persist();
			return { state: this.snapshot(state), result };
		});
		this.queue = run.catch(() => undefined);
		return run;
	}

	async get(): Promise<ProjectsState> {
		return this.snapshot(await this.load());
	}

	/** 某个区域内下一个排序值 */
	private nextOrder(state: StoredState, pinned: boolean, groupId: string | undefined): number {
		const same = state.projects.filter((p) => !!p.pinned === pinned && (pinned || p.groupId === groupId));
		return same.reduce((max, p) => Math.max(max, p.order), -1) + 1;
	}

	add(paths: string[], groupId?: string) {
		return this.mutate((state) => {
			const added: Project[] = [];
			const skipped: string[] = [];
			const validGroup = groupId && state.groups.some((g) => g.id === groupId) ? groupId : undefined;
			for (const raw of paths) {
				const path = resolve(raw);
				if (!isDir(path) || state.projects.some((p) => samePath(p.path, path))) {
					skipped.push(raw);
					continue;
				}
				const project = {
					id: randomUUID(),
					path,
					groupId: validGroup,
					order: this.nextOrder(state, false, validGroup),
					addedAt: Date.now(),
				};
				state.projects.push(project);
				added.push(project);
			}
			return { added, skipped };
		});
	}

	/** 添加远程项目：路径是服务器上的 POSIX 路径，不做本地解析与目录校验 */
	addRemote(hostId: string, path: string, name?: string) {
		return this.mutate((state) => {
			const remotePath = normalizeRemotePath(path);
			if (!remotePath.startsWith("/")) throw new Error("远程路径必须是绝对路径");
			const existing = state.projects.find((p) => p.hostId === hostId && p.path === remotePath);
			if (existing) return existing;
			const project = {
				id: randomUUID(),
				hostId,
				path: remotePath,
				...(name?.trim() ? { name: name.trim() } : {}),
				order: this.nextOrder(state, false, undefined),
				addedAt: Date.now(),
			};
			state.projects.push(project);
			return project;
		});
	}

	update(id: string, patch: ProjectPatch) {
		return this.mutate((state) => {
			const project = state.projects.find((p) => p.id === id);
			if (!project) throw new Error("项目不存在");
			if (patch.name !== undefined) {
				const name = patch.name?.trim();
				if (name && name !== basename(project.path)) project.name = name;
				else delete project.name;
			}
			const pinnedChanged = patch.pinned !== undefined && !!patch.pinned !== !!project.pinned;
			const groupChanged = patch.groupId !== undefined && (patch.groupId ?? undefined) !== project.groupId;
			if (patch.groupId !== undefined) {
				const gid = patch.groupId ?? undefined;
				if (gid && !state.groups.some((g) => g.id === gid)) throw new Error("分组不存在");
				project.groupId = gid;
			}
			if (patch.pinned !== undefined) project.pinned = patch.pinned || undefined;
			if (pinnedChanged || groupChanged) {
				project.order = -1;
				project.order = this.nextOrder(state, !!project.pinned, project.groupId);
			}
		}).then((r) => r.state);
	}

	remove(id: string) {
		return this.mutate((state) => {
			state.projects = state.projects.filter((p) => p.id !== id);
		}).then((r) => r.state);
	}

	touch(id: string) {
		return this.mutate((state) => {
			const project = state.projects.find((p) => p.id === id);
			if (project) project.lastOpenedAt = Date.now();
		}).then((r) => r.state);
	}

	move(ids: string[], pinned: boolean, groupId: string | null) {
		return this.mutate((state) => {
			const gid = groupId ?? undefined;
			if (gid && !state.groups.some((g) => g.id === gid)) throw new Error("分组不存在");
			ids.forEach((id, index) => {
				const project = state.projects.find((p) => p.id === id);
				if (!project) return;
				project.pinned = pinned || undefined;
				// 置顶的项目保留原分组，取消置顶后回到原分组
				if (!pinned) project.groupId = gid;
				project.order = index;
			});
		}).then((r) => r.state);
	}

	/** 按路径查找项目（用于把 root 映射回所属主机） */
	async findByPath(path: string): Promise<Project | undefined> {
		const state = await this.load();
		return state.projects.find((p) => (p.hostId ? p.path === path : samePath(p.path, path)));
	}

	createGroup(name: string) {
		return this.mutate((state) => {
			const group: ProjectGroup = { id: randomUUID(), name: name.trim() || "新分组" };
			state.groups.push(group);
			return group;
		});
	}

	updateGroup(id: string, patch: { name?: string; collapsed?: boolean }) {
		return this.mutate((state) => {
			const group = state.groups.find((g) => g.id === id);
			if (!group) throw new Error("分组不存在");
			if (patch.name !== undefined && patch.name.trim()) group.name = patch.name.trim();
			if (patch.collapsed !== undefined) group.collapsed = patch.collapsed || undefined;
		}).then((r) => r.state);
	}

	/** 删除分组，组内项目移到未分组 */
	removeGroup(id: string) {
		return this.mutate((state) => {
			state.groups = state.groups.filter((g) => g.id !== id);
			for (const p of state.projects) {
				if (p.groupId === id) {
					delete p.groupId;
					p.order = this.nextOrder(state, !!p.pinned, undefined);
				}
			}
		}).then((r) => r.state);
	}
}

export { samePath };
