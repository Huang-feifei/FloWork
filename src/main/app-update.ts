import { APP_RELEASE_REPOSITORY, type AppUpdateResult } from "../shared/app-update";

const VERSION = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const MINUTE = 60_000;
const MAX_PAGES = 3;
export const APP_RELEASES_URL = `https://github.com/${APP_RELEASE_REPOSITORY}/releases`;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
export type AppInstaller = { version: string; name: string; size: number; sha256: string };
export type AppUpdateCheck = AppUpdateResult extends infer R ? R extends { status: "available" } ? R & { installer?: AppInstaller } : R : never;

export function appInstallerUrl(installer: AppInstaller): string {
	return `${APP_RELEASES_URL}/download/v${installer.version}/${installer.name}`;
}

function versionParts(version: string) {
	return VERSION.exec(version)?.slice(1).map(Number);
}

function compare(a: number[], b: number[]): number {
	return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

export function appReleasePage(version: unknown): string {
	if (typeof version !== "string" || !versionParts(version)) throw new Error("无效的应用版本号。");
	return `${APP_RELEASES_URL}/tag/v${version}`;
}

export function selectAppUpdate(releases: unknown[], current: string): AppUpdateCheck {
	let best = versionParts(current);
	if (!best) return { status: "unsupported" };
	let version: string | undefined;
	let installer: AppInstaller | undefined;
	for (const entry of releases) {
		if (!entry || typeof entry !== "object") continue;
		const release = entry as Record<string, unknown>;
		if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) continue;
		const next = release.tag_name.slice(1);
		const parts = versionParts(next);
		if (!parts || compare(parts, best) <= 0) continue;
		const name = `FloWork-${next}-x64-setup.exe`;
		if (!Array.isArray(release.assets)) continue;
		const asset = release.assets.find((candidate: unknown): candidate is Record<string, unknown> => {
			if (!candidate || typeof candidate !== "object") return false;
			const item = candidate as Record<string, unknown>;
			return item.name === name && item.state === "uploaded" && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size > 0;
		});
		if (!asset) continue;
		const size = asset.size as number;
		const digest = typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : undefined;
		installer = digest && size <= MAX_INSTALLER_BYTES ? { version: next, name, size, sha256: digest } : undefined;
		version = next;
		best = parts;
	}
	return version ? { status: "available", version, current, ...(installer ? { installer } : {}) } : { status: "current", current };
}

/** 仅访问固定的公开仓库；主进程合并并限流启动、聚焦和手动检查。 */
export function createAppUpdateChecker(current: string, fetchReleases: (url: string, options: RequestInit) => Promise<Response>, now = Date.now) {
	let pending: Promise<AppUpdateCheck> | undefined;
	let cached: { value: AppUpdateCheck; checkedAt: number } | undefined;
	return (manual: boolean): Promise<AppUpdateCheck> => {
		if (pending) return pending;
		const age = cached ? now() - cached.checkedAt : Infinity;
		if (cached && age >= 0 && age < (manual || cached.value.status === "unavailable" ? MINUTE : 30 * MINUTE)) return Promise.resolve(cached.value);
		pending = (async (): Promise<AppUpdateCheck> => {
			const releases: unknown[] = [];
			const signal = AbortSignal.timeout(10_000);
			try {
				for (let page = 1; page <= MAX_PAGES; page++) {
					const response = await fetchReleases(`https://api.github.com/repos/${APP_RELEASE_REPOSITORY}/releases?per_page=30&page=${page}`, {
						headers: { Accept: "application/vnd.github+json", "User-Agent": "FloWork-Desktop" },
						redirect: "error", signal,
					});
					if (!response.ok) return { status: "unavailable" };
					const batch: unknown = await response.json();
					if (!Array.isArray(batch)) return { status: "unavailable" };
					releases.push(...batch);
					if (batch.length < 30 || !response.headers.get("link")?.includes('rel="next"')) break;
				}
				return selectAppUpdate(releases, current);
			} catch {
				return { status: "unavailable" };
			}
		})().then((value) => {
			cached = { value, checkedAt: now() };
			return value;
		}).finally(() => { pending = undefined; });
		return pending;
	};
}
