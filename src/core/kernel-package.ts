/** 签名放行清单与内核依赖的信任、兼容性边界。 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as tar from "tar";
import { KERNEL_PROTOCOL_VERSION, type KernelManifest, type SignedKernelManifest } from "@shared/kernel";

export const MAX_KERNEL_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9_][a-z0-9_.-]*\/)?[a-z0-9_][a-z0-9_.-]*$/;

export function isVersion(value: unknown): value is string {
	return typeof value === "string" && VERSION.test(value) && value.split(".").every((n) => Number.isSafeInteger(Number(n)));
}

export function compareVersions(a: string, b: string): number {
	if (!isVersion(a) || !isVersion(b)) throw new Error("版本号必须是 x.y.z 格式的稳定版本");
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const difference = left[i]! - right[i]!;
		if (difference) return difference;
	}
	return 0;
}

export function validateRepository(repository: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository);
}

export function npmTarballUrl(name: string, version: string): string {
	if (!NPM_NAME.test(name) || !NPM_VERSION.test(version)) throw new Error("无效的 npm 包名或固定版本");
	const basename = name.split("/").at(-1)!;
	return `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
}

/** 只允许 node_modules/name[/node_modules/name]，不接受别名、磁盘路径或 .bin。 */
export function packageNameAtPath(path: string): string {
	if (typeof path !== "string" || path.length > 1024) throw new Error("npm 安装路径无效");
	const parts = path.split("/");
	let name = "";
	for (let i = 0; i < parts.length;) {
		if (parts[i++] !== "node_modules") throw new Error("npm 安装路径无效");
		name = parts[i++] ?? "";
		if (name.startsWith("@")) name += `/${parts[i++] ?? ""}`;
		if (!NPM_NAME.test(name) || name.split("/").some((p) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("npm 安装路径无效");
	}
	return name;
}

export function verifyManifest(raw: unknown, publicKey: string): { envelope: SignedKernelManifest; manifest: KernelManifest } {
	const envelope = raw as SignedKernelManifest;
	if (!envelope || typeof envelope.manifest !== "string" || typeof envelope.signature !== "string" ||
		envelope.manifest.length > MAX_MANIFEST_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.manifest) ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature) || envelope.signature.length > 128) throw new Error("内核签名清单格式无效");
	const bytes = Buffer.from(envelope.manifest, "base64");
	const key = createPublicKey(publicKey);
	if (key.asymmetricKeyType !== "ed25519" || !verify(null, bytes, key, Buffer.from(envelope.signature, "base64"))) {
		throw new Error("兼容清单签名校验失败，已拒绝安装");
	}
	const m = JSON.parse(bytes.toString("utf8")) as KernelManifest;
	if (!m || ![2, 3].includes(m.format) || !isVersion(m.version) || !isVersion(m.piVersion) || !isVersion(m.minAppVersion) ||
		!isVersion(m.maxAppVersion) || compareVersions(m.minAppVersion, m.maxAppVersion) > 0 || !isVersion(m.minNodeVersion) || !isVersion(m.minElectronVersion) ||
		!Number.isSafeInteger(m.protocolVersion) || typeof m.platform !== "string" || typeof m.arch !== "string" ||
		typeof m.adapterSha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.adapterSha256) ||
		!Array.isArray(m.packages) || !m.packages.length || m.packages.length > 2048) throw new Error("兼容清单内容无效");
	if (m.format === 3 && (!m.archive || m.archive.name !== `flowork-kernel-${m.platform}-${m.arch}.tar.gz` ||
		!Number.isSafeInteger(m.archive.size) || m.archive.size <= 0 || m.archive.size > MAX_KERNEL_BYTES ||
		typeof m.archive.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.archive.sha256))) throw new Error("完整内核包清单无效");
	let size = 0;
	const paths = new Set<string>();
	for (const p of m.packages) {
		if (!p || typeof p.name !== "string" || typeof p.version !== "string" || packageNameAtPath(p.path) !== p.name ||
			p.url !== npmTarballUrl(p.name, p.version) || typeof p.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity) ||
			!Number.isSafeInteger(p.size) || p.size <= 0 || p.size > MAX_KERNEL_BYTES) throw new Error("兼容清单中的 npm 包无效");
		if (paths.has(p.path.toLowerCase())) throw new Error("兼容清单包含重复安装路径");
		paths.add(p.path.toLowerCase());
		size += p.size;
	}
	if (size > MAX_KERNEL_BYTES) throw new Error("兼容清单下载总量超出限制");
	for (const p of m.packages) {
		const parent = p.path.lastIndexOf("/node_modules/");
		if (parent >= 0 && !paths.has(p.path.slice(0, parent).toLowerCase())) throw new Error("兼容清单缺少嵌套依赖的父包");
	}
	const pi = m.packages.find((p) => p.path === "node_modules/@earendil-works/pi-coding-agent");
	if (!pi || pi.version !== m.piVersion) throw new Error("兼容清单未固定官方 Pi 版本");
	return { envelope, manifest: m };
}

export interface KernelEnvironment {
	appVersion: string;
	nodeVersion: string;
	electronVersion: string;
	platform: string;
	arch: string;
	adapterSha256: string;
}

export function incompatibility(m: KernelManifest, env: KernelEnvironment): string | undefined {
	if (m.platform !== env.platform || m.arch !== env.arch) return "该版本尚未批准用于当前操作系统或 CPU 架构";
	if (m.protocolVersion !== KERNEL_PROTOCOL_VERSION) return "内核协议已变化，请先更新 FloWork 应用";
	if (compareVersions(env.appVersion, m.minAppVersion) < 0 || compareVersions(env.appVersion, m.maxAppVersion) > 0) return "该 Pi 尚未批准用于当前 FloWork 版本";
	if (m.adapterSha256 !== env.adapterSha256) return "该 Pi 未通过当前 FloWork 适配层的兼容性放行，请更新应用或等待维护者测试";
	if (compareVersions(env.nodeVersion, m.minNodeVersion) < 0 || compareVersions(env.electronVersion, m.minElectronVersion) < 0) {
		return "该内核需要更新的 Electron / Node 运行环境，请先更新 FloWork 应用";
	}
	return undefined;
}

export interface ExtractionBudget { files: number; bytes: number }

/** npm tarball 的单层根目录（通常 package/，@types 包可能用包名）；完整检查后再解包。 */
export async function extractNpmPackage(archive: string, destination: string, budget: ExtractionBudget = { files: 0, bytes: 0 }): Promise<void> {
	let error: string | undefined;
	let archiveRoot: string | undefined;
	const paths = new Map<string, Array<{ path: string; type: string; size: number; mode: number | undefined; digest: string }>>();
	await tar.t({
		file: archive, strict: true,
		onReadEntry(entry) {
			const path = entry.path.replace(/\/$/, "");
			const parts = path.split("/");
			archiveRoot ??= parts[0];
			if (isAbsolute(path) || /[\\:\x00-\x1f]/.test(path) || parts[0] === "." || parts[0] !== archiveRoot ||
				parts.some((p) => p !== "." && (!p || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) ||
				parts.slice(1).includes("node_modules")) error ??= `npm 包包含不安全的路径或未列入清单的捆绑依赖：${path}`;
			if (entry.type !== "File" && entry.type !== "Directory") error ??= "npm 包不允许包含链接或特殊文件";
			const canonical = parts.filter((p) => p !== ".").join("/").toLowerCase();
			const record = { path: parts.filter((p) => p !== ".").join("/"), type: entry.type, size: entry.size, mode: entry.mode, digest: "" };
			const records = paths.get(canonical) ?? [];
			records.push(record); paths.set(canonical, records);
			if (entry.type === "File") {
				const hash = createHash("sha256");
				entry.on("data", (chunk) => { hash.update(chunk); });
				entry.on("end", () => { record.digest = hash.digest("hex"); });
			}
			budget.bytes += entry.size;
			if (++budget.files > 150_000 || budget.bytes > 2 * 1024 * 1024 * 1024) error ??= "npm 包解压总量超出限制";
		},
	});
	// 少数官方包同时包含 dist/x.js 与 ./dist/x.js（如 agent-base）。
	// 仅允许规范化后完全相同、内容及模式也相同的副本；提取时只写入一次。
	for (const records of paths.values()) {
		const first = records[0]!;
		if (records.some((r) => r.path !== first.path || r.type !== first.type || r.mode !== first.mode || r.size !== first.size || r.digest !== first.digest)) error ??= "npm 包包含冲突的重复路径";
	}
	if (error) throw new Error(error);
	const extracted = new Set<string>();
	await tar.x({
		file: archive, cwd: destination, strip: 1, strict: true, preservePaths: false, preserveOwner: false, noMtime: true,
		filter(path) {
			const canonical = path.replace(/\/$/, "").split("/").filter((p) => p !== ".").join("/").toLowerCase();
			if (extracted.has(canonical)) return false;
			extracted.add(canonical); return true;
		},
	});
}

export async function validateInstalledLayout(directory: string, manifest: KernelManifest): Promise<void> {
	const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	const worker = join(directory, "pi-worker.js");
	if (pkg.type !== "module" || !(await lstat(worker)).isFile() ||
		createHash("sha256").update(await readFile(worker)).digest("hex") !== manifest.adapterSha256) throw new Error("内置适配层与兼容清单不一致");
	for (const p of manifest.packages) {
		const dir = join(directory, p.path);
		if (!(await lstat(dir)).isDirectory()) throw new Error("npm 包安装目录无效");
		const installed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
		if (installed.name !== p.name || installed.version !== p.version) throw new Error("npm 包文件与批准版本不一致");
	}
}
