export interface BrowserBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BrowserTab {
	id: string;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	error: string | null;
}

export interface BrowserState {
	tabs: BrowserTab[];
	activeTabId: string | null;
}

export type BrowserCommand =
	| { type: "state" }
	| { type: "create"; url?: string }
	| { type: "activate"; tabId: string }
	| { type: "close"; tabId: string }
	| { type: "navigate"; tabId: string; url: string }
	| { type: "back"; tabId: string }
	| { type: "forward"; tabId: string }
	| { type: "reload"; tabId: string }
	| { type: "stop"; tabId: string }
	| { type: "viewport"; owner: string; sequence: number; bounds: BrowserBounds | null }
	| { type: "occlusion"; blocked: boolean };

export interface BrowserBridge {
	command(command: BrowserCommand): Promise<BrowserState>;
	onState(listener: (state: BrowserState) => void): () => void;
	onFocusAddress(listener: () => void): () => void;
}

export const BROWSER_CHANNELS = {
	command: "flowork:browser:command",
	state: "flowork:browser:state",
	focusAddress: "flowork:browser:focus-address",
} as const;

/** Returns an absolute HTTP(S) URL, or null for unsupported/invalid addresses. */
export function normalizeBrowserUrl(input: string): string | null {
	const value = input.trim();
	if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
	const explicitHttp = /^https?:\/\//i.test(value);
	const hostWithPort = /^(?:localhost|[a-z\d.-]+\.[a-z\d.-]+|\d+(?:\.\d+){3}|\[[a-f\d:]+\]):\d+(?:[/?#]|$)/i.test(value);
	if (!explicitHttp && /^[a-z][a-z\d+.-]*:/i.test(value) && !hostWithPort) return null;
	try {
		const url = new URL(explicitHttp ? value : `http://${value}`);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return null;
		return url.href;
	} catch {
		return null;
	}
}
