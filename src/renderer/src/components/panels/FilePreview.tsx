/**
 * 文件查看与编辑：覆盖在终端窗口内（标题栏下方）。
 * - 内容：CodeMirror 显示，带语法高亮、行号、查找（Ctrl+F）；点“编辑”后可修改，Ctrl+S 保存
 * - 本会话的修改：AI 对该文件每次修改的 diff
 * 保存时附带打开时的 mtime，文件已被 AI 或外部修改时后端拒绝保存，避免覆盖。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { type FilePreview as Preview, WRITE_CONFLICT_PREFIX } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { collectSessionFiles } from "../../lib/session-files";
import { useApp } from "../../store";
import { askConfirm } from "../ConfirmDialog";

const CodeEditor = lazy(() => import("./CodeEditor"));

function DiffBlock({ diff }: { diff: string }) {
	return (
		<div className="overflow-x-auto rounded border border-border bg-panel">
			{diff.split("\n").map((line, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: diff 行没有稳定 id
					key={i}
					className={`px-2 whitespace-pre ${
						line[0] === "+" ? "bg-diff-add text-diff-add-fg" : line[0] === "-" ? "bg-diff-del text-diff-del-fg" : "text-muted"
					}`}
				>
					{line || " "}
				</div>
			))}
		</div>
	);
}

export function FilePreview() {
	const path = useApp((s) => s.preview);
	const cwd = useApp((s) => s.cwd);
	const messages = useApp((s) => s.messages);
	const filesVersion = useApp((s) => s.filesVersion);
	const { openPreview, insertIntoPrompt, pushNotice, refreshFiles } = useApp.getState();
	const [file, setFile] = useState<Preview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<"content" | "changes">("content");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [revision, setRevision] = useState(0);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState(false);

	const changes = useMemo(() => {
		if (!path) return [];
		const f = collectSessionFiles(messages, cwd).find((x) => x.path.toLowerCase() === path.toLowerCase());
		return (f?.changes ?? []).filter((c) => !c.isError);
	}, [messages, cwd, path]);

	const dirty = file !== null && editing && draft !== normalizeEol(file.text);
	const editable = file !== null && !file.binary && !file.truncated;

	const load = useCallback(async () => {
		if (!path || !cwd) return;
		try {
			const f = await api.readWorkspaceFile(cwd, path);
			setFile(f);
			setDraft(normalizeEol(f.text));
			setRevision((r) => r + 1);
			setError(null);
			setConflict(false);
		} catch (e) {
			setFile(null);
			setError(errorText(e));
		}
	}, [path, cwd]);

	// 切换文件时重置
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅在文件切换时执行
	useEffect(() => {
		setTab("content");
		setEditing(false);
		setFile(null);
		void load();
	}, [path, cwd]);

	// 工作区文件可能变化：未编辑时直接重新加载；编辑中且有改动时提示冲突
	// biome-ignore lint/correctness/useExhaustiveDependencies: filesVersion 只用于触发
	useEffect(() => {
		if (!path || !cwd || filesVersion === 0) return;
		if (!dirty) {
			void load();
			return;
		}
		void api.readWorkspaceFile(cwd, path).then(
			(f) => file && f.mtime !== file.mtime && setConflict(true),
			() => undefined,
		);
	}, [filesVersion]);

	const close = useCallback(async () => {
		if (dirty && !(await askConfirm({ title: "关闭文件", message: "有未保存的修改，确定关闭？", confirmLabel: "关闭", danger: true }))) return;
		openPreview(null);
	}, [dirty, openPreview]);

	const save = useCallback(async () => {
		if (!path || !cwd || !file || !dirty || saving) return;
		setSaving(true);
		try {
			const content = file.text.includes("\r\n") ? draft.replace(/\n/g, "\r\n") : draft;
			const saved = await api.writeWorkspaceFile(cwd, path, content, file.mtime);
			setFile(saved);
			setDraft(normalizeEol(saved.text));
			setConflict(false);
			pushNotice("info", `已保存 ${path}`);
			refreshFiles();
		} catch (e) {
			const text = errorText(e);
			if (text.startsWith(WRITE_CONFLICT_PREFIX)) setConflict(true);
			else pushNotice("error", `保存失败：${text}`);
		} finally {
			setSaving(false);
		}
	}, [path, cwd, file, dirty, saving, draft, pushNotice, refreshFiles]);

	// 查看模式下 Esc 关闭（编辑模式下 Esc 留给编辑器的查找面板等使用）
	useEffect(() => {
		if (!path || editing) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopImmediatePropagation();
				void close();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [path, editing, close]);

	if (!path) return null;
	const lineCount = file && !file.binary ? normalizeEol(file.text).split("\n").length : 0;

	return (
		<div className="absolute inset-x-0 top-9 bottom-0 z-20 flex flex-col bg-term">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-term-bar px-3 text-xs whitespace-nowrap [&>button]:shrink-0">
				<span className="min-w-0 truncate font-mono font-medium" title={file?.absolutePath ?? path}>
					{dirty && <span className="mr-1 text-accent">●</span>}
					{path}
				</span>
				{file && (
					<span className="shrink-0 text-muted">
						{lineCount} 行 · {(file.size / 1024).toFixed(1)} KB
					</span>
				)}
				<div className="flex-1" />
				{changes.length > 0 && (
					<div className="flex shrink-0 rounded border border-border">
						{(["content", "changes"] as const).map((t) => (
							<button
								type="button"
								key={t}
								onClick={() => setTab(t)}
								className={`px-2 py-0.5 ${tab === t ? "bg-panel font-medium text-fg" : "text-muted hover:text-fg"}`}
							>
								{t === "content" ? "内容" : `本会话的修改（${changes.length}）`}
							</button>
						))}
					</div>
				)}
				{editable && tab === "content" && !editing && (
					<button type="button" onClick={() => setEditing(true)} className="rounded border border-border px-2 py-0.5 hover:bg-panel">
						编辑
					</button>
				)}
				{editing && (
					<>
						<button
							type="button"
							onClick={async () => {
								if (dirty && !(await askConfirm({ title: "放弃修改", message: "放弃未保存的修改？", confirmLabel: "放弃", danger: true }))) return;
								setEditing(false);
								setDraft(normalizeEol(file?.text ?? ""));
								setRevision((r) => r + 1);
							}}
							className="rounded px-2 py-0.5 text-muted hover:bg-panel-2 hover:text-fg"
						>
							{dirty ? "放弃修改" : "退出编辑"}
						</button>
						<button
							type="button"
							disabled={!dirty || saving}
							onClick={() => void save()}
							className="rounded bg-accent px-2 py-0.5 font-medium text-accent-foreground disabled:opacity-40"
							title="Ctrl+S"
						>
							{saving ? "保存中…" : "保存"}
						</button>
					</>
				)}
				<button type="button" onClick={() => insertIntoPrompt(path)} className="rounded px-1.5 text-accent hover:bg-accent-soft">
					引用
				</button>
				<button
					type="button"
					onClick={() =>
						void navigator.clipboard.writeText(file?.absolutePath ?? path).then(() => pushNotice("info", "已复制路径"))
					}
					className="rounded px-1.5 text-muted hover:bg-panel-2 hover:text-fg"
				>
					复制路径
				</button>
				<button type="button" onClick={() => void close()} title="关闭（Esc）" className="px-1 text-muted hover:text-fg">
					✕
				</button>
			</div>

			{conflict && (
				<div className="flex items-center gap-3 border-b border-warn/40 bg-warn-soft px-3 py-1.5 text-xs">
					<span className="flex-1">文件在你打开之后已被修改（可能是 AI 或其他程序）。保存会被拒绝，以免覆盖对方的改动。</span>
					<button
						type="button"
						onClick={async () => {
							if (dirty && !(await askConfirm({ title: "重新加载", message: "重新加载会丢弃你未保存的修改，继续？", confirmLabel: "重新加载", danger: true }))) return;
							setEditing(false);
							void load();
						}}
						className="rounded border border-warn/50 px-2 py-0.5 hover:bg-warn/10"
					>
						重新加载
					</button>
					{dirty && (
						<button
							type="button"
							onClick={() => void navigator.clipboard.writeText(draft).then(() => pushNotice("info", "已复制你的版本"))}
							className="rounded px-2 py-0.5 text-muted hover:text-fg"
						>
							复制我的版本
						</button>
					)}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-hidden">
				{error && <div className="p-4 text-err">{error}</div>}
				{!file && !error && <div className="term p-4 text-muted">读取中…</div>}
				{file && tab === "content" && (
					<div className="flex h-full flex-col">
						{file.binary ? (
							<div className="term p-4 text-muted">二进制文件，不显示内容。</div>
						) : (
							<div className="min-h-0 flex-1">
								<Suspense fallback={<div className="term p-4 text-muted">加载编辑器…</div>}>
									<CodeEditor
										path={path}
										value={draft}
										revision={revision}
										editable={editing}
										onChange={setDraft}
										onSave={() => void save()}
									/>
								</Suspense>
							</div>
						)}
						{file.truncated && (
							<div className="term border-t border-border p-2 text-xs text-warn">文件较大，只显示前 512 KB，不能在此编辑。</div>
						)}
					</div>
				)}
				{tab === "changes" && (
					<div className="term h-full space-y-3 overflow-auto p-4 text-[12.5px] leading-5">
						{changes.map((c, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 修改按时间排列
							<div key={i}>
								<div className="mb-1 text-muted">
									第 {i + 1} 次 · {c.tool}
									{c.created ? "（新建）" : ""}
								</div>
								{c.diff ? <DiffBlock diff={c.diff} /> : <div className="text-muted">没有 diff 记录</div>}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function normalizeEol(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}
