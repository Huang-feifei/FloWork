/**
 * 运维会话：把 pi 的 bash / read / write / edit 工具的执行换成走 SSH，在远程主机上执行。
 *
 * 做法与 pi 官方示例 examples/extensions/ssh.ts 一致：沿用 pi 自带的工具定义（输出截断、流式更新、
 * edit 的匹配与 diff 都和本地一致），只替换 operations。
 *
 * 路径：pi 的工具会把路径按本地规则解析（Windows 上 /etc/nginx 会变成 E:\etc\nginx）。所以本地 cwd
 * 用一个固定的占位目录，operations 里再把「占位目录下的路径」还原成远程 POSIX 路径。
 *
 * 安全兜底：write / edit 覆盖已有文件前，在远端复制一份 <原文件>.flowork-bak-<时间戳>，并写进工具结果。
 */
import { spawn } from "node:child_process";
import { posix, relative, resolve, sep } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ExtensionFactory,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { HostProfile, SshHost } from "@shared/protocol";
import { isHostKeyChangedError } from "../core/host-key";
import { hostKeyChangedError, shQuote, sshEnv, sshExec, sshRun, sshTerminalArgsRaw } from "../core/ssh";

export interface OpsTarget {
	host: SshHost;
	/** 远程起始目录（root 登录即 /root） */
	remoteCwd: string;
	/** 本地占位目录（pi 会话按它归档；不放任何远程文件） */
	localCwd: string;
}

const MAX_READ_BYTES = 20 * 1024 * 1024;
const FILE_OP_TIMEOUT_MS = 60_000;

/** 占位目录下的本地路径 → 远程绝对路径 */
export function toRemotePath(localPath: string, target: Pick<OpsTarget, "localCwd" | "remoteCwd">): string {
	const base = resolve(target.localCwd);
	const abs = resolve(localPath);
	const rel = relative(base, abs);
	// pi 把远程绝对路径 /etc/x 解析成 <盘符>:\etc\x，relative 会跳出占位目录：此时去掉盘符还原
	if (rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) {
		const stripped = abs.replace(/^[A-Za-z]:/, "").split(sep).join("/");
		return posix.normalize(stripped || "/");
	}
	return posix.normalize(posix.join(target.remoteCwd, rel.split(sep).join("/")));
}

function backupSuffix(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `.flowork-bak-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 远端写文件：base64 经 stdin 传入，先备份（已存在时）再写临时文件、保留原权限后原子替换 */
async function remoteWrite(host: SshHost, path: string, content: string | Buffer): Promise<string | null> {
	const backup = `${path}${backupSuffix()}`;
	const script = [
		"set -e",
		`p=${shQuote(path)}`,
		`b=${shQuote(backup)}`,
		'mkdir -p "$(dirname "$p")"',
		't="$p.flowork-tmp.$$"',
		'base64 -d > "$t"',
		'if [ -e "$p" ]; then cp -p "$p" "$b"; chmod --reference="$p" "$t" 2>/dev/null || true; chown --reference="$p" "$t" 2>/dev/null || true; echo "BACKUP:$b"; fi',
		'mv -f "$t" "$p"',
	].join("\n");
	const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
	const out = await sshRun(host, script, { stdin: `${data.toString("base64")}\n`, timeoutMs: FILE_OP_TIMEOUT_MS });
	const line = out.split("\n").find((l) => l.startsWith("BACKUP:"));
	return line ? line.slice("BACKUP:".length).trim() : null;
}

async function remoteRead(host: SshHost, path: string): Promise<Buffer> {
	const script = [
		`p=${shQuote(path)}`,
		'[ -e "$p" ] || { echo "文件不存在：$p" >&2; exit 2; }',
		'[ -d "$p" ] && { echo "这是目录，不是文件：$p（用 ls 查看目录内容）" >&2; exit 2; }',
		'[ -r "$p" ] || { echo "没有读取权限：$p" >&2; exit 2; }',
		`s=$(wc -c < "$p"); [ "$s" -le ${MAX_READ_BYTES} ] || { echo "文件过大（$s 字节），请用 head / tail / grep 查看" >&2; exit 2; }`,
		'base64 "$p"',
	].join("\n");
	const result = await sshExec(host, script, { timeoutMs: FILE_OP_TIMEOUT_MS });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `读取失败（退出码 ${result.code}）`);
	return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

async function remoteAccess(host: SshHost, path: string, mode: "r" | "rw"): Promise<void> {
	const test = mode === "r" ? '[ -f "$p" ] && [ -r "$p" ]' : '[ -f "$p" ] && [ -r "$p" ] && [ -w "$p" ]';
	const result = await sshExec(host, `p=${shQuote(path)}\n${test}`, { timeoutMs: 20_000 });
	if (result.code !== 0) {
		if (result.code === 255) {
			if (isHostKeyChangedError(result.stderr)) throw hostKeyChangedError(host, result.stderr);
			throw new Error(result.stderr.trim() || "SSH 连接失败");
		}
		const error = new Error(`ENOENT: 文件不存在或没有权限：${path}`) as Error & { code: string };
		error.code = "ENOENT";
		throw error;
	}
}

/**
 * 远程执行命令：bash -lc 包一层（没有 bash 时退回 sh），setsid 让命令自成进程组，
 * 中断 / 超时时用 ssh 再发一条 kill 结束整组，避免远端遗留进程。
 */
function remoteBashOps(target: OpsTarget): BashOperations {
	return {
		exec: (command, _cwd, { onData, signal, timeout }) =>
			new Promise((resolvePromise, reject) => {
				const { host, remoteCwd } = target;
				const marker = `FLOWORK_PGID_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				const encoded = Buffer.from(command, "utf8").toString("base64");
				// 先输出进程组号（单独一行，带标记），再执行命令；stdin 关闭，防止交互式命令卡住
				const script = [
					`cd ${shQuote(remoteCwd)} 2>/dev/null || cd ~`,
					"export DEBIAN_FRONTEND=noninteractive LANG=${LANG:-C.UTF-8} SYSTEMD_PAGER= PAGER=cat GIT_PAGER=cat",
					`cmd=$(printf %s ${shQuote(encoded)} | base64 -d)`,
					'if command -v bash >/dev/null 2>&1; then sh_bin=bash; else sh_bin=sh; fi',
					'if command -v setsid >/dev/null 2>&1; then',
					`  setsid "$sh_bin" -c 'echo "${marker}:$$" >&2; exec "$0" -lc "$1"' "$sh_bin" "$cmd" < /dev/null`,
					"else",
					`  echo "${marker}:$$" >&2; "$sh_bin" -lc "$cmd" < /dev/null`,
					"fi",
				].join("\n");
				const { command: ssh, args } = sshTerminalArgsRaw(host, script);
				const child = spawn(ssh, args, { env: sshEnv(host), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
				let pgid: string | null = null;
				let stderrHead = "";
				let settled = false;
				let timer: NodeJS.Timeout | undefined;

				const killRemote = () => {
					if (!pgid) return;
					void sshExec(host, `kill -TERM -${pgid} 2>/dev/null; sleep 1; kill -KILL -${pgid} 2>/dev/null; true`, { timeoutMs: 15_000 }).catch(() => undefined);
				};
				const finish = (fn: () => void) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					fn();
				};
				const onAbort = () => {
					killRemote();
					child.kill();
					finish(() => reject(new Error("aborted")));
				};

				child.stdout.on("data", (chunk: Buffer) => onData(chunk));
				child.stderr.on("data", (chunk: Buffer) => {
					if (pgid === null) {
						// 进程组号所在的那一行不交给模型
						stderrHead += chunk.toString("utf8");
						const idx = stderrHead.indexOf(`${marker}:`);
						if (idx === -1) {
							if (stderrHead.length > 4096) {
								onData(Buffer.from(stderrHead));
								stderrHead = "";
							}
							return;
						}
						const end = stderrHead.indexOf("\n", idx);
						if (end === -1) return;
						pgid = stderrHead.slice(idx + marker.length + 1, end).trim();
						const rest = stderrHead.slice(0, idx) + stderrHead.slice(end + 1);
						stderrHead = "";
						if (rest) onData(Buffer.from(rest));
						return;
					}
					onData(chunk);
				});
				child.on("error", (error) => finish(() => reject(error)));
				child.on("close", (code) => {
					if (pgid === null && code === 255 && isHostKeyChangedError(stderrHead)) {
						finish(() => reject(hostKeyChangedError(host, stderrHead)));
						return;
					}
					if (stderrHead) onData(Buffer.from(stderrHead));
					finish(() => {
						// 255 是 ssh 自身失败（连接 / 认证）；命令本身返回 255 的情况较少，同样按失败处理
						resolvePromise({ exitCode: code });
					});
				});

				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				if (timeout !== undefined && timeout > 0) {
					timer = setTimeout(() => {
						killRemote();
						child.kill();
						finish(() => reject(new Error(`timeout:${timeout}`)));
					}, timeout * 1000);
				}
			}),
	};
}

function remoteReadOps(target: OpsTarget): ReadOperations {
	return {
		readFile: (p) => remoteRead(target.host, toRemotePath(p, target)),
		access: (p) => remoteAccess(target.host, toRemotePath(p, target), "r"),
		detectImageMimeType: async (p) => {
			const mime = await sshRun(target.host, `file --mime-type -b ${shQuote(toRemotePath(p, target))} 2>/dev/null || true`, { timeoutMs: 20_000 }).catch(() => "");
			const m = mime.trim();
			return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
		},
	};
}

/** 记录每次写入产生的备份，tool_result 时取出放进结果 */
export class BackupLog {
	private readonly byPath = new Map<string, string>();
	set(remotePath: string, backup: string | null): void {
		if (backup) this.byPath.set(remotePath, backup);
		else this.byPath.delete(remotePath);
	}
	take(remotePath: string): string | undefined {
		const value = this.byPath.get(remotePath);
		this.byPath.delete(remotePath);
		return value;
	}
}

function remoteWriteOps(target: OpsTarget, backups: BackupLog): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const remote = toRemotePath(p, target);
			backups.set(remote, await remoteWrite(target.host, remote, content));
		},
		// remoteWrite 自己会 mkdir -p
		mkdir: async () => undefined,
	};
}

function remoteEditOps(target: OpsTarget, backups: BackupLog): EditOperations {
	return {
		readFile: (p) => remoteRead(target.host, toRemotePath(p, target)),
		access: (p) => remoteAccess(target.host, toRemotePath(p, target), "rw"),
		writeFile: async (p, content) => {
			const remote = toRemotePath(p, target);
			backups.set(remote, await remoteWrite(target.host, remote, content));
		},
	};
}

/** 运维会话的系统提示词：主机画像 + 运维守则 */
export function opsSystemPrompt(target: OpsTarget, profile: HostProfile | null): string {
	const who = `${target.host.user ?? "（ssh 默认用户）"}@${target.host.host}${target.host.port ? `:${target.host.port}` : ""}`;
	const lines = [
		`You are operating a remote server over SSH as ${who}. Every tool runs ON THAT SERVER, not on the user's machine.`,
		`Remote working directory: ${target.remoteCwd}. Use absolute POSIX paths (e.g. /etc/nginx/nginx.conf) for files outside it.`,
	];
	if (profile) {
		lines.push("", "Host profile (probed at session start):");
		for (const [k, v] of Object.entries(profile.facts)) if (v) lines.push(`- ${k}: ${v}`);
	}
	lines.push(
		"",
		"Operations rules:",
		"- Inspect before changing: check OS, service status, existing config and logs first.",
		"- Use the package manager listed above; always pass non-interactive flags (apt-get -y, dnf -y, DEBIAN_FRONTEND=noninteractive is already set).",
		"- Never run interactive or never-ending commands (vim, nano, top, less, tail -f, journalctl -f, watch, mysql_secure_installation). Use non-interactive forms (head/tail -n, journalctl -n 200 --no-pager, top -b -n 1) or tell the user to run it in the terminal panel.",
		"- Edit configs with the edit/write tools (FloWork backs up the original file automatically and reports the backup path). For bulk changes made via shell, back up first: cp -p file file.bak-$(date +%F-%H%M%S).",
		"- After changing a service config, validate before reloading (nginx -t, sshd -t, apachectl configtest, systemd-analyze verify, docker compose config) and then prefer reload over restart.",
		"- Do NOT change SSH port/config, firewall default policies, root password, or anything that could lock this SSH session out, unless the user explicitly asks; if asked, explain the risk and keep a rollback path.",
		"- Prefer idempotent commands; check whether something is already installed/configured before doing it again.",
		"- Long-running installs/builds: pass a generous timeout to the bash tool.",
		"- Summarize what you changed at the end (files, services, packages) and how to roll back.",
		"- Reply to the user in the language they use.",
	);
	return lines.join("\n");
}

/** 运维扩展：注册远程工具，并把 pi 系统提示词里的本地 cwd 换成远程信息 */
export function createOpsExtension(target: OpsTarget, getProfile: () => HostProfile | null, backups: BackupLog): ExtensionFactory {
	return (pi) => {
		const { localCwd } = target;
		pi.registerTool(createBashToolDefinition(localCwd, { operations: remoteBashOps(target), exposeSessionEnvironment: false }));
		pi.registerTool(createReadToolDefinition(localCwd, { operations: remoteReadOps(target), autoResizeImages: true }));
		pi.registerTool(createWriteToolDefinition(localCwd, { operations: remoteWriteOps(target, backups) }));
		pi.registerTool(createEditToolDefinition(localCwd, { operations: remoteEditOps(target, backups) }));

		pi.on("session_start", () => {
			// 运维会话只保留远程执行的四个工具（grep / find / ls 由 bash 完成，PowerShell 等本地工具不应出现）
			pi.setActiveTools(["bash", "read", "write", "edit"]);
		});

		pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.cwd = `${target.remoteCwd} (on remote host ${target.host.host}, via SSH)`;
			event.systemPromptOptions.appendSystemPrompt = [event.systemPromptOptions.appendSystemPrompt, opsSystemPrompt(target, getProfile())].filter(Boolean).join("\n\n");
			// 本地占位目录里没有项目说明文件；避免把本机的 AGENTS.md 等误当成服务器上下文
			event.systemPromptOptions.contextFiles = [];
			return undefined;
		});

		// 用户在输入框用 ! 执行的命令同样走远程
		pi.on("user_bash", () => ({ operations: remoteBashOps(target) }));

		pi.on("tool_result", (event) => {
			if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return undefined;
			const input = event.input as { path?: unknown };
			if (typeof input.path !== "string") return undefined;
			const remote = toRemotePath(resolve(localCwd, input.path.replace(/^@/, "")), target);
			const backup = backups.take(remote);
			const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			// 结果里的路径是本地占位路径，换成远程路径；再补上备份位置
			const fixed = text.replace(/(Successfully (?:wrote to|replaced \d+ block\(s\) in) ).*?(\.?)$/, `$1${remote}$2`);
			const note = backup ? `\nBackup of the previous version: ${backup}` : "";
			const details = { ...((event.details as object | undefined) ?? {}), remotePath: remote, backupPath: backup };
			return { content: [{ type: "text", text: fixed + note }], details };
		});
	};
}

// 供 SessionHost 使用：探测主机画像
export { probeHostProfile } from "../core/host-profile";
