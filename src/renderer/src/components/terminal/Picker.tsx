/**
 * Apple 体系的下拉选择：触发按钮是安静的 pill，展开后是白色圆角浮层。
 * 支持搜索、按 provider 分组、当前项蓝色勾选，键盘 ↑↓ / Enter / Esc 操作。
 * 用来替代输入区里的系统原生 select —— 原生菜单会把超长模型 ID 挤在一起、不能搜索、
 * 选中行还是系统的蓝色高亮，和界面其它部分不是一个语言。
 */
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";

export interface PickerItem {
	/** 分组标题：相邻同组只渲染一次标题 */
	group?: string;
	value: string;
	/** 主标题（等宽显示），例如模型 id 或选项文案 */
	title: string;
	/** 右侧徽标，例如「可思考」 */
	badge?: string;
}

/** 列表最多渲染这么多行，避免上千个模型一次性铺开 */
const MAX_ROWS = 200;

export function Picker({
	label,
	items,
	value,
	onSelect,
	title,
	searchable = false,
	searchPlaceholder = "搜索…",
	mono = false,
	tone = "muted",
	align = "start",
	emptyText = "没有匹配项",
	disabled = false,
	shrink = false,
}: {
	label: string;
	items: PickerItem[];
	value: string;
	onSelect: (value: string) => void;
	title?: string;
	searchable?: boolean;
	searchPlaceholder?: string;
	mono?: boolean;
	tone?: "muted" | "warn" | "faint";
	align?: "start" | "end";
	emptyText?: string;
	disabled?: boolean;
	/** 允许在窄容器里收缩（用于输入框底部工具条，避免换行） */
	shrink?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const boxRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items;
		return items.filter((i) => `${i.group ?? ""} ${i.title} ${i.badge ?? ""}`.toLowerCase().includes(q));
	}, [items, query]);
	const shown = filtered.slice(0, MAX_ROWS);

	// 打开时清空搜索，并把当前项定位到第一屏
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActive(Math.max(0, shown.findIndex((i) => i.value === value)));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// 点击外部关闭
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener("mousedown", onDown, true);
		return () => window.removeEventListener("mousedown", onDown, true);
	}, [open]);

	// 键盘移动时把当前行滚进视野
	useEffect(() => {
		if (!open) return;
		listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [open, active]);

	const pick = (next: string) => {
		onSelect(next);
		setOpen(false);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			setOpen(false);
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(shown.length - 1, i + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(0, i - 1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const item = shown[active];
			if (item) pick(item.value);
		}
	};

	const toneCls = tone === "warn" ? "text-warn" : tone === "faint" ? "text-faint" : "text-muted";

	return (
		<div className={`relative ${shrink ? "min-w-0" : "shrink-0"}`} ref={boxRef}>
			<button
				type="button"
				disabled={disabled}
				title={title}
				onClick={() => setOpen((o) => !o)}
				className={`flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full px-3 text-[12.5px] hover:bg-panel-2 hover:text-fg disabled:opacity-40 ${
					open ? "bg-panel-2 text-fg" : toneCls
				}`}
			>
				<span className={`min-w-0 max-w-[280px] truncate ${mono ? "font-mono" : ""}`}>{label}</span>
				<Icon name="chevron-down" className="size-3 shrink-0 text-faint" />
			</button>

			{open && (
				<div
					onKeyDown={onKeyDown}
					className={`fw-float absolute bottom-full z-40 mb-2 flex max-h-[420px] w-[440px] flex-col overflow-hidden rounded-[20px] ${
						align === "end" ? "right-0" : "left-0"
					}`}
				>
					{searchable && (
						<div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
							<Icon name="search" className="size-3.5 shrink-0 text-faint" />
							<input
								// biome-ignore lint/a11y/noAutofocus: 展开即输入是这类选择器的预期行为
								autoFocus
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
									setActive(0);
								}}
								placeholder={searchPlaceholder}
								spellCheck={false}
								className="w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-muted/70"
							/>
							<span className="shrink-0 text-[11.5px] tabular-nums text-faint">{filtered.length}</span>
						</div>
					)}

					<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
						{shown.map((item, i) => {
							const first = i === 0 || shown[i - 1]?.group !== item.group;
							const selected = item.value === value;
							return (
								<div key={item.value}>
									{item.group && first && <div className="px-2.5 pt-2.5 pb-1 text-[11.5px] font-semibold text-faint">{item.group}</div>}
									<button
										type="button"
										data-index={i}
										onMouseEnter={() => setActive(i)}
										onClick={() => pick(item.value)}
										className={`flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-left ${
											selected ? "bg-primary-soft" : i === active ? "bg-panel-2" : ""
										}`}
									>
										<span className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${selected ? "text-primary" : "text-fg"}`}>
											{item.title}
										</span>
										{item.badge && (
											<span className="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-[11px] text-muted">{item.badge}</span>
										)}
										{selected && <Icon name="check" className="size-3.5 shrink-0 text-primary" />}
									</button>
								</div>
							);
						})}
						{shown.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-muted">{emptyText}</div>}
						{filtered.length > shown.length && (
							<div className="px-2.5 py-2 text-center text-[11.5px] text-faint">
								共 {filtered.length} 项，继续输入以缩小范围
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
