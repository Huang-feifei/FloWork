/**
 * 编辑单个「聊天模型」：模型 ID / 显示名 / 上下文窗口 / 最大输出 / 支持思考·图片 /
 * 价格四项 / 思考等级映射 / 其余字段 JSON。
 *
 * 与图片模型分开：这里没有尺寸与每张价格，有上下文窗口与思考等级映射。
 * 草稿类型与序列化函数和端点编辑器共用（放在本文件里，避免循环依赖）。
 */
import { THINKING_LEVELS } from "@shared/protocol";
import type { ModelSyncState } from "@shared/model-metadata";
import { thinkingLabel } from "../../lib/format";
import { CONTEXT_WINDOW_PRESETS, MAX_OUTPUT_PRESETS, parseTokenLimit } from "../../lib/token-limit";
import { Button, Field, Input, Modal, TextArea, Toggle } from "../ui";
import { TokenLimitField } from "./TokenLimitField";
import { useState } from "react";

/** 每个模型的配置；未填的字段不会写入 models.json，pi 会用自己的默认值 */
export interface ModelDraft {
	id: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	image: boolean;
	/** 区分未声明与用户明确关闭，避免同步重新打开能力。 */
	reasoningSet?: boolean;
	imageSet?: boolean;
	sync?: ModelSyncState;
	cost: { input: string; output: string; cacheRead: string; cacheWrite: string };
	/** thinkingLevelMap：等级 → 发送给服务端的值。空 = 不写；null 文本 = 隐藏该等级 */
	thinking: Record<string, string>;
	/** 其余字段（headers、compat、samplingParams、inputLimits…）的 JSON */
	advanced: string;
}

export const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const FORM_MODEL_KEYS = new Set(["id", "name", "contextWindow", "maxTokens", "reasoning", "input", "cost", "thinkingLevelMap"]);

export function emptyModel(id = ""): ModelDraft {
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
	};
}

/** 把 models.json 里的一条模型配置拆成表单字段 + 其余 JSON */
export function toModelDraft(entry: Record<string, unknown>): ModelDraft {
	const draft = emptyModel(String(entry.id ?? ""));
	draft.name = typeof entry.name === "string" ? entry.name : "";
	draft.reasoning = entry.reasoning === true;
	draft.reasoningSet = typeof entry.reasoning === "boolean";
	const cost = (entry.cost ?? {}) as Record<string, unknown>;
	for (const key of COST_KEYS) if (cost[key] !== undefined) draft.cost[key] = String(cost[key]);
	const map = (entry.thinkingLevelMap ?? {}) as Record<string, unknown>;
	for (const level of THINKING_LEVELS) {
		const value = map[level];
		if (value === null) draft.thinking[level] = "null";
		else if (value !== undefined) draft.thinking[level] = String(value);
	}
	const known = new Set(FORM_MODEL_KEYS);
	// 只写 text 或 text+image 时可以用开关表示，其他组合保留在 JSON 里
	if (Array.isArray(entry.input) && entry.input.every((v) => v === "text" || v === "image")) {
		draft.image = entry.input.includes("image");
		draft.imageSet = true;
	} else known.delete("input");
	if (entry.contextWindow !== undefined) draft.contextWindow = String(entry.contextWindow);
	if (entry.maxTokens !== undefined) draft.maxTokens = String(entry.maxTokens);
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) if (!known.has(key)) rest[key] = value;
	if (Object.keys(rest).length > 0) draft.advanced = JSON.stringify(rest, null, 2);
	return draft;
}

/** 表单字段优先于 advanced 里的同名字段 */
export function toModelEntry(model: ModelDraft): Record<string, unknown> {
	const advanced = model.advanced.trim() ? (JSON.parse(model.advanced) as Record<string, unknown>) : {};
	const entry: Record<string, unknown> = { ...advanced, id: model.id.trim() };
	if (model.name.trim()) entry.name = model.name.trim();
	else delete entry.name;
	for (const [key, label] of [["contextWindow", "上下文窗口"], ["maxTokens", "最大输出"]] as const) {
		if (!model[key].trim()) {
			delete entry[key];
			continue;
		}
		const tokens = parseTokenLimit(model[key]);
		if (tokens === undefined) throw new Error(`${label}必须是正整数 token 数，可使用 K / M 单位`);
		entry[key] = tokens;
	}
	if (model.reasoning || model.reasoningSet) entry.reasoning = model.reasoning;
	else delete entry.reasoning;
	if (model.image) entry.input = ["text", "image"];
	else if (model.imageSet || advanced.input !== undefined) entry.input = ["text"];
	else delete entry.input;
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

/** 校验单个模型；返回第一条错误 */
export function validateModel(model: ModelDraft): string | undefined {
	const id = model.id.trim();
	if (!id) return "模型 ID 不能为空";
	if (model.contextWindow.trim() && parseTokenLimit(model.contextWindow) === undefined) return `${id}：上下文窗口必须是正整数 token 数，可填写 128000、128K 或 1M`;
	if (model.maxTokens.trim() && parseTokenLimit(model.maxTokens) === undefined) return `${id}：最大输出必须是正整数 token 数，可填写 16384、16K 或 0.5M`;
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
	return undefined;
}

export function ModelDialog({
	initial,
	isNew,
	onCancel,
	onSave,
}: {
	initial: ModelDraft;
	/** 新增还是编辑：只影响标题 */
	isNew: boolean;
	onCancel: () => void;
	onSave: (model: ModelDraft) => void;
}) {
	const [d, setD] = useState(initial);
	const [error, setError] = useState<string | undefined>();
	const patch = (next: Partial<ModelDraft>) => setD((prev) => ({ ...prev, ...next }));

	const submit = () => {
		const invalid = validateModel(d);
		if (invalid) {
			setError(invalid);
			return;
		}
		onSave({ ...d, id: d.id.trim() });
	};

	return (
		<Modal
			title={`${isNew ? "添加" : "编辑"}模型${d.id.trim() ? ` · ${d.id.trim()}` : ""}`}
			onClose={onCancel}
			width="w-[640px]"
			footer={
				<>
					<Button onClick={onCancel}>取消</Button>
					<Button variant="primary" onClick={submit}>
						确定
					</Button>
				</>
			}
		>
			<div className="grid grid-cols-2 gap-5">
				<Field label="模型 ID" hint="请求里的 model 字段，也是模型选择器里的标识。">
					<Input value={d.id} onChange={(e) => patch({ id: e.target.value })} placeholder="deepseek-v3.2" className="font-mono" />
				</Field>
				<Field label="显示名称" hint="留空则显示模型 ID。">
					<Input value={d.name} onChange={(e) => patch({ name: e.target.value })} placeholder="DeepSeek V3.2" />
				</Field>
			</div>

			<div className="mt-5 grid grid-cols-2 gap-5">
				<TokenLimitField
					label="上下文窗口"
					value={d.contextWindow}
					onChange={(contextWindow) => patch({ contextWindow })}
					placeholder="128000 / 128K / 1M"
					presets={CONTEXT_WINDOW_PRESETS}
					hint="模型可接受的上下文 token 数，留空用默认值 128000。"
				/>
				<TokenLimitField
					label="最大输出"
					value={d.maxTokens}
					onChange={(maxTokens) => patch({ maxTokens })}
					placeholder="16384 / 16K / 128K"
					presets={MAX_OUTPUT_PRESETS}
					hint="单次最大输出 token 数，留空用默认值 16384。"
				/>
			</div>
			<div className="mt-2 text-[11.5px] leading-4 text-muted">
				支持整数或 K / M 简写（1K = 1000，1M = 1000000），保存为整数；16K = 16000，不等于默认值 16384。请按供应商实际限制填写，设置更大值不会扩展模型能力。
			</div>

			<div className="mt-5 flex items-center gap-6">
				<div className="flex items-center gap-3">
					<span className="text-[12.5px] font-medium text-fg">支持思考</span>
					<Toggle on={d.reasoning} onChange={(reasoning) => patch({ reasoning, reasoningSet: true })} />
				</div>
				<div className="flex items-center gap-3">
					<span className="text-[12.5px] font-medium text-fg">支持图片输入</span>
					<Toggle on={d.image} onChange={(image) => patch({ image, imageSet: true })} />
				</div>
			</div>

			{d.sync && Object.keys(d.sync.sources).length > 0 && (
				<div className="mt-4 rounded-xl bg-panel-2 px-3.5 py-2.5 text-[11.5px] text-muted">
					自动补全来源：{[...new Set(Object.values(d.sync.sources))].join("、")}。同步不会覆盖手动修改；models.dev 价格是参考价，不代表本端点报价。
				</div>
			)}

			<div className="mt-5">
				<div className="mb-2 text-[12.5px] font-medium text-fg">价格（美元 / 百万 token）</div>
				<div className="grid grid-cols-4 gap-3">
					{(
						[
							["input", "输入"],
							["output", "输出"],
							["cacheRead", "缓存读"],
							["cacheWrite", "缓存写"],
						] as const
					).map(([key, label]) => (
						<Field key={key} label={label}>
							<Input
								value={d.cost[key]}
								onChange={(e) => patch({ cost: { ...d.cost, [key]: e.target.value } })}
								placeholder="0"
								className="font-mono"
							/>
						</Field>
					))}
				</div>
				<div className="mt-1.5 text-[11.5px] leading-4 text-muted">填任意一项即视为自定义价格，未填的按 0 写入。</div>
			</div>

			<div className="mt-5">
				<div className="mb-2 flex items-center gap-2">
					<span className="text-[12.5px] font-medium text-fg">思考等级映射</span>
					<button
						type="button"
						onClick={() => patch({ thinking: { ...d.thinking, xhigh: "xhigh", max: "max" } })}
						className="rounded-full bg-panel-2 px-2.5 py-0.5 text-[11.5px] text-muted hover:text-fg"
					>
						极高 / 最大填同名值
					</button>
				</div>
				<div className="grid grid-cols-4 gap-2">
					{THINKING_LEVELS.map((level) => (
						<Field key={level} label={thinkingLabel(level)}>
							<Input
								value={d.thinking[level] ?? ""}
								onChange={(e) => patch({ thinking: { ...d.thinking, [level]: e.target.value } })}
								placeholder={level}
								title={`${thinkingLabel(level)}（${level}）对应的值；留空不写，null 表示隐藏该等级`}
								className="font-mono text-[12px]"
							/>
						</Field>
					))}
				</div>
				<div className="mt-1.5 text-[11.5px] leading-4 text-muted">
					留空 = 用 pi 默认（关闭 / 最小 / 低 / 中 / 高 直接发送等级名，极高 / 最大必须填值才会出现在输入框）；填 null = 隐藏该等级。
				</div>
			</div>

			<div className="mt-5">
				<Field label="其余字段（JSON）" hint="会与上面的字段合并；键留空会从 models.json 里删掉。">
					<TextArea
						rows={3}
						value={d.advanced}
						onChange={(e) => patch({ advanced: e.target.value })}
						placeholder={'{\n  "compat": { "supportsDeveloperRole": true }\n}'}
					/>
				</Field>
			</div>

			{error && <div className="mt-4 rounded-xl bg-err-soft px-3.5 py-2.5 text-[12.5px] text-err">{error}</div>}
		</Modal>
	);
}
