/**
 * 外观设置：主题 / 字体与字号 / 强调色 / 窗口背景 / 辅助功能。
 *
 * 全部只影响界面外观，保存在本机 localStorage，不写入 pi 的 settings.json。
 * Apple 体系：白卡片分区、蓝色软底选中态、分段控件与开关；改一项立刻生效。
 */
import { type ReactNode, useRef, useState } from "react";
import {
	ACCENTS,
	BG_MODES,
	CODE_SIZES,
	FONTS,
	MAX_BG_IMAGE_BYTES,
	MONOS,
	SCALES,
	type AccentId,
	type BgMode,
	type CodeSize,
	type FontId,
	type MonoId,
	type ScaleId,
} from "../../appearance";
import { useApp } from "../../store";
import type { ThemeMode } from "../../theme";
import { Button, Field, Segmented, Select, Toggle } from "../ui";

const THEME_OPTIONS: Array<{ id: ThemeMode; label: string; desc: string }> = [
	{ id: "system", label: "跟随系统", desc: "随操作系统的浅色 / 深色设置自动切换" },
	{ id: "dark", label: "深色", desc: "深石墨底 + 同一套蓝色强调" },
	{ id: "light", label: "浅色", desc: "白卡片 + 蓝色强调（默认）" },
];

/** 迷你窗口预览：左半浅右半深表示跟随系统 */
function Preview({ mode }: { mode: ThemeMode }) {
	const dark = mode === "dark";
	const split = mode === "system";

	return (
		<div className="flex h-[58px] overflow-hidden rounded-lg border border-border">
			{!dark && (
				<div className={`flex flex-col bg-surface-raised ${split ? "w-1/2 border-r border-border" : "w-full"}`}>
					<div className="flex h-4 items-center gap-1 border-b border-border bg-surface px-2">
						<span className="size-1.5 rounded-full bg-border-strong" />
						<span className="size-1.5 rounded-full bg-border-strong" />
					</div>
					<div className="space-y-1.5 p-2">
						<div className="h-1.5 w-2/3 rounded-full bg-border" />
						<div className="h-1.5 w-1/2 rounded-full bg-panel-2" />
						<div className="grid grid-cols-2 gap-1.5 pt-0.5">
							<div className="h-3 rounded bg-panel-2" />
							<div className="h-3 rounded bg-panel-2" />
						</div>
					</div>
				</div>
			)}

			{(dark || split) && (
				<div className={`flex flex-col bg-fg ${split ? "w-1/2" : "w-full"}`}>
					<div className="flex h-4 items-center gap-1 border-b border-white/10 bg-white/10 px-2">
						<span className="size-1.5 rounded-full bg-white/30" />
						<span className="size-1.5 rounded-full bg-white/30" />
					</div>
					<div className="space-y-1.5 p-2">
						<div className="h-1.5 w-2/3 rounded-full bg-white/25" />
						<div className="h-1.5 w-1/2 rounded-full bg-white/15" />
						<div className="grid grid-cols-2 gap-1.5 pt-0.5">
							<div className="h-3 rounded bg-white/15" />
							<div className="h-3 rounded bg-white/15" />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 分区卡片：标题 + 说明（+ 右侧动作），内容在下面 */
function Section({
	title,
	hint,
	action,
	children,
	className = "",
}: {
	title: string;
	hint?: string;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={`fw-card p-5 ${className}`}>
			<div className="mb-3 flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="text-[15px] font-semibold tracking-tight">{title}</div>
					{hint && <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{hint}</p>}
				</div>
				{action}
			</div>
			{children}
		</div>
	);
}

/** 滑块：原生 range + 主题色，右侧是当前值 */
function Slider({
	label,
	value,
	min,
	max,
	step = 1,
	format,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	format: (value: number) => string;
	onChange: (value: number) => void;
}) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-16 shrink-0 text-[12.5px] text-muted">{label}</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary"
			/>
			<span className="w-12 shrink-0 text-right text-[12.5px] tabular-nums text-muted">{format(value)}</span>
		</div>
	);
}

export function AppearanceTab() {
	const theme = useApp((s) => s.theme);
	const resolved = useApp((s) => s.resolvedTheme);
	const setTheme = useApp((s) => s.setTheme);
	const appearance = useApp((s) => s.appearance);
	const setAppearance = useApp((s) => s.setAppearance);

	const fileRef = useRef<HTMLInputElement>(null);
	const [imageError, setImageError] = useState<string | null>(null);

	const pickImage = (file: File | undefined) => {
		if (!file) return;
		if (file.size > MAX_BG_IMAGE_BYTES) {
			setImageError(`图片 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_BG_IMAGE_BYTES / 1024 / 1024} MB 上限，请换一张小的。`);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			setImageError(null);
			setAppearance({ bgImage: String(reader.result ?? ""), bg: "image" });
		};
		reader.onerror = () => setImageError("读取图片失败，请换一张试试。");
		reader.readAsDataURL(file);
	};

	return (
		<div className="space-y-5">
			{/* 主题 */}
			<Section
				title="主题"
				hint="深色与浅色共用同一套强调色、字体与背景设置。"
				action={
					<span className="flex shrink-0 items-center gap-2 text-[12.5px] text-muted">
						当前生效
						<span className="rounded-full bg-panel-2 px-2.5 py-0.5 font-medium text-fg">
							{resolved === "dark" ? "深色" : "浅色"}
							{theme === "system" && <span className="font-normal text-muted">（跟随系统）</span>}
						</span>
					</span>
				}
			>
				<div className="grid grid-cols-3 gap-4">
					{THEME_OPTIONS.map((option) => {
						const active = theme === option.id;
						return (
							<button
								type="button"
								key={option.id}
								onClick={() => setTheme(option.id)}
								className={`rounded-2xl border p-3 text-left ${
									active ? "border-primary/40 bg-primary-soft" : "border-border hover:bg-panel-2"
								}`}
							>
								<Preview mode={option.id} />
								<div className="mt-3 flex items-center gap-2">
									<span className={`flex-1 text-[13.5px] ${active ? "font-medium text-primary" : "text-fg"}`}>
										{option.label}
									</span>
									<span
										className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
											active ? "border-primary" : "border-border-strong"
										}`}
									>
										{active && <span className="size-2 rounded-full bg-primary" />}
									</span>
								</div>
								<div className="mt-1 text-[12px] leading-relaxed text-muted">{option.desc}</div>
							</button>
						);
					})}
				</div>
			</Section>

			<div className="grid grid-cols-2 items-start gap-5">
				<div className="space-y-5">
					{/* 字体与字号 */}
					<Section title="字体与字号" hint="只用系统字体，不加载外部字体。">
						<div className="grid grid-cols-2 gap-4">
							<Field label="界面字体">
								<Select value={appearance.font} onChange={(e) => setAppearance({ font: e.target.value as FontId })}>
									{FONTS.map((f) => (
										<option key={f.id} value={f.id}>
											{f.label}
										</option>
									))}
								</Select>
							</Field>
							<Field label="等宽字体">
								<Select value={appearance.mono} onChange={(e) => setAppearance({ mono: e.target.value as MonoId })}>
									{MONOS.map((m) => (
										<option key={m.id} value={m.id}>
											{m.label}
										</option>
									))}
								</Select>
							</Field>
						</div>
						<div className="mt-4 grid grid-cols-2 gap-4">
							<Field label="界面字号">
								<Segmented
									items={SCALES}
									active={appearance.scale}
									onChange={(id) => setAppearance({ scale: id as ScaleId })}
								/>
							</Field>
							<Field label="代码字号">
								<Segmented
									items={CODE_SIZES}
									active={String(appearance.codeSize)}
									onChange={(id) => setAppearance({ codeSize: Number(id) as CodeSize })}
								/>
							</Field>
						</div>
						<div className="mt-4 flex items-center gap-3 rounded-xl bg-panel-2 px-3.5 py-2.5">
							<span className="min-w-0 flex-1 truncate text-[14px] text-fg">修复跨分组拖拽后顺序丢失</span>
							<span className="shrink-0 font-mono text-[12px] text-muted">npm test -- projects</span>
						</div>
					</Section>

					{/* 强调色 */}
					<Section title="强调色" hint="用于链接、选中态与开关；一屏只应用一种。">
						<div className="flex items-center gap-2.5">
							{ACCENTS.map((accent) => {
								const active = appearance.accent === accent.id;
								return (
									<button
										type="button"
										key={accent.id}
										title={accent.label}
										onClick={() => setAppearance({ accent: accent.id as AccentId })}
										className={`flex size-7 shrink-0 items-center justify-center rounded-full ${
											active ? "ring-2 ring-primary/40" : ""
										}`}
									>
										<span className="size-5 rounded-full" style={{ background: accent.color }} />
									</button>
								);
							})}
						</div>
						<div className="mt-4 flex items-center gap-3 border-t border-border pt-4">
							<span className="flex-1 text-[14px]">边栏图标大小</span>
							<Segmented
								items={[
									{ id: "md", label: "中" },
									{ id: "lg", label: "大" },
								]}
								active={appearance.largeSidebarIcons ? "lg" : "md"}
								onChange={(id) => setAppearance({ largeSidebarIcons: id === "lg" })}
							/>
						</div>
					</Section>
				</div>

				<div className="space-y-5">
					{/* 窗口背景 */}
					<Section title="窗口背景" hint="窗口背后的材质：跟随系统壁纸，或指定一张图片。">
						<Segmented
							items={BG_MODES}
							active={appearance.bg}
							onChange={(id) => setAppearance({ bg: id as BgMode })}
						/>
						<div className="mt-3 flex items-center gap-2">
							{appearance.bgImage ? (
								<img src={appearance.bgImage} alt="" className="size-9 shrink-0 rounded-[10px] border border-border object-cover" />
							) : null}
							<span className="flex h-9 min-w-0 flex-1 items-center rounded-[10px] border border-border bg-surface-raised px-3 text-[12.5px] text-muted">
								<span className="truncate">{appearance.bgImage ? "已选择图片" : "未选择图片"}</span>
							</span>
							<Button size="sm" onClick={() => fileRef.current?.click()}>
								选择图片…
							</Button>
							{appearance.bgImage && (
								<Button size="sm" variant="ghost" onClick={() => setAppearance({ bgImage: "", bg: "system" })}>
									清除
								</Button>
							)}
						</div>
						<input
							ref={fileRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								pickImage(e.target.files?.[0]);
								e.target.value = "";
							}}
						/>
						{imageError && <div className="mt-2 text-[12px] leading-5 text-warn">{imageError}</div>}
						<div className="mt-4 space-y-3">
							<Slider
								label="模糊"
								value={appearance.bgBlur}
								min={0}
								max={40}
								format={(v) => `${v} px`}
								onChange={(bgBlur) => setAppearance({ bgBlur })}
							/>
							<Slider
								label="不透明度"
								value={appearance.bgOpacity}
								min={0.2}
								max={1}
								step={0.02}
								format={(v) => `${Math.round(v * 100)}%`}
								onChange={(bgOpacity) => setAppearance({ bgOpacity })}
							/>
						</div>
						{appearance.bg !== "system" && (
							<div className="mt-3 text-[12px] leading-5 text-faint">
								{appearance.bg === "image" && !appearance.bgImage
									? "先选一张图片；图片保存在本机，不会上传。"
									: "模糊与不透明度对三种背景模式都生效。"}
							</div>
						)}
					</Section>

					{/* 辅助功能 */}
					<Section title="辅助功能" hint="只影响本机界面，不改变会话与模型行为。">
						<div className="space-y-3">
							<div className="flex items-center gap-3">
								<span className="flex-1 text-[14px]">提高对比度</span>
								<Toggle on={appearance.contrast} onChange={(contrast) => setAppearance({ contrast })} />
							</div>
							<div className="flex items-center gap-3">
								<span className="flex-1 text-[14px]">减少动态效果</span>
								<Toggle on={appearance.reducedMotion} onChange={(reducedMotion) => setAppearance({ reducedMotion })} />
							</div>
						</div>
						<div className="mt-4 border-t border-border pt-4 text-[12px] leading-5 text-faint">
							外观设置只保存在本机（flowork.appearance），不写入 pi 配置；主题之外的项在深色下同样生效。
						</div>
					</Section>
				</div>
			</div>
		</div>
	);
}
