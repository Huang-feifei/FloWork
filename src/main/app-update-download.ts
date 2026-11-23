import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppUpdateState } from "../shared/app-update";
import { appInstallerUrl, type AppInstaller, type AppUpdateCheck } from "./app-update";

const DOWNLOAD_TIMEOUT = 15 * 60_000;
const RETRY_DELAY = 5 * 60_000;
const ASSET_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

/** 请求只从固定发布附件开始；跳转不携带凭据，也不跟随到任意来源。 */
async function fetchInstaller(installer: AppInstaller, fetchAsset: typeof fetch, signal: AbortSignal): Promise<Response> {
	let url = appInstallerUrl(installer);
	for (let hops = 0; hops < 4; hops++) {
		const response = await fetchAsset(url, { redirect: "manual", credentials: "omit", signal, headers: { "User-Agent": "FloWork-Desktop" } });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error("GitHub 下载跳转缺少地址");
			const target = new URL(location, url);
			if (target.protocol !== "https:" || target.port || target.username || target.password || !ASSET_HOSTS.has(target.hostname)) {
				throw new Error("安装包下载跳转不属于受支持的 GitHub 附件域名");
			}
			url = target.href;
			continue;
		}
		if (response.status !== 200 || !response.body) {
			await response.body?.cancel();
			throw new Error(`下载安装包失败（HTTP ${response.status}）`);
		}
		return response;
	}
	throw new Error("安装包下载跳转次数过多");
}

async function verifyInstaller(path: string, installer: AppInstaller): Promise<boolean> {
	const info = await lstat(path).catch(() => null);
	if (!info?.isFile() || info.size !== installer.size) return false;
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		size += chunk.length;
		if (size > installer.size) return false;
		hash.update(chunk);
	}
	return size === installer.size && hash.digest("hex") === installer.sha256;
}

interface Options {
	directory: string;
	fetchAsset?: typeof fetch;
	publish: (state: AppUpdateState) => void;
	logError?: (error: unknown) => void;
}

export class AppUpdateDownload {
	private state: AppUpdateState = { phase: "idle" };
	private pending?: Promise<void>;
	private ready?: AppInstaller;
	private installInProgress = false;
	private lastFailure = 0;
	private readonly file: string;

	constructor(private readonly options: Options) {
		this.file = join(options.directory, "pending-installer.exe");
	}

	status(): AppUpdateState { return this.state; }

	private publish(state: AppUpdateState) {
		this.state = state;
		this.options.publish(state);
	}

	prepare(result: AppUpdateCheck, manual: boolean): Promise<void> {
		if (this.installInProgress || this.pending || result.status === "unavailable" || result.status === "unsupported") return this.pending ?? Promise.resolve();
		if (result.status === "current") {
			this.ready = undefined;
			if (this.state.phase !== "idle") this.publish({ phase: "idle" });
			return lstat(this.options.directory).then(async (directory) => {
				if (directory.isDirectory()) await rm(this.file, { force: true });
			}).catch(() => undefined);
		}
		const { installer, version } = result;
		if (installer && this.ready?.version === version && this.ready.sha256 === installer.sha256 && this.ready.size === installer.size) return Promise.resolve();
		if (!manual && this.state.phase === "failed" && this.state.version === version && Date.now() - this.lastFailure < RETRY_DELAY) return Promise.resolve();
		this.ready = undefined;
		if (!installer) {
			this.publish({ phase: "manual", version });
			return Promise.resolve();
		}
		this.publish({ phase: "downloading", version, downloaded: 0, total: installer.size });
		this.pending = this.download(installer).then(() => {
			this.ready = installer;
			this.publish({ phase: "ready", version });
		}, (error: unknown) => {
			this.lastFailure = Date.now();
			this.options.logError?.(error);
			this.publish({ phase: "failed", version });
		}).finally(() => { this.pending = undefined; });
		return this.pending;
	}

	/** 确认之后再次核对磁盘内容；渲染进程不能指定路径或安装参数。 */
	async install(confirm: (version: string) => Promise<boolean>, schedule: (path: string) => void): Promise<void> {
		const installer = this.ready;
		if (!installer || this.installInProgress || this.state.phase !== "ready") throw new Error("安装包尚未准备好。");
		this.installInProgress = true;
		let scheduled = false;
		try {
			if (!await confirm(installer.version)) return;
			const directory = await lstat(this.options.directory).catch(() => null);
			if (!directory?.isDirectory() || !await verifyInstaller(this.file, installer).catch(() => false)) {
				this.ready = undefined;
				this.lastFailure = Date.now();
				this.publish({ phase: "failed", version: installer.version });
				throw new Error("本地安装包未通过校验，请重新下载。");
			}
			this.publish({ phase: "installing", version: installer.version });
			try { schedule(this.file); scheduled = true; }
			catch (error) { this.publish({ phase: "ready", version: installer.version }); throw error; }
		} finally {
			if (!scheduled) this.installInProgress = false;
		}
	}

	private async download(installer: AppInstaller): Promise<void> {
		const { directory } = this.options;
		await mkdir(directory, { recursive: true });
		if (!(await lstat(directory)).isDirectory()) throw new Error("更新缓存目录不可用");
		for (const entry of await readdir(directory)) {
			if (/^download-[a-f0-9-]{36}\.part$/.test(entry)) await rm(join(directory, entry), { force: true }).catch(() => undefined);
		}
		if (await verifyInstaller(this.file, installer)) return;
		const temp = join(directory, `download-${randomUUID()}.part`);
		const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT);
		try {
			const handle = await open(temp, "wx");
			try {
				const response = await fetchInstaller(installer, this.options.fetchAsset ?? fetch, signal);
				const hash = createHash("sha256");
				let bytes = 0;
				let progressAt = 0;
				for await (const chunk of response.body! as unknown as AsyncIterable<Uint8Array>) {
					bytes += chunk.length;
					if (bytes > installer.size) throw new Error("安装包超过发布记录中的大小");
					hash.update(chunk);
					await handle.writeFile(chunk);
					if (bytes === installer.size || Date.now() - progressAt >= 250) {
						progressAt = Date.now();
						this.publish({ phase: "downloading", version: installer.version, downloaded: bytes, total: installer.size });
					}
				}
				signal.throwIfAborted();
				if (bytes !== installer.size || hash.digest("hex") !== installer.sha256) throw new Error("安装包大小或 SHA-256 不匹配");
			} finally { await handle.close(); }
			await rename(temp, this.file);
		} finally { await rm(temp, { force: true }); }
	}
}
