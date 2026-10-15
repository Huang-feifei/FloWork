/**
 * SSH 执行层：所有远程操作都走系统自带的 ssh 客户端。
 *
 * 为什么用系统 ssh 而不是 ssh2 库：可以直接复用用户已有的 ~/.ssh/config、ssh-agent、
 * known_hosts 与跳板机（ProxyJump）配置，无需在应用里重新实现认证与 host key 校验；
 * 终端（node-pty）也能直接 spawn 它。代价是每个操作一次新连接（Windows 的 OpenSSH
 * 不支持 ControlMaster 复用），因此远程操作按“少而整”的方式组织。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SshHost } from "@shared/protocol";

const CONNECT_TIMEOUT_SEC = 10;

let cachedSsh: string | null | undefined;
let cachedSshpass: string | null | undefined;

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

/** sshpass 可执行文件；密码认证的非交互命令需要它 */
export function sshpassBinary(): string | null {
	if (cachedSshpass !== undefined) return cachedSshpass;
	if (process.env.FLOWORK_SSHPASS) cachedSshpass = existsSync(process.env.FLOWORK_SSHPASS) ? process.env.FLOWORK_SSHPASS : null;
	else cachedSshpass = which("sshpass");
	return cachedSshpass;
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
 * - BatchMode：非交互命令绝不弹出口令提示，避免卡住后端（密码认证需要 sshpass）。
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
	if (batch) options.push("-o", "BatchMode=yes");
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

/** 密码认证：把口令交给 sshpass（未安装时报出可读错误） */
function wrapForPassword(target: SshHost, command: string, args: string[]): { command: string; args: string[] } {
	if (target.auth !== "password" || !target.password) return { command, args };
	const sshpass = sshpassBinary();
	if (!sshpass) return { command, args };
	// sshpass 需要在 ssh 之前；用 -e 从环境变量读口令，避免出现在进程列表里
	return { command: sshpass, args: ["-e", command, ...args] };
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
		if (target.auth === "password") {
			if (!target.password) {
				reject(new Error("主机未设置密码"));
				return;
			}
			if (!sshpassBinary()) {
				reject(new Error("密码认证需要 sshpass，请改用密钥或 ssh-agent"));
				return;
			}
		}
		// 密码认证交给 sshpass 应答提示，此时不能开 BatchMode（否则 ssh 根本不尝试密码）
		const args = [...sshOptions(target, { batch: target.auth !== "password" }), destination(target), script];
		const { command, args: finalArgs } = wrapForPassword(target, ssh, args);
		const env = { ...process.env };
		if (target.auth === "password" && target.password) env.SSHPASS = target.password;

		const child = spawn(command, finalArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
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
		throw new Error(`SSH 命令失败：${detail}`);
	}
	return result.stdout;
}

/** 交互式终端用的 ssh 参数（保留 -tt 分配伪终端） */
export function sshTerminalArgs(target: SshHost, remoteCommand?: string): { command: string; args: string[] } {
	const ssh = sshBinary();
	if (!ssh) throw new Error("未找到 ssh 可执行文件，无法连接远程主机");
	const args = ["-tt", ...sshOptions(target, { batch: false }), destination(target)];
	if (remoteCommand) args.push(remoteCommand);
	return wrapForPassword(target, ssh, args);
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
