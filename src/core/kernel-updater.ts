/** GitHub Releases 独立内核更新：下载/验签/自检/暂存，下一次启动才切换。 */
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KernelManifest, KernelUpdateController, KernelUpdateStatus, KernelVersion, SignedKernelManifest } from "@shared/kernel";
import {
	compareVersions, extractKernel, incompatibility, isVersion, validateInstalledLayout, validateRepository, verifyManifest,
	type KernelEnvironment,
} from "./kernel-package";

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; body: string | null; assets: ReleaseAsset[] }
interface Selection { active: string | null; previous: string | null; pending?: string | null }
interface Candidate { manifest: KernelManifest; envelope: SignedKernelManifest; url: string; notes: string; releaseUrl: string }

export interface KernelUpdaterOptions extends KernelEnvironment {
	directory: () => string;
	repository: string;
	publicKey: string;
	bundled: { version: string; piVersion: string; entry: string };
	/** 只启动隔离的自检进程，不打开真实会话、加载用户扩展或调用模型。 */
	probe: (entry: string) => Promise<void>;
	fetch?: typeof fetch;
}

export class KernelUpdater implements KernelUpdateController {
	private selection: Selection = { active: null, previous: null };
	private candidate?: Candidate;
	private initialized = false;
	private busy = false;
	private readonly listeners = new Set<(status: KernelUpdateStatus) => void>();
	private readonly state: KernelUpdateStatus;
	private entry: string;

	constructor(private readonly options: KernelUpdaterOptions) {
		this.entry = options.bundled.entry;
		let configured = false;
		try {
			configured = validateRepository(options.repository) && createPublicKey(options.publicKey).asymmetricKeyType === "ed25519";
		} catch { /* 首次配置前不发起网络请求。 */ }
		this.state = {
			supported: true, configured, repository: options.repository, current: this.bundled(),
			phase: "idle", downloadedBytes: 0, totalBytes: 0,
			...(!configured ? { message: "尚未配置 GitHub 发布仓库和 Ed25519 公钥；请先配置 kernel.config.json 并重新构建应用。" } : {}),
		};
	}

	private bundled(): KernelVersion {
		return { version: this.options.bundled.version, piVersion: this.options.bundled.piVersion, source: "bundled" };
	}

	get workerEntry(): string { return this.entry; }
	status(): KernelUpdateStatus { return structuredClone(this.state); }
	onChange(listener: (status: KernelUpdateStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private publish(patch: Partial<KernelUpdateStatus> = {}): KernelUpdateStatus {
		Object.assign(this.state, patch);
		const status = this.status();
		for (const listener of this.listeners) listener(status);
		return status;
	}
	private directory(version: string): string {
		if (!isVersion(version)) throw new Error("无效的内核版本路径");
		return join(this.options.directory(), version);
	}
	private async saveSelection(): Promise<void> {
		const path = join(this.options.directory(), "active.json");
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(this.selection), { flag: "wx" });
			await rename(temporary, path);
		} finally { await rm(temporary, { force: true }); }
	}
	private async installed(version: string): Promise<KernelManifest> {
		const dir = this.directory(version);
		const { manifest } = verifyManifest(JSON.parse(await readFile(join(dir, "installed.json"), "utf8")), this.options.publicKey);
		if (manifest.version !== version) throw new Error("已安装的内核版本与目录不一致");
		const reason = incompatibility(manifest, this.options);
		if (reason) throw new Error(reason);
		await validateInstalledLayout(dir, manifest);
		return manifest;
	}
	private async select(version: string | null): Promise<KernelVersion> {
		if (version === null) { this.entry = this.options.bundled.entry; return this.bundled(); }
		const manifest = await this.installed(version);
		const entry = join(this.directory(version), "pi-worker.js");
		await this.options.probe(entry);
		this.entry = entry;
		return { version, piVersion: manifest.piVersion, source: "downloaded" };
	}

	/** 在创建任何实际 worker 之前执行；同一次应用运行不再切换入口，避免混用内核。 */
	async initialize(): Promise<void> {
		if (this.initialized) return;
		try { await mkdir(this.options.directory(), { recursive: true }); }
		catch (error) {
			this.initialized = true;
			this.publish({ supported: false, configured: false, phase: "error", error: `内核目录不可写，已使用内置内核：${errorText(error)}` });
			return;
		}
		let warning: string | undefined;
		try {
			const raw = JSON.parse(await readFile(join(this.options.directory(), "active.json"), "utf8")) as Selection;
			if (!raw || !(raw.active === null || isVersion(raw.active)) || !(raw.previous === null || isVersion(raw.previous)) ||
				!(raw.pending === undefined || raw.pending === null || isVersion(raw.pending))) throw new Error("内核选择文件无效");
			this.selection = raw;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") warning = "内核选择文件损坏，已恢复内置内核。";
		}
		let current: KernelVersion | undefined;
		if (this.selection.pending !== undefined) {
			try {
				current = await this.select(this.selection.pending);
				this.selection.previous = this.selection.active;
				this.selection.active = this.selection.pending;
			} catch (error) { warning = `新内核启动自检失败，已回退：${errorText(error)}`; }
			delete this.selection.pending;
		}
		if (!current) {
			try { current = await this.select(this.selection.active); }
			catch (error) {
				warning = `当前外置内核不可用，已回退：${errorText(error)}`;
				try {
					current = await this.select(this.selection.previous);
					this.selection.active = this.selection.previous;
				} catch {
					current = await this.select(null);
					this.selection.active = null;
				}
				this.selection.previous = null;
			}
		}
		try { await this.saveSelection(); }
		catch (error) {
			// 已验证的入口仍可使用；不让更新状态文件的权限问题阻止应用启动。
			this.publish({ supported: false, configured: false, phase: "error", error: `无法保存内核状态：${errorText(error)}` });
		}
		this.initialized = true;
		this.publish({ current, message: warning ?? this.state.message });
	}

	private async operation(action: () => Promise<void>): Promise<KernelUpdateStatus> {
		if (!this.initialized) throw new Error("内核管理器尚未初始化");
		if (!this.state.supported) throw new Error("内核更新目录不可用，请检查目录权限后重启应用");
		if (this.busy) throw new Error("已有内核更新操作正在执行");
		this.busy = true;
		this.publish({ error: undefined });
		try { await action(); return this.status(); }
		catch (error) {
			this.publish({ phase: "error", error: errorText(error) });
			throw error;
		} finally { this.busy = false; }
	}

	/** 所有跳转都限定 HTTPS GitHub 域名，不把下载地址暴露为通用 URL 请求器。 */
	private async request(url: string, signal: AbortSignal): Promise<Response> {
		for (let redirects = 0; redirects < 6; redirects++) {
			const parsed = new URL(url);
			if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
				!(parsed.hostname === "api.github.com" || parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com"))) {
				throw new Error("更新地址不是受支持的 GitHub HTTPS 地址");
			}
			const response = await (this.options.fetch ?? fetch)(url, {
				redirect: "manual", signal, headers: { "User-Agent": "FloWork-Kernel-Updater", Accept: parsed.hostname === "api.github.com" ? "application/vnd.github+json" : "application/octet-stream" },
			});
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("location");
				await response.body?.cancel();
				if (!location) throw new Error("GitHub 下载跳转缺少地址");
				url = new URL(location, url).href;
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(response.status === 403 || response.status === 429 ? "GitHub 请求受限，请稍后重试" : `GitHub 请求失败（HTTP ${response.status}）`);
			}
			return response;
		}
		throw new Error("GitHub 下载跳转次数过多");
	}
	private async json(url: string, maxBytes: number): Promise<unknown> {
		const response = await this.request(url, AbortSignal.timeout(30_000));
		if (!response.body) throw new Error("GitHub 返回空响应");
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.byteLength;
			if (size > maxBytes) throw new Error("GitHub 响应超出大小限制");
			chunks.push(chunk);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	}
	private assetUrl(asset: ReleaseAsset, tag: string): string {
		const prefix = `https://github.com/${this.options.repository}/releases/download/${encodeURIComponent(tag)}/`;
		if (typeof asset.browser_download_url !== "string" || asset.browser_download_url !== `${prefix}${asset.name}`) {
			throw new Error("内核附件地址与发布仓库不一致");
		}
		return asset.browser_download_url;
	}

	check(): Promise<KernelUpdateStatus> {
		return this.operation(async () => {
			if (!this.state.configured) throw new Error("请先配置 kernel.config.json 的发布仓库与签名公钥");
			this.publish({ phase: "checking", latest: undefined, message: undefined });
			this.candidate = undefined;
			const releases = await this.json(`https://api.github.com/repos/${this.options.repository}/releases?per_page=100`, 4 * 1024 * 1024);
			if (!Array.isArray(releases)) throw new Error("GitHub Releases 响应格式无效");
			const candidates = (releases as Release[]).filter((r) => !r.draft && !r.prerelease &&
				typeof r.tag_name === "string" && r.tag_name.startsWith("kernel-v") && isVersion(r.tag_name.slice(8)))
				.sort((a, b) => compareVersions(b.tag_name.slice(8), a.tag_name.slice(8)));
			let reason: string | undefined;
			const base = this.state.pending?.source === "downloaded" ? this.state.pending.version : this.state.current.version;
			for (const release of candidates) {
				if (compareVersions(release.tag_name.slice(8), base) <= 0) continue;
				const asset = release.assets?.find((a) => a.name === `flowork-kernel-${this.options.platform}-${this.options.arch}.json`);
				if (!asset) continue;
				const verified = verifyManifest(await this.json(this.assetUrl(asset, release.tag_name), 64 * 1024), this.options.publicKey);
				const m = verified.manifest;
				if (`kernel-v${m.version}` !== release.tag_name) throw new Error("内核版本与 Release 标签不一致");
				const incompatible = incompatibility(m, this.options);
				if (incompatible) { reason ??= incompatible; continue; }
				const archive = release.assets.find((a) => a.name === m.archive);
				if (!archive) throw new Error("Release 缺少签名清单指定的内核包");
				const releaseUrl = `https://github.com/${this.options.repository}/releases/tag/${release.tag_name}`;
				this.candidate = { ...verified, url: this.assetUrl(archive, release.tag_name), notes: (release.body ?? "").slice(0, 20_000), releaseUrl };
				this.publish({ latest: { version: m.version, piVersion: m.piVersion, source: "downloaded", notes: this.candidate.notes, releaseUrl } });
				break;
			}
			this.publish({ phase: this.state.pending ? "ready" : "idle", message: this.candidate ? "发现可用的新内核" : reason ?? "暂无更新的兼容内核" });
		});
	}

	install(): Promise<KernelUpdateStatus> {
		return this.operation(async () => {
			const candidate = this.candidate;
			if (!candidate) throw new Error("请先检查更新并选择兼容的内核版本");
			const { manifest, envelope } = candidate;
			this.publish({ phase: "downloading", downloadedBytes: 0, totalBytes: manifest.size, message: undefined });
			const stage = await mkdtemp(join(this.options.directory(), ".download-"));
			try {
				const archive = join(stage, "kernel.tar.gz");
				const response = await this.request(candidate.url, AbortSignal.timeout(5 * 60_000));
				if (!response.body) throw new Error("内核下载响应为空");
				const hash = createHash("sha256");
				const output = await open(archive, "wx");
				let size = 0;
				let lastProgress = 0;
				try {
					for await (const chunk of response.body) {
						size += chunk.byteLength;
						if (size > manifest.size) throw new Error("下载的内核大小超出签名清单限制");
						hash.update(chunk);
						await output.writeFile(chunk);
						if (Date.now() - lastProgress > 150) {
							this.publish({ downloadedBytes: size });
							lastProgress = Date.now();
						}
					}
				} finally { await output.close(); }
				if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) throw new Error("内核下载不完整或 SHA-256 校验失败");
				this.publish({ phase: "verifying", downloadedBytes: size });
				const unpacked = join(stage, "runtime");
				await mkdir(unpacked);
				await extractKernel(archive, unpacked);
				await validateInstalledLayout(unpacked, manifest);
				await this.options.probe(join(unpacked, "pi-worker.js"));
				await writeFile(join(unpacked, "installed.json"), JSON.stringify(envelope));
				const destination = this.directory(manifest.version);
				try { await rename(unpacked, destination); }
				catch (error) {
					if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
					// 内核版本不可覆盖，尤其不能修改仍被本次运行使用的文件。
					const existing = await this.installed(manifest.version);
					if (existing.sha256 !== manifest.sha256) throw new Error("同一内核版本的内容已发生变化，请发行新版本号");
					await this.options.probe(join(destination, "pi-worker.js"));
				}
				const previousSelection = { ...this.selection };
				this.selection.pending = manifest.version;
				try { await this.saveSelection(); }
				catch (error) { this.selection = previousSelection; throw error; }
				this.publish({ phase: "ready", pending: { version: manifest.version, piVersion: manifest.piVersion, source: "downloaded" }, message: "内核已安装，重启 FloWork 后生效；当前会话不受影响。" });
			} finally { await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
		});
	}

	useBundled(): Promise<KernelUpdateStatus> {
		return this.operation(async () => {
			const previousSelection = { ...this.selection };
			if (this.selection.active === null) delete this.selection.pending;
			else this.selection.pending = null;
			try { await this.saveSelection(); }
			catch (error) { this.selection = previousSelection; throw error; }
			const pending = this.selection.active === null ? undefined : this.bundled();
			this.publish({ pending, phase: pending ? "ready" : "idle", message: pending ? "已安排恢复内置内核，重启后生效。" : "已取消待生效的内核更新。" });
		});
	}
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
