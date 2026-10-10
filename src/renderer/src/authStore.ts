/**
 * 登录流程状态（API Key / OAuth）。提示与通知由 service worker 经后端推送过来。
 */
import { create } from "zustand";
import type { AuthNotice, AuthPrompt } from "@shared/protocol";
import { api, errorText } from "./api/client";

export interface AuthFlow {
	flowId: string;
	provider: string;
	providerName: string;
	method: "api_key" | "oauth";
	status: "running" | "done" | "error" | "cancelled";
	error?: string;
	prompt?: { promptId: string; prompt: AuthPrompt };
	notices: AuthNotice[];
}

interface AuthState {
	flow: AuthFlow | null;
	start(provider: string, providerName: string, method: "api_key" | "oauth"): Promise<void>;
	answer(value: string): Promise<void>;
	cancel(): Promise<void>;
	close(): void;
}

let subscribed = false;

export const useAuth = create<AuthState>()((set, get) => {
	if (!subscribed) {
		subscribed = true;
		api.onPush((push) => {
			if (push.type !== "auth") return;
			const flow = get().flow;
			const event = push.event;
			if (!flow || flow.flowId !== event.flowId) return;
			switch (event.kind) {
				case "prompt":
					set({ flow: { ...flow, prompt: { promptId: event.promptId, prompt: event.prompt } } });
					return;
				case "prompt_cancelled":
					if (flow.prompt?.promptId === event.promptId) set({ flow: { ...flow, prompt: undefined } });
					return;
				case "notice":
					set({ flow: { ...flow, notices: [...flow.notices, event.notice] } });
					return;
			}
		});
	}

	return {
		flow: null,

		async start(provider, providerName, method) {
			const flowId = crypto.randomUUID();
			set({ flow: { flowId, provider, providerName, method, status: "running", notices: [] } });
			try {
				await api.service({ type: "auth_login", flowId, provider, method });
				const flow = get().flow;
				if (flow?.flowId === flowId) set({ flow: { ...flow, status: "done", prompt: undefined } });
			} catch (error) {
				const flow = get().flow;
				if (flow?.flowId !== flowId || flow.status === "cancelled") return;
				set({ flow: { ...flow, status: "error", error: errorText(error), prompt: undefined } });
			}
		},

		async answer(value) {
			const flow = get().flow;
			if (!flow?.prompt) return;
			const { promptId } = flow.prompt;
			set({ flow: { ...flow, prompt: undefined } });
			await api.authAnswer(flow.flowId, promptId, value);
		},

		async cancel() {
			const flow = get().flow;
			if (!flow) return;
			if (flow.status === "running") {
				set({ flow: { ...flow, status: "cancelled", prompt: undefined } });
				await api.authCancel(flow.flowId).catch(() => undefined);
			}
			set({ flow: null });
		},

		close() {
			set({ flow: null });
		},
	};
});
