/** 发现项目：列出 FloWork 与 pi 命令行已有会话涉及、但还没导入的目录 */
import { useEffect, useState } from "react";
import type { DiscoveredProject } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { relativeTime } from "../../lib/format";
import { useApp } from "../../store";
import { Badge, Button, Modal } from "../ui";

export function DiscoverDialog() {
	const open = useApp((s) => s.discoverOpen);
	const { setDiscoverOpen, addProjects } = useApp.getState();
	const [items, setItems] = useState<DiscoveredProject[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	useEffect(() => {
		if (!open) return;
		setItems(null);
		setError(null);
		api.projects.discover().then(
			(list) => {
				setItems(list);
				setSelected(new Set(list.filter((d) => d.exists).map((d) => d.path)));
			},
			(e: unknown) => setError(errorText(e)),
		);
	}, [open]);

	if (!open) return null;

	const toggle = (path: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});

	return (
		<Modal
			title="发现项目"
			onClose={() => setDiscoverOpen(false)}
			width="w-[640px]"
			footer={
				<>
					<Button onClick={() => setDiscoverOpen(false)}>取消</Button>
					<Button
						variant="primary"
						disabled={selected.size === 0}
						onClick={() => {
							setDiscoverOpen(false);
							void addProjects([...selected], false);
						}}
					>
						导入所选（{selected.size}）
					</Button>
				</>
			}
		>
			<div className="mb-3 text-[12px] leading-5 text-muted">
				以下目录在 FloWork 或 pi 命令行（~/.pi/agent/sessions）中有会话记录，但还没有导入为项目。导入后可以在侧边栏直接打开这些会话。
			</div>
			{error && <div className="rounded border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</div>}
			{!items && !error && <div className="py-6 text-center text-muted">正在扫描会话记录…</div>}
			{items?.length === 0 && <div className="py-6 text-center text-muted">没有发现新的项目</div>}
			<div className="space-y-1">
				{items?.map((d) => (
					<label
						key={d.path}
						className={`flex items-center gap-3 rounded-md border border-border px-3 py-2 ${d.exists ? "hover:bg-panel-2" : "opacity-50"}`}
					>
						<input type="checkbox" disabled={!d.exists} checked={selected.has(d.path)} onChange={() => toggle(d.path)} />
						<div className="min-w-0 flex-1">
							<div className="truncate text-[13px] font-medium">{d.path.split(/[\\/]/).filter(Boolean).pop()}</div>
							<div className="truncate font-mono text-[11px] text-muted">{d.path}</div>
						</div>
						<div className="shrink-0 text-right text-[11px] text-muted">
							<div>
								{d.sessionCount} 个会话 · {relativeTime(d.lastModified)}
							</div>
							<div className="mt-0.5 flex justify-end gap-1">
								{d.sources.includes("flowork") && <Badge>FloWork</Badge>}
								{d.sources.includes("pi-cli") && <Badge tone="accent">pi CLI</Badge>}
								{!d.exists && <Badge tone="err">文件夹不存在</Badge>}
							</div>
						</div>
					</label>
				))}
			</div>
		</Modal>
	);
}
