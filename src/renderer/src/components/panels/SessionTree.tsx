/**
 * 会话树：pi 的会话是一棵条目树，回到旧节点继续对话会产生分支。
 * 线性链不缩进，只在分叉点缩进（与 pi 的 /tree 一致）；高亮当前分支。
 */
import { useMemo } from "react";
import type { SessionTreeNode } from "@shared/protocol";
import { useApp } from "../../store";
import { askText } from "../PromptDialog";

interface Row {
	node: SessionTreeNode;
	depth: number;
	/** 分叉点的子分支起点 */
	branchStart: boolean;
}

/** 在树中只显示用户与助手消息，其他条目（工具结果、模型切换等）透明穿过 */
function isVisible(node: SessionTreeNode): boolean {
	if (node.entryType === "branch_summary" || node.entryType === "compaction") return true;
	return node.entryType === "message" && (node.role === "user" || node.role === "assistant") && node.preview.trim() !== "";
}

/** 把隐藏节点“压平”：返回某节点之下第一层可见的后代 */
function visibleChildren(node: SessionTreeNode): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const child of node.children) {
		if (isVisible(child)) out.push(child);
		else out.push(...visibleChildren(child));
	}
	return out;
}

function flatten(roots: SessionTreeNode[]): Row[] {
	const rows: Row[] = [];
	const walk = (nodes: SessionTreeNode[], depth: number) => {
		const branching = nodes.length > 1;
		for (const start of nodes) {
			let node: SessionTreeNode | undefined = start;
			let first = true;
			while (node) {
				rows.push({ node, depth: branching ? depth + 1 : depth, branchStart: branching && first });
				first = false;
				const next = visibleChildren(node);
				if (next.length === 1) node = next[0];
				else {
					if (next.length > 1) walk(next, branching ? depth + 1 : depth);
					node = undefined;
				}
			}
		}
	};
	const top: SessionTreeNode[] = [];
	for (const root of roots) {
		if (isVisible(root)) top.push(root);
		else top.push(...visibleChildren(root));
	}
	walk(top, 0);
	return rows;
}

/** 当前分支上的所有条目 id（从 leaf 向上） */
function activePath(roots: SessionTreeNode[], leafId: string | null): Set<string> {
	const parent = new Map<string, string | null>();
	const visit = (nodes: SessionTreeNode[]) => {
		for (const n of nodes) {
			parent.set(n.id, n.parentId);
			visit(n.children);
		}
	};
	visit(roots);
	const path = new Set<string>();
	let id = leafId;
	while (id) {
		path.add(id);
		id = parent.get(id) ?? null;
	}
	return path;
}

export function SessionTree() {
	const tree = useApp((s) => s.tree);
	const leafId = useApp((s) => s.leafId);
	const isRunning = useApp((s) => s.isRunning);
	const { navigateTo, forkFrom, setLabel } = useApp.getState();

	const rows = useMemo(() => flatten(tree), [tree]);
	const onPath = useMemo(() => activePath(tree, leafId), [tree, leafId]);
	// 当前位置：leaf 本身可能是隐藏条目，取当前分支上最后一个可见行
	const currentId = useMemo(() => [...rows].reverse().find((r) => onPath.has(r.node.id))?.node.id, [rows, onPath]);
	const branchCount = useMemo(() => rows.filter((r) => r.branchStart).length, [rows]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-b border-border px-3 py-1.5 text-[11px] text-muted">
				{branchCount > 0 ? `${branchCount} 个分支` : "当前没有分支"}
			</div>
			<div className="term min-h-0 flex-1 overflow-y-auto py-2 text-[12px] leading-5">
				{rows.length === 0 && <div className="px-3 text-muted">还没有消息</div>}
				{rows.map(({ node, depth, branchStart }) => {
					const active = onPath.has(node.id);
					const current = node.id === currentId;
					const isUser = node.role === "user";
					return (
						<div
							key={node.id}
							className={`group relative flex items-start gap-1.5 py-0.5 pr-2 ${current ? "bg-accent-soft" : "hover:bg-panel-2"}`}
							style={{ paddingLeft: 10 + depth * 14 }}
						>
							<span className={`shrink-0 ${active ? "text-accent" : "text-border-strong"}`}>
								{branchStart ? "├" : isUser ? "❯" : node.entryType === "message" ? "●" : "※"}
							</span>
							<div className={`min-w-0 flex-1 ${active ? "" : "text-muted"}`}>
								<div className="truncate" title={node.preview}>
									{node.label && <span className="mr-1 rounded bg-info/10 px-1 text-info">{node.label}</span>}
									{node.entryType === "branch_summary" ? "分支摘要：" : ""}
									{node.preview || "（空）"}
								</div>
								{current && <div className="text-[11px] text-accent">← 当前位置</div>}
							</div>
							{!isRunning && (
								<div className="absolute top-0.5 right-1 hidden gap-1 bg-panel-2 pl-1 group-hover:flex">
									{!current && (
										<button
											type="button"
											onClick={() => void navigateTo(node.id)}
											title={isUser ? "回到这条消息之前，原文填回输入框，可修改后重新发送" : "从这条回复之后继续对话"}
											className="rounded px-1 text-accent hover:bg-accent-soft"
										>
											{isUser ? "重新编辑" : "回到这里"}
										</button>
									)}
									{isUser && (
										<button
											type="button"
											onClick={() => void forkFrom(node.id, "before")}
											title="复制这条消息之前的历史到一个新会话"
											className="rounded px-1 text-muted hover:bg-panel hover:text-fg"
										>
											分叉
										</button>
									)}
									<button
										type="button"
										onClick={async () => {
											const label = await askText({ title: "节点标签", defaultValue: node.label ?? "", placeholder: "留空清除标签", allowEmpty: true });
											if (label !== null) void setLabel(node.id, label.trim());
										}}
										className="rounded px-1 text-muted hover:bg-panel hover:text-fg"
									>
										标签
									</button>
								</div>
							)}
						</div>
					);
				})}
			</div>
			<div className="border-t border-border px-3 py-2 text-[11px] leading-4 text-muted">
				回到旧节点后继续发送会形成新分支，原来的分支保留在树中。
			</div>
		</div>
	);
}
