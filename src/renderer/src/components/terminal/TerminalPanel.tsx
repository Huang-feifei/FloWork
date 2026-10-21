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
import { Button, Field, Input, Modal, Select } from "../ui";
import { setTerminalDisposer } from "./terminal-disposer";

/** xterm 只认具体色值，这里给出深 / 浅两套，与 styles.css 的 token 对应 */
const DARK_THEME: ITheme = {
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

const LIGHT_THEME: ITheme = {
	background: "#ffffff",
	foreground: "#1b2027",
	cursor: "#d9701f",
	cursorAccent: "#ffffff",
	selectionBackground: "#d9701f40",
	selectionInactiveBackground: "#d9701f26",
	scrollbarSliderBackground: "#0f172a29",
	scrollbarSliderHoverBackground: "#0f172a47",
	scrollbarSliderActiveBackground: "#0f172a59",
	black: "#24292f",
	red: "#cf222e",
	green: "#1a7f37",
	yellow: "#9a6700",
	blue: "#0969da",
	magenta: "#8250df",
	cyan: "#1b7c83",
	white: "#6e7781",
	brightBlack: "#57606a",
	brightRed: "#a40e26",
	brightGreen: "#116329",
	brightYellow: "#7d4e00",
	brightBlue: "#0550ae",
	brightMagenta: "#6639ba",
	brightCyan: "#3192aa",
	brightWhite: "#24292f",
};

/** 新建终端实例时按当前主题取色（后续切换由 TerminalTab 的 effect 统一更新） */
function terminalTheme(): ITheme {
	return useApp.getState().resolvedTheme === "dark" ? DARK_THEME : LIGHT_THEME;
}

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
	/** 远程项目所属主机；为空表示本地终端 */
	hostId?: string;
	hostKeyWarned?: boolean;
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

/** 连接列表的订阅：entries 的增删与状态变化都改这个版本号，供连接条重渲染 */
const listListeners = new Set<() => void>();
let listVersion = 0;

function bumpList(): void {
	listVersion += 1;
	for (const listener of listListeners) listener();
}

function subscribeList(listener: () => void): () => void {
	listListeners.add(listener);
	return () => listListeners.delete(listener);
}

function listSnapshot(): number {
	return listVersion;
}

/** 订阅连接列表；返回版本号，值不重要，只用于触发重渲染 */
function useTerminalList(): number {
	return useSyncExternalStore(subscribeList, listSnapshot, listSnapshot);
}

/** 连接条上的显示名 */
function connectionLabel(entry: Entry): string {
	if (!entry.hostId) return "本地";
	const host = useApp.getState().hosts.find((h) => h.id === entry.hostId);
	return host ? host.name || `${host.user ? `${host.user}@` : ""}${host.host}` : "远程主机";
}

function setView(entry: Entry, patch: Partial<EntryView>): void {
	entry.view = { ...entry.view, ...patch };
	for (const listener of entry.listeners) listener();
	bumpList();
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

/** 远程终端输出里出现主机密钥变化：弹出处理对话框（每个终端实例只弹一次） */
function watchHostKey(entry: Entry, data: string): void {
	if (!entry.hostId || entry.hostKeyWarned) return;
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(data)) {
		entry.hostKeyWarned = true;
		useApp.getState().setHostKeyPrompt(entry.hostId);
	}
}

function stash(terminalId: string, data: string): void {
	const chunks = orphan.get(terminalId);
	if (chunks) chunks.push(data);
	else if (orphan.size < ORPHAN_LIMIT) orphan.set(terminalId, [data]);
	// 一直没人认领（例如别的窗口开的终端）就不要再留着
	window.setTimeout(() => orphan.delete(terminalId), ORPHAN_MS);
}

function createEntry(cwd: string, hostId?: string): Entry {
	const container = document.createElement("div");
	container.style.width = "100%";
	container.style.height = "100%";
	container.style.overflow = "hidden";
	const term = new Terminal({
		theme: terminalTheme(),
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
		hostId,
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
			watchHostKey(entry, push.data);
			return;
		}
		entry.term.write(`\r\n\x1b[2m[终端已退出，退出码 ${push.code}]\x1b[0m\r\n`);
		setView(entry, { status: "exited", exitCode: push.code });
	});
}

/** 远程终端按「主机 + 路径」区分：不同主机上的 /root 是不同的终端 */
function entryKey(cwd: string, hostId?: string): string {
	return hostId ? `${hostId}\0${cwd}` : normalizedPath(cwd);
}

function getOrCreate(cwd: string, hostId?: string): Entry {
	const key = entryKey(cwd, hostId);
	const existing = entries.get(key);
	if (existing && !existing.disposed) return existing;
	const entry = createEntry(cwd, hostId);
	entries.set(key, entry);
	listen();
	bumpList();
	return entry;
}

/** 项目被停止 / 移除时释放；界面上的收起面板、切项目只隐藏不销毁 */
export function disposeTerminal(cwd: string, hostId?: string): void {
	const key = entryKey(cwd, hostId);
	const entry = entries.get(key);
	if (!entry) return;
	entries.delete(key);
	entry.disposed = true;
	bumpList();
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

// 只有终端模块真正加载后才接管释放；store 不再静态依赖 xterm。
setTerminalDisposer(disposeTerminal);

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
		const result = await api.terminal.open(entry.cwd, cols, rows, entry.hostId);
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
			for (const chunk of buffered) {
				entry.term.write(chunk);
				watchHostKey(entry, chunk);
			}
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
	entry.hostKeyWarned = false;
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

/** 新建终端连接：选主机（含本地终端）与起始目录 */
function ConnectDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (cwd: string, hostId?: string) => void }) {
	const hosts = useApp((s) => s.hosts);
	const projectCwd = useApp((s) => s.cwd);
	const [hostId, setHostId] = useState("");
	const [dir, setDir] = useState(projectCwd ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 选主机后预填目录：优先主机设置的默认目录，否则取远端 home
	useEffect(() => {
		if (!hostId) {
			setDir(projectCwd ?? "");
			setError(null);
			return;
		}
		const host = hosts.find((h) => h.id === hostId);
		if (host?.defaultPath) {
			setDir(host.defaultPath);
			setError(null);
			return;
		}
		let cancelled = false;
		setBusy(true);
		api.hosts
			.listDirs(hostId)
			.then((r) => {
				if (cancelled) return;
				setDir(r.home);
				setError(null);
			})
			.catch((e) => {
				if (!cancelled) setError(errorText(e));
			})
			.finally(() => {
				if (!cancelled) setBusy(false);
			});
		return () => {
			cancelled = true;
		};
	}, [hostId, hosts, projectCwd]);

	return (
		<Modal
			title="新建终端连接"
			width="w-[460px]"
			onClose={onClose}
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button
						variant="primary"
						disabled={!dir.trim() || busy}
						onClick={() => onOpen(dir.trim(), hostId || undefined)}
					>
						打开终端
					</Button>
				</>
			}
		>
			<div className="space-y-3">
				<Field label="主机">
					<Select
						value={hostId}
						onChange={(e) => setHostId(e.target.value)}
					>
						<option value="">本地终端</option>
						{hosts.map((h) => (
							<option
								key={h.id}
								value={h.id}
							>
								{h.name || `${h.user ? `${h.user}@` : ""}${h.host}`}
							</option>
						))}
					</Select>
				</Field>
				<Field label="起始目录" hint={hostId ? "服务器上的绝对路径" : "本机目录"}>
					<Input
						value={dir}
						onChange={(e) => setDir(e.target.value)}
						placeholder={hostId ? "/root" : (projectCwd ?? "")}
					/>
				</Field>
				{error && <div className="rounded border border-err/40 bg-err-soft px-2 py-1 text-[12px] text-err">{error}</div>}
				{hosts.length === 0 && <div className="text-[12px] text-muted">还没有远程主机：在侧边栏「远程主机」里添加后就能在这里选。</div>}
			</div>
		</Modal>
	);
}

export function TerminalTab() {
	const cwd = useApp((s) => s.cwd);
	const hostId = useApp((s) => s.projects.projects.find((p) => p.id === s.activeProjectId)?.hostId);
	const resolvedTheme = useApp((s) => s.resolvedTheme);
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);
	const hostRef = useRef<HTMLDivElement>(null);
	useTerminalList();

	// 懒启动：终端页签真正显示（本组件被挂载）时才创建当前项目的实例，并切到它
	useEffect(() => {
		if (!cwd) return;
		getOrCreate(cwd, hostId);
		setActiveKey(entryKey(cwd, hostId));
	}, [cwd, hostId]);

	const list = [...entries.values()].filter((item) => !item.disposed);
	const active = list.find((item) => entryKey(item.cwd, item.hostId) === activeKey) ?? list[0] ?? null;
	const view = useTerminalView(active);

	// 主题切换：已创建的终端实例同步换色
	useEffect(() => {
		const theme = resolvedTheme === "dark" ? DARK_THEME : LIGHT_THEME;
		for (const item of entries.values()) item.term.options.theme = theme;
	}, [resolvedTheme]);

	// 把活动终端挂到面板上（attach 会隐藏其它实例）
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !active) return;
		attach(active, host);
		const observer = new ResizeObserver(() => scheduleFit(active));
		observer.observe(host);
		return () => {
			observer.disconnect();
			if (active.fitTimer !== null) {
				clearTimeout(active.fitTimer);
				active.fitTimer = null;
			}
		};
	}, [active]);

	const close = async (entry: Entry) => {
		const key = entryKey(entry.cwd, entry.hostId);
		if (entry.terminalId) await api.terminal.close(entry.terminalId).catch(() => undefined);
		disposeTerminal(entry.cwd, entry.hostId);
		if (activeKey === key) setActiveKey(null);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* 连接条：每个连接一项，可切换 / 关闭；＋ 新建连接（本地或远程主机） */}
			<div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-2 font-mono text-[11px]">
				{list.map((item) => {
					const key = entryKey(item.cwd, item.hostId);
					const on = item === active;
					return (
						<div
							key={key}
							className={`flex min-w-0 max-w-[42%] items-center gap-1 rounded px-1.5 py-0.5 ${on ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2"}`}
						>
							<button
								type="button"
								onClick={() => setActiveKey(key)}
								title={`${connectionLabel(item)} · ${item.cwd}`}
								className="flex min-w-0 items-center gap-1.5"
							>
								<span className={`size-1.5 shrink-0 rounded-full ${statusDot(item.view.status)}`} />
								<span className="shrink-0">{connectionLabel(item)}</span>
								<span className="truncate text-faint">{item.cwd}</span>
							</button>
							<button
								type="button"
								onClick={() => void close(item)}
								title="关闭这个连接"
								className="shrink-0 text-faint hover:text-err"
							>
								✕
							</button>
						</div>
					);
				})}
				<button
					type="button"
					onClick={() => setConnecting(true)}
					title="新建终端连接"
					className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg"
				>
					＋
				</button>
				<div className="flex-1" />
				{active && (
					<>
						{view.error ? (
							<span
								className="max-w-[38%] min-w-0 truncate text-err"
								title={view.error}
							>
								{view.error}
							</span>
						) : (
							<span className="max-w-[38%] min-w-0 truncate text-faint" title={view.shell ?? undefined}>
								{statusText(view)}
								{view.shell ? ` · ${view.shell}` : ""}
							</span>
						)}
						{(view.status === "exited" || view.status === "error") && (
							<button
								type="button"
								onClick={() => void restart(active)}
								className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg"
							>
								<Icon
									name="refresh"
									className="size-3"
								/>
								重新启动
							</button>
						)}
					</>
				)}
			</div>

			{active ? (
				<div
					ref={hostRef}
					className="min-h-0 flex-1 px-2 py-1"
				/>
			) : (
				<div className="term min-h-0 flex-1 overflow-y-auto px-4 pb-3 text-[12.5px] leading-[1.8]">
					<div className="text-muted">还没有终端连接：点上方「＋」新建一个（本地或远程主机）。</div>
					<div className="text-faint">
						打开项目后会自动带上该项目目录的终端；按 {isMac ? "⌘`" : "Ctrl+`"} 收起本面板。
					</div>
				</div>
			)}

			{connecting && (
				<ConnectDialog
					onClose={() => setConnecting(false)}
					onOpen={(dir, host) => {
						setConnecting(false);
						getOrCreate(dir, host);
						setActiveKey(entryKey(dir, host));
					}}
				/>
			)}
		</div>
	);
}
