import { useEffect, useState } from "react";
import type { AppUpdateResult } from "@shared/app-update";
import { useApp } from "../store";
import { Icon } from "./Icon";
import { Button } from "./ui";

const CHECK_EVENT = "flowork:check-app-update";
const DISMISSED_KEY = "flowork.dismissed-app-update";
const CHECK_INTERVAL = 60 * 60_000;

export function requestAppUpdateCheck() {
	window.dispatchEvent(new Event(CHECK_EVENT));
}

function dismissedVersion() {
	try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

export function AppUpdateNotice() {
	const [update, setUpdate] = useState<Extract<AppUpdateResult, { status: "available" }> | null>(null);
	const [dismissed, setDismissed] = useState(dismissedVersion);

	useEffect(() => {
		let alive = true;
		const check = async (manual: boolean) => {
			const bridge = window.floworkAppUpdate;
			const result: AppUpdateResult = bridge ? await bridge.check(manual).catch(() => ({ status: "unavailable" })) : { status: "unsupported" };
			if (!alive) return;
			if (result.status === "available") {
				if (manual) {
					setDismissed(null);
					try { localStorage.removeItem(DISMISSED_KEY); } catch { /* 不影响本次显示 */ }
				}
				setUpdate(result);
				return;
			}
			if (result.status === "current") setUpdate(null);
			if (!manual) return;
			const pushNotice = useApp.getState().pushNotice;
			if (result.status === "current") pushNotice("info", `当前 v${result.current}，没有更新的版本。`);
			else if (result.status === "unsupported") pushNotice("info", "新版检查仅在已打包的 Windows x64 客户端中提供。");
			else pushNotice("warning", "暂时无法检查 FloWork 更新，请稍后重试。");
		};
		const auto = () => { if (document.visibilityState === "visible") void check(false); };
		const manual = () => { void check(true); };
		const startup = window.setTimeout(auto, 2500);
		const interval = window.setInterval(auto, CHECK_INTERVAL);
		window.addEventListener("focus", auto);
		window.addEventListener(CHECK_EVENT, manual);
		return () => {
			alive = false;
			window.clearTimeout(startup);
			window.clearInterval(interval);
			window.removeEventListener("focus", auto);
			window.removeEventListener(CHECK_EVENT, manual);
		};
	}, []);

	if (!update || update.version === dismissed) return null;
	return (
		<div className="mx-[9px] mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-term px-3 py-1.5" aria-label="应用更新">
			<Icon name="arrow-up" className="size-4 shrink-0 text-primary-strong" />
			<p role="status" className="min-w-0 flex-1 text-[12px]">
				<strong>FloWork v{update.version} 可下载</strong>
				<span className="ml-2 text-muted">当前 v{update.current} · 不会自动安装</span>
			</p>
			<Button variant="primary" size="sm" onClick={() => {
				void window.floworkAppUpdate?.open(update.version).catch(() => useApp.getState().pushNotice("warning", "无法打开发布页，请稍后重试。"));
			}}>打开下载页</Button>
			<Button variant="ghost" size="sm" onClick={() => {
				setDismissed(update.version);
				try { localStorage.setItem(DISMISSED_KEY, update.version); } catch { /* 不影响本次关闭 */ }
			}}>暂不提醒此版本</Button>
		</div>
	);
}
