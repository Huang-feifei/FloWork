/**
 * 会话树窄轨：贴在会话区右缘的一条竖轨，每个可见的**用户消息**一个短横条。
 * 只保留用户输入，助手回复与工具调用不占横条，轨道因此短得多、定位更快。
 * 横条分三档：屏幕上看得到的节点最亮，当前分支上但已滚出屏幕的淡亮，其他分支最暗；
 * 当前位置始终加粗。悬停弹出卡片，可回溯 / 分叉 / 打标签。
 * 它是右侧面板「会话树」标签的替代形态，不再占用面板宽度。
 */
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionTreeNode } from "@shared/protocol";
import { activePath, flattenTree, type TreeRow } from "../../lib/session-tree";
import { relativeTime } from "../../lib/format";
import { useApp } from "../../store";
import { askText } from "../PromptDialog";

/** 轨道宽、横条尺寸与节距（对照设计稿：条宽 20、条高 2、节距 8） */
const RAIL_W = 28;
const BAR_W = 20;
const PITCH = 8;
const BAR_LEFT = 3;
const INDENT = 2;
const MAX_INDENT = 3;
const CARD_W = 288;
const CARD_CLOSE_DELAY = 120;

function roleLabel(node: SessionTreeNode): string {
	if (node.entryType === "branch_summary") return "分支摘要";
	if (node.entryType === "compaction") return "上下文压缩";
	return node.role === "user" ? "用户" : "助手";
}

function markerOf(node: SessionTreeNode): string {
	if (node.entryType !== "message") return "※";
	return node.role === "user" ? "❯" : "●";
}

function timeOf(node: SessionTreeNode): string {
	const ms = Date.parse(node.timestamp);
	return Number.isFinite(ms) ? relativeTime(ms) : "";
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of b) if (!a.has(id)) return false;
	return true;
}

export function SessionRail({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
	const tree = useApp((s) => s.tree);
	const leafId = useApp((s) => s.leafId);
	const isRunning = useApp((s) => s.isRunning);
	const railVisible = useApp((s) => s.railVisible);
	const messageCount = useApp((s) => s.messages.length);
	const streaming = useApp((s) => s.streaming !== null);
	const { navigateTo, forkFrom, setLabel } = useApp.getState();

	const rows = useMemo(() => flattenTree(tree).filter((r) => r.node.entryType === "message" && r.node.role === "user"), [tree]);
	const onPath = useMemo(() => activePath(tree, leafId), [tree, leafId]);
	// 当前位置：leaf 本身可能是隐藏条目，取当前分支上最后一个可见行
	const currentId = useMemo(() => [...rows].reverse().find((r) => onPath.has(r.node.id))?.node.id ?? null, [rows, onPath]);

	const wrapRef = useRef<HTMLDivElement>(null);
	const scrollBoxRef = useRef<HTMLDivElement>(null);
	const barRefs = useRef(new Map<string, HTMLButtonElement>());
	const closeTimer = useRef<number | null>(null);
	const [hover, setHover] = useState<{ id: string; top: number } | null>(null);
	/** 当前屏幕上可见的消息所对应的条目 id */
	const [inView, setInView] = useState<ReadonlySet<string>>(() => new Set());

	/** 量一遍会话记录里哪些消息落在可视区内（消息元素带 data-entry-id） */
	const measure = useCallback(() => {
		const box = scrollRef.current;
		if (!box) return;
		const rect = box.getBoundingClientRect();
		const next = new Set<string>();
		for (const el of box.querySelectorAll<HTMLElement>("[data-entry-id]")) {
			const r = el.getBoundingClientRect();
			if (r.bottom > rect.top && r.top < rect.bottom) {
				const id = el.dataset.entryId;
				if (id) next.add(id);
			}
		}
		setInView((prev) => (sameSet(prev, next) ? prev : next));
	}, [scrollRef]);

	// 滚动 / 尺寸变化时重算可视范围（每帧最多一次）
	useEffect(() => {
		const box = scrollRef.current;
		if (!box || !railVisible || rows.length === 0) return;
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				measure();
			});
		};
		measure();
		box.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(schedule);
		observer.observe(box);
		return () => {
			box.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	}, [scrollRef, measure, railVisible, rows.length]);

	// 消息增减或流式内容变化后重新量一次
	useEffect(() => {
		if (railVisible && rows.length > 0) measure();
	}, [measure, messageCount, streaming, railVisible, rows.length]);

	// 当前位置始终留在可视区内（节点多时轨道内部滚动）
	useEffect(() => {
		const box = scrollBoxRef.current;
		const bar = currentId ? barRefs.current.get(currentId) : null;
		if (!box || !bar) return;
		const top = bar.offsetTop;
		if (top < box.scrollTop) box.scrollTop = Math.max(0, top - PITCH);
		else if (top + PITCH > box.scrollTop + box.clientHeight) box.scrollTop = top + PITCH - box.clientHeight;
	}, [currentId]);

	useEffect(() => () => {
		if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
	}, []);

	const cancelClose = () => {
		if (closeTimer.current === null) return;
		window.clearTimeout(closeTimer.current);
		closeTimer.current = null;
	};
	const scheduleClose = () => {
		cancelClose();
		closeTimer.current = window.setTimeout(() => setHover(null), CARD_CLOSE_DELAY);
	};

	const openCard = (id: string, bar: HTMLElement) => {
		cancelClose();
		const y = bar.offsetTop - (scrollBoxRef.current?.scrollTop ?? 0);
		const height = wrapRef.current?.clientHeight ?? 0;
		setHover({ id, top: Math.max(4, Math.min(y - 44, Math.max(4, height - 208))) });
	};

	if (!railVisible || rows.length === 0) return null;

	const hovered = hover ? (rows.find((r) => r.node.id === hover.id) ?? null) : null;
	const hoveredCurrent = hovered ? hovered.node.id === currentId : false;
	const hoveredUser = hovered?.node.role === "user";

	return (
		<div
			ref={wrapRef}
			className="relative flex shrink-0 flex-col border-l border-border"
			style={{ width: RAIL_W }}
		>
			<div
				ref={scrollBoxRef}
				className="fw-rail relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2"
				onScroll={scheduleClose}
			>
				{rows.map((row) => {
					const current = row.node.id === currentId;
					const active = onPath.has(row.node.id);
					const inViewport = inView.has(row.node.id);
					const depth = Math.min(row.depth, MAX_INDENT);
					return (
						<button
							type="button"
							key={row.node.id}
							ref={(el) => {
								if (el) barRefs.current.set(row.node.id, el);
								else barRefs.current.delete(row.node.id);
							}}
							onMouseEnter={(e) => openCard(row.node.id, e.currentTarget)}
							onMouseLeave={scheduleClose}
							onFocus={(e) => openCard(row.node.id, e.currentTarget)}
							onBlur={scheduleClose}
							onClick={() => {
								setHover(null);
								void navigateTo(row.node.id);
							}}
							aria-label={`${roleLabel(row.node)}：${row.node.preview || "（空）"}${current ? "（当前位置）" : ""}`}
							className="relative flex w-full items-center rounded-sm hover:bg-panel-2"
							style={{ height: PITCH }}
						>
							{row.branchStart && <span className="absolute left-px h-1.5 w-px bg-border-strong" />}
							<span
								className={`rounded-full ${
									current ? "bg-accent-strong" : inViewport ? "bg-accent" : active ? "bg-accent/40" : "bg-border-strong"
								}`}
								style={{
									marginLeft: BAR_LEFT + depth * INDENT,
									width: Math.max(6, BAR_W - depth * INDENT),
									height: current ? 3 : 2,
								}}
							/>
						</button>
					);
				})}
			</div>

			{hovered && hover && (
				<div
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
					className="fw-float absolute z-30 rounded-lg border border-border-strong p-3 text-[12px]"
					style={{ top: hover.top, right: RAIL_W + 4, width: CARD_W }}
				>
					<div className="mb-1 flex items-center gap-1.5 text-muted">
						<span className={hoveredCurrent ? "text-accent" : ""}>{markerOf(hovered.node)}</span>
						<span>{roleLabel(hovered.node)}</span>
						{hovered.node.label && <span className="rounded bg-info/10 px-1 text-info">{hovered.node.label}</span>}
						<div className="flex-1" />
						<span className="text-[11px] text-faint">{timeOf(hovered.node)}</span>
					</div>
					<div className="max-h-24 overflow-y-auto whitespace-pre-wrap text-fg/90">{hovered.node.preview || "（空）"}</div>
					{hoveredCurrent && <div className="mt-1 text-[11px] text-accent">← 当前位置</div>}
					<div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border pt-2">
						{!hoveredCurrent && (
							<button
								type="button"
								disabled={isRunning}
								onClick={() => {
									setHover(null);
									void navigateTo(hovered.node.id);
								}}
								title={hoveredUser ? "回到这条消息之前，原文填回输入框，可修改后重新发送" : "从这条回复之后继续对话"}
								className="rounded px-1.5 py-0.5 text-accent hover:bg-accent-soft disabled:opacity-40"
							>
								{hoveredUser ? "重新编辑" : "回到这里"}
							</button>
						)}
						{hoveredUser && (
							<button
								type="button"
								disabled={isRunning}
								onClick={() => {
									setHover(null);
									void forkFrom(hovered.node.id, "before");
								}}
								title="复制这条消息之前的历史到一个新会话"
								className="rounded px-1.5 py-0.5 text-muted hover:bg-panel hover:text-fg disabled:opacity-40"
							>
								分叉
							</button>
						)}
						<button
							type="button"
							onClick={async () => {
								const label = await askText({
									title: "节点标签",
									defaultValue: hovered.node.label ?? "",
									placeholder: "留空清除标签",
									allowEmpty: true,
								});
								if (label !== null) void setLabel(hovered.node.id, label.trim());
							}}
							className="rounded px-1.5 py-0.5 text-muted hover:bg-panel hover:text-fg"
						>
							标签
						</button>
						{isRunning && <span className="text-[11px] text-muted">运行中不可回溯</span>}
					</div>
				</div>
			)}
		</div>
	);
}
