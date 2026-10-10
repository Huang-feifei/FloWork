/**
 * Windows 上定位 Git Bash。
 *
 * pi 只在 %ProgramFiles%\Git 与 %ProgramFiles(x86)%\Git 中查找 Git Bash，找不到时退回 PATH 上的 bash.exe，
 * 而 PATH 上常常最先命中 C:\Windows\System32\bash.exe（WSL 启动器），导致 bash 工具在 WSL 里执行甚至直接失败。
 * 这里按更多位置查找 Git Bash，结果由 WorkerManager 放到 worker 的 PATH 最前面。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let cached: string | null | undefined;

function bashUnder(root: string | undefined): string | undefined {
	if (!root) return undefined;
	const bash = join(root, "bin", "bash.exe");
	return existsSync(bash) ? bash : undefined;
}

function registryInstallPath(): string[] {
	const roots: string[] = [];
	for (const hive of ["HKLM", "HKCU"]) {
		try {
			const out = execFileSync("reg", ["query", `${hive}\\SOFTWARE\\GitForWindows`, "/v", "InstallPath"], {
				encoding: "utf8",
				timeout: 3000,
				windowsHide: true,
			});
			const match = out.match(/InstallPath\s+REG_SZ\s+(.+)/);
			if (match?.[1]) roots.push(match[1].trim());
		} catch {
			// 未安装或无权限
		}
	}
	return roots;
}

/** 由 git.exe 位置推回安装根目录：<root>\cmd\git.exe、<root>\bin\git.exe、<root>\mingw64\bin\git.exe */
function rootsFromGitOnPath(): string[] {
	try {
		const out = execFileSync("where", ["git"], { encoding: "utf8", timeout: 3000, windowsHide: true });
		return out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.toLowerCase().endsWith("git.exe"))
			.map((gitExe) => {
				const dir = dirname(gitExe);
				const parent = dirname(dir);
				return parent.toLowerCase().endsWith("mingw64") ? dirname(parent) : parent;
			});
	} catch {
		return [];
	}
}

export function findGitBash(): string | null {
	if (process.platform !== "win32") return null;
	if (cached !== undefined) return cached;
	const roots = [
		process.env.ProgramFiles && join(process.env.ProgramFiles, "Git"),
		process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git"),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git"),
		...registryInstallPath(),
		...rootsFromGitOnPath(),
	];
	cached = null;
	for (const root of roots) {
		const bash = bashUnder(root || undefined);
		if (bash) {
			cached = bash;
			break;
		}
	}
	return cached;
}

/** 返回把 Git Bash 所在目录放到 PATH 最前面的环境变量（Windows 的 PATH 键名大小写不固定） */
export function withGitBashOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const bash = findGitBash();
	if (!bash) return env;
	const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const binDir = dirname(bash);
	const current = env[key] ?? "";
	if (current.split(";")[0]?.toLowerCase() === binDir.toLowerCase()) return { ...env, FLOWORK_GIT_BASH: bash };
	return { ...env, [key]: `${binDir};${current}`, FLOWORK_GIT_BASH: bash };
}
