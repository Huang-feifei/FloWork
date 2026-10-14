import { randomUUID } from "node:crypto";
import { type BrowserWindow, session, type Session, WebContentsView, type WebContents } from "electron";
import {
	BROWSER_CHANNELS,
	normalizeBrowserUrl,
	type BrowserBounds,
	type BrowserCommand,
	type BrowserState,
	type BrowserTab,
} from "@shared/browser";

interface ManagedTab {
	view: WebContentsView;
	state: BrowserTab;
	loadSequence: number;
}

export interface BrowserInspection {
	activeTabId: string | null;
	tabs: ReadonlyArray<{
		id: string;
		webContentsId: number;
		visible: boolean;
		bounds: BrowserBounds;
	}>;
}

export class BrowserManager {
	private readonly tabs = new Map<string, ManagedTab>();
	private readonly guestSession: Session;
	private activeTabId: string | null = null;
	private viewport: BrowserBounds | null = null;
	private viewportOwner: string | null = null;
	private readonly sequences = new Map<string, number>();
	private readonly retiredOwners = new Set<string>();
	private blocked = false;
	private disposed = false;
	private readonly controlPort: string;
	private readonly appOrigin: string;

	constructor(private readonly win: BrowserWindow, appUrl: string) {
		this.controlPort = String(Number(process.env.FLOWORK_PORT || 17321));
		this.appOrigin = new URL(appUrl).origin;
		this.guestSession = session.fromPartition(`flowork-browser-${randomUUID()}`, { cache: false });
		this.guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		this.guestSession.setPermissionCheckHandler(() => false);
		this.guestSession.setDevicePermissionHandler(() => false);
		this.guestSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));
		this.guestSession.on("will-download", (event, _item, contents) => {
			event.preventDefault();
			const tab = this.findByContents(contents);
			if (tab) this.setError(tab, "内置浏览器不支持下载，请使用系统浏览器下载。");
		});
		this.guestSession.webRequest.onBeforeRequest((details, callback) => {
			const blocked = this.isControlUrl(details.url);
			if (blocked) {
				const tab = this.findByContents(details.webContents);
				if (tab) this.setError(tab, "禁止访问 FloWork 应用及控制服务。");
			}
			callback({ cancel: blocked });
		});
		win.webContents.on("did-start-navigation", (event) => {
			if (event.isMainFrame && !event.isSameDocument) this.hideForRendererNavigation();
		});
		win.webContents.on("render-process-gone", () => this.hideForRendererNavigation());
		win.webContents.on("zoom-changed", () => this.applyLayout());
		win.on("resize", () => this.applyLayout());
		win.on("closed", () => this.dispose());
	}

	getState(): BrowserState {
		return { tabs: [...this.tabs.values()].map((tab) => ({ ...tab.state })), activeTabId: this.activeTabId };
	}

	inspect(): BrowserInspection {
		return {
			activeTabId: this.activeTabId,
			tabs: [...this.tabs.values()].map(({ view, state }) => ({
				id: state.id,
				webContentsId: view.webContents.id,
				visible: view.getVisible(),
				bounds: { ...view.getBounds() },
			})),
		};
	}

	command(input: unknown): BrowserState {
		if (this.disposed) throw new Error("浏览器窗口已关闭。");
		const command = this.validateCommand(input);
		switch (command.type) {
			case "state": break;
			case "create": this.createTab(command.url); break;
			case "activate":
				this.getTab(command.tabId);
				this.activeTabId = command.tabId;
				this.applyLayout();
				break;
			case "close": this.closeTab(command.tabId); break;
			case "navigate": this.navigate(this.getTab(command.tabId), command.url); break;
			case "back": {
				const tab = this.getTab(command.tabId);
				if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
				break;
			}
			case "forward": {
				const tab = this.getTab(command.tabId);
				if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
				break;
			}
			case "reload": {
				const tab = this.getTab(command.tabId);
				if (tab.state.url !== "about:blank") {
					tab.state.error = null;
					tab.view.webContents.reload();
				}
				break;
			}
			case "stop": this.getTab(command.tabId).view.webContents.stop(); break;
			case "viewport": this.setViewport(command); break;
			case "occlusion":
				this.blocked = command.blocked;
				this.applyLayout();
				break;
		}
		this.publish();
		return this.getState();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const tab of this.tabs.values()) {
			tab.view.setVisible(false);
			if (!this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view);
			if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
		}
		this.tabs.clear();
		this.activeTabId = null;
		this.guestSession.webRequest.onBeforeRequest(null);
		this.guestSession.removeAllListeners("will-download");
		void this.guestSession.clearStorageData().catch(() => {});
	}

	private validateCommand(input: unknown): BrowserCommand {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("无效浏览器命令。");
		const value = input as Record<string, unknown>;
		const validString = (field: string, maximum = 8192) => typeof value[field] === "string" && (value[field] as string).length > 0 && (value[field] as string).length <= maximum;
		switch (value.type) {
			case "state": break;
			case "create":
				if (value.url !== undefined && !validString("url")) throw new Error("无效浏览器地址。");
				break;
			case "navigate":
				if (!validString("url")) throw new Error("无效浏览器地址。");
				if (!validString("tabId", 128)) throw new Error("无效浏览器标签。");
				break;
			case "activate": case "close": case "back": case "forward": case "reload": case "stop":
				if (!validString("tabId", 128)) throw new Error("无效浏览器标签。");
				break;
			case "viewport": {
				if (!validString("owner", 128) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) throw new Error("无效浏览器视口租约。");
				if (value.bounds !== null) {
					if (!value.bounds || typeof value.bounds !== "object" || Array.isArray(value.bounds)) throw new Error("无效浏览器视口。");
					const bounds = value.bounds as Record<string, unknown>;
					for (const field of ["x", "y", "width", "height"]) {
						if (typeof bounds[field] !== "number" || !Number.isFinite(bounds[field])) throw new Error("无效浏览器视口尺寸。");
					}
					if ((bounds.width as number) < 0 || (bounds.height as number) < 0) throw new Error("无效浏览器视口尺寸。");
				}
				break;
			}
			case "occlusion":
				if (typeof value.blocked !== "boolean") throw new Error("无效浏览器遮挡状态。");
				break;
			default: throw new Error("未知浏览器命令。");
		}
		return input as BrowserCommand;
	}

	private isControlUrl(input: string): boolean {
		try {
			const url = new URL(input);
			const httpOrigin = url.protocol === "ws:" || url.protocol === "wss:"
				? `${url.protocol === "ws:" ? "http:" : "https:"}//${url.host}` : url.origin;
			if (this.appOrigin !== "null" && httpOrigin === this.appOrigin) return true;
			const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.startsWith("127.") || url.hostname === "[::1]";
			return local && (url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80")) === this.controlPort;
		} catch { return false; }
	}

	private allowedUrl(input: string): string | null {
		if (!/^https?:\/\//i.test(input)) return null;
		const url = normalizeBrowserUrl(input);
		return url && !this.isControlUrl(url) ? url : null;
	}

	private createTab(url?: string, foreground = true): void {
		if (this.tabs.size >= 32) throw new Error("最多支持 32 个浏览器标签。");
		const view = new WebContentsView({ webPreferences: {
			session: this.guestSession,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			webviewTag: false,
			navigateOnDragDrop: false,
		} });
		const tab: ManagedTab = { view, loadSequence: 0, state: {
			id: randomUUID(), url: "about:blank", title: "新标签页", loading: false,
			canGoBack: false, canGoForward: false, error: null,
		} };
		this.tabs.set(tab.state.id, tab);
		view.setVisible(false);
		this.win.contentView.addChildView(view);
		this.bindTab(tab);
		if (foreground || !this.activeTabId) this.activeTabId = tab.state.id;
		if (url) this.navigate(tab, url);
		this.applyLayout();
	}

	private bindTab(tab: ManagedTab): void {
		const contents = tab.view.webContents;
		const update = () => {
			if (this.disposed || !this.tabs.has(tab.state.id) || contents.isDestroyed()) return;
			tab.state.url = contents.getURL() || tab.state.url;
			tab.state.title = contents.getTitle() || (tab.state.url === "about:blank" ? "新标签页" : tab.state.url);
			tab.state.loading = contents.isLoading();
			tab.state.canGoBack = contents.navigationHistory.canGoBack();
			tab.state.canGoForward = contents.navigationHistory.canGoForward();
			this.applyLayout();
			this.publish();
		};
		contents.on("did-start-navigation", (event) => {
			if (event.isMainFrame) { tab.state.error = null; update(); }
		});
		contents.on("did-start-loading", update);
		contents.on("did-stop-loading", update);
		contents.on("did-navigate", update);
		contents.on("did-navigate-in-page", update);
		contents.on("page-title-updated", update);
		contents.on("did-finish-load", update);
		contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
			if (!mainFrame || code === -3) return;
			tab.state.url = url;
			tab.state.loading = false;
			this.setError(tab, `网页加载失败：${description} (${code})`);
		});
		contents.on("render-process-gone", (_event, details) => {
			tab.state.loading = false;
			this.setError(tab, `网页进程已退出：${details.reason}，可尝试刷新。`);
		});
		contents.on("will-frame-navigate", (event) => {
			if (!event.isMainFrame || this.allowedUrl(event.url)) return;
			event.preventDefault();
			this.setError(tab, "仅支持 HTTP(S)，且禁止访问 FloWork 应用及控制服务。");
		});
		contents.on("will-redirect", (event) => {
			if (!event.isMainFrame || this.allowedUrl(event.url)) return;
			event.preventDefault();
			this.setError(tab, "已拒绝不安全的网页重定向。");
		});
		let lastUserActivation = 0;
		contents.on("before-mouse-event", (_event, mouse) => {
			if (mouse.type === "mouseDown" && (mouse.button === "left" || mouse.button === "middle")) lastUserActivation = Date.now();
		});
		contents.setWindowOpenHandler(({ url, disposition, postBody }) => {
			const userActivated = lastUserActivation > 0 && Date.now() - lastUserActivation < 1000;
			lastUserActivation = 0;
			if (userActivated && !postBody && this.allowedUrl(url) && (disposition === "foreground-tab" || disposition === "background-tab")) {
				try { this.createTab(url, disposition === "foreground-tab"); this.publish(); }
				catch (error) { this.setError(tab, error instanceof Error ? error.message : String(error)); }
			}
			return { action: "deny" };
		});
		contents.on("before-input-event", (event, input) => {
			if (input.type === "keyDown" && input.key === "Enter" && !input.isAutoRepeat) lastUserActivation = Date.now();
			if (input.type !== "keyDown" || input.isComposing || input.alt || input.shift || !(input.control || input.meta)) return;
			const key = input.key.toLowerCase();
			if (key !== "l" && key !== "k") return;
			event.preventDefault();
			if (this.win.webContents.isDestroyed()) return;
			this.win.webContents.focus();
			if (key === "l") this.win.webContents.send(BROWSER_CHANNELS.focusAddress);
			else {
				const modifiers: Array<"control" | "meta"> = [input.meta ? "meta" : "control"];
				this.win.webContents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers });
				this.win.webContents.sendInputEvent({ type: "keyUp", keyCode: "K", modifiers });
			}
		});
	}

	private navigate(tab: ManagedTab, input: string): void {
		const normalized = normalizeBrowserUrl(input);
		const url = normalized && this.allowedUrl(normalized);
		if (!url) { this.setError(tab, "仅支持 HTTP(S)，且禁止访问 FloWork 应用及控制服务。"); return; }
		tab.state.error = null;
		tab.state.url = url;
		tab.state.loading = true;
		const sequence = ++tab.loadSequence;
		void tab.view.webContents.loadURL(url).catch((error: unknown) => {
			if (this.disposed || !this.tabs.has(tab.state.id) || tab.loadSequence !== sequence) return;
			if (error instanceof Error && error.message.includes("ERR_ABORTED")) return;
			tab.state.loading = false;
			this.setError(tab, error instanceof Error ? error.message : String(error));
		});
	}

	private getTab(id: string): ManagedTab {
		const tab = this.tabs.get(id);
		if (!tab || tab.view.webContents.isDestroyed()) throw new Error("浏览器标签不存在或不属于当前窗口。");
		return tab;
	}

	private findByContents(contents: WebContents | undefined): ManagedTab | undefined {
		return contents ? [...this.tabs.values()].find((tab) => tab.view.webContents === contents) : undefined;
	}

	private closeTab(id: string): void {
		const tab = this.getTab(id);
		const ids = [...this.tabs.keys()];
		this.tabs.delete(id);
		tab.view.setVisible(false);
		this.win.contentView.removeChildView(tab.view);
		tab.view.webContents.close({ waitForBeforeUnload: false });
		if (this.activeTabId === id) this.activeTabId = ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1] ?? null;
		this.applyLayout();
	}

	private setViewport(command: Extract<BrowserCommand, { type: "viewport" }>): void {
		if (this.retiredOwners.has(command.owner) || command.sequence <= (this.sequences.get(command.owner) ?? -1)) return;
		this.sequences.set(command.owner, command.sequence);
		if (command.bounds === null && command.owner !== this.viewportOwner) return;
		if (command.owner !== this.viewportOwner) {
			if (this.viewportOwner) this.retiredOwners.add(this.viewportOwner);
			this.viewportOwner = command.owner;
		}
		this.viewport = command.bounds ? { ...command.bounds } : null;
		this.applyLayout();
	}

	private hideForRendererNavigation(): void {
		if (this.viewportOwner) this.retiredOwners.add(this.viewportOwner);
		this.viewportOwner = null;
		this.viewport = null;
		this.blocked = false;
		this.applyLayout();
	}

	private applyLayout(): void {
		if (this.disposed || this.win.isDestroyed()) return;
		const [width = 0, height = 0] = this.win.getContentSize();
		const zoom = this.win.webContents.getZoomFactor();
		let bounds: BrowserBounds | null = null;
		if (this.viewport) {
			const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, Math.round(value)));
			const x = clamp(this.viewport.x * zoom, width);
			const y = clamp(this.viewport.y * zoom, height);
			const right = clamp((this.viewport.x + this.viewport.width) * zoom, width);
			const bottom = clamp((this.viewport.y + this.viewport.height) * zoom, height);
			bounds = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
		}
		for (const tab of this.tabs.values()) {
			const visible = !!bounds && bounds.width > 0 && bounds.height > 0 && !this.blocked && tab.state.id === this.activeTabId && tab.state.url !== "about:blank";
			if (visible && bounds) tab.view.setBounds(bounds);
			tab.view.setVisible(visible);
		}
	}

	private setError(tab: ManagedTab, error: string): void {
		tab.state.error = error;
		this.publish();
	}

	private publish(): void {
		if (!this.disposed && !this.win.webContents.isDestroyed()) this.win.webContents.send(BROWSER_CHANNELS.state, this.getState());
	}
}
