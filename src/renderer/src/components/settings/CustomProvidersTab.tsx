/**
 * 自定义端点：页面上只有端点列表与新建入口，编辑全部走弹窗（EndpointDialog），
 * 弹窗里再点模型行打开模型弹窗（ModelDialog / ImageModelDialog）—— 与设计稿的两层弹窗一致。
 * 内置的 pi 供应商折叠在页面底部，默认收起。
 */
import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { askConfirm } from "../ConfirmDialog";
import { isMtimeConflict, parseObject, useConfigFile } from "./useConfigFile";
import { Button } from "../ui";
import { Icon } from "../Icon";
import { ProvidersTab } from "./ProvidersTab";
import {
	emptyEndpoint,
	EndpointDialog,
	modelIds,
	toEndpointConfig,
	toEndpointDraft,
	type EndpointDraft,
	type ProviderConfig,
} from "./EndpointDialog";

interface Preset {
	label: string;
	key: string;
	api: string;
	baseUrl: string;
}

/** 只保留两类中转预设；具体的地址与模型在弹窗里填 */
const PRESETS: Preset[] = [
	{ label: "OpenAI 兼容中转", key: "relay-openai", api: "openai-completions", baseUrl: "" },
	{ label: "Anthropic 兼容中转", key: "relay-anthropic", api: "anthropic-messages", baseUrl: "" },
];

function ModelGroup({ kind, ids, disabled, onManage }: { kind: "chat" | "image"; ids: string[]; disabled?: boolean; onManage: () => void }) {
	const image = kind === "image";
	const label = image ? "图片模型" : "聊天模型";
	return (
		<section aria-label={label} className="min-w-0 rounded-lg bg-bg p-3.5">
			<div className="flex flex-wrap items-center gap-2">
				<Icon name={image ? "image" : "messages"} className="size-4 shrink-0 text-muted" />
				<h4 className="font-semibold">{label}</h4>
				<span className="rounded-sm bg-panel-2 px-1.5 text-[11px] tabular-nums text-muted">{ids.length} 个</span>
			</div>
			<p className="mt-1 text-[12px] text-muted">{image ? "在「图片生成」中使用" : "在会话输入框中选择"}</p>
			{disabled && <p className="mt-2 text-[12px] text-warn">图片生成已停用</p>}
			{ids.length > 0 ? (
				<ul className="mt-2.5 max-h-32 space-y-1 overflow-y-auto text-[12px]">
					{ids.map((id, index) => <li key={`${id}:${index}`} className="break-all" title={id}>{id}</li>)}
				</ul>
			) : <p className="mt-2.5 text-[12px] text-muted">未添加{label}</p>}
			<button type="button" onClick={onManage} className="mt-3 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-[12px] font-medium text-primary-strong hover:bg-panel-2">
				{ids.length ? "管理" : "添加"}{label}
				<Icon name="chevron-right" className="size-3.5" />
			</button>
		</section>
	);
}

export function CustomProvidersTab() {
	const { file, error, conflict, reload, save } = useConfigFile("models");
	const pushNotice = useApp((s) => s.pushNotice);
	const configVersion = useApp((s) => s.configVersion);
	const [editor, setEditor] = useState<{ draft: EndpointDraft; section: "models" | "images" } | null>(null);
	const draft = editor?.draft;
	const openEditor = (draft: EndpointDraft, section: "models" | "images" = "models") => setEditor({ draft, section });
	const [builtinIds, setBuiltinIds] = useState<Set<string>>(new Set());
	const [showBuiltin, setShowBuiltin] = useState(false);

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

	/** 写入一条端点：新建时追加，编辑时先删掉旧键（键可能被改过） */
	const saveEndpoint = async (d: EndpointDraft, force: boolean) => {
		const next = { ...(parsed ?? {}) } as Record<string, unknown>;
		const nextProviders = { ...((next.providers ?? {}) as Record<string, ProviderConfig>) };
		if (d.originalKey && d.originalKey !== d.key) delete nextProviders[d.originalKey];
		nextProviders[d.key] = toEndpointConfig(d);
		next.providers = nextProviders;
		await persist(next, d.originalKey ? `已保存端点 ${d.key}` : `已添加端点 ${d.key}`, force);
		setEditor(null);
	};

	const remove = async (key: string) => {
		const ok = await askConfirm({
			title: "删除端点",
			message: `删除自定义端点「${key}」？\n会从 models.json 里移除这个供应商及其模型配置，不影响已保存的凭据。`,
			confirmLabel: "删除",
			danger: true,
		});
		if (!ok) return;
		const next = { ...(parsed ?? {}) } as Record<string, unknown>;
		const nextProviders = { ...((next.providers ?? {}) as Record<string, ProviderConfig>) };
		delete nextProviders[key];
		next.providers = nextProviders;
		try {
			await persist(next, `已删除端点 ${key}`);
		} catch (e) {
			if (!isMtimeConflict(e)) pushNotice("error", errorText(e));
		}
	};

	if (error || parseError) {
		return <div className="rounded-xl bg-err-soft px-3.5 py-2.5 text-[13px] text-err">{error ?? `models.json 解析失败：${parseError}`}</div>;
	}

	if (!file) return <p role="status" className="py-4 text-muted">正在读取模型配置…</p>;
	const entries = Object.entries(providers);

	return (
		<div className="space-y-4">
			{conflict && !draft && (
				<div className="flex items-center gap-3 rounded-xl bg-warn-soft px-3.5 py-3 text-[12.5px] text-warn">
					<span className="flex-1">models.json 已被其他程序改过，下面显示的列表是打开页面时的旧内容；直接保存会被拒绝，以免覆盖对方的改动。</span>
					<Button size="sm" onClick={() => void reload()}>
						重新加载磁盘版本
					</Button>
				</div>
			)}

			<section aria-labelledby="configured-endpoints" className="space-y-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 id="configured-endpoints" className="text-base font-semibold">已配置端点</h2>
					<button type="button" className="fw-workbench-button fw-workbench-primary" onClick={() => openEditor(emptyEndpoint())}>
						<span aria-hidden="true">＋</span> 新建端点
					</button>
				</div>
				{entries.length === 0 ? (
					<div className="border-y border-border py-5">
						<p className="text-[14px] font-medium">还没有自定义端点</p>
						<p className="mt-1.5 text-[13px] leading-relaxed text-muted">填写服务地址和 API Key，即可接入兼容接口、中转服务或本地模型。</p>
					</div>
				) : (
					<div className="space-y-3">
						{entries.map(([key, config]) => {
							const chatModels = modelIds(config);
							const images = (config.imageModels ?? []).map((model) => String(model.id ?? "")).filter(Boolean);
							return (
								<article key={key} className="rounded-lg border border-border bg-term p-4 sm:p-5">
									<div className="flex items-center gap-2">
										<Icon name="git-fork" className="size-4 shrink-0 text-muted" />
										<h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={key}>{key}</h3>
										{builtinIds.has(key) && <span className="shrink-0 text-[12px] text-warn">覆盖内置</span>}
										<button type="button" className="fw-workbench-button" onClick={() => openEditor(toEndpointDraft(key, config))}>编辑端点</button>
										<button type="button" className="rounded-md px-2 py-1.5 text-[12px] whitespace-nowrap text-err hover:bg-err-soft" onClick={() => void remove(key)}>删除</button>
									</div>
									<dl className="mt-3 grid grid-cols-[76px_minmax(0,1fr)] gap-y-1 text-[12px]">
										<dt className="text-muted">接口协议</dt><dd className="break-words">{String(config.api ?? "继承供应商")}</dd>
										<dt className="text-muted">服务地址</dt><dd className="break-all">{String(config.baseUrl || "未填写")}</dd>
										<dt className="text-muted">API Key</dt><dd>{config.apiKey ? "已填写" : "未填写"}</dd>
									</dl>
									<div className="mt-4 grid gap-3 min-[850px]:grid-cols-2">
										<ModelGroup kind="chat" ids={chatModels} onManage={() => openEditor(toEndpointDraft(key, config), "models")} />
										<ModelGroup kind="image" ids={images} disabled={config.imageEnabled === false} onManage={() => openEditor(toEndpointDraft(key, config), "images")} />
									</div>
								</article>
							);
						})}
					</div>
				)}
				<div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
					<span className="mr-1">从预设新建</span>
					{PRESETS.map((preset) => (
						<button
							key={preset.key}
							type="button"
							className="fw-workbench-button"
							onClick={() => openEditor({ ...emptyEndpoint(), key: preset.key, api: preset.api, baseUrl: preset.baseUrl })}
						>
							{preset.label}
						</button>
					))}
				</div>
				<p className="text-[12px] leading-5 text-muted">高级参数（如 headers、compat 和思考参数）可在「配置文件」中编辑。</p>
			</section>

			{/* pi 内置供应商：多数人只接自己的中转，所以默认收起，能力一点不丢 */}
			<div className="border-y border-border">
				<button
					type="button"
					onClick={() => setShowBuiltin((v) => !v)}
					aria-expanded={showBuiltin}
					className="flex w-full items-center gap-3 rounded-md px-2 py-4 text-left hover:bg-panel-2"
				>
					<Icon name="chevron-right" className={`size-4 shrink-0 text-faint transition-transform ${showBuiltin ? "rotate-90" : ""}`} />
					<div className="min-w-0 flex-1">
						<div className="text-[15px] font-semibold">使用 pi 内置供应商</div>
						<div className="mt-0.5 text-[12px] leading-relaxed text-muted">
							无需兼容中转时，可直接配置 pi 内置供应商的凭据。
						</div>
					</div>
					<span className="shrink-0 text-[12px] text-faint">{showBuiltin ? "收起" : "展开"}</span>
				</button>
				{showBuiltin && (
					<div className="border-t border-border py-4">
						<ProvidersTab />
					</div>
				)}
			</div>

			<div className="rounded-md bg-panel-2 px-4 py-3.5 text-[12px] text-muted">
				<p className="mb-1 text-[13px] font-medium text-fg">配置保存在哪里？</p>
				<p>自定义端点写入 models.json，内置供应商登录凭据保存在 auth.json。</p>
			</div>

			{draft && (
				<EndpointDialog
					key={draft.originalKey ?? draft.key}
					draft={draft}
					initialSection={editor?.section}
					builtinIds={builtinIds}
					conflict={conflict}
					onCancel={() => setEditor(null)}
					onSave={(d) => saveEndpoint(d, false)}
					onForceSave={(d) => saveEndpoint(d, true)}
					onReload={reload}
				/>
			)}
		</div>
	);
}
