import { useEffect, useMemo, useState } from "react";
import { type ModelEntry } from "@shared/protocol";
import {
	MAX_SUBAGENT_CONCURRENCY,
	MAX_SUBAGENT_TASKS,
	readSubagentSettings,
	writeSubagentSettings,
	type SubagentSettings,
} from "@shared/subagent-settings";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Button, Field, Select, Toggle } from "../ui";
import { isMtimeConflict, parseObject, useConfigFile } from "./useConfigFile";

type Settings = Record<string, unknown>;

const TASKS = Array.from({ length: MAX_SUBAGENT_TASKS }, (_, i) => i + 1);

function modelKey(model: ModelEntry): string {
	return `${model.provider}/${model.id}`;
}

export function SubagentTab() {
	const { file, error, conflict, reload, save } = useConfigFile("settings");
	const pushNotice = useApp((s) => s.pushNotice);
	const configVersion = useApp((s) => s.configVersion);
	const [draft, setDraft] = useState<Settings | null>(null);
	const [models, setModels] = useState<ModelEntry[]>([]);
	const [saving, setSaving] = useState(false);

	const base = useMemo(() => {
		try {
			return parseObject(file?.text);
		} catch {
			return null;
		}
	}, [file]);

	useEffect(() => {
		if (base) setDraft(structuredClone(base));
	}, [base]);

	useEffect(() => {
		void api
			.service({ type: "list_models", availableOnly: true })
			.then(setModels)
			.catch(() => undefined);
	}, [configVersion]);

	if (error) return <div className="rounded-xl bg-err-soft px-3.5 py-2.5 text-[13px] text-err">{error}</div>;
	if (file && !base)
		return <div className="rounded-xl bg-err-soft px-3.5 py-2.5 text-[13px] text-err">settings.json 解析失败，请在“配置文件”页修复。</div>;
	if (!draft) return <div className="py-10 text-center text-[13.5px] text-muted">读取中…</div>;

	const current = readSubagentSettings(draft);
	const dirty = JSON.stringify(draft) !== JSON.stringify(base);
	const defaultModelKey = current.defaultModel ?? "";
	const concurrencyOptions = TASKS.filter((n) => n <= Math.min(MAX_SUBAGENT_CONCURRENCY, current.maxTasks));

	const set = (patch: Partial<SubagentSettings>) =>
		setDraft((prev) => {
			const baseDraft = prev ?? {};
			return writeSubagentSettings(baseDraft, { ...readSubagentSettings(baseDraft), ...patch });
		});

	const onSave = async (force = false) => {
		setSaving(true);
		try {
			await save(`${JSON.stringify(draft, null, 2)}\n`, { force });
			pushNotice("info", "子代理设置已保存；新会话生效");
		} catch (e) {
			// 冲突交给下面的内联提示处理（draft 保留，让用户选择保留哪一份）
			if (!isMtimeConflict(e)) pushNotice("error", errorText(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-6">
			<section className="fw-card p-6">
				<div className="flex items-start justify-between gap-6">
					<div>
						<h3 className="text-[15px] font-semibold tracking-tight">启用子代理</h3>
						<p className="mt-1.5 max-w-[640px] text-[12.5px] leading-relaxed text-muted">
							关闭后，新会话不再注册 <span className="font-mono">subagent</span> 工具；已经打开的会话需要重新打开或切换会话才会生效。
						</p>
					</div>
					<Toggle on={current.enabled} onChange={(enabled) => set({ enabled })} />
				</div>
			</section>

			<section className="fw-card space-y-4 p-6">
				<div>
					<h3 className="text-[15px] font-semibold tracking-tight">并行执行</h3>
					<p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
						只影响 <span className="font-mono">parallel</span> 模式；<span className="font-mono">single</span> 和{" "}
						<span className="font-mono">chain</span> 始终一次运行一个。
					</p>
				</div>
				<div className="grid grid-cols-2 gap-4">
					<Field label="最大任务数" hint="parallel 一次最多接受多少个任务">
						<Select
							value={String(current.maxTasks)}
							onChange={(e) => {
								const maxTasks = Number(e.target.value);
								set({ maxTasks, maxConcurrency: Math.min(current.maxConcurrency, maxTasks) });
							}}
						>
							{TASKS.map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</Select>
					</Field>
					<Field label="最大并发数" hint="同时运行的子代理数量，不会超过最大任务数">
						<Select value={String(current.maxConcurrency)} onChange={(e) => set({ maxConcurrency: Number(e.target.value) })}>
							{concurrencyOptions.map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</Select>
					</Field>
				</div>
			</section>

			<section className="fw-card space-y-4 p-6">
				<div>
					<h3 className="text-[15px] font-semibold tracking-tight">默认模型</h3>
					<p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
						agent Markdown 的 frontmatter 写了 <span className="font-mono">model</span> 时仍以 agent 为准；这里只影响没有写{" "}
						<span className="font-mono">model</span> 的 agent。
					</p>
				</div>
				<Field label="子代理默认模型" hint="留空时继承父会话的模型和思考等级">
					<Select value={defaultModelKey} onChange={(e) => set({ defaultModel: e.target.value || undefined })}>
						<option value="">（跟随当前会话）</option>
						{defaultModelKey && !models.some((m) => modelKey(m) === defaultModelKey) && (
							<option value={defaultModelKey}>{defaultModelKey}（当前不可用）</option>
						)}
						{models.map((m) => (
							<option key={modelKey(m)} value={modelKey(m)}>
								{m.provider} / {m.name}
							</option>
						))}
					</Select>
				</Field>
			</section>

			<section className="rounded-xl bg-panel-2 px-4 py-3 text-[12.5px] leading-relaxed text-muted">
				这些设置写入 <span className="font-mono">settings.json</span> 的{" "}
				<span className="font-mono">flowork.subagent</span>，不需要手动编辑 JSON。总开关、并行上限和默认模型都在新建或切换会话后生效，不需要重启 FloWork。
			</section>

			{conflict && (
				<div className="rounded-xl bg-warn-soft px-3.5 py-3 text-[12.5px] text-warn">
					<div>settings.json 在你打开之后被其他程序改过；直接保存会被拒绝，以免覆盖对方的改动。你改的内容还在这里。</div>
					<div className="mt-1.5 flex flex-wrap gap-2">
						<Button size="sm" disabled={saving} onClick={() => void reload()}>
							重新加载磁盘版本（放弃我的修改）
						</Button>
						<Button size="sm" variant="primary" disabled={saving} onClick={() => void onSave(true)}>
							用我的内容覆盖磁盘版本（丢弃对方的改动）
						</Button>
					</div>
				</div>
			)}
			<div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-surface py-3">
				{dirty && <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-[11.5px] font-medium text-warn">有未保存的修改</span>}
				<Button disabled={!dirty} onClick={() => base && setDraft(structuredClone(base))}>
					撤销修改
				</Button>
				<Button variant="primary" disabled={!dirty || saving} onClick={() => void onSave()}>
					{saving ? "保存中…" : "保存设置"}
				</Button>
			</div>
		</div>
	);
}
