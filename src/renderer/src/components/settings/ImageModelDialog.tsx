/**
 * 编辑单个「图片模型」：模型 ID / 显示名称 / 支持的尺寸 / 支持参考图 / 每张价格 / 其余字段 JSON。
 *
 * 图片模型与聊天模型分开维护：它走的是 /images/generations 与 /images/edits，
 * 没有上下文窗口与思考等级这些概念；质量（标准 / 高清）在图片生成工作台里按次选择，
 * 不在这里写死。保存后写入 models.json 里该供应商的 imageModels。
 */
import { useState } from "react";
import { Button, Field, Input, Modal, TextArea, Toggle } from "../ui";

export interface ImageModelDraft {
	id: string;
	name: string;
	/** 支持的尺寸，例如 ["1024x1024", "1536x1024"] */
	sizes: string[];
	/** 是否支持参考图（图生图，走 /images/edits） */
	edits: boolean;
	/** 每张价格（元），用于工作台的费用预估；留空表示不填 */
	price: string;
	/** 其余字段的 JSON（例如 outputFormat） */
	advanced: string;
}

/** 常见的尺寸预设，点一下加入/移出 */
export const SIZE_PRESETS = ["1024x1024", "1536x1024", "1024x1536", "512x512"];

export function emptyImageModel(id = ""): ImageModelDraft {
	return { id, name: "", sizes: ["1024x1024"], edits: true, price: "", advanced: "" };
}

/** 把 models.json 里的一条 imageModels 读成草稿 */
export function toImageModelDraft(entry: Record<string, unknown>): ImageModelDraft {
	const draft = emptyImageModel(String(entry.id ?? ""));
	draft.name = typeof entry.name === "string" ? entry.name : "";
	const sizes = Array.isArray(entry.sizes) ? entry.sizes.map(String).filter(Boolean) : [];
	draft.sizes = sizes.length > 0 ? sizes : ["1024x1024"];
	draft.edits = entry.edits === true;
	if (entry.price !== undefined && Number.isFinite(Number(entry.price))) draft.price = String(entry.price);
	const known = new Set(["id", "name", "sizes", "edits", "price"]);
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) if (!known.has(key)) rest[key] = value;
	if (Object.keys(rest).length > 0) draft.advanced = JSON.stringify(rest, null, 2);
	return draft;
}

/** 草稿 → models.json 里的 imageModels 条目；留空的字段不写 */
export function toImageModelEntry(model: ImageModelDraft): Record<string, unknown> {
	const advanced = model.advanced.trim() ? (JSON.parse(model.advanced) as Record<string, unknown>) : {};
	const entry: Record<string, unknown> = { ...advanced, id: model.id.trim() };
	if (model.name.trim()) entry.name = model.name.trim();
	else delete entry.name;
	const sizes = model.sizes.map((s) => s.trim()).filter(Boolean);
	if (sizes.length > 0) entry.sizes = sizes;
	else delete entry.sizes;
	if (model.edits) entry.edits = true;
	else delete entry.edits;
	if (model.price.trim()) entry.price = Number(model.price);
	else delete entry.price;
	return entry;
}

/** 保存前校验；返回第一条错误 */
export function validateImageModel(model: ImageModelDraft): string | undefined {
	const id = model.id.trim();
	if (!id) return "图片模型的 ID 不能为空";
	if (model.sizes.length === 0) return `${id}：至少要选一个尺寸`;
	if (model.price.trim() && !(Number.isFinite(Number(model.price)) && Number(model.price) >= 0)) {
		return `${id}：每张价格必须是非负数`;
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

export function ImageModelDialog({
	initial,
	onCancel,
	onSave,
}: {
	initial: ImageModelDraft;
	onCancel: () => void;
	onSave: (model: ImageModelDraft) => void;
}) {
	const [d, setD] = useState(initial);
	const [error, setError] = useState<string | undefined>();
	const patch = (next: Partial<ImageModelDraft>) => setD((prev) => ({ ...prev, ...next }));

	const toggleSize = (size: string) => {
		patch({ sizes: d.sizes.includes(size) ? d.sizes.filter((s) => s !== size) : [...d.sizes, size] });
	};

	const submit = () => {
		const invalid = validateImageModel(d);
		if (invalid) {
			setError(invalid);
			return;
		}
		onSave({ ...d, id: d.id.trim() });
	};

	return (
		<Modal
			title={`${initial.id ? "编辑" : "添加"}图片模型${d.id.trim() ? ` · ${d.id.trim()}` : ""}`}
			onClose={onCancel}
			width="w-[600px]"
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
				<Field label="模型 ID" hint="请求里的 model 字段，例如 gpt-image-1。">
					<Input value={d.id} onChange={(e) => patch({ id: e.target.value })} placeholder="gpt-image-1" className="font-mono" />
				</Field>
				<Field label="显示名称" hint="留空则显示模型 ID。">
					<Input value={d.name} onChange={(e) => patch({ name: e.target.value })} placeholder="GPT Image 1" />
				</Field>
			</div>

			<div className="mt-5">
				<div className="mb-2 flex items-center gap-2.5">
					<span className="text-[12.5px] font-medium text-fg">支持的尺寸</span>
					<span className="text-[12px] text-faint">勾上的会出现在生成工作台的尺寸下拉里</span>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{SIZE_PRESETS.map((size) => {
						const on = d.sizes.includes(size);
						return (
							<button
								type="button"
								key={size}
								onClick={() => toggleSize(size)}
								className={`flex h-8 items-center gap-1.5 rounded-full px-3 font-mono text-[12px] ${
									on ? "bg-primary-soft font-medium text-primary" : "bg-panel-2 text-muted hover:text-fg"
								}`}
							>
								{on && <span className="icon-[lucide--check] size-3.5" />}
								{size}
							</button>
						);
					})}
					<Input
						value={d.sizes.filter((s) => !SIZE_PRESETS.includes(s)).join(",")}
						onChange={(e) => {
							const custom = e.target.value
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean);
							patch({ sizes: [...d.sizes.filter((s) => SIZE_PRESETS.includes(s)), ...custom] });
						}}
						placeholder="自定义，逗号分隔"
						className="h-8 w-44 px-3 text-[12px]"
					/>
				</div>
			</div>

			<div className="mt-5 flex items-center gap-6">
				<div className="flex items-center gap-3">
					<span className="text-[12.5px] font-medium text-fg">支持参考图（图生图）</span>
					<Toggle on={d.edits} onChange={(edits) => patch({ edits })} />
				</div>
				<span className="text-[12px] text-faint">关掉后只能纯文生图，走 /images/generations</span>
			</div>

			<div className="mt-5 grid grid-cols-2 gap-5">
				<Field label="每张价格（元）" hint="用于生成工作台的费用预估；留空表示不预估。">
					<Input value={d.price} onChange={(e) => patch({ price: e.target.value })} placeholder="0.06" className="font-mono" />
				</Field>
			</div>

			<div className="mt-5">
				<Field label="其余字段（JSON）" hint="保持原样即可；键留空会从 models.json 里删掉。">
					<TextArea rows={3} value={d.advanced} onChange={(e) => patch({ advanced: e.target.value })} placeholder={'{\n  "outputFormat": "png"\n}'} />
				</Field>
			</div>

			{error && <div className="mt-4 rounded-xl bg-err-soft px-3.5 py-2.5 text-[12.5px] text-err">{error}</div>}
		</Modal>
	);
}
