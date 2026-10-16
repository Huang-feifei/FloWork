/**
 * 运维会话的路径映射。
 *
 * 界面里远程项目的 cwd 一直是服务器上的路径（例如 /root）；pi 需要一个本机真实存在的目录来归档会话，
 * 所以每个「主机 + 远程目录」对应一个本地占位目录：
 *   ~/.flowork/hosts/<hostId>/<sha1(remotePath) 前 12 位>/
 * 占位目录里不放任何远程文件。后端在请求进出时做双向转换，界面与 worker 都不需要知道对方的路径。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionState, SessionSummary } from "@shared/protocol";
import { getFloworkDataDir } from "./paths";

export function opsLocalCwd(hostId: string, remotePath: string): string {
	const hash = createHash("sha1").update(remotePath).digest("hex").slice(0, 12);
	const dir = join(getFloworkDataDir(), "hosts", hostId.replace(/[^\w-]/g, "_"), hash);
	mkdirSync(dir, { recursive: true });
	return resolve(dir);
}

/** 双向映射表：本地占位目录 ⇄ 远程路径 */
export class OpsPathMap {
	private readonly toRemote = new Map<string, string>();

	private key(local: string): string {
		const r = resolve(local);
		return process.platform === "win32" ? r.toLowerCase() : r;
	}

	register(hostId: string, remotePath: string): string {
		const local = opsLocalCwd(hostId, remotePath);
		this.toRemote.set(this.key(local), remotePath);
		return local;
	}

	/** 本地占位目录 → 远程路径；不是占位目录时原样返回 */
	remoteOf(localCwd: string): string {
		return this.toRemote.get(this.key(localCwd)) ?? localCwd;
	}

	state<T extends SessionState | undefined | null>(state: T): T {
		if (!state || !state.ops) return state;
		return { ...state, cwd: this.remoteOf(state.cwd) };
	}

	summaries(list: SessionSummary[], remoteCwd: string): SessionSummary[] {
		return list.map((s) => ({ ...s, cwd: remoteCwd }));
	}
}
