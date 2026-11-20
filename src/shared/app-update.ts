export const APP_RELEASE_REPOSITORY = "Huang-feifei/FloWork";
export const APP_UPDATE_CHANNELS = {
	check: "flowork:app-update-check", open: "flowork:app-update-open", status: "flowork:app-update-status",
	changed: "flowork:app-update-changed", install: "flowork:app-update-install",
} as const;

export type AppUpdateResult =
	| { status: "available"; version: string; current: string }
	| { status: "current"; current: string }
	| { status: "unavailable" }
	| { status: "unsupported" };

export type AppUpdateState =
	| { phase: "idle" }
	| { phase: "downloading"; version: string; downloaded: number; total: number }
	| { phase: "ready" | "manual" | "failed" | "installing"; version: string };

export interface AppUpdateBridge {
	check(manual?: boolean): Promise<AppUpdateResult>;
	open(version: string): Promise<void>;
	status(): Promise<AppUpdateState>;
	onStatus(listener: (status: AppUpdateState) => void): () => void;
	install(): Promise<void>;
}
