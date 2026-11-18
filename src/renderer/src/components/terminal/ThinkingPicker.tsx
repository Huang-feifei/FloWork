import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { THINKING_LEVELS, type ModelInfo, type SessionState, type ThinkingLevel } from "@shared/protocol";
import { thinkingLabel } from "../../lib/format";
import { Icon } from "../Icon";

const MAX_ROWS = 200;
const PANEL_HEIGHT = 410;
const FAVORITES_KEY = "flowork.favoriteModels";
const GUIDE: Record<ThinkingLevel, [string, string]> = {
	off: ["直接回答", "不启用额外推理，适合改写、翻译和简单问答。"],
	minimal: ["最少推理", "适合明确、短小的任务，例如调整格式。"],
	low: ["轻量推理", "适合单文件改动、短问答和小范围排查。"],
	medium: ["日常推理", "适合日常编码、理解代码和常规问题排查。"],
	high: ["深入推理", "适合跨文件改动、复杂排查，或比较几种实现方案。"],
	xhigh: ["高强度推理", "适合需要多步推导、同时处理多个约束的任务。"],
	max: ["最大推理", "适合需要深入分析和反复核对的任务，通常耗时更长。"],
};
const modelKey = (model: ModelInfo) => `${model.provider}/${model.id}`;

function readFavorites(): string[] {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
		return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : [];
	} catch {
		return [];
	}
}

export function ModelThinkingPicker({ state, models, onModel, onThinking, onRefresh }: {
	state: SessionState;
	models: readonly ModelInfo[];
	onModel: (model: ModelInfo) => Promise<void>;
	onThinking: (level: ThinkingLevel) => Promise<void>;
	onRefresh: () => Promise<void>;
}) {
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const busy = useRef(false);
	const panelId = useId();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [provider, setProvider] = useState("");
	const [onlyFavorites, setOnlyFavorites] = useState(false);
	const [favorites, setFavorites] = useState(readFavorites);
	const [pending, setPending] = useState<"model" | "thinking" | "refresh" | null>(null);
	const [height, setHeight] = useState(PANEL_HEIGHT);
	const active = state.model;
	const current = active ? modelKey(active) : "";
	const levels = THINKING_LEVELS.filter((level) => state.availableThinkingLevels.includes(level));
	const adjustable = levels.length > 1;
	const guide = GUIDE[state.thinkingLevel] ?? GUIDE.off;
	const groups = useMemo(() => {
		const map = new Map<string, ModelInfo[]>();
		for (const model of models) {
			const group = map.get(model.provider);
			if (group) group.push(model);
			else map.set(model.provider, [model]);
		}
		return map;
	}, [models]);
	const filtered = useMemo(() => {
		if (!open) return { rows: [], count: 0 };
		const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const saved = new Set(favorites);
		let remaining = MAX_ROWS;
		let count = 0;
		const rows: Array<[string, ModelInfo[]]> = [];
		for (const [name, items] of groups) {
			if (provider && provider !== name && groups.has(provider)) continue;
			const matching = items.filter((model) => (!onlyFavorites || saved.has(modelKey(model))) && terms.every((term) => `${name} ${model.name} ${model.id}`.toLowerCase().includes(term)));
			count += matching.length;
			if (matching.length && remaining > 0) {
				const visible = matching.slice(0, remaining);
				rows.push([name, visible]);
				remaining -= visible.length;
			}
		}
		return { rows, count };
	}, [open, groups, provider, onlyFavorites, favorites, query]);

	function toggleFavorite(model: ModelInfo) {
		const key = modelKey(model);
		const next = favorites.includes(key) ? favorites.filter((item) => item !== key) : [...favorites, key];
		setFavorites(next);
		try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch { /* 存储不可用时，仅在当前窗口保留。 */ }
	}

	function dismiss(restore = false) {
		setOpen(false);
		if (restore) trigger.current?.focus();
	}

	function show() {
		setQuery("");
		setProvider("");
		setOnlyFavorites(false);
		setOpen(true);
	}

	useLayoutEffect(() => {
		if (!open) return;
		const toolbar = root.current?.closest(".fw-composer-tools");
		const measure = () => setHeight(Math.max(110, Math.min(PANEL_HEIGHT, (toolbar?.getBoundingClientRect().top ?? PANEL_HEIGHT + 16) - 16)));
		measure();
		search.current?.focus({ preventScroll: true });
		const observer = new ResizeObserver(measure);
		const content = toolbar?.closest(".fw-workbench");
		if (content) observer.observe(content);
		if (toolbar?.parentElement) observer.observe(toolbar.parentElement);
		window.addEventListener("resize", measure);
		return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [open]);

	async function change(kind: "model" | "thinking" | "refresh", update: () => Promise<void>) {
		if (busy.current) return;
		busy.current = true;
		setPending(kind);
		try { await update(); } finally { busy.current = false; setPending(null); }
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (!open || event.nativeEvent.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			dismiss(true);
			return;
		}
		const target = event.target as HTMLElement;
		const fromSearch = target === search.current;
		const column = fromSearch ? "model" : target.dataset.choice;
		if (!column) return;
		const rows = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(`[data-choice="${column}"]`) ?? []);
		const index = rows.indexOf(target as HTMLButtonElement);
		if (!fromSearch && ((column === "model" && event.key === "ArrowRight") || (column === "thinking" && event.key === "ArrowLeft" && index === 0))) {
			const next = column === "model" ? "thinking" : "model";
			const row = root.current?.querySelector<HTMLElement>(`[data-choice="${next}"][aria-checked="true"]`) ?? root.current?.querySelector<HTMLElement>(`[data-choice="${next}"]`);
			if (row) { event.preventDefault(); row.focus(); }
			return;
		}
		if (!rows.length) return;
		if (fromSearch && event.key === "Enter") { event.preventDefault(); rows[0]?.click(); return; }
		const forward = event.key === "ArrowDown" || (column === "thinking" && event.key === "ArrowRight");
		const back = event.key === "ArrowUp" || (column === "thinking" && event.key === "ArrowLeft");
		const next = forward ? (index + 1) % rows.length : back ? (index <= 0 ? rows.length - 1 : index - 1)
			: !fromSearch && event.key === "Home" ? 0 : !fromSearch && event.key === "End" ? rows.length - 1 : -1;
		if (next >= 0) { event.preventDefault(); rows[next]?.focus(); }
	}

	return (
		<div ref={root} className="min-w-0" onKeyDown={onKeyDown} onBlur={(event) => {
			if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) dismiss();
		}}>
			<button ref={trigger} type="button" title="模型与推理" aria-label="模型与推理" aria-haspopup="dialog" aria-expanded={open}
				aria-controls={open ? panelId : undefined} className="fw-model-trigger" onClick={() => open ? dismiss(true) : show()}
				onKeyDown={(event) => { if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); show(); } }}>
				<Icon name="cpu" className="fw-model-trigger-icon size-3.5 shrink-0" />
				<span className="min-w-0 truncate" title={active?.id}>{active?.name || active?.id || "选择模型"}</span>
				{active && <span className="fw-model-trigger-level">{adjustable ? `推理 ${thinkingLabel(state.thinkingLevel)}` : "推理不可调"}</span>}
				<Icon name={open ? "chevron-up" : "chevron-down"} className="size-3.5 shrink-0" />
			</button>
			{open && (
				<section id={panelId} role="dialog" aria-labelledby={`${panelId}-name`} className="fw-model-panel" style={{ height }}>
					<header className="fw-model-header">
						<h2 id={`${panelId}-name`}>模型与推理</h2>
						<button type="button" className="fw-model-icon" title="关闭模型面板（Esc）" aria-label="关闭模型面板" onClick={() => dismiss(true)}><Icon name="x" className="size-4" /></button>
					</header>
					<div className="fw-model-columns">
						<div className="fw-model-catalog">
							<div className="fw-model-tools">
								<div className="fw-model-search">
									<Icon name="search" className="size-4 shrink-0" />
									<input ref={search} aria-label="搜索模型或供应商" placeholder="搜索模型或供应商" value={query} onChange={(event) => { setProvider(""); setQuery(event.target.value); }} spellCheck={false} />
								</div>
								<button type="button" title="刷新模型" aria-label="刷新模型" disabled={!!pending} className="fw-model-icon fw-model-refresh" onClick={() => void change("refresh", onRefresh)}><Icon name="refresh" className={`size-4 ${pending === "refresh" ? "animate-spin" : ""}`} /></button>
							</div>
							<div className="fw-model-filters" role="group" aria-label="模型筛选">
								<button type="button" className="fw-model-filter" aria-pressed={!onlyFavorites} onClick={() => setOnlyFavorites(false)}>全部</button>
								<button type="button" className="fw-model-filter fw-model-favorites" aria-pressed={onlyFavorites} onClick={() => { setOnlyFavorites(true); setProvider(""); }}><Icon name="star" className="size-3" /> 收藏</button>
								{groups.size > 1 && (
									<select aria-label="筛选供应商" className="fw-model-provider" value={groups.has(provider) ? provider : ""} onChange={(event) => setProvider(event.target.value)}>
										<option value="">所有供应商</option>
										{Array.from(groups.keys(), (name) => <option key={name} value={name}>{name}</option>)}
									</select>
								)}
							</div>
							<div role="radiogroup" aria-label="模型" className="fw-model-list fw-scroll">
								{filtered.rows.map(([name, items]) => (
									<div key={name} role="group" aria-label={name}>
										<p className="fw-model-label" title={name}>{name}</p>
										{items.map((model) => {
											const key = modelKey(model);
											const saved = favorites.includes(key);
											return (
												<div key={key} className="fw-model-entry">
													<button type="button" role="radio" data-choice="model" aria-checked={key === current} aria-disabled={!!pending} title={model.id} className="fw-model-row" onClick={() => { if (key !== current) void change("model", () => onModel(model)); }}>
														<span className="min-w-0 flex-1 truncate">{model.name || model.id}</span>
														{key === current && <Icon name="check" className="size-3.5 shrink-0" />}
													</button>
													<button type="button" className="fw-model-save fw-model-icon" aria-pressed={saved} aria-label={`${saved ? "取消收藏" : "收藏"} ${model.name || model.id}`} title={saved ? "取消收藏" : "收藏模型"} onClick={() => { if (onlyFavorites) search.current?.focus(); toggleFavorite(model); }}><Icon name="star" className="size-3.5" /></button>
												</div>
											);
										})}
									</div>
								))}
								{!filtered.count && <p className="fw-model-empty">{query || (provider && onlyFavorites) ? "没有找到匹配的模型。" : onlyFavorites ? "暂无收藏。点击模型旁的星标即可收藏。" : "当前没有可选模型。可在设置中添加端点。"}</p>}
								{filtered.count > MAX_ROWS && <p className="fw-model-empty">只显示前 {MAX_ROWS} 项，可用搜索缩小范围。</p>}
							</div>
						</div>
						<div className="fw-model-details fw-scroll" aria-busy={!!pending}>
							<p className="fw-model-current"><span aria-hidden="true" /> 当前模型</p>
							<h3 className="fw-model-name" title={active?.id}>{active?.name || active?.id || "尚未选择模型"}</h3>
							{active && <p className="fw-model-label" title={active.provider}>{active.provider}</p>}
							<div className="fw-model-reasoning">
								<h4 id={`${panelId}-reasoning`}>推理强度</h4>
								{pending === "model" ? <p role="status" className="fw-model-empty">正在切换模型…</p> : adjustable && active ? (
									<>
										<div className="fw-model-scale" role="radiogroup" aria-labelledby={`${panelId}-reasoning`} style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}>
											{levels.map((level, index) => (
												<button type="button" key={level} role="radio" data-choice="thinking" aria-label={`${thinkingLabel(level)} · ${GUIDE[level][0]}`} aria-checked={level === state.thinkingLevel} aria-disabled={!!pending} title={GUIDE[level][0]} className="fw-model-step" onClick={() => { if (level !== state.thinkingLevel) void change("thinking", () => onThinking(level)); }}>
													<span className="fw-model-step-track" aria-hidden="true"><span style={{ height: index ? 8 + index * 3 : 4 }} /></span>
													<span>{thinkingLabel(level)}</span>
												</button>
											))}
										</div>
										<div className="fw-model-guide" aria-live="polite"><strong>{guide[0]}</strong><p>{guide[1]}</p></div>
									</>
								) : <p className="fw-model-empty">{active ? "这个模型不提供可调档位。" : "选好模型后，可在这里查看可用档位。"}</p>}
							</div>
						</div>
					</div>
					<footer className="fw-model-footer">
						<span className="fw-model-hints"><kbd>↑↓</kbd> 浏览 <kbd>Enter</kbd> 选择</span>
						<span role="status">{pending === "thinking" ? "正在调整推理…" : pending === "refresh" ? "正在刷新模型…" : "仅调整当前会话"}</span>
					</footer>
				</section>
			)}
		</div>
	);
}
