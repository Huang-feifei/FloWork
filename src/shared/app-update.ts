export const APP_RELEASE_REPOSITORY = "Huang-feifei/FloWork";
export const APP_UPDATE_CHANNELS = { check: "flowork:app-update-check", open: "flowork:app-update-open" } as const;

export type AppUpdateResult =
	| { status: "available"; version: string; current: string }
	| { status: "current"; current: string }
	| { status: "unavailable" }
	| { status: "unsupported" };

export interface AppUpdateBridge {
	check(manual?: boolean): Promise<AppUpdateResult>;
	open(version: string): Promise<void>;
}
