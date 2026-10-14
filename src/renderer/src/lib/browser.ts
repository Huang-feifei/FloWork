import { useLayoutEffect, type RefObject } from "react";
import { create } from "zustand";
import type { BrowserBounds, BrowserBridge, BrowserCommand, BrowserState } from "@shared/browser";
import { errorText } from "../api/client";

export function browserBridge(): BrowserBridge | undefined {
	return window.floworkBrowser;
}

interface BrowserUIState {
	state: BrowserState;
	ready: boolean;
	error: string | null;
}

export const useBrowser = create<BrowserUIState>()(() => ({
	state: { tabs: [], activeTabId: null },
	ready: false,
	error: null,
}));

let initialized = false;
let stateVersion = 0;

export async function initializeBrowser(): Promise<void> {
	const bridge = browserBridge();
	if (!bridge || initialized) return;
	initialized = true;
	bridge.onState((state) => {
		stateVersion++;
		useBrowser.setState({ state, ready: true });
	});
	await browserCommand({ type: "state" });
}

export async function browserCommand(command: BrowserCommand): Promise<void> {
	const bridge = browserBridge();
	if (!bridge) return;
	const version = stateVersion;
	try {
		const state = await bridge.command(command);
		useBrowser.setState({ ...(version === stateVersion ? { state } : {}), ready: true, error: null });
	} catch (error) {
		useBrowser.setState({ error: errorText(error) });
	}
}

const occlusions = new Set<symbol>();

function sendOcclusion(): void {
	void browserBridge()?.command({ type: "occlusion", blocked: occlusions.size > 0 }).catch(() => undefined);
}

export function acquireBrowserOcclusion(): () => void {
	const lease = Symbol();
	occlusions.add(lease);
	if (occlusions.size === 1) sendOcclusion();
	return () => {
		if (!occlusions.delete(lease)) return;
		if (occlusions.size === 0) sendOcclusion();
	};
}

export function useBrowserOcclusion(blocked = true): void {
	useLayoutEffect(() => {
		if (blocked) return acquireBrowserOcclusion();
	}, [blocked]);
}

export function useBrowserViewport(host: RefObject<HTMLDivElement | null>, visible: boolean): void {
	useLayoutEffect(() => {
		const bridge = browserBridge();
		const element = host.current;
		if (!bridge || !element) return;
		const owner = crypto.randomUUID();
		let sequence = 0;
		let frame = 0;
		let last = "";
		const send = (bounds: BrowserBounds | null) => {
			const key = JSON.stringify(bounds);
			if (key === last) return;
			last = key;
			void bridge.command({ type: "viewport", owner, sequence: ++sequence, bounds }).catch(() => undefined);
		};
		const measure = () => {
			frame = 0;
			const rect = element.getBoundingClientRect();
			const x = Math.max(0, Math.round(rect.left));
			const y = Math.max(0, Math.round(rect.top));
			const width = Math.max(0, Math.round(Math.min(rect.right, window.innerWidth)) - x);
			const height = Math.max(0, Math.round(Math.min(rect.bottom, window.innerHeight)) - y);
			send(visible && !document.hidden && width > 0 && height > 0 ? { x, y, width, height } : null);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		const resize = new ResizeObserver(schedule);
		for (let node: HTMLElement | null = element; node; node = node.parentElement) resize.observe(node);
		const mutation = new MutationObserver(schedule);
		mutation.observe(document.body, { attributes: true, childList: true, subtree: true });
		window.addEventListener("resize", schedule);
		window.addEventListener("scroll", schedule, true);
		document.addEventListener("visibilitychange", schedule);
		document.addEventListener("transitionend", schedule, true);
		measure();
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			mutation.disconnect();
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", schedule, true);
			document.removeEventListener("visibilitychange", schedule);
			document.removeEventListener("transitionend", schedule, true);
			send(null);
		};
	}, [host, visible]);
}
