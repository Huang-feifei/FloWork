/**
 * 会话区：会话头 + 会话记录（终端风格）+ 输入区（含工具栏）+ 右侧面板。
 * 窗口级的标题栏与状态栏在 App 中。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApprovalMode, ImageAttachment, WorkMode } from "@shared/protocol";
import { projectName, useApp, waitingCount } from "../../store";
import { Icon } from "../Icon";
import { ApprovalPanel } from "./ApprovalPanel";
import { ExtDialogPanel, ExtWidgets } from "./ExtDialogPanel";
import { ImageThumb } from "./ImageThumb";
import { Spinner, useElapsed } from "./Spinner";
import { Picker } from "./Picker";
import { ModelThinkingPicker } from "./ThinkingPicker";
import { SessionRail } from "./SessionRail";
import { PlanBoard } from "./PlanBoard";
import { SlashMenu, useSlashMenu } from "./SlashMenu";
import { MentionMenu, useMentionMenu, type MentionItem } from "./MentionMenu";
import { Transcript } from "./Transcript";
import { TrustBanner } from "./TrustBanner";
import { FilePreview } from "../panels/FilePreview";
import { RightPanel, useChangedCount } from "../panels/RightPanel";
import { displayUserText } from "@shared/skill-text";

function SessionHeader() {
	const rightPanel = useApp((s) => s.rightPanel);
	const changedCount = useChangedCount();
	const { setView, toggleRightPanel } = useApp.getState();
	return (
		<header className="fw-page-heading fw-session-toolbar">
			<div className="min-w-0 flex-1">
				<SessionHeading />
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{changedCount > 0 && (
					<button type="button" aria-label={`查看本会话的文件改动（${changedCount} 个文件）`} title={`查看本会话的文件改动（${changedCount} 个文件）`} onClick={() => setView("review")} className="fw-workbench-button fw-review-link">
						<Icon name="git-compare" className="size-4" />
						<span className="fw-review-word">文件改动</span>
						<span className="rounded-sm bg-panel-2 px-1 text-[11px] tabular-nums text-muted">{changedCount}</span>
					</button>
				)}
				<button type="button" aria-expanded={!!rightPanel} aria-controls={rightPanel ? "conversation-tools" : undefined} onClick={toggleRightPanel} className="fw-workbench-button fw-session-tools">
					<Icon name="panel-right" className="size-4" />
					工具面板
				</button>
			</div>
		</header>
	);
}

function SessionHeading() {
	const name = useApp((s) => s.state?.sessionName);
	const firstPrompt = useApp((s) => {
		const first = s.messages.find((m) => m.role === "user");
		return first?.role === "user" ? displayUserText(first.content.map((b) => (b.type === "text" ? b.text : "")).join("")).slice(0, 80) : "";
	});
	const project = useApp((s) => s.projects.projects.find((item) => item.id === s.activeProjectId));
	const waiting = useApp((s) => waitingCount(s));
	const running = useApp((s) => s.isRunning);
	return (
		<div className="min-w-0 space-y-1">
			<h1 className="fw-page-title truncate" title={name || firstPrompt || "新会话"}>{name || firstPrompt || "新会话"}</h1>
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
				{project && <span>{projectName(project)} · 项目会话</span>}
				<OpsBadge />
				{waiting > 0 ? <span className="text-warn">等待确认</span> : running && <span className="text-primary-strong">运行中</span>}
			</div>
		</div>
	);
}

/** 运维会话：会话头上的主机标记，悬停显示探测到的主机画像 */
function OpsBadge() {
	const ops = useApp((s) => s.state?.ops);
	if (!ops) return null;
	const facts = ops.profile?.facts ?? {};
	const title = ops.profile
		? Object.entries(facts)
				.map(([k, v]) => `${k}: ${v}`)
				.join("\n")
		: (ops.profileError ?? "正在探测主机环境…");
	return (
		<span
			title={title}
			className="flex min-w-0 shrink items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 font-mono text-[11px] text-primary"
		>
			<Icon name="server" className="size-3 shrink-0" />
			<span className="truncate">{ops.label}</span>
			{facts.os && <span className="truncate text-primary/70">· {facts.os}</span>}
			{!ops.profile && !ops.profileError && <span className="text-primary/70">· 探测中…</span>}
			{ops.profileError && <span className="text-warn">· 探测失败</span>}
		</span>
	);
}

function OpsWelcome() {
	const ops = useApp((s) => s.state?.ops);
	const models = useApp((s) => s.models);
	const setView = useApp((s) => s.setView);
	if (!ops) return null;
	const facts = ops.profile?.facts ?? {};
	return (
		<div className="mb-2 rounded-md border border-accent/40 px-4 py-3">
			<div>
				<span className="text-accent">✻</span> 运维会话 · <span className="font-bold">{ops.label}</span>
			</div>
			<div className="mt-1 text-muted">
				AI 的命令与文件操作都在这台服务器上执行（起始目录 {ops.remoteCwd}）。
				{facts.os ? ` ${facts.os}，包管理器 ${facts.package_manager ?? "未知"}${facts.init === "systemd" ? "，systemd" : facts.init ? `，未检测到 systemd（${facts.init}）` : ""}。` : ""}
			</div>
			<div className="mt-1 text-muted">
				只读命令按审批模式处理；高危命令（删除系统目录、重启、改 SSH / 防火墙 / 账号等）在任何模式下都会先请你确认。修改已有文件前会自动备份为
				<span className="font-mono"> 原文件.flowork-bak-时间戳</span>。
			</div>
			{models.length === 0 && (
				<div className="mt-2 text-muted">
					尚未配置可用模型，
					<button type="button" onClick={() => setView("settings", "custom")} className="text-accent underline">
						前往设置
					</button>
				</div>
			)}
		</div>
	);
}

function Welcome() {
	const cwd = useApp((s) => s.cwd);
	const models = useApp((s) => s.models);
	const setView = useApp((s) => s.setView);
	const isOps = useApp((s) => !!s.state?.ops);
	if (isOps) return <OpsWelcome />;
	return (
		<div className="mb-2 rounded-md border border-accent/40 px-4 py-3">
			<div>
				<span className="text-accent">✻</span> 欢迎使用 <span className="font-bold">FloWork</span>
				<span className="text-muted"> · 基于 pi coding agent</span>
			</div>
			<div className="mt-1 text-muted">cwd: {cwd}</div>
			<div className="mt-2 text-muted">
				{models.length === 0 ? (
					<>
						尚未配置可用模型，
						<button type="button" onClick={() => setView("settings", "custom")} className="text-accent underline">
							前往设置
						</button>
					</>
				) : (
					"输入任务开始。可以让它阅读代码、执行命令、修改文件。"
				)}
			</div>
		</div>
	);
}

function RunningLine() {
	const isRunning = useApp((s) => s.isRunning);
	const waiting = useApp((s) => waitingCount(s) > 0);
	const [since, setSince] = useState<number | null>(null);
	useEffect(() => setSince(isRunning ? Date.now() : null), [isRunning]);
	const elapsed = useElapsed(since);
	if (!isRunning || waiting) return null;
	return (
		<div className="grid grid-cols-[2ch_1fr] gap-x-1 text-accent">
			<Spinner />
			<span>
				运行中… <span className="text-muted">（{elapsed}s · esc 中断）</span>
			</span>
		</div>
	);
}

const QUEUE_DRAG_TYPE = "application/x-flowork-queue";

/** 单张图片上限：超过就拒收，避免超大 base64 走 IPC */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** 把剪贴板 / 拖拽得到的图片文件读成附件（base64，不带 data URL 前缀） */
function readImageFile(file: File): Promise<ImageAttachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
		reader.onload = () => {
			const url = typeof reader.result === "string" ? reader.result : "";
			const comma = url.indexOf(",");
			if (comma < 0) {
				reject(new Error("无法解析图片数据"));
				return;
			}
			const mimeType = /^data:([^;]+)/.exec(url)?.[1] ?? file.type ?? "image/png";
			resolve({ type: "image", mimeType, data: url.slice(comma + 1) });
		};
		reader.readAsDataURL(file);
	});
}

/** 运行中排队等待送达的消息（插话 / 排队）：可拖拽或 ↑↓ 调整顺序，也可一键取回输入框 */
function QueueList() {
	const queue = useApp((s) => s.state?.queue);
	const dequeue = useApp((s) => s.dequeue);
	const reorderQueue = useApp((s) => s.reorderQueue);
	const steering = queue?.steering ?? [];
	const followUp = queue?.followUp ?? [];
	const total = steering.length + followUp.length;
	const [dropAt, setDropAt] = useState<{ kind: "steering" | "followUp"; index: number; pos: "before" | "after" } | null>(null);
	if (total === 0) return null;

	const apply = (kind: "steering" | "followUp", next: string[]) =>
		void reorderQueue(kind === "steering" ? next : [...steering], kind === "followUp" ? next : [...followUp]);

	// pi 队列是 FIFO：调整顺序通过「清空后按新顺序重新入队」实现，因此只支持队列内部重排
	const move = (kind: "steering" | "followUp", index: number, delta: number) => {
		const list = kind === "steering" ? [...steering] : [...followUp];
		const target = index + delta;
		const a = list[index];
		const b = list[target];
		if (a === undefined || b === undefined) return;
		list[index] = b;
		list[target] = a;
		apply(kind, list);
	};

	/** 拖拽落点：只允许同一队列内部重排，跨队列（插话 ↔ 排队）会被忽略 */
	const drop = (kind: "steering" | "followUp", from: number, index: number, pos: "before" | "after") => {
		const list = kind === "steering" ? [...steering] : [...followUp];
		const [moved] = list.splice(from, 1);
		if (moved === undefined) return;
		const at = pos === "before" ? index : index + 1;
		list.splice(from < at ? at - 1 : at, 0, moved);
		apply(kind, list);
	};

	const row = (kind: "steering" | "followUp", text: string, index: number, length: number) => {
		const hint = dropAt?.kind === kind && dropAt.index === index ? dropAt.pos : null;
		return (
			<li
				key={`${kind}-${index}`}
				draggable
				onDragStart={(e) => {
					e.dataTransfer.setData(QUEUE_DRAG_TYPE, JSON.stringify({ kind, index }));
					e.dataTransfer.effectAllowed = "move";
				}}
				onDragOver={(e) => {
					if (!e.dataTransfer.types.includes(QUEUE_DRAG_TYPE)) return;
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					const rect = e.currentTarget.getBoundingClientRect();
					setDropAt({ kind, index, pos: e.clientY < rect.top + rect.height / 2 ? "before" : "after" });
				}}
				onDragLeave={() => setDropAt((d) => (d?.kind === kind && d.index === index ? null : d))}
				onDrop={(e) => {
					const raw = e.dataTransfer.getData(QUEUE_DRAG_TYPE);
					const pos = dropAt?.kind === kind && dropAt.index === index ? dropAt.pos : null;
					setDropAt(null);
					if (!raw || !pos) return;
					e.preventDefault();
					try {
						const src = JSON.parse(raw) as { kind: string; index: number };
						if (src.kind !== kind || typeof src.index !== "number") return;
						drop(kind, src.index, index, pos);
					} catch {
						/* 忽略无法解析的拖拽数据 */
					}
				}}
				onDragEnd={() => setDropAt(null)}
				className={`group flex min-w-0 cursor-grab items-center gap-1.5 active:cursor-grabbing ${
					hint === "before"
						? "shadow-[inset_0_2px_0_var(--color-accent)]"
						: hint === "after"
							? "shadow-[inset_0_-2px_0_var(--color-accent)]"
							: ""
				}`}
			>
				<span className={`shrink-0 ${kind === "steering" ? "text-primary" : "text-muted"}`}>{kind === "steering" ? "插话" : "排队"}</span>
				<span className="min-w-0 flex-1 truncate text-fg">{text}</span>
				<span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
					<button
						type="button"
						disabled={index === 0}
						onClick={() => move(kind, index, -1)}
						title="上移"
						className="rounded px-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
					>
						↑
					</button>
					<button
						type="button"
						disabled={index === length - 1}
						onClick={() => move(kind, index, 1)}
						title="下移"
						className="rounded px-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
					>
						↓
					</button>
				</span>
			</li>
		);
	};

	return (
		<div className="mb-1 rounded-lg border border-border bg-panel/70 px-3 py-2 text-[12px]">
			<div className="flex items-center gap-2 text-muted">
				<span>待发送 {total} 条</span>
				{total > 1 && <span className="text-faint">· 拖动或 ↑↓ 调整顺序</span>}
				<div className="flex-1" />
				<button
					type="button"
					onClick={() => void dequeue()}
					title="清空队列并填回输入框"
					className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg"
				>
					取回
				</button>
			</div>
			<ul className="mt-1 space-y-0.5">
				{steering.map((text, i) => row("steering", text, i, steering.length))}
				{followUp.map((text, i) => row("followUp", text, i, followUp.length))}
			</ul>
		</div>
	);
}

function PromptInput() {
	const [text, setText] = useState("");
	/** 已选好、随下一条消息发送的图片 */
	// 待发送的图片放在 store 里：图片生成模块也会往里放
	const images = useApp((s) => s.pendingImages);
	const setImages = useApp((s) => s.setPendingImages);
	const isRunning = useApp((s) => s.isRunning);
	const ready = useApp((s) => s.handleId !== null);
	const planning = useApp((s) => s.state?.workMode === "plan");
	const pushNotice = useApp((s) => s.pushNotice);
	const { sendPrompt, abort } = useApp.getState();
	const ref = useRef<HTMLTextAreaElement>(null);
	const draft = useApp((s) => s.draft);

	useEffect(() => {
		if (ready) ref.current?.focus();
	}, [ready]);

	// 回溯 / 分叉 / 从队列取回后把内容填回输入框
	useEffect(() => {
		if (draft.seq === 0) return;
		if (draft.append) {
			if (draft.text)
				setText((prev) => (prev && !/\s$/.test(prev) ? `${prev} ${draft.text} ` : `${prev}${draft.text} `));
		} else setText(draft.text);
		if (draft.images && draft.images.length > 0) {
			const current = useApp.getState().pendingImages;
			setImages(draft.append ? [...current, ...draft.images] : [...draft.images]);
		}
		ref.current?.focus();
	}, [draft, setImages]);

	// 自适应高度
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "0px";
		el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
	}, [text]);

	const menu = useSlashMenu(text);
	const pickCommand = (name: string) => {
		setText(`/${name} `);
		ref.current?.focus();
	};

	const [cursor, setCursor] = useState(0);
	const mentionMenu = useMentionMenu(text, cursor);

	const pickMention = (item: MentionItem) => {
		const el = ref.current;
		const atIdx = mentionMenu.atIndex;
		const currentCursor = el?.selectionStart ?? cursor;
		const before = text.slice(0, atIdx);
		const after = text.slice(currentCursor);
		const nextText = `${before}${item.insertText} ${after}`;
		setText(nextText);
		const newCursor = atIdx + item.insertText.length + 1;
		setCursor(newCursor);
		requestAnimationFrame(() => {
			if (el) {
				el.focus();
				el.setSelectionRange(newCursor, newCursor);
			}
		});
	};

	const updateCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
		setCursor(e.currentTarget.selectionStart);
	};

	const addImageFiles = async (files: File[]) => {
		const accepted: ImageAttachment[] = [];
		for (const file of files) {
			if (file.size > MAX_IMAGE_BYTES) {
				pushNotice("warning", `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，已忽略`);
				continue;
			}
			try {
				accepted.push(await readImageFile(file));
			} catch (error) {
				pushNotice("error", error instanceof Error ? error.message : "读取图片失败");
			}
		}
		if (accepted.length > 0) setImages([...images, ...accepted]);
	};

	/** 剪贴板里有图片时接管粘贴（Ctrl+V / 截图后直接粘贴）；纯文本粘贴走浏览器默认行为 */
	const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = event.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (!item || item.kind !== "file" || !item.type.startsWith("image/")) continue;
			const file = item.getAsFile();
			if (file) files.push(file);
		}
		if (files.length === 0) return;
		event.preventDefault();
		void addImageFiles(files);
	};

	const submit = (behavior?: "steer" | "followUp") => {
		if (!ready) return;
		if (!text.trim() && images.length === 0) return;
		void sendPrompt(text, images, behavior);
		setText("");
		setImages([]);
	};

	return (
		<div className="fw-composer relative">
			<SlashMenu menu={menu} onPick={(c) => pickCommand(c.name)} />
			<MentionMenu menu={mentionMenu} onPick={pickMention} />
			{images.length > 0 && (
				<div className="flex flex-wrap gap-2 px-5 pt-4 pb-1">
					{images.map((image, i) => (
						<div key={i} className="relative">
							<ImageThumb image={image} alt={`待发送图片 ${i + 1}`} thumbClassName="h-16 max-w-[160px]" />
							<button
								type="button"
								onClick={() => setImages(images.filter((_, index) => index !== i))}
								title="移除这张图片"
								className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-panel-2 text-[11px] leading-none text-muted hover:bg-highlight hover:text-fg"
							>
								×
							</button>
						</div>
					))}
				</div>
			)}
			<div className={`px-4 pb-1 ${images.length > 0 ? "pt-2" : "pt-4"}`}>
				<textarea
					aria-label="输入任务"
					ref={ref}
					value={text}
					rows={1}
					disabled={!ready}
					onChange={(e) => {
						setText(e.target.value);
						setCursor(e.target.selectionStart);
					}}
					onClick={updateCursor}
					onKeyUp={updateCursor}
					onSelect={updateCursor}
					onPaste={onPaste}
					onKeyDown={(e) => {
						if (mentionMenu.open && !e.nativeEvent.isComposing) {
							const picked = mentionMenu.items[mentionMenu.active];
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								const n = mentionMenu.items.length;
								mentionMenu.setActive((mentionMenu.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
								return;
							}
							if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && picked) {
								e.preventDefault();
								pickMention(picked);
								return;
							}
							if (e.key === "Escape") {
								e.preventDefault();
								e.stopPropagation();
								mentionMenu.dismiss();
								return;
							}
						}
						if (menu.open && !e.nativeEvent.isComposing) {
							const picked = menu.matches[menu.active];
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								const n = menu.matches.length;
								menu.setActive((menu.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
								return;
							}
							if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && picked) {
								e.preventDefault();
								pickCommand(picked.name);
								return;
							}
							if (e.key === "Escape") {
								e.preventDefault();
								e.stopPropagation();
								menu.dismiss();
								return;
							}
						}
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							// 运行中：Enter 排队（followUp），Ctrl/Cmd+Enter 插话（steer）
							submit(isRunning && (e.ctrlKey || e.metaKey) ? "steer" : undefined);
						} else if (e.key === "Escape" && isRunning) {
							e.preventDefault();
							void abort();
						}
					}}
					placeholder={ready ? (isRunning ? "运行中：Enter 排队，Ctrl+Enter 插话" : planning ? "描述需求，先讨论计划，确认后再执行" : "输入任务，Enter 发送，Shift+Enter 换行") : "正在启动 pi…"}
					className="block min-h-14 w-full resize-none bg-transparent text-[14.5px] leading-relaxed outline-none placeholder:text-muted"
				/>
			</div>
			<ComposerToolbar
				canMention={ready}
				onMention={() => {
					const field = ref.current;
					if (!field) return;
					const start = field.selectionStart;
					const before = text.slice(0, start);
					const mention = before && !/\s$/.test(before) ? " @" : "@";
					const next = start + mention.length;
					setText(`${before}${mention}${text.slice(field.selectionEnd)}`);
					setCursor(next);
					requestAnimationFrame(() => { field.focus(); field.setSelectionRange(next, next); });
				}}
				canSend={ready && (text.trim().length > 0 || images.length > 0)}
				onSend={submit}
			/>
		</div>
	);
}

/** 输入框底部：审批模式、思考等级、模型，以及发送 / 中断按钮 */
function ComposerToolbar({ canSend, onSend, canMention, onMention }: { canSend: boolean; onSend: () => void; canMention: boolean; onMention: () => void }) {
	const state = useApp((s) => s.state);
	const models = useApp((s) => s.models);
	const isRunning = useApp((s) => s.isRunning);
	const approvalMode = useApp((s) => s.approvalMode);
	const isOps = useApp((s) => !!s.state?.ops);
	const waiting = useApp((s) => waitingCount(s));
	const workMode = state?.workMode ?? "execute";
	const { setModel, setThinkingLevel, loadModels, setApprovalMode, setWorkMode, abort } = useApp.getState();
	/** 审批选项：ops 会话用运维语汇，普通会话用工具语汇（文案与原 select 一致） */
	const approvalItems: { value: ApprovalMode; title: string }[] = isOps
		? [
				{ value: "ask_writes", title: "审批：只读自动，改动确认" },
				{ value: "ask_all", title: "审批：每条都确认" },
				{ value: "auto", title: "审批：自动（高危/连接仍确认）" },
			]
		: [
				{ value: "ask_writes", title: "审批：修改与命令" },
				{ value: "ask_all", title: "审批：全部工具" },
				{ value: "auto", title: "审批：关闭（连接仍确认）" },
			];
	const approvalLabel = approvalItems.find((item) => item.value === approvalMode)?.title ?? "工具审批";
	const approvalName = workMode === "plan" ? "审批：计划限制优先" : approvalLabel;
	const approvalShort = workMode === "plan" ? "只读" : ({ ask_writes: "按需审批", ask_all: "逐项审批", auto: "自动审批" })[approvalMode];

	return (
		<div className="fw-composer-tools">
			<div className="fw-composer-options">
				<button type="button" title="引用项目文件或技能" disabled={!canMention} onClick={onMention} className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40">
					<Icon name="at-sign" className="size-4" />
				</button>
				<Picker
					label={workMode === "plan" ? "计划模式" : "执行模式"}
					accessibleLabel={workMode === "plan" ? "计划模式（只读）" : "执行模式"}
					compactIcon="list-checks"
					title={isRunning || waiting > 0 ? "请先结束或中断当前运行，再切换模式" : "计划模式先讨论并确认方案，执行模式允许实施"}
					items={[
						{ value: "plan", title: "计划模式：只读分析，提问并确认方案" },
						{ value: "execute", title: "执行模式：允许修改和运行命令" },
					]}
					value={workMode}
					tone={workMode === "plan" ? "warn" : "muted"}
					disabled={!state || isRunning || waiting > 0}
					onSelect={(next) => void setWorkMode(next as WorkMode)}
				/>
				<Picker
					label={approvalShort}
					accessibleLabel={approvalName}
					compactIcon="shield-alert"
					title={approvalName}
					items={approvalItems}
					value={approvalMode}
					tone={approvalMode === "auto" ? "warn" : "muted"}
					disabled={workMode === "plan"}
					onSelect={(next) => void setApprovalMode(next as ApprovalMode)}
				/>
			</div>
			<div className="fw-composer-actions">
				{state && <ModelThinkingPicker key={state.sessionId} state={state} models={models} onModel={setModel} onThinking={setThinkingLevel} onRefresh={loadModels} />}
				{isRunning && !canSend ? (
					<button type="button" onClick={() => void abort()} title="中断当前任务（Esc）" aria-label="中断当前任务" className="fw-workbench-button fw-composer-action fw-composer-stop">
						<Icon name="stop" className="size-3.5" />
						<span className="fw-composer-stop-label">中断</span>
					</button>
				) : (
					<button
						type="button"
						disabled={!canSend}
						onClick={onSend}
						title={isRunning ? "加入队列（Enter）· Ctrl+Enter 插话" : "发送（Enter）"}
						className="fw-workbench-button fw-workbench-primary fw-composer-action !px-0"
					>
						<Icon name="arrow-up" />
					</button>
				)}
			</div>
		</div>
	);
}

/** 等待你决定的卡片（工具审批 + 提问/计划审批）：停在输入框上方，不插进会话流，免得要往上翻才找得到。 */
function DecisionDock() {
	const approvals = useApp((s) => s.pendingApprovals.length > 0);
	const dialogs = useApp((s) => s.extDialogs.length > 0);
	if (!approvals && !dialogs) return null;
	return (
		<div className="fw-scroll flex max-h-[min(56vh,520px)] w-full flex-col gap-2.5 overflow-y-auto pb-3 pr-0.5">
			<ApprovalPanel />
			<ExtDialogPanel />
		</div>
	);
}

export function TerminalView() {
	const handleId = useApp((s) => s.handleId);
	const sessionFile = useApp((s) => s.state?.sessionFile);
	const connecting = useApp((s) => s.connecting);
	const messages = useApp((s) => s.messages);
	const streaming = useApp((s) => s.streaming);
	const isRunning = useApp((s) => s.isRunning);
	const pendingCount = useApp((s) => waitingCount(s));
	const abort = useApp((s) => s.abort);
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	/** 是否跟随最新输出（用户上滚查看历史时置 false） */
	const stickToBottom = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const followFrame = useRef(0);

	/** 跟随滚动：每帧最多一次，直接写 scrollTop。不做动画，否则会一直追不上流式输出。 */
	const follow = useCallback(() => {
		if (followFrame.current) return;
		followFrame.current = requestAnimationFrame(() => {
			followFrame.current = 0;
			const el = scrollRef.current;
			if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
		});
	}, []);

	// 切换会话不能继承上一会话的「正在翻阅历史」状态；在绘制前直接定位最新消息。
	useLayoutEffect(() => {
		stickToBottom.current = true;
		setAtBottom(true);
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [handleId, sessionFile]);

	// 内容长高就跟随：覆盖流式文本、工具输出、图片加载、Markdown 重排等所有情况
	useEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		const observer = new ResizeObserver(follow);
		observer.observe(content);
		return () => observer.disconnect();
	}, [follow]);

	// 历史消息异步载入后也在绘制前定位，避免布局产生的 scroll 先关闭跟随。
	// 同一会话中手动上滚后仍保留阅读位置，不因新消息强制跳到底部。
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
		follow();
	}, [messages, streaming, isRunning, pendingCount, follow]);

	useEffect(
		() => () => {
			if (followFrame.current) cancelAnimationFrame(followFrame.current);
			followFrame.current = 0;
		},
		[],
	);

	const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
		const el = e.currentTarget;
		const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		stickToBottom.current = bottom;
		setAtBottom(bottom);
	};

	const scrollToBottom = () => {
		const el = scrollRef.current;
		if (!el) return;
		stickToBottom.current = true;
		setAtBottom(true);
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	};

	// 运行中按 Esc 中断（焦点不在输入框时也生效）
	useEffect(() => {
		if (!isRunning) return;
		const onKey = (e: KeyboardEvent) => {
			const target = e.target instanceof Element ? e.target : null;
			if (e.key === "Escape" && !e.defaultPrevented && !(target instanceof HTMLTextAreaElement) && !target?.closest(".cm-editor, input, [data-browser-panel]")) void abort();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isRunning, abort]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<SessionHeader />
			<div className="flex min-h-0 flex-1">
				<div className="fw-conversation relative flex min-h-0 min-w-0 flex-1 flex-col">
					<FilePreview />
					<div className="relative min-h-0 flex-1">
						<div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 pt-3 pb-5 text-[14px] sm:px-8">
							<div ref={contentRef} className="mx-auto flex max-w-[760px] flex-col gap-6">
								{messages.length === 0 && !streaming && <Welcome />}
								<TrustBanner />
								<PlanBoard />
								{connecting ? (
									<div className="text-muted"><Spinner /> 正在启动 pi…</div>
								) : <Transcript />}
								<RunningLine />
							</div>
						</div>
						{!atBottom && (
							<button
								type="button"
								onClick={scrollToBottom}
								title="回到最新输出"
								className="fw-workbench-button absolute bottom-4 left-1/2 z-20 -translate-x-1/2 bg-surface-solid text-muted shadow-sm hover:text-fg"
							>
								<Icon name="arrow-down" className="size-3.5" />
								回到最新
							</button>
						)}
					</div>
					<div className="fw-composer-dock shrink-0 px-4 pt-3 pb-4 sm:px-8">
						<div className="mx-auto min-w-0 max-w-[760px]">
							<ExtWidgets placement="aboveEditor" />
							<DecisionDock />
							<QueueList />
							<PromptInput />
							<ExtWidgets placement="belowEditor" />
						</div>
					</div>
				</div>
				<SessionRail scrollRef={scrollRef} />
				<RightPanel />
			</div>
		</div>
	);
}
