/**
 * 图片库侧栏（「图片生成」与「图片库」两个视图共用）：
 * 按收藏 / 时间 / 模型三种维度分组，选中后通过全局的图片筛选状态驱动主区的网格。
 * 底部显示缓存占用与「清空缓存」。
 */
import { useMemo } from "react";
import { useApp } from "../../store";
import { Icon } from "../Icon";

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function GalleryTree() {
	const images = useApp((s) => s.images);
	const filter = useApp((s) => s.imageFilter);
	const setImageFilter = useApp((s) => s.setImageFilter);
	const setView = useApp((s) => s.setView);
	const favoriteFlags = useApp((s) => s.imageFavorites);

	const { favorites, week, byModel, bytes } = useMemo(() => {
		const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const models = new Map<string, number>();
		for (const image of images) models.set(image.model, (models.get(image.model) ?? 0) + 1);
		return {
			favorites: images.filter((i) => favoriteFlags[i.id]).length,
			week: images.filter((i) => i.createdAt >= weekAgo).length,
			byModel: [...models.entries()].sort((a, b) => b[1] - a[1]),
			bytes: images.reduce((sum, i) => sum + i.bytes, 0),
		};
	}, [images, favoriteFlags]);

	const Row = ({ id, label, count, icon }: { id: string; label: string; count?: number; icon?: "sparkles" }) => (
		<button
			type="button"
			onClick={() => {
				setImageFilter(id);
				setView("gallery");
			}}
			className={`flex h-8 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[12.5px] ${
				filter === id ? "bg-primary-soft font-medium text-primary" : "text-muted hover:bg-panel-2 hover:text-fg"
			}`}
		>
			{icon && <Icon name={icon} className="size-4 shrink-0" />}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count !== undefined && <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">{count}</span>}
		</button>
	);

	return (
		<div className="space-y-0.5">
			<Row id="all" label="全部图片" count={images.length} />
			<Row id="favorite" label="收藏" count={favorites} />
			<Row id="week" label="本周" count={week} />

			{byModel.length > 0 && (
				<div className="mt-3 space-y-0.5 border-t border-border pt-3">
					<div className="mb-1 px-2.5 text-[11px] font-semibold text-faint">按模型</div>
					{byModel.map(([model, count]) => (
						<button
							type="button"
							key={model}
							onClick={() => {
								setImageFilter(`model:${model}`);
								setView("gallery");
							}}
							title={model}
							className={`flex h-8 w-full items-center gap-2 rounded-[10px] px-2.5 text-left ${
								filter === `model:${model}` ? "bg-primary-soft text-primary" : "text-muted hover:bg-panel-2 hover:text-fg"
							}`}
						>
							<Icon name="cpu" className="size-4 shrink-0 text-faint" />
							<span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{model}</span>
							<span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">{count}</span>
						</button>
					))}
				</div>
			)}

			<div className="mt-3 border-t border-border pt-3">
				<button
					type="button"
					onClick={() => setView("imagegen")}
					className="flex h-8 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[12.5px] text-primary hover:bg-panel-2"
				>
					<Icon name="sparkles" className="size-4 shrink-0" />
					<span className="min-w-0 flex-1 truncate">去生成图片</span>
				</button>
			</div>

			<div className="px-2.5 pt-3 text-[11.5px] leading-5 text-faint">
				缓存 {images.length} 张 · {formatBytes(bytes)}
			</div>
		</div>
	);
}
