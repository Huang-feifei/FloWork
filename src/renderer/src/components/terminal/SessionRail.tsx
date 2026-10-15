/**
 * 会话树窄轨：贴在会话区右缘的一条竖轨，每个可见树节点一个短横条。
 * 当前分支高亮、当前节点加粗；悬停弹出卡片，可回溯 / 分叉 / 打标签。
 * 它是右侧面板「会话树」标签的替代形态，不再占用面板宽度。
 */
import { useEffect, useMemo, useRef, useState } from "react";
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

export function SessionRail() {
	const tree = useApp((s) => s.tree);
	const leafId = useApp((s) => s.leafId);
	const isRunning = useApp((s) => s.isRunning);
	const visible = useApp((s) => s.railVisible);
	const { navigateTo, forkFrom, setLabel } = useApp.getState();

	const rows = useMemo(() => flattenTree(tree), [tree]);
	const onPath = useMemo(() => activePath(tree, leafId), [tree, leafId]);
	// 当前位置：leaf 本身可能是隐藏条目，取当前分支上最后一个可见行
	const currentId = useMemo(() => [...rows].reverse().find((r) => onPath.has(r.node.id))?.node.id ?? null, [rows, onPath]);

	const wrapRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const barRefs = useRef(new Map<string, HTMLButtonElement>());
	const closeTimer = useRef<number | null>(null);
	const [hover, setHover] = useState<{ id: string; top: number } | null>(null);

	// 当前位置始终留在可视区内（节点多时轨道内部滚动）
	useEffect(() => {
		const box = scrollRef.current;
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
		const y = bar.offsetTop - (scrollRef.current?.scrollTop ?? 0);
		const height = wrapRef.current?.clientHeight ?? 0;
		setHover({ id, top: Math.max(4, Math.min(y - 44, Math.max(4, height - 208))) });
	};

	if (!visible || rows.length === 0) return null;

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
				ref={scrollRef}
				className="fw-rail relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2"
				onScroll={scheduleClose}
			>
				{rows.map((row) => {
					const active = onPath.has(row.node.id);
					const current = row.node.id === currentId;
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
								className={`rounded-full ${current ? "bg-accent-strong" : active ? "bg-accent" : "bg-border-strong"}`}
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
