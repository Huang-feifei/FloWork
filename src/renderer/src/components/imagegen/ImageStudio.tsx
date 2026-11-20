import { useCallback, useEffect, useRef, useState } from "react";
import type { GeneratedImage, ImageAttachment } from "@shared/protocol";
import { normalizeImageSize } from "@shared/image-size";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Icon } from "../Icon";
import { askConfirm } from "../ConfirmDialog";
import { Button, Input, Select } from "../ui";
import { PageHeading } from "../PageHeading";
import "./image-studio.css";

const COUNTS = [1, 2, 4];

/** 缓存里的图片按需读成 data URL（生成历史不大，单张读一次即可） */
export function useImagePreview(id: string) {
	const [preview, setPreview] = useState<{ id: string; url?: string }>();
	useEffect(() => {
		if (!id) return;
		let alive = true;
		void api.images
			.read(id)
			.then((file) => {
				if (alive) setPreview({ id, url: `data:${file.mimeType};base64,${file.dataBase64}` });
			})
			.catch(() => { if (alive) setPreview({ id }); });
		return () => {
			alive = false;
		};
	}, [id]);
	return preview?.id === id ? preview : undefined;
}

export function useImageUrl(id: string): string | undefined {
	return useImagePreview(id)?.url;
}

const REFERENCE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;

function sizeText(size: string) {
	return size.replace(/(\d+)x(\d+)/i, "$1 × $2");
}

function ImageThumbnail({ image, selected, onSelect }: { image: GeneratedImage; selected: boolean; onSelect: () => void }) {
	const url = useImageUrl(image.id);
	return (
		<button type="button" className="fw-studio-thumbnail" aria-pressed={selected} aria-label={`预览图片：${image.prompt}`} title={image.prompt} onClick={onSelect}>
			{url ? <img src={url} alt="" /> : <Icon name="image" className="size-5 text-muted" />}
		</button>
	);
}

export function ImageStudio({ active }: { active: boolean }) {
	const imageModels = useApp((s) => s.imageModels);
	const images = useApp((s) => s.images);
	const busy = useApp((s) => s.imageBusy);
	const hasProject = useApp((s) => !!s.activeProjectId);
	const { generateImages, loadImages, setView, pushNotice, removeImage, attachImage } = useApp.getState();
	const [prompt, setPrompt] = useState("");
	const [modelKey, setModelKey] = useState("");
	const [sizeSelections, setSizeSelections] = useState<Record<string, string>>({});
	const [count, setCount] = useState(1);
	const [quality, setQuality] = useState<"standard" | "hd">("standard");
	const [reference, setReference] = useState<{ fileName: string; image: ImageAttachment }>();
	const [referenceError, setReferenceError] = useState("");
	const [reading, setReading] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState("");
	const [error, setError] = useState("");
	const [createdIds, setCreatedIds] = useState<string[]>([]);
	const [selectedId, setSelectedId] = useState<string>();
	const [attaching, setAttaching] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const running = useRef(false);

	const reload = useCallback(async () => {
		setLoading(true);
		setLoadError("");
		try { await loadImages(); }
		catch (cause) { setLoadError(errorText(cause)); }
		finally { setLoading(false); }
	}, [loadImages]);
	useEffect(() => { if (active) void reload(); }, [active, reload]);

	const model = imageModels.find((item) => item.key === modelKey) ?? imageModels[0];
	const sizes = [...new Set(model?.sizes.filter(Boolean) ?? [])];
	const sizeTextInput = model ? sizeSelections[model.key] ?? sizes[0] ?? "" : "";
	const size = normalizeImageSize(sizeTextInput, sizes);
	const sizeInvalid = !!sizeTextInput.trim() && !size;
	const setSize = (value: string) => {
		if (model) setSizeSelections((previous) => ({ ...previous, [model.key]: value }));
	};
	const canReference = !!model?.edits;
	const effectiveReference = canReference ? reference?.image : undefined;
	const batch = createdIds.flatMap((id) => { const item = images.find((image) => image.id === id); return item ? [item] : []; });
	const history = images.filter((image) => !createdIds.includes(image.id)).slice(0, 8);
	const selected = images.find((image) => image.id === selectedId) ?? batch[0];
	const preview = useImagePreview(selected?.id ?? "");
	const stage = busy ? "generating" : error ? "error" : selected ? "ready" : "idle";
	const canGenerate = !busy && !reading && !sizeInvalid && !!model && !!prompt.trim();

	async function pickReference(file: File) {
		setReferenceError("");
		if (!REFERENCE_TYPES.includes(file.type) || file.size === 0 || file.size > MAX_REFERENCE_BYTES) {
			setReferenceError("请选择不超过 12 MB 的 PNG、JPG 或 WebP 图片。");
			return;
		}
		setReading(true);
		try {
			const data = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onerror = () => reject(reader.error ?? new Error("无法读取参考图"));
				reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
				reader.readAsDataURL(file);
			});
			if (!data) throw new Error("参考图没有可读取的内容。");
			setReference({ fileName: file.name, image: { type: "image", mimeType: file.type, data } });
		} catch (cause) { setReferenceError(errorText(cause)); }
		finally { setReading(false); }
	}

	async function run() {
		if (running.current || !canGenerate || !model) return;
		running.current = true;
		setError("");
		try {
			const result = await generateImages({ model: model.key, prompt: prompt.trim(), size, count,
				quality: effectiveReference ? undefined : quality,
				reference: effectiveReference ? { dataBase64: effectiveReference.data, mimeType: effectiveReference.mimeType } : undefined });
			setCreatedIds(result.map((image) => image.id));
			setSelectedId(result[0]?.id);
		} catch (cause) { setError(errorText(cause)); }
		finally { running.current = false; }
	}

	async function bringToChat(image: GeneratedImage) {
		setAttaching(true);
		try {
			await attachImage(image.id);
			setView("chat");
			pushNotice("info", "图片已添加到会话输入框，尚未发送。");
		} catch (cause) { pushNotice("error", errorText(cause)); }
		finally { setAttaching(false); }
	}

	async function remove(image: GeneratedImage) {
		if (!await askConfirm({ title: "删除这张图片？", message: "将从本机图片库移除这张图片，已插入会话的附件不受影响。", confirmLabel: "删除图片", danger: true })) return;
		if (useApp.getState().imageBusy) return;
		try { await removeImage(image.id); }
		catch (cause) { pushNotice("error", errorText(cause)); }
	}

	async function download(image: GeneratedImage) {
		try {
			const file = await api.images.read(image.id);
			const link = document.createElement("a");
			link.href = `data:${file.mimeType};base64,${file.dataBase64}`;
			link.download = image.id;
			link.click();
		} catch (cause) { pushNotice("error", errorText(cause)); }
	}

	return (
		<div className="fw-image-studio flex min-h-0 flex-1 flex-col">
			<PageHeading title="图片生成" detail="从提示词开始，生成的图片会保存在本机。" actions={
				<Button size="sm" onClick={() => setView("gallery")}><Icon name="image" className="size-4" />打开图片库</Button>
			} />
			<div className="fw-studio-layout">
				<section className="fw-studio-output" aria-label="生成结果">
					<header className="fw-studio-output-header">
						<h2 className="text-base font-semibold">画布</h2>
						{selected && <span className="min-w-0 truncate text-[12px] text-muted" title={selected.model}>{sizeText(selected.size)} · {selected.model}</span>}
					</header>
					<div className="fw-studio-stage" data-image-stage data-state={stage} aria-busy={busy}>
						{selected ? (
							preview?.url ? <img className="fw-studio-result" src={preview.url} alt={selected.prompt} /> : <div className="fw-studio-placeholder"><Icon name="image" className="size-6" /><p>{preview ? "无法读取本地预览，请从图片库检查原图。" : "正在读取本地预览…"}</p></div>
						) : !busy && !error && (
							<div className="fw-studio-placeholder" role="status">
								<span className="fw-studio-blank-mark"><Icon name="image" className="size-8" /></span>
								<h3>{loading ? "正在读取图片模型" : loadError ? "暂时无法读取图片配置" : model ? "画布已就绪" : "先添加一个图片模型"}</h3>
								<p>{model ? "写下画面的主体、风格与构图，生成结果会显示在这里。" : !loading && !loadError ? "图片模型在「设置 → 自定义端点」中独立配置。" : null}</p>
								{!loading && (loadError ? <Button size="sm" onClick={() => void reload()}>重新读取</Button>
									: model ? <Button size="sm" variant="ghost" onClick={() => promptRef.current?.focus()}>填写提示词 <Icon name="arrow-right" className="size-3.5" /></Button>
									: <Button size="sm" variant="primary" onClick={() => setView("settings", "custom")}>前往配置 <Icon name="arrow-right" className="size-3.5" /></Button>)}
							</div>
						)}
						{busy && (
							<div className={`fw-studio-stage-status ${selected ? "is-overlay" : ""}`} role="status">
								<Icon name="refresh" className="size-4 animate-spin" />
								<div><strong>正在生成图片</strong><p className="text-[12px] text-muted">等待模型返回结果。切换页面不会丢失本次任务。</p></div>
							</div>
						)}
						{!busy && error && (
							<div className={`fw-studio-stage-status ${selected ? "is-overlay" : ""}`} role="alert">
								<div className="min-w-0"><strong className="text-err">生成失败</strong><p className="mt-1 max-h-24 overflow-auto break-words text-[12px] text-muted">{error}</p></div>
								<Button size="sm" disabled={!canGenerate} onClick={() => void run()}>重试</Button>
							</div>
						)}
					</div>
					{selected && (
						<div className="fw-studio-resultbar">
							<p className="min-w-0 flex-1 truncate text-[12px] text-muted" title={selected.prompt}>{selected.prompt}</p>
							<Button size="sm" disabled={!hasProject || attaching} title={hasProject ? undefined : "请先打开一个项目会话"} onClick={() => void bringToChat(selected)}>插入会话</Button>
							<Button size="sm" onClick={() => void download(selected)}>下载</Button>
							<Button size="sm" variant="ghost" disabled={busy} className="hover:text-err" onClick={() => void remove(selected)}>删除</Button>
						</div>
					)}
					{(batch.length > 1 || history.length > 0) && (
						<div className="fw-studio-filmstrip">
							{batch.length > 1 && <div><h3>本次结果 · {batch.length} 张</h3><div className="fw-studio-thumbnails">{batch.map((image) => <ImageThumbnail key={image.id} image={image} selected={selected?.id === image.id} onSelect={() => setSelectedId(image.id)} />)}</div></div>}
							{history.length > 0 && <div><h3>最近生成</h3><div className="fw-studio-thumbnails">{history.map((image) => <ImageThumbnail key={image.id} image={image} selected={selected?.id === image.id} onSelect={() => setSelectedId(image.id)} />)}</div></div>}
						</div>
					)}
				</section>
				<form className="fw-studio-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
					<fieldset disabled={busy} className="fw-studio-fields">
						<section className="fw-studio-settings-group">
							<label className="fw-studio-field-label" htmlFor="fw-image-prompt">提示词</label>
							<textarea ref={promptRef} id="fw-image-prompt" className="fw-studio-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：雨后街角的书店，暖光透过玻璃窗，电影感横幅构图…" />
							<div className="fw-studio-reference">
								{reference && <img src={`data:${reference.image.mimeType};base64,${reference.image.data}`} alt="参考图预览" />}
								<div className="min-w-0 flex-1"><p className="truncate text-[12px] font-medium" title={reference?.fileName}>{reference?.fileName ?? "参考图（可选）"}</p><p className="mt-0.5 text-[11.5px] text-muted">{reference && !canReference ? "当前模型不支持参考图，本次不发送。" : model && !canReference ? "当前模型不支持参考图" : "PNG、JPG 或 WebP，最大 12 MB"}</p></div>
								{reference && <Button size="sm" variant="ghost" disabled={reading} onClick={() => { setReference(undefined); setReferenceError(""); }}>移除</Button>}
								<Button size="sm" disabled={!canReference || reading} aria-label="添加参考图" onClick={() => fileRef.current?.click()}>{reading ? "读取中…" : reference ? "更换" : "添加"}</Button>
							</div>
							{referenceError && <p role="alert" className="text-[12px] text-err">{referenceError}</p>}
							<input ref={fileRef} type="file" accept={REFERENCE_TYPES.join(",")} className="hidden" onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file && canReference && !busy) void pickReference(file);
							}} />
						</section>
						<section className="fw-studio-settings-group">
							<h2 className="fw-studio-field-label">图片模型</h2>
							{imageModels.length > 1 ? (
								<Select aria-label="图片模型" value={model?.key ?? ""} onChange={(event) => setModelKey(event.target.value)}>
									{imageModels.map((item) => <option key={item.key} value={item.key}>{item.name || item.id} · {item.provider}</option>)}
								</Select>
							) : model ? <div className="fw-studio-static"><strong className="min-w-0 break-words">{model.name || model.id}</strong><span className="shrink-0 text-muted">{model.provider}</span></div> :
								<p className="text-[12px] text-muted">{loading ? "正在读取…" : loadError ? "未能读取配置，请重试。" : "还没有可用的图片模型。"}</p>}
							<div className="flex flex-wrap items-center gap-2 text-[12px]">
								<button type="button" className="text-primary-strong hover:underline" onClick={() => setView("settings", "custom")}>{model ? "管理图片模型" : "配置图片模型"}</button>
								{loadError && <button type="button" title={loadError} className="text-err hover:underline" onClick={() => void reload()}>重新读取</button>}
							</div>
						</section>
						{model && (
							<section className="fw-studio-settings-group">
								<h2 className="fw-studio-field-label">输出设置</h2>
								<div className="flex min-w-0 items-center gap-2">
									<label htmlFor="fw-image-size" className="shrink-0 text-[12px] text-muted">尺寸</label>
									<Input id="fw-image-size" maxLength={64} value={sizeTextInput} placeholder="服务商默认" aria-invalid={sizeInvalid || undefined} aria-describedby="fw-image-size-hint" onChange={(event) => setSize(event.target.value)} className="min-w-0 flex-1" />
									{sizeTextInput && <Button size="sm" variant="ghost" onClick={() => setSize("")}>用默认</Button>}
								</div>
								<p id="fw-image-size-hint" className={`text-[11.5px] ${sizeInvalid ? "text-err" : "text-muted"}`}>
									{sizeInvalid ? "请输入有效宽高，例如 1920 × 1080，或留空。" : "可填自定义宽高，留空用服务商默认。实际支持以服务商为准。"}
								</p>
								{sizes.length > 1 && (
									<div role="group" aria-label="输出尺寸" className="fw-studio-sizes">
										{sizes.map((value) => {
											const dimensions = /^(\d{1,5})x(\d{1,5})$/i.exec(value);
											const ratio = dimensions && Number(dimensions[2]) ? Number(dimensions[1]) / Number(dimensions[2]) : 1;
											return <button key={value} type="button" data-image-size={value} aria-pressed={size === normalizeImageSize(value, sizes)} className="fw-studio-size" onClick={() => setSize(value)}>
												<span className="fw-studio-size-mark" style={{ width: ratio >= 1 ? 20 : Math.max(8, 20 * ratio), height: ratio <= 1 ? 20 : Math.max(8, 20 / ratio) }} aria-hidden="true" />{sizeText(value)}
											</button>;
										})}
									</div>
								)}
								<div className="fw-studio-option-row"><span>数量</span><div className="fw-seg" role="group" aria-label="生成数量">{COUNTS.map((value) => <button key={value} type="button" aria-pressed={count === value} className={`fw-seg-item ${count === value ? "fw-seg-item-active" : ""}`} onClick={() => setCount(value)}>{value} 张</button>)}</div></div>
								<div className="fw-studio-option-row"><span>质量</span>{effectiveReference ? <span className="text-[12px] text-muted">参考图模式使用默认质量</span> : <div className="fw-seg" role="group" aria-label="输出质量">{(["standard", "hd"] as const).map((value) => <button key={value} type="button" aria-pressed={quality === value} className={`fw-seg-item ${quality === value ? "fw-seg-item-active" : ""}`} onClick={() => setQuality(value)}>{value === "hd" ? "高清" : "标准"}</button>)}</div>}</div>
							</section>
						)}
					</fieldset>
					<footer className="fw-studio-submit">
						<p className="text-[12px] text-muted">{!model ? "配置图片模型后可生成" : !prompt.trim() ? "填写提示词后可生成" : model.price == null ? "此模型未设置参考价格" : `预估 ¥${(model.price * count).toFixed(2)} · ${count} 张`}</p>
						<Button type="submit" variant="primary" disabled={!canGenerate} className="w-full"><Icon name={busy ? "refresh" : "sparkles"} className={`size-4 ${busy ? "animate-spin" : ""}`} />{busy ? "生成中…" : `生成 ${count} 张`}</Button>
					</footer>
				</form>
			</div>
		</div>
	);
}
