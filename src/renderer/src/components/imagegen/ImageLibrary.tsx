/**
 * 图片库（活动栏「图片库」主视图）：生成历史按时间排列的网格 + 右侧详情。
 * 与生成工作台共用同一份缓存（store.images），操作也是同一套：插入会话 / 下载 / 删除。
 */
import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Icon } from "../Icon";
import { Badge, Button } from "../ui";
import { GeneratedTile, useImageUrl } from "./ImageStudio";

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ImageLibrary() {
	const images = useApp((s) => s.images);
	const loadImages = useApp((s) => s.loadImages);
	const clearImages = useApp((s) => s.clearImages);
	const attachImage = useApp((s) => s.attachImage);
	const pushNotice = useApp((s) => s.pushNotice);
	const filter = useApp((s) => s.imageFilter);
	const favorites = useApp((s) => s.imageFavorites);
	const toggleImageFavorite = useApp((s) => s.toggleImageFavorite);
	const [selectedId, setSelectedId] = useState<string>();

	useEffect(() => {
		void loadImages().catch((error) => pushNotice("error", `读取图片库失败：${errorText(error)}`));
	}, [loadImages, pushNotice]);

	/** 侧栏筛选：全部 / 收藏 / 本周 / 按模型 */
	const visible = useMemo(() => {
		const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		if (filter === "favorite") return images.filter((i) => favorites[i.id]);
		if (filter === "week") return images.filter((i) => i.createdAt >= weekAgo);
		if (filter.startsWith("model:")) {
			const model = filter.slice("model:".length);
			return images.filter((i) => i.model === model);
		}
		return images;
	}, [images, filter, favorites]);
	const selected = useMemo(() => visible.find((i) => i.id === selectedId) ?? visible[0], [visible, selectedId]);
	const url = useImageUrl(selected?.id ?? "");
	const bytes = images.reduce((sum, i) => sum + i.bytes, 0);

	const insert = async () => {
		if (!selected) return;
		try {
			await attachImage(selected.id);
			pushNotice("info", "已放进输入框，切回会话即可随下一条消息发送");
		} catch (error) {
			pushNotice("error", errorText(error));
		}
	};

	const download = async () => {
		if (!selected) return;
		try {
			const file = await api.images.read(selected.id);
			const link = document.createElement("a");
			link.href = `data:${file.mimeType};base64,${file.dataBase64}`;
			link.download = `${selected.model.replace(/[^\w.-]+/g, "_")}-${selected.id}`;
			link.click();
		} catch (error) {
			pushNotice("error", errorText(error));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-6">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
					<Icon name="image" className="size-4" />
				</span>
				<span className="shrink-0 text-[15px] font-semibold tracking-tight">图片库</span>
				<Badge tone="muted">
					{images.length} 张 · {formatBytes(bytes)}
				</Badge>
				<div className="flex-1" />
				<Button size="sm" variant="ghost" onClick={() => void loadImages().catch(() => undefined)}>
					<Icon name="refresh" className="size-4" />
					刷新
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="text-err hover:bg-err-soft"
					disabled={images.length === 0}
					onClick={() => {
						void clearImages()
							.then(() => pushNotice("info", "缓存已清空（已经插入会话的附件不受影响）"))
							.catch((error) => pushNotice("error", errorText(error)));
					}}
				>
					<Icon name="trash-2" className="size-4" />
					清空缓存
				</Button>
			</div>

			{images.length === 0 ? (
				<div className="flex min-h-0 flex-1 items-center justify-center">
					<div className="text-center">
						<div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-panel-2 text-faint">
							<Icon name="image" className="size-5" />
						</div>
						<div className="mt-3 text-[14px] text-fg">图片库还是空的</div>
						<div className="mt-1 text-[12.5px] text-muted">到「图片生成」里生成第一张，结果会自动收进这里。</div>
					</div>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-5">
					<div className="min-w-0 flex-1">
						<div className="grid grid-cols-4 gap-4">
							{visible.map((image) => (
								<button
									type="button"
									key={image.id}
									onClick={() => setSelectedId(image.id)}
									className={`block rounded-2xl text-left ${
										selected?.id === image.id ? "ring-2 ring-primary" : ""
									}`}
								>
									<GeneratedTile image={image} />
								</button>
							))}
						</div>
					</div>

							{visible.length === 0 && (
								<div className="rounded-2xl border border-dashed border-border-strong px-4 py-10 text-center text-[12.5px] text-muted">
									这个筛选下还没有图片。
								</div>
							)}
					<div className="w-[320px] shrink-0">
						{selected && (
							<div className="fw-card overflow-hidden">
								<div className="aspect-square bg-panel-2">
									{url ? (
										<img src={url} alt={selected.prompt} className="size-full object-cover" />
									) : (
										<div className="flex size-full items-center justify-center text-faint">
											<Icon name="image" className="size-5" />
										</div>
									)}
								</div>
								<div className="p-4">
									<div className="text-[13px] leading-relaxed text-fg">{selected.prompt}</div>
									<div className="mt-3 space-y-1.5 text-[12px] text-muted">
										<div className="flex gap-2">
											<span className="w-16 shrink-0 text-faint">模型</span>
											<span className="min-w-0 truncate font-mono">{selected.model}</span>
										</div>
										<div className="flex gap-2">
											<span className="w-16 shrink-0 text-faint">尺寸</span>
											<span className="font-mono">{selected.size}</span>
										</div>
										<div className="flex gap-2">
											<span className="w-16 shrink-0 text-faint">质量</span>
											<span>{selected.quality === "hd" ? "高清" : "标准"}</span>
										</div>
										<div className="flex gap-2">
											<span className="w-16 shrink-0 text-faint">大小</span>
											<span>{formatBytes(selected.bytes)}</span>
										</div>
										<div className="flex gap-2">
											<span className="w-16 shrink-0 text-faint">生成于</span>
											<span>{new Date(selected.createdAt).toLocaleString()}</span>
										</div>
									</div>
									<div className="mt-4 flex items-center gap-2">
										<Button variant="primary" size="sm" onClick={() => void insert()}>
											<Icon name="corner-down-left" className="size-4" />
											插入会话
										</Button>
										<Button size="sm" onClick={() => void download()}>
											下载
										</Button>
										<Button size="sm" variant="ghost" onClick={() => toggleImageFavorite(selected.id)}>
											<Icon name="star" className={`size-4 ${favorites[selected.id] ? "text-warn" : ""}`} />
											{favorites[selected.id] ? "已收藏" : "收藏"}
										</Button>
									</div>
								</div>
							</div>
						)}
						<div className="mt-3 text-[11.5px] leading-relaxed text-faint">
							图片缓存在本机（配置目录下的 images/），最多保留 200 张，超出时自动删最旧的；清空缓存不会影响已经插入会话的附件。
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
