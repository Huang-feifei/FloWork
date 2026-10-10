/**
 * 不依赖活动会话的服务：会话列表、供应商与模型、登录 / 登出、测试连接、配置文件读写。
 * 由后端启动的常驻 service worker 承载。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	AuthFlowEvent,
	AuthNotice,
	AuthPrompt,
	CommandResultMap,
	ConfigFile,
	ConfigFileName,
	ModelEntry,
	ProviderInfo,
	ServiceCommand,
	SessionSummary,
	TestResult,
} from "@shared/protocol";
import { toModelInfo } from "./adapter";

const CONFIG_FILES: Record<ConfigFileName, string> = {
	settings: "settings.json",
	models: "models.json",
};

interface PendingPrompt {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
}

// pi 登录交互的参数类型从 ModelRuntime.login 推导，避免依赖 pi-ai 的内部导出
type LoginInteraction = Parameters<ModelRuntime["login"]>[2];
type PiAuthPrompt = Parameters<LoginInteraction["prompt"]>[0];
type PiAuthEvent = Parameters<LoginInteraction["notify"]>[0];

export class ServiceHost {
	private modelRuntime: Promise<ModelRuntime> | undefined;
	private readonly flows = new Map<string, AbortController>();
	private readonly prompts = new Map<string, PendingPrompt>();

	constructor(private readonly emitAuth: (event: AuthFlowEvent) => void) {}

	private getModelRuntime(): Promise<ModelRuntime> {
		this.modelRuntime ??= ModelRuntime.create();
		return this.modelRuntime;
	}

	private configPath(name: ConfigFileName): string {
		return join(getAgentDir(), CONFIG_FILES[name]);
	}

	async handle(command: ServiceCommand): Promise<CommandResultMap[ServiceCommand["type"]]> {
		switch (command.type) {
			case "ping":
				return { pid: process.pid, versions: { ...process.versions }, agentDir: getAgentDir() };
			case "list_sessions":
				return this.listSessions(command.cwd);
			case "list_providers":
				return this.listProviders();
			case "list_models":
				return this.listModels(command.availableOnly === true);
			case "auth_login":
				return this.login(command.flowId, command.provider, command.method);
			case "logout": {
				const runtime = await this.getModelRuntime();
				await runtime.logout(command.provider);
				return null;
			}
			case "test_model":
				return this.testModel(command.provider, command.modelId);
			case "get_config_file":
				return this.readConfig(command.name);
			case "save_config_file":
				return this.saveConfig(command.name, command.text);
			case "fetch_remote_models":
				return this.fetchRemoteModels(command.baseUrl, command.apiKey);
		}
	}

	// ----- 会话 -----

	private async listSessions(cwd?: string): Promise<SessionSummary[]> {
		const infos = cwd ? await SessionManager.list(cwd) : await SessionManager.listAll();
		return infos.map((info) => ({
			path: info.path,
			id: info.id,
			cwd: info.cwd,
			name: info.name,
			firstMessage: info.firstMessage,
			messageCount: info.messageCount,
			created: info.created.getTime(),
			modified: info.modified.getTime(),
			parentSessionPath: info.parentSessionPath,
		}));
	}

	// ----- 供应商与模型 -----

	private async customProviderIds(): Promise<Set<string>> {
		try {
			const parsed = JSON.parse((await this.readConfig("models")).text || "{}") as { providers?: object };
			return new Set(Object.keys(parsed.providers ?? {}));
		} catch {
			return new Set();
		}
	}

	private async listProviders(): Promise<ProviderInfo[]> {
		const runtime = await this.getModelRuntime();
		const custom = await this.customProviderIds();
		return runtime.getProviders().map((provider) => {
			const authMethods: ProviderInfo["authMethods"] = [];
			const auth = provider.auth;
			if (auth?.apiKey) authMethods.push(auth.apiKey.login ? "api_key" : "ambient");
			if (auth?.oauth) authMethods.push(auth.oauth.isSubscription ? "oauth_subscription" : "oauth");
			const status = runtime.getProviderAuthStatus(provider.id);
			return {
				id: provider.id,
				name: provider.name,
				authMethods,
				configured: status.configured,
				authSource: status.source,
				authLabel: status.label,
				modelCount: runtime.getModels(provider.id).length,
				custom: custom.has(provider.id),
			};
		});
	}

	private async listModels(availableOnly: boolean): Promise<ModelEntry[]> {
		const runtime = await this.getModelRuntime();
		const available = await runtime.getAvailable();
		const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
		const source = availableOnly ? available : runtime.getModels();
		return source.flatMap((m) => {
			const info = toModelInfo(m);
			return info ? [{ ...info, available: availableKeys.has(`${m.provider}/${m.id}`) }] : [];
		});
	}

	private async testModel(provider: string, modelId: string): Promise<TestResult> {
		const runtime = await this.getModelRuntime();
		const model = runtime.getModel(provider, modelId);
		if (!model) return { ok: false, latencyMs: 0, error: `找不到模型：${provider}/${modelId}` };
		const started = Date.now();
		try {
			const message = await runtime.completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }] },
				{ maxTokens: 64, reasoning: "minimal", signal: AbortSignal.timeout(60_000) },
			);
			const latencyMs = Date.now() - started;
			const text = message.content
				.map((b) => (b.type === "text" ? b.text : ""))
				.join("")
				.trim();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return { ok: false, latencyMs, error: message.errorMessage ?? message.stopReason };
			}
			return { ok: true, latencyMs, text: text.slice(0, 200) };
		} catch (error) {
			return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
		}
	}

	// ----- 登录流程 -----

	private async login(flowId: string, provider: string, method: "api_key" | "oauth"): Promise<{ provider: string }> {
		const runtime = await this.getModelRuntime();
		const controller = new AbortController();
		this.flows.set(flowId, controller);
		const interaction: LoginInteraction = {
			signal: controller.signal,
			prompt: (prompt) => this.askPrompt(flowId, prompt),
			notify: (event) => this.emitAuth({ flowId, kind: "notice", notice: toAuthNotice(event) }),
		};
		try {
			await runtime.login(provider, method, interaction);
			return { provider };
		} finally {
			this.flows.delete(flowId);
			for (const [key, pending] of this.prompts) {
				if (key.startsWith(`${flowId}:`)) {
					this.prompts.delete(key);
					pending.reject(new Error("登录流程已结束"));
				}
			}
		}
	}

	private askPrompt(flowId: string, prompt: PiAuthPrompt): Promise<string> {
		const promptId = randomUUID();
		const key = `${flowId}:${promptId}`;
		return new Promise<string>((resolve, reject) => {
			this.prompts.set(key, { resolve, reject });
			prompt.signal?.addEventListener("abort", () => {
				if (!this.prompts.delete(key)) return;
				this.emitAuth({ flowId, kind: "prompt_cancelled", promptId });
				reject(new Error("提示已取消"));
			});
			this.emitAuth({ flowId, kind: "prompt", promptId, prompt: toAuthPrompt(prompt) });
		});
	}

	answer(flowId: string, promptId: string, value: string | undefined, cancel: boolean | undefined): void {
		const key = `${flowId}:${promptId}`;
		const pending = this.prompts.get(key);
		if (!pending) return;
		this.prompts.delete(key);
		if (cancel || value === undefined) pending.reject(new Error("用户取消了登录"));
		else pending.resolve(value);
	}

	cancelFlow(flowId: string): void {
		this.flows.get(flowId)?.abort(new Error("用户取消了登录"));
		for (const [key, pending] of this.prompts) {
			if (key.startsWith(`${flowId}:`)) {
				this.prompts.delete(key);
				pending.reject(new Error("用户取消了登录"));
			}
		}
	}

	// ----- 配置文件 -----

	private async readConfig(name: ConfigFileName): Promise<ConfigFile> {
		const path = this.configPath(name);
		if (!existsSync(path)) return { name, path, exists: false, text: "" };
		return { name, path, exists: true, text: await readFile(path, "utf8") };
	}

	private async saveConfig(name: ConfigFileName, text: string): Promise<ConfigFile> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(`${CONFIG_FILES[name]} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`${CONFIG_FILES[name]} 顶层必须是对象`);
		}
		const path = this.configPath(name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
		// models.json 变化需要重建供应商；settings.json 由各会话在 refresh_config 时重新加载
		const runtime = await this.getModelRuntime();
		await runtime.refresh();
		return this.readConfig(name);
	}

	private async fetchRemoteModels(baseUrl: string, apiKey?: string): Promise<string[]> {
		const url = `${baseUrl.replace(/\/+$/, "")}/models`;
		const response = await fetch(url, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new Error(`GET ${url} 返回 ${response.status} ${response.statusText}`);
		const body = (await response.json()) as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; name?: unknown }> };
		const list = body.data ?? body.models ?? [];
		return list
			.map((m) => (typeof m.id === "string" ? m.id : typeof (m as { name?: unknown }).name === "string" ? String((m as { name: string }).name) : ""))
			.filter(Boolean)
			.sort();
	}
}

function toAuthPrompt(prompt: PiAuthPrompt): AuthPrompt {
	if (prompt.type === "select") {
		return {
			type: "select",
			message: prompt.message,
			options: prompt.options.map((o) => ({ id: o.id, label: o.label, description: o.description })),
		};
	}
	return { type: prompt.type, message: prompt.message, placeholder: prompt.placeholder };
}

function toAuthNotice(event: PiAuthEvent): AuthNotice {
	switch (event.type) {
		case "info":
			return { type: "info", message: event.message, links: event.links?.map((l) => ({ url: l.url, label: l.label })) };
		case "auth_url":
			return { type: "auth_url", url: event.url, instructions: event.instructions };
		case "device_code":
			return {
				type: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				expiresInSeconds: event.expiresInSeconds,
			};
		case "progress":
			return { type: "progress", message: event.message };
	}
}
