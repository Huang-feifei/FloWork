import { useEffect, useRef, useState } from "react";
import { normalizeBrowserUrl } from "@shared/browser";
import { browserBridge, browserCommand, ensureBrowserDefault, useBrowser, useBrowserViewport } from "../../lib/browser";
import { Icon, type IconName } from "../Icon";
import { Button } from "../ui";

function NavigationButton({ icon, label, disabled, onClick }: { icon: IconName; label: string; disabled?: boolean; onClick: () => void }) {
	return (
		<button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}
			className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30">
			<Icon name={icon} className="size-3.5" />
		</button>
	);
}

export function BrowserPanel() {
	const { state, ready, error } = useBrowser();
	const active = state.tabs.find((tab) => tab.id === state.activeTabId);
	const [address, setAddress] = useState("");
	const [addressError, setAddressError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const host = useRef<HTMLDivElement>(null);
	const hasPage = !!active?.url && active.url !== "about:blank" && !active.error;
	useBrowserViewport(host, hasPage);

	useEffect(() => { void ensureBrowserDefault(); }, []);
	useEffect(() => {
		setAddress(active?.url === "about:blank" ? "" : active?.url ?? "");
		setAddressError(null);
	}, [active?.id, active?.url]);
	useEffect(() => {
		const focus = () => {
			input.current?.focus();
			input.current?.select();
		};
		const key = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "l") {
				event.preventDefault();
				focus();
			}
		};
		window.addEventListener("keydown", key);
		const unsubscribe = browserBridge().onFocusAddress(focus);
		return () => {
			window.removeEventListener("keydown", key);
			unsubscribe();
		};
	}, []);

	const navigate = () => {
		const url = normalizeBrowserUrl(address);
		if (!url) {
			setAddressError("请输入有效的 HTTP(S) 地址，例如 https://example.com 或 localhost:3000");
			return;
		}
		setAddressError(null);
		void browserCommand(active ? { type: "navigate", tabId: active.id, url } : { type: "create", url });
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-browser-panel>
				<div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
					<div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
						{state.tabs.map((tab) => (
							<div key={tab.id} className={`flex h-7 min-w-[96px] max-w-[176px] shrink-0 items-center rounded-full ${active?.id === tab.id ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2"}`}>
								<button type="button" onClick={() => void browserCommand({ type: "activate", tabId: tab.id })} title={tab.url || "新标签页"}
									className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-xs">
									<Icon name={tab.loading ? "loader-circle" : "globe"} className={`size-3 ${tab.loading ? "animate-spin" : ""}`} />
									<span className="truncate">{tab.title || "新标签页"}</span>
								</button>
								<NavigationButton icon="x" label={`关闭 ${tab.title || "标签页"}`} onClick={() => void browserCommand({ type: "close", tabId: tab.id })} />
							</div>
						))}
					</div>
					<NavigationButton icon="plus" label="新建标签页" disabled={!ready} onClick={() => void browserCommand({ type: "create" })} />
				</div>
			<form className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2.5" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
					<NavigationButton icon="arrow-left" label="后退" disabled={!active?.canGoBack} onClick={() => active && void browserCommand({ type: "back", tabId: active.id })} />
					<NavigationButton icon="arrow-right" label="前进" disabled={!active?.canGoForward} onClick={() => active && void browserCommand({ type: "forward", tabId: active.id })} />
					<NavigationButton icon={active?.loading ? "x" : "refresh"} label={active?.loading ? "停止加载" : "刷新"} disabled={!active}
						onClick={() => active && void browserCommand({ type: active.loading ? "stop" : "reload", tabId: active.id })} />
				<input ref={input} value={address} onChange={(event) => { setAddress(event.target.value); setAddressError(null); }} aria-label="网页地址"
					placeholder="输入网址或 localhost:端口" spellCheck={false} autoComplete="off"
					className="h-8 min-w-0 flex-1 rounded-full bg-panel-2 px-3.5 font-mono text-[12px] outline-none placeholder:text-muted/70 focus:ring-4 focus:ring-primary/10" />
				<button type="submit" title="打开地址" aria-label="打开地址"
					className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-fg">
					<Icon name="arrow-right" className="size-3.5" />
				</button>
			</form>
			{(addressError || error) && <div role="alert" className="shrink-0 border-b border-border px-3 py-2 text-xs break-words text-err">{addressError || error}</div>}
			<div ref={host} data-browser-viewport className="relative min-h-0 flex-1 bg-bg">
				{!hasPage && (
					<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
						<Icon name="globe" className="size-8 text-faint" />
						<h2 className="text-[15px] font-semibold tracking-tight">{active?.error ? "网页加载失败" : !ready ? "正在连接浏览器…" : "打开一个网页"}</h2>
						<p className="max-w-sm text-[12.5px] leading-relaxed break-words text-muted">{active?.error || "在上方输入网址。网页标签属于此窗口，不随聊天会话切换关闭。"}</p>
						{active?.error && <Button size="sm" onClick={() => void browserCommand({ type: "reload", tabId: active.id })}>重新加载</Button>}
						{!ready && error && <Button size="sm" onClick={() => void browserCommand({ type: "state" })}>重试连接</Button>}
					</div>
				)}
			</div>
		</div>
	);
}
