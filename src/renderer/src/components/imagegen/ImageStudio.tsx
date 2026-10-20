/**
 * 图片生成工作台（活动栏「图片生成」主视图）：
 * 左侧参数（提示词 / 参考图 / 模型 / 尺寸 / 数量 / 质量），右侧本次生成与最近生成。
 * 与代码会话刻意区分：没有消息流、没有输入框；生成结果通过「插入会话」放进当前会话的输入框。
 * 模型与凭据来自 models.json 里各供应商声明的 imageModels（设置 › 自定义端点）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { GeneratedImage, ImageAttachment } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Icon } from "../Icon";
import { Badge, Button, Select, TextArea } from "../ui";

const COUNTS = [1, 2, 4];

/** 缓存里的图片按需读成 data URL（生成历史不大，单张读一次即可） */
export function useImageUrl(id: string): string | undefined {
	const [url, setUrl] = useState<string>();
	useEffect(() => {
		let alive = true;
		void api.images
			.read(id)
			.then((file) => {
				if (alive) setUrl(`data:${file.mimeType};base64,${file.dataBase64}`);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [id]);
	return url;
}

/** 一张生成结果：预览 + 提示词 + 尺寸/耗时 + 操作 */
export function GeneratedTile({ image, tall = false }: { image: GeneratedImage; tall?: boolean }) {
	const url = useImageUrl(image.id);
	const attachImage = useApp((s) => s.attachImage);
	const removeImage = useApp((s) => s.removeImage);
	const pushNotice = useApp((s) => s.pushNotice);
	const setView = useApp((s) => s.setView);
	const [busy, setBusy] = useState(false);

	const insert = async () => {
		setBusy(true);
		try {
			await attachImage(image.id);
			pushNotice("info", "已放进输入框，切回会话即可随下一条消息发送");
			if (useApp.getState().activeProjectId) setView("chat");
		} catch (error) {
			pushNotice("error", errorText(error));
		} finally {
			setBusy(false);
		}
	};

	const download = async () => {
		try {
			const file = await api.images.read(image.id);
			const link = document.createElement("a");
			link.href = `data:${file.mimeType};base64,${file.dataBase64}`;
			link.download = `${image.model.replace(/[^\w.-]+/g, "_")}-${image.id}`;
			link.click();
		} catch (error) {
			pushNotice("error", errorText(error));
		}
	};

	return (
		<div className="overflow-hidden rounded-2xl border border-border bg-surface-raised">
			<div className={`${tall ? "aspect-[4/3]" : "aspect-square"} bg-panel-2`}>
				{url ? (
					<img src={url} alt={image.prompt} className="size-full object-cover" />
				) : (
					<div className="flex size-full items-center justify-center text-faint">
						<Icon name="image" className="size-5" />
					</div>
				)}
			</div>
			<div className="px-3 py-2.5">
				<div className="truncate text-[12px] text-muted" title={image.prompt}>
					{image.prompt}
				</div>
				<div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-faint">
					<span className="shrink-0 font-mono">{image.size}</span>
					<span className="shrink-0">· {Math.round(image.bytes / 1024)} KB</span>
					{image.edited && <span className="shrink-0">· 参考图</span>}
					<div className="flex-1" />
					<button type="button" disabled={busy} onClick={() => void insert()} className="shrink-0 text-primary hover:underline">
						插入会话
					</button>
					<button type="button" onClick={() => void download()} className="shrink-0 hover:text-fg">
						下载
					</button>
					<button type="button" onClick={() => void removeImage(image.id)} className="shrink-0 hover:text-err">
						删除
					</button>
				</div>
			</div>
		</div>
	);
}

export function ImageStudio() {
	const imageModels = useApp((s) => s.imageModels);
	const images = useApp((s) => s.images);
	const busy = useApp((s) => s.imageBusy);
	const generateImages = useApp((s) => s.generateImages);
	const loadImages = useApp((s) => s.loadImages);
	const pushNotice = useApp((s) => s.pushNotice);
	const activeProjectId = useApp((s) => s.activeProjectId);
	const sessionName = useApp((s) => s.state?.sessionName ?? "");

	const [prompt, setPrompt] = useState("");
	const [modelKey, setModelKey] = useState("");
	const [size, setSize] = useState("");
	const [count, setCount] = useState(2);
	const [quality, setQuality] = useState<"standard" | "hd">("standard");
	const [reference, setReference] = useState<ImageAttachment>();
	const [created, setCreated] = useState<GeneratedImage[]>([]);
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		void loadImages().catch((error) => pushNotice("error", `读取图片模型失败：${errorText(error)}`));
	}, [loadImages, pushNotice]);

	const model = useMemo(() => imageModels.find((m) => m.key === modelKey) ?? imageModels[0], [imageModels, modelKey]);
	useEffect(() => {
		if (model && !model.sizes.includes(size)) setSize(model.sizes[0] ?? "1024x1024");
	}, [model, size]);

	const pickReference = async (file: File) => {
		const data = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(reader.error ?? new Error("读取参考图失败"));
			reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]+,/, ""));
			reader.readAsDataURL(file);
		});
		setReference({ type: "image", mimeType: file.type || "image/png", data });
	};

	const run = async () => {
		if (!prompt.trim()) {
			pushNotice("warning", "先写一句提示词");
			return;
		}
		try {
			const result = await generateImages({
				model: model?.key,
				prompt,
				size,
				quality,
				count,
				reference: reference ? { dataBase64: reference.data, mimeType: reference.mimeType } : undefined,
			});
			setCreated(result);
			pushNotice("info", `生成完成：${result.length} 张`);
		} catch (error) {
			pushNotice("error", errorText(error));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* 模块头：与代码会话区分开 */}
			<div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-6">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
					<Icon name="image" className="size-4" />
				</span>
				<span className="shrink-0 text-[15px] font-semibold tracking-tight">图片生成</span>
				{model ? <Badge tone="muted">{model.provider} · {model.id}</Badge> : <Badge tone="warn">还没有配置图片模型</Badge>}
				<span className="min-w-0 truncate text-[12.5px] text-faint">独立工作台，不占用项目会话</span>
				<div className="flex-1" />
				<span className="shrink-0 text-[12px] text-faint">
					{activeProjectId ? `插入到：${sessionName || "当前会话"}` : "还没有打开会话"}
				</span>
			</div>

			<div className="flex min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-5">
				{/* 左：参数 */}
				<div className="w-[400px] shrink-0 space-y-4">
					<div className="fw-card p-5">
						<div className="mb-2 text-[13.5px] font-medium text-fg">提示词</div>
						<TextArea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想生成的画面…" />

						<div className="mt-3 flex items-center gap-2.5">
							<span className="shrink-0 text-[12.5px] text-muted">参考图</span>
							<button
								type="button"
								onClick={() => fileRef.current?.click()}
								className="flex size-12 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-border-strong text-faint hover:text-fg"
								title="选一张本地图片作为参考（图生图）"
							>
								<Icon name="plus" className="size-4" />
							</button>
							{reference && (
								<span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-border">
									<img src={`data:${reference.mimeType};base64,${reference.data}`} alt="参考图" className="size-full object-cover" />
								</span>
							)}
							<div className="flex-1" />
							{reference ? (
								<Button variant="ghost" size="sm" onClick={() => setReference(undefined)}>
									去掉参考图
								</Button>
							) : (
								<span className="text-[11.5px] text-faint">{model?.edits ? "这个模型支持图生图" : "当前模型不支持参考图"}</span>
							)}
						</div>
						<input
							ref={fileRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) void pickReference(file);
								e.target.value = "";
							}}
						/>
					</div>

					<div className="fw-card p-5">
						<div className="mb-3 text-[13.5px] font-medium text-fg">参数</div>
						<div className="space-y-4">
							<div>
								<div className="mb-1.5 text-[12.5px] text-muted">模型</div>
								{imageModels.length > 0 ? (
									<Select value={model?.key ?? ""} onChange={(e) => setModelKey(e.target.value)}>
										{imageModels.map((m) => (
											<option key={m.key} value={m.key}>
												{m.key}
											</option>
										))}
									</Select>
								) : (
									<div className="rounded-[10px] bg-warn-soft px-3 py-2 text-[12.5px] leading-relaxed text-warn">
										还没有图片模型。到「设置 › 自定义端点」里给某个供应商添加图片模型（写进 models.json 的 imageModels）。
									</div>
								)}
							</div>

							<div className="flex items-center gap-3">
								<span className="w-12 shrink-0 text-[12.5px] text-muted">尺寸</span>
								<Select value={size} onChange={(e) => setSize(e.target.value)} className="w-auto">
									{(model?.sizes ?? ["1024x1024"]).map((s) => (
										<option key={s} value={s}>
											{s}
										</option>
									))}
								</Select>
							</div>

							<div className="flex items-center gap-3">
								<span className="w-12 shrink-0 text-[12.5px] text-muted">数量</span>
								<div className="fw-seg">
									{COUNTS.map((n) => (
										<button
											type="button"
											key={n}
											onClick={() => setCount(n)}
											className={`fw-seg-item ${n === count ? "fw-seg-item-active" : ""}`}
										>
											{n} 张
										</button>
									))}
								</div>
							</div>

							<div className="flex items-center gap-3">
								<span className="flex-1 text-[13px] text-fg">高质量</span>
								<div className="fw-seg">
									{(["standard", "hd"] as const).map((q) => (
										<button
											type="button"
											key={q}
											onClick={() => setQuality(q)}
											className={`fw-seg-item ${q === quality ? "fw-seg-item-active" : ""}`}
										>
											{q === "standard" ? "标准" : "高清"}
										</button>
									))}
								</div>
							</div>
						</div>

						<div className="mt-4 flex items-center gap-3 border-t border-border pt-4">
							<span className="text-[11.5px] tabular-nums text-faint">
								{model?.price ? `约 ¥${(model.price * count).toFixed(2)}` : "价格未配置"}
							</span>
							<div className="flex-1" />
							<Button variant="primary" disabled={busy || !model} onClick={() => void run()}>
								<Icon name="sparkles" className="size-4" />
								{busy ? "生成中…" : `生成 ${count} 张`}
							</Button>
						</div>
					</div>
				</div>

				{/* 右：结果 */}
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="text-[13.5px] font-semibold tracking-tight">本次生成</span>
						{created.length > 0 && <Badge tone="ok">{created.length} 张</Badge>}
						<div className="flex-1" />
					</div>
					{created.length > 0 ? (
						<div className="mt-3 grid grid-cols-2 gap-4">
							{created.map((image) => (
								<GeneratedTile key={image.id} image={image} tall />
							))}
						</div>
					) : (
						<div className="mt-3 flex h-32 items-center justify-center rounded-2xl border border-dashed border-border-strong text-[12.5px] text-faint">
							生成结果会出现在这里
						</div>
					)}

					<div className="mt-6 flex items-center gap-2">
						<span className="text-[13.5px] font-semibold tracking-tight">最近生成</span>
						<Badge tone="muted">{images.length}</Badge>
					</div>
					{images.length > 0 ? (
						<div className="mt-3 grid grid-cols-4 gap-3">
							{images.slice(0, 8).map((image) => (
								<GeneratedTile key={image.id} image={image} />
							))}
						</div>
					) : (
						<div className="mt-3 text-[12.5px] text-faint">还没有生成过图片。</div>
					)}
				</div>
			</div>

			<div className="shrink-0 border-t border-border px-6 py-3 text-[11.5px] leading-relaxed text-faint">
				生成的图片先落到本机缓存；「插入会话」会作为附件进入输入框。模型与凭据复用「设置 › 自定义端点」里的 OpenAI 兼容端点（纯生成走
				/images/generations，带参考图走 /images/edits）。
			</div>
		</div>
	);
}
