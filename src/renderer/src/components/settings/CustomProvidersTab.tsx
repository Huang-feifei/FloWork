import { useEffect, useMemo, useState } from "react";
import { THINKING_LEVELS } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { thinkingLabel } from "../../lib/format";
import { Badge, Button, Field, Input, Select } from "../ui";
import { isMtimeConflict, parseObject, useConfigFile } from "./useConfigFile";

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
}

/** 只保留两类中转预设；具体的地址与模型在表单里填 */
const PRESETS: Preset[] = [
	{ label: "OpenAI 兼容中转", key: "relay-openai", api: "openai-completions", baseUrl: "" },
	{ label: "Anthropic 兼容中转", key: "relay-anthropic", api: "anthropic-messages", baseUrl: "" },
];

/** 每个模型的配置；未填的字段不会写入 models.json，pi 会用自己的默认值 */
interface ModelDraft {
	id: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	image: boolean;
	cost: { input: string; output: string; cacheRead: string; cacheWrite: string };
	/** thinkingLevelMap：等级 → 发送给服务端的值。空 = 不写；null 文本 = 隐藏该等级 */
	thinking: Record<string, string>;
	/** 其余字段（headers、compat、samplingParams、inputLimits…）的 JSON */
	advanced: string;
	open: boolean;
}

interface Draft {
	originalKey?: string;
	key: string;
	api: string;
	baseUrl: string;
	apiKey: string;
	models: ModelDraft[];
}

type ProviderConfig = Record<string, unknown> & { models?: Array<Record<string, unknown>> };

/** 表格里单独编辑的字段，其余原样留在 advanced */
const FORM_MODEL_KEYS = new Set(["id", "name", "contextWindow", "maxTokens", "reasoning", "input", "cost", "thinkingLevelMap"]);
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function modelIds(config: ProviderConfig): string[] {
	return (config.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
}

function splitModels(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

function emptyModel(id = ""): ModelDraft {
	return {
		id,
		name: "",
		contextWindow: "",
		maxTokens: "",
		reasoning: false,
		image: false,
		cost: { input: "", output: "", cacheRead: "", cacheWrite: "" },
		thinking: {},
		advanced: "",
		open: false,
	};
}

/** 把 models.json 里的一条模型配置拆成表格字段 + 其余 JSON */
function toModelDraft(entry: Record<string, unknown>): ModelDraft {
	const draft = emptyModel(String(entry.id ?? ""));
	draft.name = typeof entry.name === "string" ? entry.name : "";
	draft.reasoning = entry.reasoning === true;
	const cost = (entry.cost ?? {}) as Record<string, unknown>;
	for (const key of COST_KEYS) if (cost[key] !== undefined) draft.cost[key] = String(cost[key]);
	const map = (entry.thinkingLevelMap ?? {}) as Record<string, unknown>;
	for (const level of THINKING_LEVELS) {
		const value = map[level];
		if (value === null) draft.thinking[level] = "null";
		else if (value !== undefined) draft.thinking[level] = String(value);
	}
	const known = new Set(FORM_MODEL_KEYS);
	// 只写 text 或 text+image 时可以用勾选框表示，其他组合保留在 JSON 里
	if (Array.isArray(entry.input) && entry.input.every((v) => v === "text" || v === "image")) draft.image = entry.input.includes("image");
	else known.delete("input");
	if (entry.contextWindow !== undefined) draft.contextWindow = String(entry.contextWindow);
	if (entry.maxTokens !== undefined) draft.maxTokens = String(entry.maxTokens);
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) if (!known.has(key)) rest[key] = value;
	if (Object.keys(rest).length > 0) draft.advanced = JSON.stringify(rest, null, 2);
	return draft;
}

/** 表单字段优先于 advanced 里的同名字段 */
function toModelEntry(model: ModelDraft): Record<string, unknown> {
	const advanced = model.advanced.trim() ? (JSON.parse(model.advanced) as Record<string, unknown>) : {};
	const entry: Record<string, unknown> = { ...advanced, id: model.id.trim() };
	if (model.name.trim()) entry.name = model.name.trim();
	else delete entry.name;
	if (model.contextWindow.trim()) entry.contextWindow = Number(model.contextWindow);
	else delete entry.contextWindow;
	if (model.maxTokens.trim()) entry.maxTokens = Number(model.maxTokens);
	else delete entry.maxTokens;
	if (model.reasoning) entry.reasoning = true;
	else delete entry.reasoning;
	if (model.image) entry.input = ["text", "image"];
	else if (advanced.input === undefined) delete entry.input;
	else entry.input = ["text"];
	if (COST_KEYS.some((key) => model.cost[key].trim())) {
		// pi 要求 cost 的四项齐全，未填的按 0 计
		entry.cost = Object.fromEntries(COST_KEYS.map((key) => [key, model.cost[key].trim() ? Number(model.cost[key]) : 0]));
	} else delete entry.cost;
	const thinkingMap: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) {
		const value = (model.thinking[level] ?? "").trim();
		if (!value) continue;
		thinkingMap[level] = value.toLowerCase() === "null" ? null : value;
	}
	if (Object.keys(thinkingMap).length > 0) entry.thinkingLevelMap = thinkingMap;
	else delete entry.thinkingLevelMap;
	return entry;
}

function positiveInt(text: string): boolean {
	if (!text.trim()) return true;
	const value = Number(text);
	return Number.isFinite(value) && value > 0;
}

/** 保存前校验；返回第一条错误 */
function validateModels(models: ModelDraft[]): string | undefined {
	const seen = new Set<string>();
	for (const model of models) {
		const id = model.id.trim();
		if (!id) return "模型 ID 不能为空";
		if (seen.has(id)) return `模型 ID 重复：${id}`;
		seen.add(id);
		if (!positiveInt(model.contextWindow)) return `${id}：上下文窗口必须是正数`;
		if (!positiveInt(model.maxTokens)) return `${id}：最大输出必须是正数`;
		for (const key of COST_KEYS) {
			const value = model.cost[key].trim();
			if (value && !(Number.isFinite(Number(value)) && Number(value) >= 0)) return `${id}：价格 ${key} 必须是非负数`;
		}
		if (model.advanced.trim()) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(model.advanced);
			} catch (error) {
				return `${id}：附加字段不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`;
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `${id}：附加字段必须是 JSON 对象`;
			if ("id" in (parsed as Record<string, unknown>)) return `${id}：附加字段里不能有 id`;
		}
	}
	return undefined;
}

const MODEL_INPUT =
	"rounded border border-border bg-bg px-1.5 py-1 font-mono text-[11px] outline-none placeholder:text-muted/50 focus:border-accent";

/** 表格里一行一个模型；展开后编辑价格与其余字段 */
function ModelRow({
	model,
	index,
	onPatch,
	onRemove,
}: {
	model: ModelDraft;
	index: number;
	onPatch: (index: number, patch: Partial<ModelDraft>) => void;
	onRemove: (index: number) => void;
}) {
	const chip = (on: boolean) =>
		`shrink-0 rounded px-1.5 py-1 text-[11px] ${on ? "bg-accent text-accent-foreground" : "bg-panel-2 text-muted hover:text-fg"}`;
	return (
		<div className="rounded border border-border bg-bg/60">
			<div className="flex items-center gap-1.5 p-1.5">
				<input
					value={model.id}
					onChange={(e) => onPatch(index, { id: e.target.value })}
					placeholder="模型 ID"
					className={`${MODEL_INPUT} min-w-0 flex-1`}
				/>
				<input
					value={model.name}
					onChange={(e) => onPatch(index, { name: e.target.value })}
					placeholder="显示名"
					title="显示名，留空则显示模型 ID"
					className={`${MODEL_INPUT} w-28`}
				/>
				<input
					value={model.contextWindow}
					onChange={(e) => onPatch(index, { contextWindow: e.target.value })}
					placeholder="上下文"
					title="上下文窗口（token），留空用默认值 128000"
					className={`${MODEL_INPUT} w-24`}
				/>
				<input
					value={model.maxTokens}
					onChange={(e) => onPatch(index, { maxTokens: e.target.value })}
					placeholder="最大输出"
					title="单次最大输出 token，留空用默认值 16384"
					className={`${MODEL_INPUT} w-24`}
				/>
				<button
					type="button"
					onClick={() => onPatch(index, { reasoning: !model.reasoning })}
					title="打开后，这个模型在输入框里就能选择思考强度；xhigh / max 需要在「更多」里用 thinkingLevelMap 显式映射"
					className={chip(model.reasoning)}
				>
					思考
				</button>
				<button
					type="button"
					onClick={() => onPatch(index, { image: !model.image })}
					title="是否支持图片输入"
					className={chip(model.image)}
				>
					图片
				</button>
				<button
					type="button"
					onClick={() => onPatch(index, { open: !model.open })}
					title="价格与其余字段"
					className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
				>
					{model.open ? "▾ 收起" : "▸ 更多"}
				</button>
				<button
					type="button"
					onClick={() => onRemove(index)}
					title="移除这个模型"
					className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-err"
				>
					✕
				</button>
			</div>
			{model.open && (
				<div className="space-y-2 border-t border-border px-2 py-2">
					<div>
						<div className="mb-1 text-[11px] text-muted">价格（美元 / 百万 token；填任意一项即视为自定义价格，未填的按 0 写入）</div>
						<div className="grid grid-cols-4 gap-1.5">
							{(
								[
									["input", "输入"],
									["output", "输出"],
									["cacheRead", "缓存读"],
									["cacheWrite", "缓存写"],
								] as const
							).map(([key, label]) => (
								<input
									key={key}
									value={model.cost[key]}
									onChange={(e) => onPatch(index, { cost: { ...model.cost, [key]: e.target.value } })}
									placeholder={label}
									className={`${MODEL_INPUT} w-full`}
								/>
							))}
						</div>
					</div>
					<div>
						<div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
							<span>
								思考等级映射：留空 = pi 默认（关闭/最小/低/中/高 直接发送等级名，极高/最大必须在这里填值才会出现在输入框）；填
								null = 隐藏该等级
							</span>
							<button
								type="button"
								onClick={() =>
									onPatch(index, { thinking: { ...model.thinking, xhigh: "xhigh", max: "max" } })
								}
								className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted hover:text-fg"
							>
								极高/最大填同名值
							</button>
						</div>
						<div className="grid grid-cols-4 gap-1.5">
							{THINKING_LEVELS.map((level) => (
								<input
									key={level}
									value={model.thinking[level] ?? ""}
									onChange={(e) => onPatch(index, { thinking: { ...model.thinking, [level]: e.target.value } })}
									placeholder={thinkingLabel(level)}
									title={`${thinkingLabel(level)}（${level}）对应的值；留空不写，null 表示隐藏该等级`}
									className={`${MODEL_INPUT} w-full`}
								/>
							))}
						</div>
					</div>
					<div>
						<div className="mb-1 text-[11px] text-muted">
							其余字段（JSON，会与上面的字段合并）：headers、compat、samplingParams、inputLimits、api、baseUrl、promptCache…
						</div>
						<textarea
							value={model.advanced}
							onChange={(e) => onPatch(index, { advanced: e.target.value })}
							rows={4}
							placeholder={'{\n  "thinkingLevelMap": { "off": null, "high": "high" }\n}'}
							className="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
						/>
					</div>
				</div>
			)}
		</div>
	);
}

function Editor({
	draft,
	builtinIds,
	conflict,
	onCancel,
	onSave,
	onForceSave,
	onReload,
}: {
	draft: Draft;
	builtinIds: Set<string>;
	/** models.json 已被外部改动：这份 draft 基于旧内容，保存会被拒绝 */
	conflict: boolean;
	onCancel: () => void;
	onSave: (draft: Draft) => Promise<void>;
	onForceSave: (draft: Draft) => Promise<void>;
	onReload: () => Promise<void>;
}) {
	const [d, setD] = useState(draft);
	const [fetched, setFetched] = useState<string[] | null>(null);
	const [fetchFilter, setFetchFilter] = useState("");
	const [bulk, setBulk] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const update = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
	const patchModel = (index: number, patch: Partial<ModelDraft>) =>
		setD((prev) => ({ ...prev, models: prev.models.map((m, i) => (i === index ? { ...m, ...patch } : m)) }));
	const addModels = (ids: string[]) =>
		setD((prev) => ({
			...prev,
			models: [...prev.models, ...ids.filter((id) => !prev.models.some((m) => m.id.trim() === id)).map((id) => emptyModel(id))],
		}));
	const selected = d.models.map((m) => m.id.trim()).filter(Boolean);
	const keyValid = /^[a-z0-9][a-z0-9._-]*$/i.test(d.key);
	const overridesBuiltin = builtinIds.has(d.key);
	const invalid = validateModels(d.models);

	const fetchModels = async () => {
		setError(null);
		const literalKey = d.apiKey && !d.apiKey.startsWith("$") && !d.apiKey.startsWith("!") ? d.apiKey : undefined;
		try {
			setFetched(await api.service({ type: "fetch_remote_models", baseUrl: d.baseUrl, apiKey: literalKey }));
		} catch (e) {
			setError(`拉取失败：${errorText(e)}`);
		}
	};

	const save = async (force: boolean) => {
		setBusy(true);
		setError(null);
		try {
			await (force ? onForceSave(d) : onSave(d));
		} catch (e) {
			// 冲突交给下面的内联提示处理（让用户选保留哪一份）；draft 保持原样，不因失败被清掉
			if (!isMtimeConflict(e)) setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const visibleFetched = (fetched ?? []).filter((id) => id.toLowerCase().includes(fetchFilter.toLowerCase()));

	return (
		<div className="space-y-3 rounded-md border border-accent/40 bg-panel p-4">
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

			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium">模型（{d.models.length} 个）</span>
					<span className="text-[11px] text-muted">留空的字段不写入 models.json，pi 用默认值</span>
					<div className="flex-1" />
					<Input
						value={bulk}
						onChange={(e) => setBulk(e.target.value)}
						placeholder="粘贴多个 ID，逗号或换行分隔"
						className="max-w-56"
					/>
					<Button
						size="sm"
						disabled={splitModels(bulk).length === 0}
						onClick={() => {
							addModels(splitModels(bulk));
							setBulk("");
						}}
					>
						添加
					</Button>
					<Button size="sm" disabled={!d.baseUrl} onClick={() => void fetchModels()}>
						从接口拉取
					</Button>
					<Button size="sm" variant="primary" onClick={() => addModels([""])}>
						+ 空白模型
					</Button>
				</div>

				{d.models.length === 0 && (
					<div className="rounded border border-border bg-bg px-3 py-4 text-center text-xs text-muted">
						还没有模型。用「从接口拉取」调用 GET {"{Base URL}"}/models，或点「+ 空白模型」手动添加。
					</div>
				)}
				{d.models.map((model, index) => (
					<ModelRow
						// biome-ignore lint/suspicious/noArrayIndexKey: 行可增删，用索引保持输入焦点
						key={index}
						model={model}
						index={index}
						onPatch={patchModel}
						onRemove={(i) => setD((prev) => ({ ...prev, models: prev.models.filter((_, j) => j !== i) }))}
					/>
				))}

				{fetched && (
					<div className="rounded-md border border-border bg-bg p-2">
						<div className="mb-2 flex items-center gap-2">
							<Input value={fetchFilter} onChange={(e) => setFetchFilter(e.target.value)} placeholder={`筛选（共 ${fetched.length} 个）`} />
							<Button size="sm" onClick={() => addModels(visibleFetched)}>
								添加筛选结果
							</Button>
						</div>
						<div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
							{visibleFetched.map((id) => (
								<button
									type="button"
									key={id}
									onClick={() => addModels([id])}
									className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
										selected.includes(id) ? "bg-accent text-accent-foreground" : "bg-panel-2 text-muted hover:text-fg"
									}`}
								>
									{id}
								</button>
							))}
						</div>
					</div>
				)}
			</div>

			{conflict && (
				<div className="rounded border border-warn/40 bg-warn-soft px-2 py-1.5 text-xs text-warn">
					<div>models.json 在你打开之后被其他程序改过；直接保存会被拒绝，以免覆盖对方的改动。你填的内容还在这里。</div>
					<div className="mt-1.5 flex flex-wrap gap-2">
						<Button size="sm" disabled={busy} onClick={() => void onReload()}>
							重新加载磁盘版本（保留我的填写）
						</Button>
						<Button size="sm" variant="primary" disabled={busy} onClick={() => void save(true)}>
							用我的内容覆盖磁盘版本（丢弃对方的改动）
						</Button>
					</div>
				</div>
			)}
			{(error || invalid) && (
				<div className="rounded border border-err/40 bg-err/10 px-2 py-1 text-xs text-err">{error ?? invalid}</div>
			)}
			<div className="flex justify-end gap-2">
				<Button onClick={onCancel}>取消</Button>
				<Button
					variant="primary"
					disabled={busy || !keyValid || !d.baseUrl || d.models.length === 0 || !!invalid}
					onClick={() => void save(false)}
				>
					{busy ? "保存中…" : "保存到 models.json"}
				</Button>
			</div>
		</div>
	);
}

export function CustomProvidersTab() {
	const { file, error, conflict, reload, save } = useConfigFile("models");
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

	// force：用户已确认用本地内容覆盖磁盘版本，跳过 mtime 校验
	const persist = async (next: Record<string, unknown>, message: string, force = false) => {
		await save(`${JSON.stringify(next, null, 2)}\n`, { force });
		pushNotice("info", message);
	};

	const saveDraft = async (d: Draft, force = false) => {
		if (!parsed) throw new Error("models.json 无法解析，请先在“配置文件”页修复");
		const invalid = validateModels(d.models);
		if (invalid) throw new Error(invalid);
		const nextProviders = { ...providers };
		const existing: ProviderConfig = (d.originalKey ? nextProviders[d.originalKey] : undefined) ?? {};
		if (d.originalKey && d.originalKey !== d.key) delete nextProviders[d.originalKey];
		const config: ProviderConfig = {
			...existing,
			baseUrl: d.baseUrl,
			api: d.api,
			models: d.models.map(toModelEntry),
		};
		if (d.apiKey) config.apiKey = d.apiKey;
		else delete config.apiKey;
		nextProviders[d.key] = config;
		await persist({ ...parsed, providers: nextProviders }, `已保存自定义供应商 ${d.key}`, force);
		// 只有保存成功才关掉表单：失败（含 mtime 冲突）时保留用户填的内容
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
			models: (c.models ?? []).map(toModelDraft),
		});
	};

	if (error || parseError) {
		return <div className="rounded border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error ?? `models.json 解析失败：${parseError}`}</div>;
	}

	return (
		<div className="space-y-4">
			{conflict && !draft && (
				<div className="flex items-center gap-2 rounded border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
					<span className="flex-1">models.json 已被其他程序改过，下面显示的列表是打开页面时的旧内容；直接保存会被拒绝，以免覆盖对方的改动。</span>
					<Button size="sm" onClick={() => void reload()}>
						重新加载磁盘版本
					</Button>
				</div>
			)}
			<div>
				<div className="mb-2 text-xs text-muted">新建：</div>
				<div className="flex flex-wrap gap-1.5">
					{PRESETS.map((p) => (
						<Button
							key={p.key}
							size="sm"
							onClick={() => setDraft({ key: p.key, api: p.api, baseUrl: p.baseUrl, apiKey: "", models: [] })}
						>
							+ {p.label}
						</Button>
					))}
					<Button size="sm" variant="primary" onClick={() => setDraft({ key: "", api: "openai-completions", baseUrl: "", apiKey: "", models: [] })}>
						+ 空白
					</Button>
				</div>
			</div>

			{draft && (
				<Editor
					key={draft.originalKey ?? draft.key}
					draft={draft}
					builtinIds={builtinIds}
					conflict={conflict}
					onCancel={() => setDraft(null)}
					onSave={saveDraft}
					onForceSave={(d) => saveDraft(d, true)}
					onReload={reload}
				/>
			)}

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
