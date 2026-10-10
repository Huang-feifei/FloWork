import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Badge, Button, Field, Input, Select } from "../ui";
import { parseObject, useConfigFile } from "./useConfigFile";

const API_TYPES = [
	{ id: "openai-completions", label: "OpenAI Chat Completions（最常见）" },
	{ id: "openai-responses", label: "OpenAI Responses" },
	{ id: "anthropic-messages", label: "Anthropic Messages" },
	{ id: "google-generative-ai", label: "Google Generative AI" },
	{ id: "mistral-conversations", label: "Mistral Conversations" },
];

interface Preset {
	label: string;
	key: string;
	api: string;
	baseUrl: string;
	apiKey?: string;
	note?: string;
}

/** 预设地址来自各家公开文档，使用前请核对 */
const PRESETS: Preset[] = [
	{ label: "火山方舟（豆包）", key: "volcengine", api: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", note: "模型 ID 填推理接入点 ID 或模型名" },
	{ label: "阿里云百炼", key: "dashscope", api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
	{ label: "硅基流动", key: "siliconflow", api: "openai-completions", baseUrl: "https://api.siliconflow.cn/v1" },
	{ label: "智谱开放平台", key: "zhipu", api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
	{ label: "Ollama（本地）", key: "ollama", api: "openai-completions", baseUrl: "http://localhost:11434/v1", apiKey: "ollama", note: "Ollama 忽略 Key，但 pi 需要一个非空值" },
	{ label: "LM Studio（本地）", key: "lmstudio", api: "openai-completions", baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio" },
	{ label: "OpenAI 兼容中转", key: "relay-openai", api: "openai-completions", baseUrl: "" },
	{ label: "Anthropic 兼容中转", key: "relay-anthropic", api: "anthropic-messages", baseUrl: "" },
];

interface Draft {
	originalKey?: string;
	key: string;
	api: string;
	baseUrl: string;
	apiKey: string;
	models: string;
	note?: string;
}

type ProviderConfig = Record<string, unknown> & { models?: Array<Record<string, unknown>> };

function modelIds(config: ProviderConfig): string[] {
	return (config.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
}

function splitModels(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

function Editor({
	draft,
	builtinIds,
	onCancel,
	onSave,
}: {
	draft: Draft;
	builtinIds: Set<string>;
	onCancel: () => void;
	onSave: (draft: Draft) => Promise<void>;
}) {
	const [d, setD] = useState(draft);
	const [fetched, setFetched] = useState<string[] | null>(null);
	const [fetchFilter, setFetchFilter] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const update = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
	const selected = splitModels(d.models);
	const keyValid = /^[a-z0-9][a-z0-9._-]*$/i.test(d.key);
	const overridesBuiltin = builtinIds.has(d.key);

	const fetchModels = async () => {
		setError(null);
		const literalKey = d.apiKey && !d.apiKey.startsWith("$") && !d.apiKey.startsWith("!") ? d.apiKey : undefined;
		try {
			setFetched(await api.service({ type: "fetch_remote_models", baseUrl: d.baseUrl, apiKey: literalKey }));
		} catch (e) {
			setError(`拉取失败：${errorText(e)}`);
		}
	};

	const toggle = (id: string) => {
		const next = selected.includes(id) ? selected.filter((m) => m !== id) : [...selected, id];
		update({ models: next.join("\n") });
	};

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			await onSave(d);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const visibleFetched = (fetched ?? []).filter((id) => id.toLowerCase().includes(fetchFilter.toLowerCase()));

	return (
		<div className="space-y-3 rounded-md border border-accent/40 bg-panel p-4">
			{d.note && <div className="text-xs text-warn">{d.note}</div>}
			<div className="grid grid-cols-2 gap-3">
				<Field
					label="供应商 ID"
					hint={
						overridesBuiltin
							? "与内置供应商同名：将覆盖该内置供应商的地址或模型列表"
							: "在模型选择器中显示为 ID / 模型名，只能用字母、数字、. _ -"
					}
				>
					<Input value={d.key} onChange={(e) => update({ key: e.target.value.trim() })} placeholder="例如 siliconflow" />
				</Field>
				<Field label="接口类型">
					<Select value={d.api} onChange={(e) => update({ api: e.target.value })}>
						{API_TYPES.map((t) => (
							<option key={t.id} value={t.id}>
								{t.label}
							</option>
						))}
					</Select>
				</Field>
			</div>
			<Field label="Base URL" hint="OpenAI 兼容接口通常以 /v1 结尾">
				<Input value={d.baseUrl} onChange={(e) => update({ baseUrl: e.target.value.trim() })} placeholder="https://…/v1" />
			</Field>
			<Field
				label="API Key"
				hint={
					<>
						明文写入 models.json。也可以写 <code>$环境变量名</code> 读取环境变量，或 <code>!命令</code> 从命令输出读取。
					</>
				}
			>
				<Input type="password" value={d.apiKey} onChange={(e) => update({ apiKey: e.target.value })} autoComplete="off" />
			</Field>
			<Field label={`模型 ID（每行一个，已选 ${selected.length} 个）`}>
				<textarea
					value={d.models}
					onChange={(e) => update({ models: e.target.value })}
					rows={Math.min(8, Math.max(3, selected.length + 1))}
					className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent"
					placeholder="deepseek-ai/DeepSeek-V3"
				/>
			</Field>
			<div className="flex items-center gap-2">
				<Button size="sm" disabled={!d.baseUrl} onClick={() => void fetchModels()}>
					从接口拉取模型列表
				</Button>
				<span className="text-[11px] text-muted">调用 GET {"{Base URL}"}/models，仅部分服务支持</span>
			</div>
			{fetched && (
				<div className="rounded-md border border-border bg-bg p-2">
					<div className="mb-2 flex items-center gap-2">
						<Input value={fetchFilter} onChange={(e) => setFetchFilter(e.target.value)} placeholder={`筛选（共 ${fetched.length} 个）`} />
						<Button size="sm" onClick={() => update({ models: [...new Set([...selected, ...visibleFetched])].join("\n") })}>
							添加筛选结果
						</Button>
					</div>
					<div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
						{visibleFetched.map((id) => (
							<button
								type="button"
								key={id}
								onClick={() => toggle(id)}
								className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
									selected.includes(id) ? "bg-accent text-white" : "bg-panel-2 text-muted hover:text-fg"
								}`}
							>
								{id}
							</button>
						))}
					</div>
				</div>
			)}
			{error && <div className="rounded border border-err/40 bg-err/10 px-2 py-1 text-xs text-err">{error}</div>}
			<div className="flex justify-end gap-2">
				<Button onClick={onCancel}>取消</Button>
				<Button variant="primary" disabled={busy || !keyValid || !d.baseUrl || selected.length === 0} onClick={() => void save()}>
					{busy ? "保存中…" : "保存到 models.json"}
				</Button>
			</div>
		</div>
	);
}

export function CustomProvidersTab() {
	const { file, error, save } = useConfigFile("models");
	const pushNotice = useApp((s) => s.pushNotice);
	const configVersion = useApp((s) => s.configVersion);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [builtinIds, setBuiltinIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		void api
			.service({ type: "list_providers" })
			.then((list) => setBuiltinIds(new Set(list.filter((p) => !p.custom).map((p) => p.id))))
			.catch(() => undefined);
	}, [configVersion]);

	const { parsed, parseError } = useMemo(() => {
		try {
			return { parsed: parseObject(file?.text), parseError: null };
		} catch (e) {
			return { parsed: null, parseError: errorText(e) };
		}
	}, [file]);

	const providers = (parsed?.providers ?? {}) as Record<string, ProviderConfig>;

	const persist = async (next: Record<string, unknown>, message: string) => {
		await save(`${JSON.stringify(next, null, 2)}\n`);
		pushNotice("info", message);
	};

	const saveDraft = async (d: Draft) => {
		if (!parsed) throw new Error("models.json 无法解析，请先在“配置文件”页修复");
		const nextProviders = { ...providers };
		const existing: ProviderConfig = (d.originalKey ? nextProviders[d.originalKey] : undefined) ?? {};
		if (d.originalKey && d.originalKey !== d.key) delete nextProviders[d.originalKey];
		const existingModels = new Map((existing.models ?? []).map((m) => [String(m.id), m]));
		const config: ProviderConfig = {
			...existing,
			baseUrl: d.baseUrl,
			api: d.api,
			models: splitModels(d.models).map((id) => existingModels.get(id) ?? { id }),
		};
		if (d.apiKey) config.apiKey = d.apiKey;
		else delete config.apiKey;
		nextProviders[d.key] = config;
		await persist({ ...parsed, providers: nextProviders }, `已保存自定义供应商 ${d.key}`);
		setDraft(null);
	};

	const remove = async (key: string) => {
		if (!parsed || !window.confirm(`从 models.json 删除供应商 ${key}？`)) return;
		const nextProviders = { ...providers };
		delete nextProviders[key];
		try {
			await persist({ ...parsed, providers: nextProviders }, `已删除 ${key}`);
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const edit = (key: string) => {
		const c = providers[key] ?? {};
		setDraft({
			originalKey: key,
			key,
			api: typeof c.api === "string" ? c.api : "openai-completions",
			baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : "",
			apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
			models: modelIds(c).join("\n"),
		});
	};

	if (error || parseError) {
		return <div className="rounded border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error ?? `models.json 解析失败：${parseError}`}</div>;
	}

	return (
		<div className="space-y-4">
			<div>
				<div className="mb-2 text-xs text-muted">从预设新建（地址取自各家公开文档，请核对）：</div>
				<div className="flex flex-wrap gap-1.5">
					{PRESETS.map((p) => (
						<Button
							key={p.key}
							size="sm"
							onClick={() =>
								setDraft({ key: p.key, api: p.api, baseUrl: p.baseUrl, apiKey: p.apiKey ?? "", models: "", note: p.note })
							}
						>
							+ {p.label}
						</Button>
					))}
					<Button size="sm" variant="primary" onClick={() => setDraft({ key: "", api: "openai-completions", baseUrl: "", apiKey: "", models: "" })}>
						+ 空白
					</Button>
				</div>
			</div>

			{draft && <Editor key={draft.originalKey ?? draft.key} draft={draft} builtinIds={builtinIds} onCancel={() => setDraft(null)} onSave={saveDraft} />}

			<div className="overflow-hidden rounded-md border border-border bg-panel">
				{Object.keys(providers).length === 0 && (
					<div className="px-3 py-6 text-center text-sm text-muted">还没有自定义供应商。{file && !file.exists ? "（models.json 尚未创建）" : ""}</div>
				)}
				{Object.entries(providers).map(([key, c]) => (
					<div key={key} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="font-medium">{key}</span>
								{builtinIds.has(key) && <Badge tone="warn">覆盖内置</Badge>}
								<Badge>{String(c.api ?? "（继承）")}</Badge>
								{c.apiKey ? <Badge tone="ok">已填 Key</Badge> : <Badge>无 Key</Badge>}
							</div>
							<div className="truncate font-mono text-[11px] text-muted">{String(c.baseUrl ?? "")}</div>
							<div className="truncate text-[11px] text-muted">模型：{modelIds(c).join("、") || "（无）"}</div>
						</div>
						<Button size="sm" onClick={() => edit(key)}>
							编辑
						</Button>
						<Button size="sm" variant="danger" onClick={() => void remove(key)}>
							删除
						</Button>
					</div>
				))}
			</div>
			<div className="text-[11px] text-muted">
				保存后可到“模型供应商”页展开该供应商测试连接。更复杂的配置（headers、compat、modelOverrides、思考参数等）请在“配置文件”页直接编辑。
			</div>
		</div>
	);
}
