/**
 * 编辑自定义端点：弹窗形态（与设计稿一致）。
 * 上半是端点字段（供应商 ID / 接口类型 / Base URL / API Key），
 * 下半用分段控件在「聊天模型」与「图片生成」两份清单之间切换 —— 弹窗高度恒定，一屏就能看完。
 * 两份清单各自的「编辑…」打开对应的模型弹窗，形成两层弹窗。
 * 保存时整份写入 models.json（图片模型走 imageModels，聊天模型走 models）。
 */
import { useState } from "react";
import { api, errorText } from "../../api/client";
import { isMtimeConflict } from "./useConfigFile";
import { Badge, Button, Field, Input, Modal, Segmented, Select, Toggle } from "../ui";
import { Icon } from "../Icon";
import {
	emptyImageModel,
	ImageModelDialog,
	toImageModelDraft,
	toImageModelEntry,
	validateImageModel,
	type ImageModelDraft,
} from "./ImageModelDialog";
import { emptyModel, ModelDialog, toModelDraft, toModelEntry, validateModel, type ModelDraft } from "./ModelDialog";

const API_TYPES = [
	{ id: "openai-completions", label: "OpenAI Chat Completions（最常见）" },
	{ id: "openai-responses", label: "OpenAI Responses" },
	{ id: "anthropic-messages", label: "Anthropic Messages" },
	{ id: "google-generative-ai", label: "Google Generative AI" },
	{ id: "mistral-conversations", label: "Mistral Conversations" },
];

export type ProviderConfig = Record<string, unknown> & {
	models?: Array<Record<string, unknown>>;
	imageEnabled?: boolean;
	imageModels?: Array<Record<string, unknown>>;
};

export interface EndpointDraft {
	originalKey?: string;
	key: string;
	api: string;
	baseUrl: string;
	apiKey: string;
	models: ModelDraft[];
	imageEnabled: boolean;
	imageModels: ImageModelDraft[];
}

export function modelIds(config: ProviderConfig): string[] {
	return (config.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
}

export function splitModels(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

export function emptyEndpoint(): EndpointDraft {
	return { key: "", api: "openai-completions", baseUrl: "", apiKey: "", models: [], imageEnabled: true, imageModels: [] };
}

/** 把 models.json 里的一条供应商配置读成草稿 */
export function toEndpointDraft(key: string, config: ProviderConfig): EndpointDraft {
	return {
		originalKey: key,
		key,
		api: typeof config.api === "string" ? config.api : "openai-completions",
		baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
		apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
		models: (config.models ?? []).map(toModelDraft),
		imageEnabled: config.imageEnabled !== false,
		imageModels: (config.imageModels ?? []).map(toImageModelDraft),
	};
}

/** 草稿 → models.json 里的供应商条目；留空的字段不写 */
export function toEndpointConfig(d: EndpointDraft): Record<string, unknown> {
	const models = d.models.map(toModelEntry);
	const imageModels = d.imageModels.map(toImageModelEntry);
	const config: Record<string, unknown> = { api: d.api };
	if (d.baseUrl.trim()) config.baseUrl = d.baseUrl.trim();
	if (d.apiKey) config.apiKey = d.apiKey;
	if (models.length > 0) config.models = models;
	if (imageModels.length > 0) {
		config.imageEnabled = d.imageEnabled;
		config.imageModels = imageModels;
	}
	return config;
}

export function validateEndpoint(d: EndpointDraft): string | undefined {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(d.key)) return "供应商 ID 只能使用字母、数字、点、下划线和短横线，且不能以符号开头";
	if (!d.baseUrl.trim()) return "Base URL 不能为空";
	const seen = new Set<string>();
	for (const model of d.models) {
		const invalid = validateModel(model);
		if (invalid) return invalid;
		const id = model.id.trim();
		if (seen.has(id)) return `模型 ID 重复：${id}`;
		seen.add(id);
	}
	for (const model of d.imageModels) {
		const invalid = validateImageModel(model);
		if (invalid) return invalid;
	}
	return undefined;
}

/** 端点编辑弹窗 */
export function EndpointDialog({
	draft,
	builtinIds,
	conflict,
	onCancel,
	onSave,
	onForceSave,
	onReload,
}: {
	draft: EndpointDraft;
	builtinIds: Set<string>;
	/** models.json 已被外部改动：这份 draft 基于旧内容，保存会被拒绝 */
	conflict: boolean;
	onCancel: () => void;
	onSave: (draft: EndpointDraft) => Promise<void>;
	onForceSave: (draft: EndpointDraft) => Promise<void>;
	onReload: () => Promise<void>;
}) {
	const [d, setD] = useState(draft);
	const [section, setSection] = useState<"models" | "images">("models");
	const [fetched, setFetched] = useState<string[] | null>(null);
	const [fetchFilter, setFetchFilter] = useState("");
	const [bulk, setBulk] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 正在编辑的模型：index = -1 表示新增 */
	const [modelEdit, setModelEdit] = useState<{ index: number; draft: ModelDraft } | null>(null);
	const [imageEdit, setImageEdit] = useState<{ index: number; draft: ImageModelDraft } | null>(null);

	const update = (patch: Partial<EndpointDraft>) => setD((prev) => ({ ...prev, ...patch }));
	const overridesBuiltin = builtinIds.has(d.key);
	const invalid = validateEndpoint(d);

	const addModels = (ids: string[]) =>
		setD((prev) => ({
			...prev,
			models: [...prev.models, ...ids.filter((id) => !prev.models.some((m) => m.id.trim() === id)).map((id) => emptyModel(id))],
		}));

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
		const problem = validateEndpoint(d);
		if (problem) {
			setError(problem);
			return;
		}
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
		<Modal
			title={`${d.originalKey ? "编辑端点" : "新建端点"}${d.key ? ` · ${d.key}` : ""}`}
			onClose={onCancel}
			width="w-[760px]"
			footer={
				<>
					<Button onClick={onCancel}>取消</Button>
					<Button variant="primary" disabled={busy} onClick={() => void save(false)}>
						{busy ? "保存中…" : "保存到 models.json"}
					</Button>
				</>
			}
		>
			<div className="grid grid-cols-2 gap-5">
				<Field
					label="供应商 ID"
					hint={
						<>
							写入 models.json 的键，也是模型 ID 的前缀。只能使用字母、数字、<code>.</code>
							<code>_</code>
							<code>-</code>。
						</>
					}
				>
					<Input value={d.key} onChange={(e) => update({ key: e.target.value.trim() })} placeholder="例如 siliconflow" className="font-mono" />
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

			<div className="mt-4 grid grid-cols-2 gap-5">
				<Field label="Base URL" hint="OpenAI 兼容接口通常以 /v1 结尾。">
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
			</div>

			{overridesBuiltin && (
				<div className="mt-4 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12px] text-warn">
					这个 ID 与 pi 内置供应商同名，保存后会覆盖内置的那一份配置。
				</div>
			)}

			{/* 两份清单用分段控件切换：弹窗高度恒定，一屏就能看完 */}
			<div className="mt-6 flex items-center gap-3">
				<Segmented
					items={[
						{ id: "models", label: `聊天模型 ${d.models.length}` },
						{ id: "images", label: `图片生成 ${d.imageModels.length}` },
					]}
					active={section}
					onChange={(id) => setSection(id as "models" | "images")}
				/>
				<span className="min-w-0 truncate text-[12px] text-faint">
					{section === "models"
						? "留空的字段不写入 models.json，pi 用自己的默认值。点「编辑…」设置上下文窗口、价格与思考等级。"
						: "图片模型与聊天模型分开：纯生成走 /images/generations，带参考图走 /images/edits。"}
				</span>
			</div>

			{section === "models" ? (
				<div className="mt-3 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="primary" onClick={() => setModelEdit({ index: -1, draft: emptyModel() })}>
							<Icon name="plus" className="size-4" />
							添加模型
						</Button>
						<Button size="sm" variant="ghost" disabled={!d.baseUrl} onClick={() => void fetchModels()}>
							从接口拉取
						</Button>
						<div className="flex-1" />
						<Input
							value={bulk}
							onChange={(e) => setBulk(e.target.value)}
							placeholder="粘贴多个 ID，逗号或换行分隔"
							className="h-8 max-w-64 px-3 text-[12px]"
						/>
						<Button
							size="sm"
							disabled={splitModels(bulk).length === 0}
							onClick={() => {
								addModels(splitModels(bulk));
								setBulk("");
							}}
						>
							批量添加
						</Button>
					</div>

					{d.models.length === 0 ? (
						<div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border-strong px-4 py-8">
							<span className="text-[12.5px] text-muted">还没有模型。可以从接口拉取，或手动添加。</span>
						</div>
					) : (
						<div className="overflow-hidden rounded-xl border border-border">
							{d.models.map((m, index) => (
								<div key={index} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
									<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{m.id || "（未填 ID）"}</span>
									<span className="min-w-0 flex-1 truncate text-[12px] text-muted">{m.name || "—"}</span>
									<span className="shrink-0 font-mono text-[11px] text-faint">
										{m.contextWindow ? `${m.contextWindow} / ${m.maxTokens || "—"}` : "—"}
									</span>
									{m.reasoning && <Badge tone="accent">思考</Badge>}
									{m.image && <Badge tone="muted">图片</Badge>}
									<Button size="sm" onClick={() => setModelEdit({ index, draft: m })}>
										编辑…
									</Button>
									<button
										type="button"
										title="移除这个模型"
										onClick={() => update({ models: d.models.filter((_, i) => i !== index) })}
										className="flex size-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-panel-2 hover:text-err"
									>
										<Icon name="trash-2" className="size-4" />
									</button>
								</div>
							))}
						</div>
					)}

					{fetched && (
						<div className="rounded-xl border border-border bg-panel-2 p-3">
							<div className="mb-2 flex items-center gap-2">
								<Input value={fetchFilter} onChange={(e) => setFetchFilter(e.target.value)} placeholder={`筛选（共 ${fetched.length} 个）`} />
								<Button size="sm" onClick={() => addModels(visibleFetched)}>
									添加筛选结果
								</Button>
							</div>
							<div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
								{visibleFetched.map((id) => (
									<button
										type="button"
										key={id}
										onClick={() => addModels([id])}
										className={`rounded-full px-2.5 py-1 font-mono text-[11.5px] ${
											d.models.some((m) => m.id.trim() === id)
												? "bg-primary text-primary-foreground"
												: "bg-panel-2 text-muted hover:text-fg"
										}`}
									>
										{id}
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="mt-3 space-y-2">
					<div className="flex items-center gap-3 rounded-xl bg-panel-2 px-3.5 py-2.5">
						<span className="min-w-0 flex-1 text-[12.5px] text-fg">在「图片生成」工作台里提供这个端点的图片模型</span>
						<Badge tone={d.imageModels.length > 0 && d.imageEnabled ? "primary" : "muted"}>
							{d.imageModels.length === 0 ? "未配置" : d.imageEnabled ? "已启用" : "已停用"}
						</Badge>
						<Toggle on={d.imageEnabled} onChange={(imageEnabled) => update({ imageEnabled })} />
					</div>

					<div className="flex items-center gap-2">
						<Button size="sm" variant="primary" onClick={() => setImageEdit({ index: -1, draft: emptyImageModel() })}>
							<Icon name="plus" className="size-4" />
							添加图片模型
						</Button>
					</div>

					{d.imageModels.length === 0 ? (
						<div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border-strong px-4 py-8">
							<span className="text-[12.5px] text-muted">还没有图片模型。加一个之后，「图片生成」工作台就能用这个端点出图。</span>
						</div>
					) : (
						<div className="overflow-hidden rounded-xl border border-border">
							{d.imageModels.map((m, index) => (
								<div key={index} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
									<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{m.id || "（未填 ID）"}</span>
									<span className="min-w-0 flex-1 truncate text-[12px] text-muted">{m.name || "—"}</span>
									<span className="shrink-0 font-mono text-[11px] text-faint">{m.sizes.join(" · ") || "—"}</span>
									{m.edits && <Badge tone="muted">参考图</Badge>}
									{m.price.trim() && (
										<span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">¥{m.price}/张</span>
									)}
									<Button size="sm" onClick={() => setImageEdit({ index, draft: m })}>
										编辑…
									</Button>
									<button
										type="button"
										title="删除这个图片模型"
										onClick={() => update({ imageModels: d.imageModels.filter((_, i) => i !== index) })}
										className="flex size-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-panel-2 hover:text-err"
									>
										<Icon name="trash-2" className="size-4" />
									</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{conflict && (
				<div className="mt-4 rounded-xl bg-warn-soft px-3.5 py-3 text-[12.5px] text-warn">
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

			{error && <div className="mt-4 rounded-xl bg-err-soft px-3.5 py-2.5 text-[12.5px] text-err">{error}</div>}
			{!error && invalid && (
				<div className="mt-4 text-[11.5px] leading-4 text-faint">保存前会再校验一次：{invalid}</div>
			)}

			{modelEdit && (
				<ModelDialog
					initial={modelEdit.draft}
					isNew={modelEdit.index < 0}
					onCancel={() => setModelEdit(null)}
					onSave={(next) => {
						const list = [...d.models];
						if (modelEdit.index >= 0) list[modelEdit.index] = next;
						else list.push(next);
						update({ models: list });
						setModelEdit(null);
					}}
				/>
			)}
			{imageEdit && (
				<ImageModelDialog
					initial={imageEdit.draft}
					onCancel={() => setImageEdit(null)}
					onSave={(next) => {
						const list = [...d.imageModels];
						if (imageEdit.index >= 0) list[imageEdit.index] = next;
						else list.push(next);
						update({ imageModels: list });
						setImageEdit(null);
					}}
				/>
			)}
		</Modal>
	);
}
