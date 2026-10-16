import { useEffect, useMemo, useState } from "react";
import type { ModelEntry, ProviderInfo, TestResult } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useAuth } from "../../authStore";
import { useApp } from "../../store";
import { Badge, Button, Input, Segmented, Select } from "../ui";

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

/**
 * 本应用只提供 API Key 与普通 OAuth 登录，不提供订阅登录；
 * 这里把订阅登录从可用方式里排除，供「是否值得展示」和计数使用。
 */
function usableAuthMethods(provider: ProviderInfo): ProviderInfo["authMethods"] {
	return provider.authMethods.filter((m) => m !== "oauth_subscription");
}

type Filter = "common" | "all" | "configured" | "domestic";

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
	/** 只认普通 OAuth；订阅登录入口已移除 */
	const oauth = provider.authMethods.find((m) => m === "oauth");

	return (
		<div className="border-b border-border last:border-b-0">
			<div className="flex items-center gap-3 px-5 py-3.5">
				<button type="button" onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1 text-left">
					<div className="flex items-center gap-2">
						<span className="text-[13.5px] font-medium text-fg">{provider.name}</span>
						<span className="font-mono text-[11.5px] text-muted">{provider.id}</span>
						{provider.custom && <Badge tone="accent">自定义</Badge>}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
						{provider.configured ? (
							<Badge tone="ok">
								已配置
								{provider.authSource ? ` · ${SOURCE_LABEL[provider.authSource] ?? provider.authSource}` : ""}
								{provider.authLabel ? ` · ${provider.authLabel}` : ""}
							</Badge>
						) : (
							<Badge>未配置</Badge>
						)}
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
							OAuth 登录
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
				<div className="space-y-3 bg-panel-2/60 px-5 pt-2 pb-4">
					{providerModels.length === 0 ? (
						<div className="text-[12.5px] text-muted">配置凭据后可在此测试连接。</div>
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
							className={`rounded-xl px-3.5 py-2.5 text-[12.5px] ${
								result.ok ? "bg-ok-soft text-accent-strong" : "bg-err-soft text-err"
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

	/** 常用视图：主流供应商 + 已配置的（含自定义端点） */
	const isCommon = (p: ProviderInfo) => COMMON.has(p.id) || p.configured;

	/** 没有可用登录方式且未配置的供应商不展示（例如只剩订阅登录的 OpenAI Codex legacy） */
	const isUsable = (p: ProviderInfo) => usableAuthMethods(p).length > 0 || p.configured;

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return providers
			.filter(isUsable)
			.filter((p) => {
				if (filter === "common") return isCommon(p);
				if (filter === "configured") return p.configured;
				if (filter === "domestic") return DOMESTIC.has(p.id);
				return true;
			})
			.filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q))
			.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}, [providers, filter, query]);

	// 计数基于可展示的供应商，否则「全部」的数字会比列表多
	const usable = providers.filter(isUsable);
	const counts = {
		common: usable.filter(isCommon).length,
		all: usable.length,
		configured: usable.filter((p) => p.configured).length,
		domestic: usable.filter((p) => DOMESTIC.has(p.id)).length,
	};

	return (
		<div>
			<div className="mb-4 flex items-center gap-3">
				<Segmented
					items={[
						{ id: "common", label: `常用 ${counts.common}` },
						{ id: "all", label: `全部 ${counts.all}` },
						{ id: "configured", label: `已配置 ${counts.configured}` },
						{ id: "domestic", label: `国内 ${counts.domestic}` },
					]}
					active={filter}
					onChange={(id) => setFilter(id as Filter)}
				/>
				<div className="flex-1" />
				<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索供应商" className="max-w-56" />
			</div>

			{filter === "common" && counts.all > counts.common && (
				<div className="mb-4 text-[12px] text-muted">已隐藏 {counts.all - counts.common} 个不常用供应商，点「全部」查看。</div>
			)}

			<div className="mb-4 rounded-xl bg-panel-2 px-4 py-3 text-[12px] leading-relaxed text-muted">
				凭据优先级：auth.json（这里登录保存的）&gt; models.json 中的 apiKey &gt; 环境变量。API Key 以明文保存在
				配置目录的 auth.json 中（桌面版计划改为系统加密存储）。
			</div>

			{error && <div className="mb-4 rounded-xl bg-err-soft px-3.5 py-2.5 text-[13px] text-err">{error}</div>}
			{loading && providers.length === 0 ? (
				<div className="py-10 text-center text-muted">正在读取供应商…</div>
			) : (
				<div className="overflow-hidden rounded-2xl border border-border bg-surface-raised">
					{visible.map((p) => (
						<ProviderRow key={p.id} provider={p} models={models} />
					))}
					{visible.length === 0 && <div className="px-5 py-8 text-center text-[13px] text-muted">没有匹配的供应商</div>}
				</div>
			)}
		</div>
	);
}
