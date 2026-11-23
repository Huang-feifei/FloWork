import { useEffect, useRef, useState } from "react";
import type { AppUpdateResult, AppUpdateState } from "@shared/app-update";
import { useApp } from "../store";
import { Icon } from "./Icon";
import { Button } from "./ui";

const CHECK_EVENT = "flowork:check-app-update";
const CHECK_INTERVAL = 60 * 60_000;
const LABELS = { downloading: "下载中", ready: "可安装", manual: "有新版", failed: "更新失败", installing: "安装中" } as const;
let lastPromptedVersion: string | undefined;

export function requestAppUpdateCheck() {
	window.dispatchEvent(new Event(CHECK_EVENT));
}

export function AppUpdateNotice({ welcome = false }: { welcome?: boolean }) {
	const [state, setState] = useState<AppUpdateState>({ phase: "idle" });
	const [open, setOpen] = useState(false);
	const [installing, setInstalling] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let alive = true;
		let pushed = false;
		const bridge = window.floworkAppUpdate;
		const off = bridge?.onStatus((next) => { pushed = true; if (alive) setState(next); });
		void bridge?.status().then(next => { if (alive && !pushed) setState(next); }).catch(() => undefined);
		const check = async (manual: boolean) => {
			const result: AppUpdateResult = bridge ? await bridge.check(manual).catch(() => ({ status: "unavailable" })) : { status: "unsupported" };
			if (!alive || !manual) return;
			const notice = useApp.getState().pushNotice;
			if (result.status === "available") setOpen(true);
			else if (result.status === "current") notice("info", `当前 v${result.current}，没有更新的版本。`);
			else if (result.status === "unsupported") notice("info", "应用内更新仅在已打包的 Windows x64 客户端中提供。");
			else notice("warning", "暂时无法检查 FloWork 更新，请稍后重试。");
		};
		const auto = () => { if (document.visibilityState === "visible") void check(false); };
		const manual = () => { void check(true); };
		const startup = window.setTimeout(auto, 2500);
		const interval = window.setInterval(auto, CHECK_INTERVAL);
		window.addEventListener("focus", auto);
		window.addEventListener(CHECK_EVENT, manual);
		return () => {
			alive = false;
			off?.();
			window.clearTimeout(startup);
			window.clearInterval(interval);
			window.removeEventListener("focus", auto);
			window.removeEventListener(CHECK_EVENT, manual);
		};
	}, []);

	useEffect(() => {
		if (!open) return;
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && root.current?.contains(document.activeElement)) {
				event.preventDefault();
				setOpen(false);
				trigger.current?.focus();
			}
		};
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
		};
		window.addEventListener("keydown", escape);
		window.addEventListener("pointerdown", outside);
		return () => { window.removeEventListener("keydown", escape); window.removeEventListener("pointerdown", outside); };
	}, [open]);

	async function install() {
		setInstalling(true);
		try { await window.floworkAppUpdate?.install(); }
		catch (cause) {
			const message = cause instanceof Error ? cause.message.replace(/^.*?Error: /, "") : "无法启动更新，请稍后重试。";
			useApp.getState().pushNotice("warning", message);
		} finally { setInstalling(false); }
	}

	const readyVersion = state.phase === "ready" ? state.version : undefined;
	useEffect(() => {
		if (!readyVersion || lastPromptedVersion === readyVersion) return;
		lastPromptedVersion = readyVersion;
		setOpen(true);
	}, [readyVersion]);

	const ready = state.phase === "ready";
	const download = state.phase === "downloading" ? state : null;
	const verifying = !!download && download.downloaded >= download.total;
	const percent = download ? Math.floor(100 * download.downloaded / download.total) : 0;
	const downloadLabel = verifying ? "校验中" : `${percent}%`;
	const label = download ? downloadLabel : state.phase !== "idle" ? LABELS[state.phase] : "";
	return (
		<div ref={root} className={welcome ? "fw-update-welcome" : "fw-update-slot"}>
			<span className="sr-only" aria-live="polite">{ready ? `FloWork v${state.version} 已下载，可以重启安装。` : ""}</span>
			{state.phase !== "idle" && <>
				<button ref={trigger} type="button" className="fw-rail-item fw-update-trigger" data-phase={state.phase} title={ready ? "更新已下载 · 重启安装" : `应用更新 · ${download && !verifying ? `下载 ${label}` : label}`} aria-label={ready ? "应用更新已就绪，可以重启安装" : `应用更新：${download && !verifying ? `下载 ${label}` : label}`} aria-expanded={open} aria-controls={open ? "fw-update-popover" : undefined} onClick={() => setOpen(!open)}>
					<Icon name={ready ? "check" : "arrow-up"} className="size-4" />
					<span>{label}</span>
					{download && <progress aria-hidden="true" className="fw-update-progress fw-update-progress-rail" value={download.downloaded} max={download.total} />}
				</button>
				{open && <section id="fw-update-popover" className="fw-update-popover fw-float" aria-label="应用更新">
					<header className="flex items-center justify-between gap-3">
						<h2 className="text-[14px] font-semibold">FloWork v{state.version}</h2>
						<button type="button" aria-label="关闭更新详情" className="grid size-6 place-items-center rounded-md text-muted hover:bg-panel-2" onClick={() => { setOpen(false); trigger.current?.focus(); }}><Icon name="x" className="size-3.5" /></button>
					</header>
					{state.phase === "downloading" ? <>
						<p className="text-[12px] text-muted">正在后台下载和校验，不影响当前操作。</p>
						<progress aria-label="安装包下载进度" value={state.downloaded} max={state.total} className="fw-update-progress h-2 w-full" />
						<p className="text-[11px] text-muted">{verifying ? "下载完成，正在校验…" : `${percent}%`}</p>
					</> : ready ? <>
						<p className="text-[12px] text-muted">更新已下载并校验。可以现在重启安装，也可以继续工作。</p>
						<div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" disabled={installing} onClick={() => void install()}>重启安装</Button><Button size="sm" variant="ghost" disabled={installing} onClick={() => { setOpen(false); trigger.current?.focus(); }}>稍后</Button></div>
					</> : state.phase === "installing" ? <p className="text-[12px] text-muted">正在关闭 FloWork，安装进度将在 Windows 安装器中显示。</p> : <>
						<p className="text-[12px] text-muted">{state.phase === "failed" ? "后台下载或校验失败。可以重试，或前往发布页手动下载安装。" : "此版本未提供可用于后台校验的安装包，请前往发布页手动安装。"}</p>
						<div className="flex flex-wrap gap-2">
							{state.phase === "failed" && <Button size="sm" variant="primary" onClick={requestAppUpdateCheck}>重试下载</Button>}
							<Button size="sm" onClick={() => void window.floworkAppUpdate?.open(state.version).catch(() => useApp.getState().pushNotice("warning", "无法打开发布页，请稍后重试。"))}>打开发布页</Button>
						</div>
					</>}
				</section>}
			</>}
		</div>
	);
}
