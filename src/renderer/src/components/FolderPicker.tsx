/** 网页版的文件夹选择器（桌面版使用系统对话框） */
import { useEffect, useRef, useState } from "react";
import type { DirListing } from "@shared/protocol";
import { api, errorText } from "../api/client";
import { getRecentCwds } from "../lib/recent";
import { useApp } from "../store";
import { Button, Input, Modal } from "./ui";

export function FolderPicker() {
	const open = useApp((s) => s.folderPickerOpen);
	const current = useApp((s) => s.cwd);
	const { closeFolderPicker, selectWorkspace } = useApp.getState();
	const [listing, setListing] = useState<DirListing | null>(null);
	const [pathInput, setPathInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const recent = getRecentCwds();
	// 只采用最后一次请求的结果，避免较慢的旧请求覆盖新路径
	const requestSeq = useRef(0);

	const load = async (path?: string) => {
		const seq = ++requestSeq.current;
		try {
			const result = await api.listDirs(path);
			if (seq !== requestSeq.current) return;
			setListing(result);
			setPathInput(result.path);
			setError(null);
		} catch (e) {
			if (seq === requestSeq.current) setError(errorText(e));
		}
	};

	useEffect(() => {
		if (open) void load(current ?? undefined);
	}, [open, current]);

	if (!open) return null;

	const choose = (path: string) => {
		void selectWorkspace(path);
	};

	return (
		<Modal
			title="选择工作区文件夹"
			onClose={closeFolderPicker}
			width="w-[640px]"
			footer={
				<>
					<Button onClick={closeFolderPicker}>取消</Button>
					<Button variant="primary" disabled={!listing} onClick={() => listing && choose(listing.path)}>
						选择此文件夹
					</Button>
				</>
			}
		>
			<div className="mb-3 flex gap-2">
				<Input
					value={pathInput}
					onChange={(e) => setPathInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && void load(pathInput)}
					placeholder="输入路径后回车"
				/>
				<Button onClick={() => void load(pathInput)}>前往</Button>
			</div>

			{recent.length > 0 && (
				<div className="mb-3">
					<div className="mb-1 text-xs text-muted">最近使用</div>
					<div className="flex flex-wrap gap-1.5">
						{recent.map((p) => (
							<Button key={p} size="sm" onClick={() => choose(p)} title={p}>
								{p.length > 48 ? `…${p.slice(-46)}` : p}
							</Button>
						))}
					</div>
				</div>
			)}

			{listing && (
				<div className="mb-2 flex flex-wrap gap-1.5">
					{listing.roots.map((r) => (
						<Button key={r} size="sm" variant="ghost" onClick={() => void load(r)}>
							{r}
						</Button>
					))}
					<Button size="sm" variant="ghost" onClick={() => void load(listing.home)}>
						主目录
					</Button>
				</div>
			)}

			{error && <div className="mb-2 rounded border border-err/40 bg-err/10 px-2 py-1 text-xs text-err">{error}</div>}

			<div className="h-72 overflow-y-auto rounded-md border border-border bg-bg">
				{listing?.parent && (
					<button
						type="button"
						onClick={() => void load(listing.parent ?? undefined)}
						className="block w-full px-3 py-1.5 text-left text-sm text-muted hover:bg-panel-2"
					>
						.. 上一级
					</button>
				)}
				{listing?.entries.map((entry) => (
					<button
						type="button"
						key={entry.path}
						onClick={() => void load(entry.path)}
						onDoubleClick={() => choose(entry.path)}
						className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-panel-2"
					>
						📁 {entry.name}
					</button>
				))}
				{listing && listing.entries.length === 0 && <div className="px-3 py-2 text-xs text-muted">没有子文件夹</div>}
			</div>
			<div className="mt-2 text-[11px] text-muted">单击进入文件夹，双击直接选择。</div>
		</Modal>
	);
}
