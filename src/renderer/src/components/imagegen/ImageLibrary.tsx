import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeneratedImage } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { askConfirm } from "../ConfirmDialog";
import { Icon } from "../Icon";
import { PageHeading, WorkbenchEmpty } from "../PageHeading";
import { Button } from "../ui";
import { useImagePreview } from "./ImageStudio";
import "./image-library.css";

const PAGE_SIZE = 24;

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return bytes ? `${Math.max(1, Math.round(bytes / 1024))} KB` : "0 KB";
}

function GalleryTile({ image, active, favorite, select }: { image: GeneratedImage; active: boolean; favorite: boolean; select: () => void }) {
	const preview = useImagePreview(image.id);
	return (
		<button type="button" className="fw-gallery-tile" aria-pressed={active} onClick={select} data-gallery-image={image.id}>
			<span className="fw-gallery-thumb">
				{preview?.url ? <img src={preview.url} alt="" loading="lazy" /> : <Icon name="image" className="size-5" />}
				{favorite && <Icon name="star" className="fw-gallery-star size-5" />}
			</span>
			<span className="block truncate px-2.5 py-2 text-[12px]" title={image.prompt}>{image.prompt || "无提示词"}</span>
		</button>
	);
}

export function ImageLibrary() {
	const images = useApp((s) => s.images);
	const imageBusy = useApp((s) => s.imageBusy);
	const hasProject = useApp((s) => !!s.activeProjectId);
	const loadImages = useApp((s) => s.loadImages);
	const filter = useApp((s) => s.imageFilter);
	const favorites = useApp((s) => s.imageFavorites);
	const { attachImage, clearImages, removeImage, pushNotice, setImageFilter, setView, toggleImageFavorite } = useApp.getState();
	const [selectedId, setSelectedId] = useState<string>();
	const [paging, setPaging] = useState({ filter: "", limit: PAGE_SIZE });
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState("");
	const [action, setAction] = useState<"clearing" | "removing" | "attaching" | "downloading" | null>(null);
	const inFlight = useRef(false);
	const reload = useCallback(async () => {
		setLoading(true);
		setLoadError("");
		try { await loadImages(); }
		catch (cause) { setLoadError(errorText(cause)); }
		finally { setLoading(false); }
	}, [loadImages]);
	useEffect(() => { void reload(); }, [reload]);

	const visible = useMemo(() => {
		const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		if (filter === "favorite") return images.filter((image) => favorites[image.id]);
		if (filter === "week") return images.filter((image) => image.createdAt >= weekAgo);
		if (filter.startsWith("model:")) return images.filter((image) => image.model === filter.slice(6));
		return images;
	}, [images, filter, favorites]);
	const limit = paging.filter === filter ? paging.limit : PAGE_SIZE;
	const selected = visible.slice(0, limit).find((image) => image.id === selectedId) ?? visible[0];
	const preview = useImagePreview(selected?.id ?? "");
	const bytes = images.reduce((sum, image) => sum + image.bytes, 0);
	const filterLabel = filter === "favorite" ? "收藏" : filter === "week" ? "最近 7 天" : filter.startsWith("model:") ? filter.slice(6) : "全部图片";

	async function perform(kind: NonNullable<typeof action>, run: () => Promise<void>) {
		if (inFlight.current) return;
		inFlight.current = true;
		setAction(kind);
		try { await run(); }
		catch (cause) { pushNotice("error", errorText(cause)); }
		finally { inFlight.current = false; setAction(null); }
	}

	function clear() {
		void perform("clearing", async () => {
			if (!await askConfirm({ title: "清空图片库？", message: `将删除本机图片库中的 ${useApp.getState().images.length} 张图片，包括已收藏的图片。此操作无法撤销，已插入会话的附件不受影响。`, confirmLabel: "清空图片库", danger: true })) return;
			if (useApp.getState().imageBusy) { pushNotice("warning", "请等待此次图片生成完成，再清空图库。"); return; }
			await clearImages();
			setSelectedId(undefined);
			setImageFilter("all");
			pushNotice("info", "图片库已清空");
		});
	}

	function remove(image: GeneratedImage) {
		void perform("removing", async () => {
			if (!await askConfirm({ title: "删除这张图片？", message: "将从本机图片库移除这张图片，已插入会话的附件不受影响。", confirmLabel: "删除图片", danger: true })) return;
			if (useApp.getState().imageBusy) { pushNotice("warning", "请等待此次图片生成完成，再删除图片。"); return; }
			await removeImage(image.id);
			pushNotice("info", "图片已删除");
		});
	}

	function insert(image: GeneratedImage) {
		if (!useApp.getState().activeProjectId) return;
		void perform("attaching", async () => {
			await attachImage(image.id);
			setView("chat");
			pushNotice("info", "图片已添加到会话输入框，尚未发送。");
		});
	}

	function download(image: GeneratedImage) {
		void perform("downloading", async () => {
			let url = preview?.url;
			if (!url) {
				const file = await api.images.read(image.id);
				url = `data:${file.mimeType};base64,${file.dataBase64}`;
			}
			const link = document.createElement("a");
			link.href = url;
			link.download = image.id;
			link.click();
		});
	}

	return (
		<div className="fw-gallery flex min-h-0 flex-1 flex-col bg-bg">
			<PageHeading title="图片库" detail={images.length ? `${images.length} 张本地图片 · ${formatBytes(bytes)}` : "查看、收藏和下载生成的图片。"} actions={
				<Button size="sm" onClick={() => setView("imagegen")}><Icon name="sparkles" className="size-4" />生成图片</Button>
			} />
			{loadError && <div role="alert" className="flex items-center justify-between gap-3 bg-err-soft px-5 py-2 text-[13px] text-err">
				<span className="min-w-0 break-words">读取图片库失败：{loadError}</span>
				<Button size="sm" disabled={loading} onClick={() => void reload()}>重试</Button>
			</div>}
			{images.length === 0 ? (
				<WorkbenchEmpty icon="image" title={loading ? "正在读取图片库" : loadError ? "暂时无法读取图片库" : "图片库还是空的"} detail={loading ? "正在读取本地图片记录。" : loadError ? "重试读取后，就能继续查看已保存的图片。" : "生成结果会自动保存在本机，也能从这里添加到会话。"} />
			) : (
				<div className="fw-gallery-layout-next">
					<section className="fw-gallery-index" aria-label="图片列表">
						<header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
							<h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold" title={filterLabel}>{filterLabel} <span className="text-[12px] font-normal text-muted">{visible.length} 张</span></h2>
							<Button variant="ghost" size="sm" disabled={loading || !!action} onClick={() => void reload()}>{loading ? "刷新中…" : "刷新"}</Button>
							<Button variant="ghost" size="sm" disabled={imageBusy || loading || !!action} className="text-err" onClick={clear}>清空图片库</Button>
						</header>
						{visible.length === 0 ? (
							<div className="fw-gallery-no-results" role="status">
								<h3 className="text-[16px] font-semibold">{filter === "favorite" ? "还没有收藏的图片" : "没有符合条件的图片"}</h3>
								<p className="text-[13px] text-muted">{filter === "favorite" ? "在图片预览中点击收藏，方便下次找到。" : "可以返回全部图片，或从侧栏选择其他分类。"}</p>
								<Button size="sm" onClick={() => setImageFilter("all")}>查看全部图片</Button>
							</div>
						) : <>
							<div className="fw-gallery-tiles">
								{visible.slice(0, limit).map((image) => <GalleryTile key={image.id} image={image} active={selected?.id === image.id} favorite={!!favorites[image.id]} select={() => setSelectedId(image.id)} />)}
							</div>
							{visible.length > limit && <Button className="mt-4" onClick={() => setPaging({ filter, limit: limit + PAGE_SIZE })}>显示更多 · 剩余 {visible.length - limit} 张</Button>}
						</>}
					</section>
					{selected && <section className="fw-gallery-detail" aria-label="图片预览">
						<header className="mb-3 flex items-center justify-between gap-2">
							<h2 className="text-[16px] font-semibold">图片预览</h2>
							<Button size="sm" variant="ghost" aria-pressed={!!favorites[selected.id]} onClick={() => toggleImageFavorite(selected.id)}><Icon name="star" className={`size-4 ${favorites[selected.id] ? "text-warn" : ""}`} />{favorites[selected.id] ? "已收藏" : "收藏"}</Button>
						</header>
						<div className="fw-gallery-stage">
							{preview?.url ? <img src={preview.url} alt={selected.prompt || "生成图片"} /> : <p role="status" className="px-4 text-center text-[13px] text-muted">{preview ? "无法读取这张本地图片" : "正在读取本地图片…"}</p>}
						</div>
						<p className="mt-3 break-words text-[13px] leading-relaxed">{selected.prompt || "无提示词"}</p>
						<p className="mt-2 break-words text-[12px] text-muted">{selected.size.replace(/x/g, " × ")} · {formatBytes(selected.bytes)} · {selected.model}</p>
						<p className="mt-1 text-[12px] text-muted">{new Date(selected.createdAt).toLocaleString()}{selected.edited ? " · 使用了参考图" : ""}</p>
						<div className="mt-4 flex flex-wrap gap-2">
							<Button size="sm" variant="primary" disabled={!hasProject || !!action} onClick={() => insert(selected)}>{action === "attaching" ? "插入中…" : "插入会话"}</Button>
							<Button size="sm" disabled={!!action} onClick={() => download(selected)}>{action === "downloading" ? "读取中…" : "下载"}</Button>
							<Button size="sm" variant="ghost" disabled={imageBusy || !!action} className="text-err" onClick={() => remove(selected)}>删除</Button>
						</div>
						{!hasProject && <p className="mt-2 text-[12px] text-muted">打开项目会话后即可插入图片。</p>}
					</section>}
				</div>
			)}
		</div>
	);
}
