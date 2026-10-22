/** 开发与发行验证工具使用的 Node 运行时选择；桌面应用始终使用 Electron 自带的 Node。 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** pi 要求的最低 Node 版本 */
const MIN_NODE = [22, 19];

function meetsMinimum(version) {
	const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
	return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function compareVersions(a, b) {
	const pa = a.replace(/^v/, "").split(".").map(Number);
	const pb = b.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
	return 0;
}

function nodeVersionOf(binary) {
	try {
		return execFileSync(binary, ["-v"], { encoding: "utf8", timeout: 5000 }).trim();
	} catch {
		return undefined;
	}
}

/** nvm（nvm-windows 的 NVM_HOME/NVM_SYMLINK，或 nvm-sh 的 NVM_DIR）中已安装的 Node，按版本从高到低 */
function nvmNodeCandidates() {
	const exe = process.platform === "win32" ? "node.exe" : "node";
	const candidates = [];
	if (process.env.NVM_SYMLINK) candidates.push(join(process.env.NVM_SYMLINK, exe));
	const roots = [
		process.env.NVM_HOME,
		process.env.NVM_DIR ? join(process.env.NVM_DIR, "versions", "node") : undefined,
	].filter(Boolean);
	for (const root of roots) {
		if (!existsSync(root)) continue;
		const versions = readdirSync(root)
			.filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
			.sort(compareVersions);
		for (const v of versions) {
			candidates.push(process.platform === "win32" ? join(root, v, exe) : join(root, v, "bin", exe));
		}
	}
	return candidates.filter((p) => existsSync(p));
}

/**
 * 选择运行开发、测试与内核发行工具的 Node，依次尝试：
 * 1. 当前 Node（≥ 22.19 时）；
 * 2. 环境变量 FLOWORK_NODE 指定的 Node；
 * 3. nvm 已安装的 Node 中满足要求的最高版本；
 * 4. Electron 自带的 Node 24（ELECTRON_RUN_AS_NODE=1）。
 */
export async function backendRuntime() {
	if (meetsMinimum(process.versions.node)) return { command: process.execPath, env: {}, label: `node ${process.version}` };
	const candidates = [process.env.FLOWORK_NODE, ...nvmNodeCandidates()].filter(Boolean);
	for (const binary of candidates) {
		const version = nodeVersionOf(binary);
		if (version && meetsMinimum(version)) return { command: binary, env: {}, label: `node ${version}（${binary}）` };
	}
	const { default: electronPath } = await import("electron");
	return { command: electronPath, env: { ELECTRON_RUN_AS_NODE: "1" }, label: "Electron 自带的 Node" };
}
