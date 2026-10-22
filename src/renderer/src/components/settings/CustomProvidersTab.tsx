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
import { Badge, Button } from "../ui";
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

export function CustomProvidersTab() {
	const { file, error, conflict, reload, save } = useConfigFile("models");
	const pushNotice = useApp((s) => s.pushNotice);
	const configVersion = useApp((s) => s.configVersion);
	const [draft, setDraft] = useState<EndpointDraft | null>(null);
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
		setDraft(null);
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

			{entries.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border-strong px-6 py-10">
					<div className="text-[13.5px] text-fg">还没有自定义端点</div>
					<div className="max-w-[540px] text-center text-[12.5px] leading-relaxed text-muted">
						自定义端点用来接入任意 OpenAI / Anthropic 兼容接口 —— 中转服务、自建网关、本地模型都行。
						填一个 Base URL 和 API Key，再从接口拉取模型清单就能用了。
					</div>
					<div className="mt-1 flex flex-wrap items-center justify-center gap-2">
						{PRESETS.map((p) => (
							<Button
								key={p.key}
								size="sm"
								onClick={() => setDraft({ ...emptyEndpoint(), key: p.key, api: p.api, baseUrl: p.baseUrl })}
							>
								+ {p.label}
							</Button>
						))}
						<Button size="sm" variant="primary" onClick={() => setDraft(emptyEndpoint())}>
							+ 空白端点
						</Button>
					</div>
					<div className="mt-1 font-mono text-[11.5px] text-faint">
						{file && !file.exists ? "models.json 尚未创建，新建后会自动写入" : "例：https://api.relay.dev/v1"}
					</div>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-[12.5px] text-muted">新建：</span>
					{PRESETS.map((p) => (
						<Button
							key={p.key}
							size="sm"
							onClick={() => setDraft({ ...emptyEndpoint(), key: p.key, api: p.api, baseUrl: p.baseUrl })}
						>
							+ {p.label}
						</Button>
					))}
					<Button size="sm" variant="primary" onClick={() => setDraft(emptyEndpoint())}>
						+ 空白端点
					</Button>
				</div>
			)}

			{entries.length > 0 && (
			<div className="overflow-hidden rounded-2xl border border-border bg-surface-raised">
				{entries.map(([key, config]) => {
					const images = (config.imageModels ?? []).length;
					return (
						<div key={key} className="flex items-center gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-[13.5px] font-medium text-fg">{key}</span>
									{builtinIds.has(key) && <Badge tone="warn">覆盖内置</Badge>}
									<Badge>{String(config.api ?? "（继承）")}</Badge>
									{config.apiKey ? <Badge tone="ok">已填 Key</Badge> : <Badge>无 Key</Badge>}
									{images > 0 && <Badge tone="primary">图片生成 {images}</Badge>}
								</div>
								<div className="mt-0.5 truncate font-mono text-[11.5px] text-muted">{String(config.baseUrl ?? "")}</div>
								<div className="truncate text-[11.5px] text-muted">模型：{modelIds(config).join("、") || "（无）"}</div>
							</div>
							<Button size="sm" onClick={() => setDraft(toEndpointDraft(key, config))}>
								编辑…
							</Button>
							<Button size="sm" variant="ghost" className="text-err hover:bg-err-soft" onClick={() => void remove(key)}>
								<Icon name="trash-2" className="size-4" />
								删除
							</Button>
						</div>
					);
				})}
			</div>

			)}
			<div className="text-[12px] leading-5 text-faint">
				更复杂的配置（headers、compat、modelOverrides、思考参数等）请在“配置文件”页直接编辑。
			</div>

			{/* pi 内置供应商：多数人只接自己的中转，所以默认收起，能力一点不丢 */}
			<div className="overflow-hidden rounded-2xl border border-border bg-surface-raised">
				<button
					type="button"
					onClick={() => setShowBuiltin((v) => !v)}
					className="flex w-full items-center gap-3 px-5 py-3.5 text-left hover:bg-panel-2"
				>
					<Icon name="chevron-right" className={`size-4 shrink-0 text-faint transition-transform ${showBuiltin ? "rotate-90" : ""}`} />
					<div className="min-w-0 flex-1">
						<div className="text-[13.5px] font-medium text-fg">使用 pi 内置供应商</div>
						<div className="mt-0.5 text-[12px] leading-relaxed text-muted">
							OpenAI / Anthropic / Google 等 pi 自带的供应商，凭据存在 auth.json。多数情况下用上面的自定义端点就够了。
						</div>
					</div>
					<span className="shrink-0 text-[12px] text-faint">{showBuiltin ? "收起" : "展开"}</span>
				</button>
				{showBuiltin && (
					<div className="border-t border-border px-5 py-5">
						<ProvidersTab />
					</div>
				)}
			</div>

			{draft && (
				<EndpointDialog
					key={draft.originalKey ?? draft.key}
					draft={draft}
					builtinIds={builtinIds}
					conflict={conflict}
					onCancel={() => setDraft(null)}
					onSave={(d) => saveEndpoint(d, false)}
					onForceSave={(d) => saveEndpoint(d, true)}
					onReload={reload}
				/>
			)}
		</div>
	);
}
