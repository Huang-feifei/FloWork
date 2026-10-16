/** 网页版的文件夹选择器（桌面版使用系统对话框），支持一次选择多个文件夹导入为项目。
 *  Apple 体系：白卡片列表 + 内缩圆角行，多选改用开关（toggles over checkboxes），根目录是灰色胶囊。 */
import { useEffect, useRef, useState } from "react";
import type { DirListing } from "@shared/protocol";
import { api, errorText } from "../api/client";
import { useApp } from "../store";
import { Icon } from "./Icon";
import { Badge, Button, Input, Modal, Toggle } from "./ui";

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
					<span className="mr-auto self-center text-[12.5px] text-muted">
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
					className="font-mono"
				/>
				<Button onClick={() => void load(pathInput)}>前往</Button>
			</div>

			{listing && (
				<div className="mb-3 flex flex-wrap items-center gap-1.5">
					{listing.roots.map((r) => (
						<Button key={r} size="sm" variant="default" onClick={() => void load(r)}>
							{r}
						</Button>
					))}
					<Button size="sm" variant="default" onClick={() => void load(listing.home)}>
						主目录
					</Button>
				</div>
			)}

			{error && <div className="mb-3 rounded-xl bg-err-soft px-3.5 py-2 text-[12.5px] text-err">{error}</div>}

			<div className="h-72 overflow-y-auto rounded-2xl border border-border bg-surface-raised p-1.5">
				{listing?.parent && (
					<button
						type="button"
						onClick={() => void load(listing.parent ?? undefined)}
						className="flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[13px] text-muted hover:bg-panel-2"
					>
						<Icon name="arrow-left" className="size-4" />
						上一级
					</button>
				)}
				{listing?.entries.map((entry) => {
					const done = isImported(entry.path);
					return (
						<div key={entry.path} className="flex h-10 items-center gap-2.5 rounded-[10px] px-2.5 hover:bg-panel-2">
							<span className={done ? "pointer-events-none opacity-40" : ""}>
								<Toggle
									on={done || selected.includes(entry.path)}
									onChange={() => toggle(entry.path)}
									title={done ? "已导入" : "选择"}
								/>
							</span>
							<button
								type="button"
								onClick={() => void load(entry.path)}
								onDoubleClick={() => !done && void addProjects([entry.path])}
								className="flex min-w-0 flex-1 items-center gap-2 truncate text-left text-[13.5px] text-fg"
							>
								<Icon name="folder" className="size-4 shrink-0 text-muted" />
								<span className="truncate">{entry.name}</span>
							</button>
							{done && <Badge tone="ok">已导入</Badge>}
						</div>
					);
				})}
				{listing && listing.entries.length === 0 && (
					<div className="px-2.5 py-3 text-[12.5px] text-muted">没有子文件夹</div>
				)}
			</div>

			{selected.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-1.5">
					{selected.map((p) => (
						<button
							type="button"
							key={p}
							onClick={() => toggle(p)}
							title="点击移除"
							className="flex items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-0.5 text-[11.5px] text-primary"
						>
							{p.split(/[\\/]/).pop()}
							<Icon name="x" className="size-3" />
						</button>
					))}
				</div>
			)}
			<div className="mt-3 text-[12px] leading-5 text-faint">单击文件夹名进入，开关选择；双击直接导入并打开。</div>
		</Modal>
	);
}
