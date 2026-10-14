/**
 * 真终端（xterm.js）：每个项目目录一个实例。
 *
 * 实例与它的 DOM 容器放在模块级 Map 里，而不是组件状态里：底部面板收起、切页签、切项目都会卸载组件，
 * 但 shell 进程与滚动历史要留着。组件只负责把容器挂到面板上 / 从面板上摘下来，并切换显示；
 * 只有项目被停止或移除（store 调 disposeTerminal）才真正销毁实例。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, errorText } from "../../api/client";
import { isMac } from "../../lib/desktop";
import { normalizedPath, useApp } from "../../store";
import { Icon } from "../Icon";

/** 与应用深色主题协调：取自 styles.css 的 token（xterm 只认具体色值） */
const THEME: ITheme = {
	background: "#11141a",
	foreground: "#dfe3ea",
	cursor: "#f0883e",
	cursorAccent: "#11141a",
	selectionBackground: "#f0883e55",
	selectionInactiveBackground: "#f0883e33",
	scrollbarSliderBackground: "#ffffff29",
	scrollbarSliderHoverBackground: "#ffffff47",
	scrollbarSliderActiveBackground: "#ffffff59",
	black: "#2f343c",
	red: "#f85149",
	green: "#56d364",
	yellow: "#e3b341",
	blue: "#6cb6ff",
	magenta: "#d2a8ff",
	cyan: "#56d4dd",
	white: "#c9d1d9",
	brightBlack: "#66707c",
	brightRed: "#ff7b72",
	brightGreen: "#7ee787",
	brightYellow: "#ffd76a",
	brightBlue: "#a5d6ff",
	brightMagenta: "#e2c5ff",
	brightCyan: "#9fe8f0",
	brightWhite: "#f0f3f6",
};

const FONT_FAMILY = '"Cascadia Mono", "JetBrains Mono", "Sarasa Mono SC", Consolas, "Microsoft YaHei UI", monospace';

/** 拖动窗口时会连续触发尺寸变化，等停稳再算一次，免得狂发 resize */
const FIT_DEBOUNCE_MS = 150;

type Status = "idle" | "opening" | "running" | "exited" | "error";

/** 供 React 渲染标题行的快照；变化时整体替换，useSyncExternalStore 靠它判断 */
interface EntryView {
	status: Status;
	shell: string | null;
	exitCode: number | null;
	error: string | null;
}

interface Entry {
	cwd: string;
	term: Terminal;
	fit: FitAddon;
	container: HTMLDivElement;
	view: EntryView;
	listeners: Set<() => void>;
	/** 后端返回的终端 id；为空表示还没 open */
	terminalId: string | null;
	opened: boolean;
	disposed: boolean;
	fitTimer: number | null;
}

const EMPTY_VIEW: EntryView = { status: "idle", shell: null, exitCode: null, error: null };

const entries = new Map<string, Entry>();
let listening = false;

function setView(entry: Entry, patch: Partial<EntryView>): void {
	entry.view = { ...entry.view, ...patch };
	for (const listener of entry.listeners) listener();
}

function subscribeEntry(entry: Entry, listener: () => void): () => void {
	entry.listeners.add(listener);
	return () => entry.listeners.delete(listener);
}

function byTerminalId(terminalId: string): Entry | undefined {
	for (const entry of entries.values()) if (entry.terminalId === terminalId) return entry;
	return undefined;
}

/**
 * open 的响应还没回来时到达的输出先攒着：shell 的启动横幅可能抢在响应前面到，
 * 那时还不知道 terminalId 属于谁，直接丢掉会让终端空着等用户敲回车。
 */
const orphan = new Map<string, string[]>();
const ORPHAN_MS = 5000;
const ORPHAN_LIMIT = 8;

function stash(terminalId: string, data: string): void {
	const chunks = orphan.get(terminalId);
	if (chunks) chunks.push(data);
	else if (orphan.size < ORPHAN_LIMIT) orphan.set(terminalId, [data]);
	// 一直没人认领（例如别的窗口开的终端）就不要再留着
	window.setTimeout(() => orphan.delete(terminalId), ORPHAN_MS);
}

function createEntry(cwd: string): Entry {
	const container = document.createElement("div");
	container.style.width = "100%";
	container.style.height = "100%";
	container.style.overflow = "hidden";
	const term = new Terminal({
		theme: THEME,
		fontFamily: FONT_FAMILY,
		fontSize: 12.5,
		lineHeight: 1.3,
		scrollback: 5000,
		cursorBlink: true,
		macOptionIsMeta: true,
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	// Ctrl+` 是收起面板的全局快捷键，终端聚焦时也要交给应用处理（其余组合键留给 shell）
	term.attachCustomKeyEventHandler((event) => !(event.type === "keydown" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key === "`"));
	const entry: Entry = {
		cwd,
		term,
		fit,
		container,
		view: EMPTY_VIEW,
		listeners: new Set(),
		terminalId: null,
		opened: false,
		disposed: false,
		fitTimer: null,
	};
	term.onData((data) => {
		if (entry.terminalId) void api.terminal.write(entry.terminalId, data).catch(() => undefined);
	});
	// 尺寸由 fit() 决定，后端跟着渲染层走；终端还没 open 时不需要通知
	term.onResize(({ cols, rows }) => {
		if (entry.terminalId) void api.terminal.resize(entry.terminalId, cols, rows).catch(() => undefined);
	});
	return entry;
}

/** 终端推送单独订阅：输出量大，没必要每条都穿过 store */
function listen(): void {
	if (listening) return;
	listening = true;
	api.onPush((push) => {
		if (push.type !== "terminal_data" && push.type !== "terminal_exit") return;
		const entry = byTerminalId(push.terminalId);
		if (!entry) {
			if (push.type === "terminal_data") stash(push.terminalId, push.data);
			return;
		}
		if (push.type === "terminal_data") {
			entry.term.write(push.data);
			return;
		}
		entry.term.write(`\r\n\x1b[2m[终端已退出，退出码 ${push.code}]\x1b[0m\r\n`);
		setView(entry, { status: "exited", exitCode: push.code });
	});
}

function getOrCreate(cwd: string): Entry {
	const key = normalizedPath(cwd);
	const existing = entries.get(key);
	if (existing && !existing.disposed) return existing;
	const entry = createEntry(cwd);
	entries.set(key, entry);
	listen();
	return entry;
}

/** 项目被停止 / 移除时释放；界面上的收起面板、切项目只隐藏不销毁 */
export function disposeTerminal(cwd: string): void {
	const key = normalizedPath(cwd);
	const entry = entries.get(key);
	if (!entry) return;
	entries.delete(key);
	entry.disposed = true;
	if (entry.fitTimer !== null) {
		clearTimeout(entry.fitTimer);
		entry.fitTimer = null;
	}
	const terminalId = entry.terminalId;
	entry.terminalId = null;
	entry.listeners.clear();
	entry.term.dispose();
	entry.container.remove();
	// 项目已经停了，收 shell 失败也没别的可做
	if (terminalId) void api.terminal.close(terminalId).catch(() => undefined);
}

/** 容器不可测量（隐藏 / 面板正在收起）时 fit() 会抛错，忽略即可 */
function applyFit(entry: Entry): void {
	if (entry.disposed || entry.container.style.display === "none" || !entry.container.isConnected) return;
	try {
		entry.fit.fit();
	} catch {
		return;
	}
}

function scheduleFit(entry: Entry): void {
	if (entry.fitTimer !== null) clearTimeout(entry.fitTimer);
	entry.fitTimer = window.setTimeout(() => {
		entry.fitTimer = null;
		applyFit(entry);
	}, FIT_DEBOUNCE_MS);
}

async function openEntry(entry: Entry): Promise<void> {
	if (entry.disposed || entry.terminalId || entry.view.status === "opening") return;
	setView(entry, { status: "opening", error: null });
	const cols = entry.term.cols;
	const rows = entry.term.rows;
	try {
		const result = await api.terminal.open(entry.cwd, cols, rows);
		if (entry.disposed) {
			// 打开过程中项目被关掉：把刚起的 shell 收掉
			void api.terminal.close(result.terminalId).catch(() => undefined);
			return;
		}
		entry.terminalId = result.terminalId;
		// 等 open 返回的这段时间尺寸可能又变了（面板刚展开时布局还在落定），补一次 resize 免得 PTY 停在旧尺寸
		if (entry.term.cols !== cols || entry.term.rows !== rows) {
			void api.terminal.resize(entry.terminalId, entry.term.cols, entry.term.rows).catch(() => undefined);
		}
		const buffered = orphan.get(result.terminalId);
		if (buffered) {
			orphan.delete(result.terminalId);
			for (const chunk of buffered) entry.term.write(chunk);
		}
		setView(entry, { status: "running", shell: result.shell, exitCode: null, error: null });
	} catch (error) {
		const text = errorText(error);
		entry.term.write(`\r\n\x1b[31m[终端启动失败] ${text}\x1b[0m\r\n`);
		setView(entry, { status: "error", error: text });
	}
}

/** 重新启动：先关掉旧 shell（可能已经退出），清屏后重新 open */
async function restart(entry: Entry): Promise<void> {
	if (entry.disposed || entry.view.status === "opening") return;
	const previous = entry.terminalId;
	entry.terminalId = null;
	setView(entry, { status: "idle", exitCode: null, error: null });
	entry.term.reset();
	if (previous) await api.terminal.close(previous).catch(() => undefined);
	await openEntry(entry);
}

function attach(entry: Entry, host: HTMLDivElement): void {
	if (entry.container.parentElement !== host) host.appendChild(entry.container);
	entry.container.style.display = "";
	for (const other of entries.values()) if (other !== entry) other.container.style.display = "none";
	if (!entry.opened) {
		entry.opened = true;
		entry.term.open(entry.container);
	}
	// 面板刚打开时先按真实尺寸 fit 再 open，避免后端以 80x24 起步
	applyFit(entry);
	entry.term.refresh(0, entry.term.rows - 1);
	if (entry.view.status === "idle") void openEntry(entry);
	entry.term.focus();
}

function statusText(view: EntryView): string {
	switch (view.status) {
		case "running":
			return "运行中";
		case "exited":
			return `已退出（退出码 ${view.exitCode ?? "?"}）`;
		case "error":
			return "启动失败";
		default:
			return "启动中…";
	}
}

function statusDot(status: Status): string {
	if (status === "running") return "bg-ok";
	if (status === "error") return "bg-err";
	if (status === "exited") return "bg-faint";
	return "bg-warn";
}

function useTerminalView(entry: Entry | null): EntryView {
	const subscribe = useCallback(
		(listener: () => void) => (entry ? subscribeEntry(entry, listener) : () => undefined),
		[entry],
	);
	const snapshot = useCallback(() => entry?.view ?? EMPTY_VIEW, [entry]);
	return useSyncExternalStore(subscribe, snapshot);
}

export function TerminalTab() {
	const cwd = useApp((s) => s.cwd);
	const [entry, setEntry] = useState<Entry | null>(null);
	const hostRef = useRef<HTMLDivElement>(null);
	const view = useTerminalView(entry);

	// 懒启动：终端页签真正显示（本组件被挂载）时才创建实例
	useEffect(() => {
		setEntry(cwd ? getOrCreate(cwd) : null);
	}, [cwd]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || !entry) return;
		attach(entry, host);
		const observer = new ResizeObserver(() => scheduleFit(entry));
		observer.observe(host);
		return () => {
			observer.disconnect();
			if (entry.fitTimer !== null) {
				clearTimeout(entry.fitTimer);
				entry.fitTimer = null;
			}
		};
	}, [entry]);

	if (!cwd) {
		return (
			<div className="term min-h-0 flex-1 overflow-y-auto px-4 pb-3 text-[12.5px] leading-[1.8]">
				<div className="text-muted">打开一个项目后，这里会出现该项目目录下的终端。</div>
				<div className="text-faint">按 {isMac ? "⌘`" : "Ctrl+`"} 收起本面板。</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-6 shrink-0 items-center gap-2 border-b border-border px-3 font-mono text-[11px]">
				<span className={`size-1.5 shrink-0 rounded-full ${statusDot(view.status)}`} />
				<span className="shrink-0 text-muted">{statusText(view)}</span>
				<span
					className="min-w-0 truncate text-faint"
					title={cwd}
				>
					{cwd}
				</span>
				<div className="flex-1" />
				{view.error ? (
					<span
						className="max-w-[45%] min-w-0 truncate text-err"
						title={view.error}
					>
						{view.error}
					</span>
				) : (
					view.shell && (
						<span
							className="max-w-[45%] min-w-0 truncate text-faint"
							title={view.shell}
						>
							{view.shell}
						</span>
					)
				)}
				{(view.status === "exited" || view.status === "error") && (
					<button
						type="button"
						onClick={() => entry && void restart(entry)}
						className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg"
					>
						<Icon
							name="refresh"
							className="size-3"
						/>
						重新启动终端
					</button>
				)}
			</div>
			<div
				ref={hostRef}
				className="min-h-0 flex-1 px-2 py-1"
			/>
		</div>
	);
}
