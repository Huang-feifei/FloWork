/** 从维护者 GitHub Releases 下载签名批准的完整 Pi 运行包。 */
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveKernelManifest, KernelManifest, KernelUpdateController, KernelUpdateStatus, KernelVersion, SignedKernelManifest } from "@shared/kernel";
import {
	compareVersions, incompatibility, isVersion, MAX_MANIFEST_BYTES, validateInstalledLayout, validateRepository, verifyManifest,
	type KernelEnvironment,
} from "./kernel-package";
import { extractKernelRuntime } from "./kernel-archive";

interface ReleaseAsset { id?: number; name: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; body: string | null; assets: ReleaseAsset[] }
interface Selection { active: string | null; previous: string | null; pending?: string | null }
interface Candidate { manifest: ArchiveKernelManifest; envelope: SignedKernelManifest; notes: string; releaseUrl: string }

export interface KernelUpdaterOptions extends Omit<KernelEnvironment, "adapterSha256"> {
	/** 来自应用自身，不从网络下载或替换。 */
	adapterEntry: string;
	directory: () => string;
	repository: string;
	publicKey: string;
	/** 仅由后端环境注入的维护者测试凭据；不写配置、不返回 Renderer、不转发 CDN。 */
	githubToken?: string;
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
	private adapterSha256 = "";
	private environment(): KernelEnvironment { return { ...this.options, adapterSha256: this.adapterSha256 }; }

	constructor(private readonly options: KernelUpdaterOptions) {
		this.entry = options.bundled.entry;
		let configured = false;
		try {
			configured = validateRepository(options.repository) && createPublicKey(options.publicKey).asymmetricKeyType === "ed25519";
		} catch { /* 首次配置前不发起网络请求。 */ }
		this.state = {
			supported: true, configured, repository: options.repository, current: this.bundled(),
			phase: "idle", downloadedBytes: 0, totalBytes: 0,
			...(!configured ? { message: "尚未配置维护者的 GitHub 兼容清单仓库和 Ed25519 公钥；请先配置 kernel.config.json 并重新构建应用。" } : {}),
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
		const reason = incompatibility(manifest, this.environment());
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
		try {
			await mkdir(this.options.directory(), { recursive: true });
			this.adapterSha256 = createHash("sha256").update(await readFile(this.options.adapterEntry)).digest("hex");
		} catch (error) {
			this.initialized = true;
			this.publish({ supported: false, configured: false, phase: "error", error: `内核目录或应用内置适配层不可用，已使用内置内核：${errorText(error)}` });
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
			const api = parsed.hostname === "api.github.com";
			const headers: Record<string, string> = { "User-Agent": "FloWork-Kernel-Updater", Accept: api && !/\/releases\/assets\/\d+$/.test(parsed.pathname) ? "application/vnd.github+json" : "application/octet-stream" };
			if (api && parsed.pathname.startsWith(`/repos/${this.options.repository}/`) && this.options.githubToken) headers.Authorization = `Bearer ${this.options.githubToken}`;
			const response = await (this.options.fetch ?? fetch)(url, { redirect: "manual", signal, headers });
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("location");
				await response.body?.cancel();
				if (!location) throw new Error("GitHub 下载跳转缺少地址");
				url = new URL(location, url).href;
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(response.status === 403 || response.status === 429 ? "GitHub 请求受限或当前凭据权限不足，请稍后重试" : response.status === 404 ? "GitHub 仓库或附件不可见（HTTP 404）；私有仓库测试需在后端设置 FLOWORK_KERNEL_GITHUB_TOKEN，公开后无需凭据" : `GitHub 请求失败（HTTP ${response.status}）`);
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
		if (this.options.githubToken) {
			if (!Number.isSafeInteger(asset.id) || asset.id! <= 0) throw new Error("私有内核附件缺少合法 GitHub asset ID");
			return `https://api.github.com/repos/${this.options.repository}/releases/assets/${asset.id}`;
		}
		return asset.browser_download_url;
	}

	check(): Promise<KernelUpdateStatus> {
		return this.operation(async () => {
			if (!this.state.configured) throw new Error("请先配置 kernel.config.json 的兼容清单仓库与签名公钥");
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
				const verified = verifyManifest(await this.json(this.assetUrl(asset, release.tag_name), MAX_MANIFEST_BYTES), this.options.publicKey);
				const m = verified.manifest;
				if (m.format !== 3) throw new Error("此发布不是签名完整内核包，请维护者重新打包发布");
				if (!release.assets.some(a => a.name === m.archive.name)) { reason ??= "维护者尚未上传完整内核包"; continue; }
				if (`kernel-v${m.version}` !== release.tag_name) throw new Error("内核版本与 Release 标签不一致");
				const incompatible = incompatibility(m, this.environment());
				if (incompatible) { reason ??= incompatible; continue; }
				const releaseUrl = `https://github.com/${this.options.repository}/releases/tag/${release.tag_name}`;
				this.candidate = { envelope: verified.envelope, manifest: m, notes: (release.body ?? "").slice(0, 20_000), releaseUrl };
				this.publish({ latest: { version: m.version, piVersion: m.piVersion, source: "downloaded", notes: this.candidate.notes, releaseUrl } });
				break;
			}
			this.publish({ phase: this.state.pending ? "ready" : "idle", message: this.candidate ? "发现维护者已测试并签名批准的完整 Pi 内核包，将从 GitHub 下载" : reason ?? "暂无维护者已批准的 Pi 更新" });
		});
	}

	install(): Promise<KernelUpdateStatus> {
		return this.operation(async () => {
			const candidate = this.candidate;
			if (!candidate) throw new Error("请先检查更新并选择兼容的内核版本");
			const { manifest, envelope } = candidate;
			// 安装前再次确认维护者没有撤回或更换这次放行；已安装版本仍可离线启动。
			const release = await this.json(`https://api.github.com/repos/${this.options.repository}/releases/tags/kernel-v${manifest.version}`, 4 * 1024 * 1024) as Release;
			if (!release || release.draft || release.prerelease || release.tag_name !== `kernel-v${manifest.version}`) throw new Error("该 Pi 放行已被撤回，请重新检查更新");
			const asset = release.assets?.find((a) => a.name === `flowork-kernel-${this.options.platform}-${this.options.arch}.json`);
			if (!asset) throw new Error("该 Pi 放行清单已被撤回，请重新检查更新");
			const fresh = verifyManifest(await this.json(this.assetUrl(asset, release.tag_name), MAX_MANIFEST_BYTES), this.options.publicKey);
			if (fresh.envelope.manifest !== envelope.manifest) throw new Error("该批次放行内容已变更，请重新检查更新；维护者应使用新的批次号");
			const archiveAsset = release.assets?.find(a => a.name === manifest.archive.name);
			if (!archiveAsset) throw new Error("该完整内核包已被撤回，请重新检查更新");
			const archiveUrl = this.assetUrl(archiveAsset, release.tag_name);
			this.publish({ phase: "downloading", downloadedBytes: 0, totalBytes: manifest.archive.size, message: undefined });
			const stage = await mkdtemp(join(this.options.directory(), ".download-"));
			try {
				const unpacked = join(stage, "runtime");
				const archive = join(stage, "kernel.tar.gz");
				const response = await this.request(archiveUrl, AbortSignal.timeout(5 * 60_000));
				if (!response.body) throw new Error("内核包下载响应为空");
				const hash = createHash("sha256"), output = await open(archive, "wx");
				let downloaded = 0, lastProgress = 0;
				try {
					for await (const chunk of response.body) {
						downloaded += chunk.byteLength;
						if (downloaded > manifest.archive.size) throw new Error("内核包大小超出签名清单限制");
						hash.update(chunk); await output.writeFile(chunk);
						if (Date.now() - lastProgress > 150) { this.publish({ downloadedBytes: downloaded }); lastProgress = Date.now(); }
					}
				} finally { await output.close(); }
				if (downloaded !== manifest.archive.size || hash.digest("hex") !== manifest.archive.sha256) throw new Error("完整内核包下载不完整或 SHA-256 校验失败");
				this.publish({ downloadedBytes: downloaded, phase: "verifying" });
				await extractKernelRuntime(archive, unpacked, manifest, this.options.adapterEntry);
				await this.options.probe(join(unpacked, "pi-worker.js"));
				await writeFile(join(unpacked, "installed.json"), JSON.stringify(envelope));
				const destination = this.directory(manifest.version);
				try { await rename(unpacked, destination); }
				catch (error) {
					if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
					// 内核版本不可覆盖，尤其不能修改仍被本次运行使用的文件。
					await this.installed(manifest.version);
					const existing = JSON.parse(await readFile(join(destination, "installed.json"), "utf8")) as SignedKernelManifest;
					if (existing.manifest !== envelope.manifest) throw new Error("同一放行批次的内容已发生变化，请发行新版本号");
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
