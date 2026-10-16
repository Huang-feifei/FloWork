/**
 * 真终端（PTY）：按项目目录维护长期存活的 shell。
 *
 * 与会话不同，终端不绑定客户端连接——网页版刷新页面不该杀掉正在跑的命令。
 * 生命周期改为按 cwd 归属：同一个 cwd 复用同一个终端，项目被移除（projects.remove）
 * 或后端关闭（Backend.shutdown）时才结束。输出不回放，重连后界面只收到之后的数据。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
import type { BackendMethods, BackendPush, SshHost } from "@shared/protocol";
import { isDirectory } from "./fs";
import { findGitBash, withGitBashOnPath } from "./git-bash";
import { getPiAgentDir } from "./paths";
import { samePath } from "./projects";
import { remoteIsDirectory } from "./remote-fs";
import { shQuote, sshEnv, sshTerminalArgs } from "./ssh";

export type TerminalOpenParams = BackendMethods["terminal.open"]["params"];
export type TerminalOpenResult = BackendMethods["terminal.open"]["result"];
export type TerminalWriteParams = BackendMethods["terminal.write"]["params"];
export type TerminalResizeParams = BackendMethods["terminal.resize"]["params"];
export type TerminalCloseParams = BackendMethods["terminal.close"]["params"];

/**
 * 尺寸收敛范围。越界不报错而是 clamp：界面布局或 fit 计算偶尔给出极端值，
 * 报错只会打断用户输入，而 clamp 到合理范围总是可用的。
 */
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 200;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface TerminalEntry {
	id: string;
	cwd: string;
	shell: string;
	/** 所属远程主机；本地终端为 undefined */
	hostId?: string;
	pty: IPty;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** settings.json 中的 shellPath；文件不存在或解析失败都按未设置处理（只读，不写回） */
function settingsShellPath(): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(getPiAgentDir(), "settings.json"), "utf8")) as { shellPath?: unknown };
		const value = parsed.shellPath;
		if (typeof value === "string" && value.trim()) return value.trim();
	} catch {
		// 未配置或不是合法 JSON
	}
	return undefined;
}

/** 解析顺序：settings.json 的 shellPath → Windows 自动识别的 Git Bash → $SHELL → 非 Windows 兜底 /bin/bash */
function resolveShell(): { path: string; args: string[] } {
	const candidates = [
		settingsShellPath(),
		process.platform === "win32" ? findGitBash() : null,
		process.env.SHELL,
		process.platform === "win32" ? null : "/bin/bash",
	];
	const shell = candidates.find((candidate): candidate is string => !!candidate?.trim());
	if (!shell) {
		throw new Error("未找到可用的 bash：请安装 Git for Windows，或在设置里填写 shellPath");
	}
	// bash 加 -i 才会加载提示符与 .bashrc；其它 shell 的参数约定不同，不猜
	const name = basename(shell).toLowerCase();
	const args = name === "bash" || name === "bash.exe" ? ["-i"] : [];
	return { path: shell, args };
}

export class TerminalManager {
	/** terminalId → 终端。按 cwd 复用需要线性查找，但同时存活的终端数量很小 */
	private readonly terminals = new Map<string, TerminalEntry>();

	constructor(
		private readonly emit: (push: BackendPush) => void,
		/** 解析远程主机；未注入或找不到时远程终端不可用 */
		private readonly resolveHost?: (id: string) => Promise<SshHost>,
	) {}

	async open(params: TerminalOpenParams): Promise<TerminalOpenResult> {
		if (typeof params?.cwd !== "string" || !params.cwd.trim()) throw new Error("终端的工作目录不能为空");
		const host = params.hostId ? await this.resolveHost?.(params.hostId) : undefined;
		if (params.hostId && !host) throw new Error("远程主机不存在，可能已被删除");

		if (host) {
			const cwd = params.cwd.trim();
			if (!cwd.startsWith("/")) throw new Error(`远程终端的工作目录必须是绝对路径：${cwd}`);
			if (!(await remoteIsDirectory(host, cwd))) throw new Error(`远程目录不存在或不是文件夹：${cwd}`);
			const existing = [...this.terminals.values()].find((entry) => entry.hostId === host.id && entry.cwd === cwd);
			if (existing) return { terminalId: existing.id, shell: existing.shell, reused: true };
			return this.spawnRemote(host, cwd, params);
		}

		// 相对路径会让 pty 落在后端进程的当前目录，与界面显示的项目不符，直接拒绝
		if (!isAbsolute(params.cwd)) throw new Error(`终端的工作目录必须是绝对路径：${params.cwd}`);
		const cwd = resolve(params.cwd);
		if (!(await isDirectory(cwd))) throw new Error(`终端的工作目录不存在或不是文件夹：${cwd}`);

		const existing = [...this.terminals.values()].find((entry) => !entry.hostId && samePath(entry.cwd, cwd));
		if (existing) return { terminalId: existing.id, shell: existing.shell, reused: true };

		const { path: shell, args } = resolveShell();
		const cols = clamp(params.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
		const rows = clamp(params.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);
		const id = randomUUID();
		let child: IPty;
		try {
			child = spawnPty(shell, args, {
				name: "xterm-256color",
				cols,
				rows,
				cwd,
				// Git Bash 的 bin 必须在 PATH 最前面，否则子进程里的 git 等工具会落到 WSL 的 bash
				env: { ...withGitBashOnPath(process.env), TERM: "xterm-256color" },
			});
		} catch (error) {
			throw new Error(`无法启动 shell（${shell}）：${error instanceof Error ? error.message : String(error)}`);
		}
		return this.attach({ id, cwd, shell, pty: child });
	}

	/** 远程终端：直接 spawn `ssh -tt`，远程侧 cd 到项目目录后起登录 shell */
	private spawnRemote(host: SshHost, cwd: string, params: TerminalOpenParams): TerminalOpenResult {
		const cols = clamp(params.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
		const rows = clamp(params.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);
		const remoteCommand = `cd ${shQuote(cwd)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`;
		const { command, args } = sshTerminalArgs(host, remoteCommand);
		const id = randomUUID();
		let child: IPty;
		try {
			child = spawnPty(command, args, {
				name: "xterm-256color",
				cols,
				rows,
				// ssh 是本地进程，cwd 必须是本地存在的目录
				cwd: homedir(),
				env: { ...sshEnv(host), TERM: "xterm-256color" },
			});
		} catch (error) {
			throw new Error(`无法连接远程主机（${host.user ? `${host.user}@` : ""}${host.host}）：${error instanceof Error ? error.message : String(error)}`);
		}
		return this.attach({ id, cwd, shell: `ssh ${host.user ? `${host.user}@` : ""}${host.host}`, hostId: host.id, pty: child });
	}

	/** 登记终端并挂上输出 / 退出回调 */
	private attach(entry: TerminalEntry): TerminalOpenResult {
		this.terminals.set(entry.id, entry);
		entry.pty.onData((data) => this.emit({ type: "terminal_data", terminalId: entry.id, data }));
		entry.pty.onExit(({ exitCode }) => {
			// 已显式 close 的终端不在表里：那条路径由调用方负责，这里只处理自行退出（exit、崩溃）
			if (this.terminals.get(entry.id) !== entry) return;
			this.terminals.delete(entry.id);
			this.emit({ type: "terminal_exit", terminalId: entry.id, code: exitCode });
		});
		return { terminalId: entry.id, shell: entry.shell, reused: false };
	}

	/** 透传原始按键数据（含 \r）。id 不存在说明终端已退出，报错让界面重新 open */
	write(params: TerminalWriteParams): null {
		const entry = this.require(params?.terminalId);
		if (typeof params.data !== "string") throw new Error("terminal.write 的 data 必须是字符串");
		entry.pty.write(params.data);
		return null;
	}

	resize(params: TerminalResizeParams): null {
		const entry = this.require(params?.terminalId);
		const cols = clamp(params.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
		const rows = clamp(params.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);
		try {
			entry.pty.resize(cols, rows);
		} catch {
			// 进程刚退出、onExit 尚未回调时会失败，随后的 terminal_exit 会通知界面
		}
		return null;
	}

	/** 关闭终端并移除；id 不存在时什么都不做（界面关闭与项目移除可能同时发生） */
	close(params: TerminalCloseParams): null {
		const entry = this.terminals.get(params?.terminalId);
		if (!entry) return null;
		this.terminals.delete(entry.id);
		this.kill(entry);
		return null;
	}

	/** 项目被移除时关闭它名下的终端（hostId 区分本地与远程） */
	closeByCwd(cwd: string, hostId?: string): void {
		for (const entry of [...this.terminals.values()]) {
			if (entry.hostId !== hostId) continue;
			if (hostId ? entry.cwd !== cwd : !samePath(entry.cwd, cwd)) continue;
			this.terminals.delete(entry.id);
			this.kill(entry);
		}
	}

	/** 远程主机被移除时关闭它名下的所有终端 */
	closeByHost(hostId: string): void {
		for (const entry of [...this.terminals.values()]) {
			if (entry.hostId !== hostId) continue;
			this.terminals.delete(entry.id);
			this.kill(entry);
		}
	}

	/** 后端关闭：结束所有终端，避免留下孤儿 shell */
	closeAll(): void {
		const entries = [...this.terminals.values()];
		this.terminals.clear();
		for (const entry of entries) this.kill(entry);
	}

	private kill(entry: TerminalEntry): void {
		try {
			entry.pty.kill();
		} catch {
			// 已经退出的 pty 再 kill 会抛错
		}
	}

	private require(terminalId: string): TerminalEntry {
		const entry = typeof terminalId === "string" ? this.terminals.get(terminalId) : undefined;
		if (!entry) throw new Error(`终端不存在或已退出：${terminalId}`);
		return entry;
	}
}
