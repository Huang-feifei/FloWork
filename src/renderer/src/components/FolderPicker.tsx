/** 网页版的文件夹选择器（桌面版使用系统对话框），支持一次选择多个文件夹导入为项目 */
import { useEffect, useRef, useState } from "react";
import type { DirListing } from "@shared/protocol";
import { api, errorText } from "../api/client";
import { useApp } from "../store";
import { Button, Input, Modal } from "./ui";

export function FolderPicker() {
	const open = useApp((s) => s.folderPicker.open);
	const current = useApp((s) => s.cwd);
	const projects = useApp((s) => s.projects.projects);
	const { closeFolderPicker, addProjects } = useApp.getState();
	const [listing, setListing] = useState<DirListing | null>(null);
	const [pathInput, setPathInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	// 只采用最后一次请求的结果，避免较慢的旧请求覆盖新路径
	const requestSeq = useRef(0);

	const imported = new Set(projects.map((p) => p.path.toLowerCase()));

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
		if (open) {
			setSelected([]);
			void load(current ? current.replace(/[\\/][^\\/]+[\\/]?$/, "") : undefined);
		}
	}, [open, current]);

	if (!open) return null;

	const toggle = (path: string) =>
		setSelected((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));

	const isImported = (path: string) => imported.has(path.toLowerCase());

	return (
		<Modal
			title="导入项目文件夹"
			onClose={closeFolderPicker}
			width="w-[680px]"
			footer={
				<>
					<span className="mr-auto self-center text-xs text-muted">
						{selected.length > 0 ? `已选 ${selected.length} 个` : "勾选文件夹，可一次导入多个"}
					</span>
					<Button onClick={closeFolderPicker}>取消</Button>
					<Button
						variant="primary"
						disabled={selected.length === 0 && !listing}
						onClick={() => void addProjects(selected.length > 0 ? selected : listing ? [listing.path] : [])}
					>
						{selected.length > 0 ? `导入所选（${selected.length}）` : "导入当前文件夹"}
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

			{listing && (
				<div className="mb-2 flex flex-wrap items-center gap-1.5">
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

			<div className="h-72 overflow-y-auto rounded-md border border-border bg-panel">
				{listing?.parent && (
					<button
						type="button"
						onClick={() => void load(listing.parent ?? undefined)}
						className="block w-full px-3 py-1.5 text-left text-sm text-muted hover:bg-panel-2"
					>
						.. 上一级
					</button>
				)}
				{listing?.entries.map((entry) => {
					const done = isImported(entry.path);
					return (
						<div key={entry.path} className="flex items-center gap-2 px-3 py-1 hover:bg-panel-2">
							<input
								type="checkbox"
								disabled={done}
								checked={done || selected.includes(entry.path)}
								onChange={() => toggle(entry.path)}
								title={done ? "已导入" : "选择"}
							/>
							<button
								type="button"
								onClick={() => void load(entry.path)}
								onDoubleClick={() => !done && void addProjects([entry.path])}
								className="min-w-0 flex-1 truncate text-left text-sm"
							>
								📁 {entry.name}
							</button>
							{done && <span className="text-[11px] text-muted">已导入</span>}
						</div>
					);
				})}
				{listing && listing.entries.length === 0 && <div className="px-3 py-2 text-xs text-muted">没有子文件夹</div>}
			</div>
			{selected.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1.5">
					{selected.map((p) => (
						<button
							type="button"
							key={p}
							onClick={() => toggle(p)}
							title="点击移除"
							className="rounded bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
						>
							{p.split(/[\\/]/).pop()} ✕
						</button>
					))}
				</div>
			)}
			<div className="mt-2 text-[11px] text-muted">单击文件夹名进入，勾选框选择；双击直接导入并打开。</div>
		</Modal>
	);
}
