import { useEffect, useMemo, useState } from "react";
import type { ModelEntry, ProviderInfo, TestResult } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useAuth } from "../../authStore";
import { useApp } from "../../store";
import { Badge, Button, Input, Select } from "../ui";

/** 国内可直接使用的内置供应商 */
const DOMESTIC = new Set([
	"deepseek",
	"moonshotai",
	"moonshotai-cn",
	"kimi-coding",
	"minimax",
	"minimax-cn",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"zai",
	"zai-coding-cn",
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
	"ant-ling",
]);

/** 默认展示的主流供应商；其余在「全部」里查看。已配置的供应商始终显示 */
const COMMON = new Set([
	"openai",
	"anthropic",
	"google",
	"xai",
	"openrouter",
	"github-copilot",
	"deepseek",
	"moonshotai",
	"moonshotai-cn",
	"kimi-coding",
	"zai",
	"zai-coding-cn",
	"qwen-token-plan",
	"minimax",
]);

/** 支持订阅登录的供应商不放「常用」，需要时到「订阅登录」筛选里找 */
function supportsSubscription(provider: ProviderInfo): boolean {
	return provider.authMethods.includes("oauth_subscription");
}

type Filter = "common" | "all" | "configured" | "domestic" | "subscription";

const SOURCE_LABEL: Record<string, string> = {
	stored: "auth.json",
	runtime: "运行时",
	environment: "环境变量",
	fallback: "默认凭据",
	models_json_key: "models.json",
	models_json_command: "models.json 命令",
};

function ProviderRow({ provider, models }: { provider: ProviderInfo; models: ModelEntry[] }) {
	const startLogin = useAuth((s) => s.start);
	const pushNotice = useApp((s) => s.pushNotice);
	const [testModel, setTestModel] = useState("");
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<TestResult | null>(null);
	const [expanded, setExpanded] = useState(false);

	const providerModels = models.filter((m) => m.provider === provider.id);
	const selectedModel = testModel || providerModels[0]?.id || "";

	const runTest = async () => {
		if (!selectedModel) return;
		setTesting(true);
		setResult(null);
		try {
			setResult(await api.service({ type: "test_model", provider: provider.id, modelId: selectedModel }));
		} catch (e) {
			setResult({ ok: false, latencyMs: 0, error: errorText(e) });
		} finally {
			setTesting(false);
		}
	};

	const logout = async () => {
		try {
			await api.service({ type: "logout", provider: provider.id });
			pushNotice("info", `已移除 ${provider.name} 的已保存凭据`);
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const hasApiKey = provider.authMethods.includes("api_key");
	const oauth = provider.authMethods.find((m) => m === "oauth" || m === "oauth_subscription");

	return (
		<div className="border-b border-border last:border-b-0">
			<div className="flex items-center gap-3 px-3 py-2.5">
				<button type="button" onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1 text-left">
					<div className="flex items-center gap-2">
						<span className="font-medium">{provider.name}</span>
						<span className="font-mono text-[11px] text-muted">{provider.id}</span>
						{provider.custom && <Badge tone="accent">自定义</Badge>}
					</div>
					<div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
						{provider.configured ? (
							<Badge tone="ok">
								已配置
								{provider.authSource ? ` · ${SOURCE_LABEL[provider.authSource] ?? provider.authSource}` : ""}
								{provider.authLabel ? ` · ${provider.authLabel}` : ""}
							</Badge>
						) : (
							<Badge>未配置</Badge>
						)}
						{provider.authMethods.includes("oauth_subscription") && <Badge tone="warn">支持订阅登录</Badge>}
						{provider.authMethods.includes("ambient") && <Badge>使用环境凭据</Badge>}
						<span>{provider.modelCount} 个模型</span>
					</div>
				</button>
				<div className="flex shrink-0 gap-1.5">
					{hasApiKey && (
						<Button size="sm" onClick={() => void startLogin(provider.id, provider.name, "api_key")}>
							API Key
						</Button>
					)}
					{oauth && (
						<Button size="sm" onClick={() => void startLogin(provider.id, provider.name, "oauth")}>
							{oauth === "oauth_subscription" ? "订阅登录" : "OAuth 登录"}
						</Button>
					)}
					{provider.configured && provider.authSource === "stored" && (
						<Button size="sm" variant="danger" onClick={() => void logout()}>
							登出
						</Button>
					)}
				</div>
			</div>
			{expanded && (
				<div className="space-y-2 bg-panel-2/60 px-3 pt-1 pb-3">
					{providerModels.length === 0 ? (
						<div className="text-xs text-muted">配置凭据后可在此测试连接。</div>
					) : (
						<div className="flex items-center gap-2">
							<Select value={selectedModel} onChange={(e) => setTestModel(e.target.value)} className="max-w-md">
								{providerModels.map((m) => (
									<option key={m.id} value={m.id}>
										{m.name} {m.available ? "" : "（凭据不可用）"}
									</option>
								))}
							</Select>
							<Button size="sm" variant="primary" disabled={testing} onClick={() => void runTest()}>
								{testing ? "测试中…" : "测试连接"}
							</Button>
						</div>
					)}
					{result && (
						<div
							className={`rounded border px-2 py-1.5 text-xs ${
								result.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-err/40 bg-err/10 text-err"
							}`}
						>
							{result.ok ? `连接成功，耗时 ${result.latencyMs} ms，回复：${result.text || "（空）"}` : `失败：${result.error}`}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export function ProvidersTab() {
	const configVersion = useApp((s) => s.configVersion);
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [models, setModels] = useState<ModelEntry[]>([]);
	const [filter, setFilter] = useState<Filter>("common");
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		Promise.all([api.service({ type: "list_providers" }), api.service({ type: "list_models" })])
			.then(([p, m]) => {
				if (cancelled) return;
				setProviders(p);
				setModels(m);
				setError(null);
			})
			.catch((e) => !cancelled && setError(errorText(e)))
			.finally(() => !cancelled && setLoading(false));
		return () => {
			cancelled = true;
		};
	}, [configVersion]);

	/** 常用视图：主流供应商 + 已配置的（含自定义端点）；支持订阅登录的排除在外 */
	const isCommon = (p: ProviderInfo) => (COMMON.has(p.id) && !supportsSubscription(p)) || p.configured;

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return providers
			.filter((p) => {
				if (filter === "common") return isCommon(p);
				if (filter === "configured") return p.configured;
				if (filter === "domestic") return DOMESTIC.has(p.id);
				if (filter === "subscription") return supportsSubscription(p);
				return true;
			})
			.filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q))
			.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}, [providers, filter, query]);

	const counts = {
		common: providers.filter(isCommon).length,
		all: providers.length,
		configured: providers.filter((p) => p.configured).length,
		domestic: providers.filter((p) => DOMESTIC.has(p.id)).length,
		subscription: providers.filter(supportsSubscription).length,
	};

	return (
		<div>
			<div className="mb-3 flex items-center gap-2">
				{(
					[
						["common", "常用"],
						["all", "全部"],
						["configured", "已配置"],
						["domestic", "国内"],
						["subscription", "订阅登录"],
					] as const
				).map(([id, label]) => (
					<Button key={id} size="sm" variant={filter === id ? "primary" : "default"} onClick={() => setFilter(id)}>
						{label} {counts[id]}
					</Button>
				))}
				<div className="flex-1" />
				<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索供应商" className="max-w-56" />
			</div>

			{filter === "common" && counts.all > counts.common && (
				<div className="mb-3 text-[11px] text-muted">已隐藏 {counts.all - counts.common} 个不常用供应商，点「全部」查看。</div>
			)}

			<div className="mb-3 rounded-md border border-border bg-panel px-3 py-2 text-[11px] leading-5 text-muted">
				凭据优先级：auth.json（这里登录保存的）&gt; models.json 中的 apiKey &gt; 环境变量。API Key 以明文保存在
				配置目录的 auth.json 中（桌面版计划改为系统加密存储）。订阅登录是否允许在第三方客户端使用，以各家服务条款为准。
			</div>

			{error && <div className="mb-3 rounded border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</div>}
			{loading && providers.length === 0 ? (
				<div className="py-10 text-center text-muted">正在读取供应商…</div>
			) : (
				<div className="overflow-hidden rounded-md border border-border bg-panel">
					{visible.map((p) => (
						<ProviderRow key={p.id} provider={p} models={models} />
					))}
					{visible.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted">没有匹配的供应商</div>}
				</div>
			)}
		</div>
	);
}
