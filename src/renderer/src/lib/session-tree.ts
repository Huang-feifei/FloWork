/**
 * 会话树的纯计算：pi 的会话是一棵条目树，回到旧节点继续对话会产生分支。
 * 窄轨（SessionRail）用它把树压平成「一行一个可见节点」的序列：
 * 线性链不缩进，只在分叉点缩进（与 pi 的 /tree 一致）。
 */
import type { SessionTreeNode } from "@shared/protocol";

export interface TreeRow {
	node: SessionTreeNode;
	/** 分叉产生的缩进层级 */
	depth: number;
	/** 该行是某个分叉的子分支起点 */
	branchStart: boolean;
}

/** 在树中只显示用户与助手消息，其他条目（工具结果、模型切换等）透明穿过 */
export function isVisible(node: SessionTreeNode): boolean {
	if (node.entryType === "branch_summary" || node.entryType === "compaction") return true;
	return node.entryType === "message" && (node.role === "user" || node.role === "assistant") && node.preview.trim() !== "";
}

/** 把隐藏节点“压平”：返回某节点之下第一层可见的后代 */
export function visibleChildren(node: SessionTreeNode): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const child of node.children) {
		if (isVisible(child)) out.push(child);
		else out.push(...visibleChildren(child));
	}
	return out;
}

export function flattenTree(roots: SessionTreeNode[]): TreeRow[] {
	const rows: TreeRow[] = [];
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
export function activePath(roots: SessionTreeNode[], leafId: string | null): Set<string> {
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
