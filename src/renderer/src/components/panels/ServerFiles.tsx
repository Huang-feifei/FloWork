/**
 * 服务器目录：浏览远程主机上的任意目录（不受项目根限制）。
 * 支持路径导航（上一级 / 输入跳转 / home）、上传本地文件（选择或拖拽）、下载到本地、
 * 新建 / 重命名 / 删除 / 移动，双击文件在会话区的预览面板里打开（可编辑）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerDirListing, WorkspaceEntry } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { askConfirm } from "../ConfirmDialog";
import { Icon } from "../Icon";
import { askText } from "../PromptDialog";
import { Menu, type MenuItem } from "../sidebar/Menu";

/** 单文件传输上限，与后端 SERVER_TRANSFER_LIMIT 保持一致 */
const TRANSFER_LIMIT = 32 * 1024 * 1024;

function formatSize(n: number | undefined): string {
	if (n === undefined) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 把本地文件读成 base64（去掉 data URL 前缀） */
function readAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("读取本地文件失败"));
		reader.onload = () => {
			const url = typeof reader.result === "string" ? reader.result : "";
			const comma = url.indexOf(",");
			if (comma < 0) {
				reject(new Error("无法解析文件内容"));
				return;
			}
			resolve(url.slice(comma + 1));
		};
		reader.readAsDataURL(file);
	});
}

function parentOf(path: string): string {
	const cut = path.replace(/\/+$/, "").lastIndexOf("/");
	return cut <= 0 ? "/" : path.slice(0, cut);
}

export function ServerFiles() {
	const hostId = useApp((s) => s.projects.projects.find((p) => p.id === s.activeProjectId)?.hostId ?? null);
	const host = useApp((s) => s.hosts.find((h) => h.id === hostId));
	const projectCwd = useApp((s) => s.cwd);
	const { openPreview, pushNotice } = useApp.getState();

	const [listing, setListing] = useState<ServerDirListing | null>(null);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry | null } | null>(null);
	const [uploading, setUploading] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	const load = useCallback(
		async (target: string) => {
			if (!hostId) return;
			setBusy(true);
			try {
				const next = await api.server.list(hostId, target);
				setListing(next);
				setDraft(next.path);
				setError(null);
			} catch (e) {
				setError(errorText(e));
				// 读不到也要把路径显示出来，方便改一个可用的路径
				setDraft(target);
			} finally {
				setBusy(false);
			}
		},
		[hostId],
	);

	// 切换主机或项目时回到项目目录
	useEffect(() => {
		setListing(null);
		setError(null);
		setDraft(projectCwd ?? "/");
		if (hostId && projectCwd) void load(projectCwd);
	}, [hostId, projectCwd, load]);

	const current = listing?.path ?? projectCwd ?? "/";

	const uploadFiles = async (files: File[]) => {
		if (!hostId || files.length === 0) return;
		const dir = current;
		let done = 0;
		for (const file of files) {
			if (file.size > TRANSFER_LIMIT) {
				pushNotice("warning", `${file.name} 超过 ${TRANSFER_LIMIT / 1024 / 1024} MB，已跳过`);
				continue;
			}
			setUploading(`${file.name}（${done + 1}/${files.length}）`);
			try {
				await api.server.upload(hostId, dir, file.name, await readAsBase64(file));
				done += 1;
			} catch (e) {
				pushNotice("error", `上传 ${file.name} 失败：${errorText(e)}`);
			}
		}
		setUploading(null);
		if (done > 0) pushNotice("info", `已上传 ${done} 个文件到 ${dir}`);
		await load(dir);
	};

	const download = async (entry: WorkspaceEntry) => {
		if (!hostId) return;
		try {
			const target = await api.pickSavePath(entry.name);
			if (!target) return;
			const saved = await api.server.exportToLocal(hostId, entry.path, target);
			pushNotice("info", `已保存到 ${target}（${formatSize(saved.size)}）`);
		} catch (e) {
			pushNotice("error", `下载失败：${errorText(e)}`);
		}
	};

	const createEntry = async (type: "file" | "dir") => {
		if (!hostId) return;
		const name = (
			await askText({
				title: type === "file" ? "新建文件" : "新建文件夹",
				placeholder: type === "file" ? "文件名，例如 app.conf" : "文件夹名",
			})
		)?.trim();
		if (!name) return;
		try {
			await api.server.create(hostId, `${current}/${name}`, type);
			await load(current);
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const renameEntry = async (entry: WorkspaceEntry) => {
		if (!hostId) return;
		const name = (await askText({ title: "重命名", defaultValue: entry.name }))?.trim();
		if (!name || name === entry.name) return;
		try {
			await api.server.rename(hostId, entry.path, name);
			await load(current);
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const removeEntry = async (entry: WorkspaceEntry) => {
		if (!hostId) return;
		const ok = await askConfirm({
			title: `删除${entry.type === "dir" ? "文件夹" : "文件"}`,
			message: `确定永久删除 ${entry.path}？服务器上没有回收站，无法恢复${entry.type === "dir" ? "，目录内容会一并删除" : ""}。`,
			confirmLabel: "永久删除",
			danger: true,
		});
		if (!ok) return;
		try {
			await api.server.remove(hostId, entry.path);
			await load(current);
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const moveEntry = async (entry: WorkspaceEntry) => {
		if (!hostId) return;
		const target = (
			await askText({
				title: "移动到目录（服务器绝对路径）",
				defaultValue: parentOf(entry.path),
				placeholder: "/etc/nginx",
			})
		)?.trim();
		if (!target) return;
		try {
			await api.server.move(hostId, entry.path, target);
			await load(current);
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const goHome = async () => {
		if (!hostId) return;
		try {
			const home = await api.hosts.listDirs(hostId);
			await load(home.home);
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const openEntry = (entry: WorkspaceEntry) => {
		if (entry.type === "dir") void load(entry.path);
		else if (hostId) openPreview(entry.path, hostId);
	};

	if (!hostId) {
		return <div className="px-3 py-3 text-[12.5px] text-muted">当前项目不是远程项目，没有服务器目录。</div>;
	}

	const menuItems: MenuItem[] = (() => {
		const entry = menu?.entry ?? null;
		const items: MenuItem[] = [];
		if (entry) {
			items.push({ label: "打开", onClick: () => openEntry(entry) });
			if (entry.type === "file") items.push({ label: "下载到本地…", onClick: () => void download(entry) });
			items.push({ separator: true, label: "" });
			items.push({ label: "重命名…", onClick: () => void renameEntry(entry) });
			items.push({ label: "移动到…", onClick: () => void moveEntry(entry) });
			items.push({ label: "复制绝对路径", onClick: () => void navigator.clipboard.writeText(entry.path) });
			items.push({ label: "删除", danger: true, onClick: () => void removeEntry(entry) });
			return items;
		}
		items.push({ label: "上传文件到此处…", onClick: () => fileInput.current?.click() });
		items.push({ label: "新建文件…", onClick: () => void createEntry("file") });
		items.push({ label: "新建文件夹…", onClick: () => void createEntry("dir") });
		items.push({ separator: true, label: "" });
		items.push({ label: "刷新", onClick: () => void load(current) });
		return items;
	})();

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* 路径栏 */}
			<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
				<button
					type="button"
					title="返回上一级"
					disabled={!listing?.parent}
					onClick={() => listing?.parent && void load(listing.parent)}
					className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
				>
					<Icon name="arrow-up" className="size-4" />
				</button>
				<button
					type="button"
					title="回到 home"
					onClick={() => void goHome()}
					className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-fg"
				>
					<Icon name="server" className="size-4" />
				</button>
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void load(draft.trim() || "/");
						if (e.key === "Escape") setDraft(current);
					}}
					spellCheck={false}
					className="term min-w-0 flex-1 rounded-full bg-panel-2 px-3 py-1.5 text-[11.5px] outline-none focus:ring-4 focus:ring-primary/10"
				/>
				<button
					type="button"
					title="刷新"
					onClick={() => void load(current)}
					className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-fg"
				>
					<Icon name="refresh" className="size-4" />
				</button>
			</div>

			{/* 主机与上传状态 */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[11.5px] text-muted">
				<span className="truncate">{host ? host.name || `${host.user ? `${host.user}@` : ""}${host.host}` : "远程主机"}</span>
				<div className="flex-1" />
				{uploading ? (
					<span className="truncate text-primary">上传中：{uploading}</span>
				) : busy ? (
					<span>读取中…</span>
				) : (
					<span>{listing?.entries.length ?? 0} 项</span>
				)}
			</div>

			{/* 列表（支持拖拽上传） */}
			<div
				onDragOver={(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragOver(false);
					void uploadFiles([...e.dataTransfer.files]);
				}}
				onContextMenu={(e) => {
					if (e.target === e.currentTarget) {
						e.preventDefault();
						setMenu({ x: e.clientX, y: e.clientY, entry: null });
					}
				}}
				className={`min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 text-[12.5px] leading-6 ${dragOver ? "bg-primary-soft" : ""}`}
			>
				{error && <div className="px-3 py-2 text-err">{error}</div>}
				{!error && listing && listing.entries.length === 0 && <div className="px-3 py-2 text-muted">这个目录是空的</div>}
				{listing?.entries.map((entry) => (
					<div
						key={entry.path}
						onClick={() => setMenu(null)}
						onDoubleClick={() => openEntry(entry)}
						onContextMenu={(e) => {
							e.preventDefault();
							setMenu({ x: e.clientX, y: e.clientY, entry });
						}}
						title={entry.path}
						className={`group flex h-8 cursor-default items-center gap-2 rounded-[10px] px-2 hover:bg-panel-2 ${entry.ignored ? "text-muted/70" : "text-fg/85"}`}
					>
						<Icon
							name={entry.type === "dir" ? "folder" : "file-code"}
							className={`size-4 shrink-0 ${entry.type === "dir" ? "text-muted" : "text-faint"}`}
						/>
						<span className="min-w-0 flex-1 truncate">{entry.name}</span>
						{entry.type === "file" && <span className="shrink-0 text-[11px] text-faint">{formatSize(entry.size)}</span>}
					</div>
				))}
			</div>

			{/* 底部操作条 */}
			<div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2.5 text-[12.5px]">
				<input
					ref={fileInput}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => {
						void uploadFiles([...(e.target.files ?? [])]);
						e.target.value = "";
					}}
				/>
				<button
					type="button"
					onClick={() => fileInput.current?.click()}
					className="flex h-8 items-center rounded-full bg-panel-2 px-3.5 hover:bg-highlight"
				>
					上传文件
				</button>
				<button
					type="button"
					onClick={() => void createEntry("dir")}
					className="flex h-8 items-center rounded-full px-3.5 text-muted hover:bg-panel-2 hover:text-fg"
				>
					新建文件夹
				</button>
				<div className="flex-1" />
				<span className="truncate text-[11.5px] text-faint">双击打开 · 右键更多 · 可拖入文件</span>
			</div>

			{menu && <Menu items={menuItems} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
		</div>
	);
}
