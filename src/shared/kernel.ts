/** 界面与 Pi 的兼容边界；破坏性修改 worker 协议时必须递增。 */
export const KERNEL_PROTOCOL_VERSION = 1;

export interface KernelVersion {
	/** 维护者签名放行的更新批次，不是 Pi 版本号。 */
	version: string;
	piVersion: string;
	source: "bundled" | "downloaded";
}

export interface KernelUpdateStatus {
	supported: boolean;
	configured: boolean;
	repository: string;
	current: KernelVersion;
	pending?: KernelVersion;
	latest?: KernelVersion & { notes: string; releaseUrl: string };
	phase: "idle" | "checking" | "downloading" | "verifying" | "ready" | "error";
	downloadedBytes: number;
	totalBytes: number;
	message?: string;
	error?: string;
}

/** 安装位置和官方 tarball 均被签名固定，不在客户端解析 latest 或依赖范围。 */
export interface ApprovedNpmPackage {
	path: string;
	name: string;
	version: string;
	url: string;
	integrity: string;
	size: number;
}

/** GitHub Release 中的完整运行包；名称、长度和摘要均受签名保护。 */
export interface KernelArchive {
	name: string;
	size: number;
	sha256: string;
}

/** 格式 2 仅保留已安装版本的离线验证；新发布统一使用格式 3 完整包。 */
interface KernelManifestBase {
	version: string;
	piVersion: string;
	protocolVersion: number;
	platform: string;
	arch: string;
	minAppVersion: string;
	maxAppVersion: string;
	minNodeVersion: string;
	minElectronVersion: string;
	/** 必须与当前应用内置的适配层完全一致；更新不能悄悄替换适配代码。 */
	adapterSha256: string;
	packages: ApprovedNpmPackage[];
}

export interface NpmKernelManifest extends KernelManifestBase { format: 2; archive?: never }
export interface ArchiveKernelManifest extends KernelManifestBase { format: 3; archive: KernelArchive }
export type KernelManifest = NpmKernelManifest | ArchiveKernelManifest;

/** 原始 JSON 字节的 Base64 与 Ed25519 签名。 */
export interface SignedKernelManifest {
	manifest: string;
	signature: string;
}

export interface KernelUpdateController {
	status(): KernelUpdateStatus;
	check(): Promise<KernelUpdateStatus>;
	install(): Promise<KernelUpdateStatus>;
	useBundled(): Promise<KernelUpdateStatus>;
	onChange(listener: (status: KernelUpdateStatus) => void): () => void;
}
