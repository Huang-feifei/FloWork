/**
 * SSH 执行层：所有远程操作都走系统自带的 ssh 客户端。
 *
 * 为什么用系统 ssh 而不是 ssh2 库：可以直接复用用户已有的 ~/.ssh/config、ssh-agent、
 * known_hosts 与跳板机（ProxyJump）配置，无需在应用里重新实现认证与 host key 校验；
 * 终端（node-pty）也能直接 spawn 它。代价是每个操作一次新连接（Windows 的 OpenSSH
 * 不支持 ControlMaster 复用），因此远程操作按“少而整”的方式组织。
 *
 * 密码认证：用 OpenSSH 自带的 SSH_ASKPASS（8.4 起支持 SSH_ASKPASS_REQUIRE=force，Windows 10/11
 * 自带的 OpenSSH 9.x 可用），由一个小脚本从环境变量 FLOWORK_SSH_SECRET 输出口令。
 * 不需要安装 sshpass，口令也不会出现在命令行参数或磁盘文件里。
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshHost } from "@shared/protocol";

const CONNECT_TIMEOUT_SEC = 10;

let cachedSsh: string | null | undefined;
let cachedAskpass: string | undefined;

/** 口令通过这个环境变量交给 askpass 脚本 */
const SECRET_ENV = "FLOWORK_SSH_SECRET";

/** 在 PATH 中查找可执行文件（Windows 补上 .exe） */
function which(name: string): string | null {
	const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
	const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/** 本机 ssh 可执行文件；找不到返回 null（远程功能不可用） */
export function sshBinary(): string | null {
	if (cachedSsh !== undefined) return cachedSsh;
	const candidates: string[] = [];
	if (process.env.FLOWORK_SSH) candidates.push(process.env.FLOWORK_SSH);
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		candidates.push(join(systemRoot, "System32", "OpenSSH", "ssh.exe"));
	}
	cachedSsh = candidates.find((c) => existsSync(c)) ?? which("ssh");
	return cachedSsh;
}

/**
 * askpass 脚本：原样输出环境变量里的口令。
 * Windows 用 PowerShell 读取（cmd 的 echo 会被 & | < > ^ % ! 等字符破坏），其他平台用 sh 的 printf。
 * 脚本本身不含任何秘密，写到临时目录即可。
 */
function askpassScript(): string {
	if (cachedAskpass && existsSync(cachedAskpass)) return cachedAskpass;
	const dir = join(tmpdir(), "flowork-ssh");
	mkdirSync(dir, { recursive: true });
	if (process.platform === "win32") {
		const file = join(dir, "askpass.cmd");
		writeFileSync(file, ["@echo off", `powershell -NoProfile -NonInteractive -Command "[Console]::Out.Write($env:${SECRET_ENV})"`, ""].join("\r\n"));
		cachedAskpass = file;
	} else {
		const file = join(dir, "askpass.sh");
		writeFileSync(file, ["#!/bin/sh", `printf '%s\\n' "$${SECRET_ENV}"`, ""].join("\n"));
		chmodSync(file, 0o700);
		cachedAskpass = file;
	}
	return cachedAskpass;
}

/** 密码认证时给 ssh 子进程加上 askpass 相关环境变量 */
export function sshEnv(target: SshHost, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...base };
	if (target.auth === "password" && target.password) {
		env.SSH_ASKPASS = askpassScript();
		env.SSH_ASKPASS_REQUIRE = "force";
		env[SECRET_ENV] = target.password;
		// 旧版 OpenSSH 只在设置了 DISPLAY 时才使用 askpass
		env.DISPLAY ??= "flowork:0";
	} else {
		delete env[SECRET_ENV];
	}
	return env;
}

/** POSIX 单引号转义，用于把路径安全嵌进远程脚本 */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 目标地址：user@host（缺省时省略 user） */
function destination(target: SshHost): string {
	return target.user ? `${target.user}@${target.host}` : target.host;
}

/**
 * 组装 ssh 参数。
 * - BatchMode：非交互命令绝不弹出口令提示，避免卡住后端。
 *   密码认证不能开 BatchMode（否则 ssh 根本不尝试密码），改为只允许一次口令尝试，由 askpass 应答。
 * - accept-new：新主机自动记录 host key，但已记录过的 key 变化仍会拒绝。
 * - IdentitiesOnly：指定私钥时只用这一把，避免被 agent 里其它 key 抢占。
 */
function sshOptions(target: SshHost, { batch }: { batch: boolean }): string[] {
	const options = [
		"-o",
		`ConnectTimeout=${CONNECT_TIMEOUT_SEC}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ServerAliveInterval=15",
	];
	if (target.auth === "password") {
		options.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "NumberOfPasswordPrompts=1");
	} else if (batch) options.push("-o", "BatchMode=yes");
	if (target.auth === "key" && target.keyPath) options.push("-i", target.keyPath, "-o", "IdentitiesOnly=yes");
	if (target.port) options.push("-p", String(target.port));
	return options;
}

export interface SshExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface SshExecOptions {
	/** 超时（毫秒），默认 30s */
	timeoutMs?: number;
	/** 写入远程 stdin 的内容（用于上传文件） */
	stdin?: string | Buffer;
}

/**
 * 在远程执行一段 sh 脚本（脚本作为远程命令传入，stdin 留给数据上传）。
 * 返回退出码与输出，不抛错——调用方根据 code 判断。
 */
export function sshExec(target: SshHost, script: string, options: SshExecOptions = {}): Promise<SshExecResult> {
	return new Promise((resolve, reject) => {
		const ssh = sshBinary();
		if (!ssh) {
			reject(new Error("未找到 ssh 可执行文件，无法连接远程主机"));
			return;
		}
		if (target.auth === "password" && !target.password) {
			reject(new Error("主机未设置密码"));
			return;
		}
		const args = [...sshOptions(target, { batch: true }), destination(target), script];
		const child = spawn(ssh, args, { env: sshEnv(target), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(() => reject(new Error(`SSH 操作超时（${options.timeoutMs ?? 30_000}ms）`)));
		}, options.timeoutMs ?? 30_000);

		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
		if (options.stdin !== undefined) child.stdin.end(options.stdin);
		else child.stdin.end();
	});
}

/** 执行脚本并要求成功；失败时抛出带 stderr 的错误 */
export async function sshRun(target: SshHost, script: string, options: SshExecOptions = {}): Promise<string> {
	const result = await sshExec(target, script, options);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`;
		const hint = result.code === 255 ? describeSshFailure(result.stderr) : null;
		throw new Error(hint ? `${hint}（${detail}）` : `SSH 命令失败：${detail}`);
	}
	return result.stdout;
}

/** 交互式终端用的 ssh 参数（保留 -tt 分配伪终端）；密码认证时调用方需用 sshEnv() 设置环境变量 */
export function sshTerminalArgs(target: SshHost, remoteCommand?: string): { command: string; args: string[] } {
	const ssh = sshBinary();
	if (!ssh) throw new Error("未找到 ssh 可执行文件，无法连接远程主机");
	const args = ["-tt", ...sshOptions(target, { batch: false }), destination(target)];
	if (remoteCommand) args.push(remoteCommand);
	return { command: ssh, args };
}

/** 认证失败的典型输出：用于给出可读的错误提示 */
export function describeSshFailure(stderr: string): string | null {
	if (/Permission denied/i.test(stderr)) return "认证失败：用户名、密码或私钥不正确";
	if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return "主机密钥校验失败：服务器的 host key 与 known_hosts 记录不一致（可能重装过系统，也可能存在中间人）";
	if (/Connection refused/i.test(stderr)) return "连接被拒绝：确认 SSH 服务已启动、端口正确";
	if (/timed out|Connection timed out/i.test(stderr)) return "连接超时：确认主机地址、端口与网络可达";
	if (/Could not resolve hostname/i.test(stderr)) return "无法解析主机名";
	return null;
}

/** 连接测试：探测平台、home 与远程 Node */
export async function probeHost(target: SshHost): Promise<{
	platform: string;
	home: string;
	node: string | null;
}> {
	const script = [
		'printf "platform\\t%s\\n" "$(uname -s 2>/dev/null || echo unknown)"',
		'printf "home\\t%s\\n" "$HOME"',
		'if command -v node >/dev/null 2>&1; then printf "node\\t%s\\n" "$(node -v)"; else printf "node\\t\\n"; fi',
	].join("\n");
	const stdout = await sshRun(target, script, { timeoutMs: 15_000 });
	const pick = (key: string) => {
		const line = stdout.split("\n").find((l) => l.startsWith(`${key}\t`));
		return line ? line.slice(key.length + 1).trim() : "";
	};
	const uname = pick("platform").toLowerCase();
	const platform = uname.includes("darwin") ? "darwin" : uname.includes("linux") ? "linux" : uname.includes("mingw") || uname.includes("msys") ? "win32" : "unknown";
	return { platform, home: pick("home"), node: pick("node") || null };
}
