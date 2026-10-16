/**
 * 会话区：会话头 + 会话记录（终端风格）+ 输入区（含工具栏）+ 右侧面板。
 * 窗口级的标题栏与状态栏在 App 中。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApprovalMode, ImageAttachment, ThinkingLevel } from "@shared/protocol";
import { useApp, waitingCount } from "../../store";
import { Icon } from "../Icon";
import { ApprovalPanel } from "./ApprovalPanel";
import { ExtDialogPanel, ExtWidgets } from "./ExtDialogPanel";
import { ImageThumb } from "./ImageThumb";
import { Spinner, useElapsed } from "./Spinner";
import { SessionRail } from "./SessionRail";
import { SlashMenu, useSlashMenu } from "./SlashMenu";
import { Transcript } from "./Transcript";
import { TrustBanner } from "./TrustBanner";
import { FilePreview } from "../panels/FilePreview";
import { QuickOpen } from "../panels/QuickOpen";
import { PANEL_TABS, RightPanel, useChangedCount } from "../panels/RightPanel";
import { thinkingLabel } from "../../lib/format";
import { displayUserText } from "@shared/skill-text";

function SessionHeader() {
	const state = useApp((s) => s.state);
	const isRunning = useApp((s) => s.isRunning);
	const waiting = useApp((s) => waitingCount(s));
	const rightPanel = useApp((s) => s.rightPanel);
	const setRightPanel = useApp((s) => s.setRightPanel);
	const isRemote = useApp((s) => !!s.projects.projects.find((p) => p.id === s.activeProjectId)?.hostId);
	const panelTabs = PANEL_TABS.filter((t) => !t.remoteOnly || isRemote);
	const foldProcess = useApp((s) => s.foldProcess);
	const toggleFoldProcess = useApp((s) => s.toggleFoldProcess);
	const changedCount = useChangedCount();
	const firstPrompt = useApp((s) => {
		const first = s.messages.find((m) => m.role === "user");
		return first?.role === "user" ? displayUserText(first.content.map((b) => (b.type === "text" ? b.text : "")).join("")).slice(0, 80) : "";
	});
	return (
		<div className="flex h-12 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-6 py-1">
			<h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{state?.sessionName || firstPrompt || "新会话"}</h1>
			{state?.ops && <OpsBadge />}
			{waiting > 0 ? (
				<span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-1 text-[11.5px] font-medium text-warn">
					<span className="size-1.5 rounded-full bg-warn" />
					等待确认
				</span>
			) : (
				isRunning && (
					<span className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 text-[11.5px] font-medium text-primary">
						<span className="size-1.5 rounded-full bg-primary" />
					运行中
					</span>
				)
			)}
			<div className="flex-1" />
			<button
				type="button"
				onClick={toggleFoldProcess}
				aria-pressed={foldProcess}
				title={foldProcess ? "已折叠：历史轮次的思考与工具调用收成一行（点击全部展开）" : "未折叠：点击把历史轮次的思考与工具调用折叠成一行"}
				className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] ${foldProcess ? "bg-primary-soft text-primary" : "text-muted hover:bg-panel-2 hover:text-fg"}`}
			>
				<span className={`size-1.5 rounded-full ${foldProcess ? "bg-primary" : "border border-current"}`} />
				折叠过程
			</button>
			{/* 右侧面板打开时它自己有标签栏，这里不再重复显示 */}
			{!rightPanel && <div className="flex shrink-0 gap-0.5">
				{panelTabs.map((tab) => (
					<button
						type="button"
						key={tab.id}
						onClick={() => setRightPanel(rightPanel === tab.id ? null : tab.id)}
						title={tab.hint}
						className={`rounded-full px-2.5 py-1 text-[12.5px] ${rightPanel === tab.id ? "bg-primary-soft text-primary" : "text-muted hover:bg-panel-2 hover:text-fg"}`}
					>
						{tab.label}
						{tab.id === "session" && changedCount > 0 && <span className="ml-1 text-warn">{changedCount}</span>}
					</button>
				))}
			</div>}
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
					<button type="button" onClick={() => setView("settings", "providers")} className="text-accent underline">
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
						<button type="button" onClick={() => setView("settings", "providers")} className="text-accent underline">
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
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const isRunning = useApp((s) => s.isRunning);
	const ready = useApp((s) => s.handleId !== null);
	const pushNotice = useApp((s) => s.pushNotice);
	const { sendPrompt, abort } = useApp.getState();
	const ref = useRef<HTMLTextAreaElement>(null);
	const draft = useApp((s) => s.draft);

	useEffect(() => {
		if (ready) ref.current?.focus();
	}, [ready]);

	// 回溯 / 分叉后把原消息填回输入框
	useEffect(() => {
		if (draft.seq === 0) return;
		if (draft.append) setText((prev) => (prev && !/\s$/.test(prev) ? `${prev} ${draft.text} ` : `${prev}${draft.text} `));
		else setText(draft.text);
		ref.current?.focus();
	}, [draft]);

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
		if (accepted.length > 0) setImages((prev) => [...prev, ...accepted]);
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
		<div className="fw-float relative rounded-[22px] focus-within:ring-2 focus-within:ring-primary/20">
			<SlashMenu menu={menu} onPick={(c) => pickCommand(c.name)} />
			<div className="grid grid-cols-[2ch_1fr] gap-x-2 px-5 pt-4 pb-1">
				<span className="text-[14px] leading-[1.6] font-semibold text-primary">❯</span>
				<textarea
					ref={ref}
					value={text}
					rows={1}
					disabled={!ready}
					onChange={(e) => setText(e.target.value)}
					onPaste={onPaste}
					onKeyDown={(e) => {
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
					placeholder={ready ? (isRunning ? "运行中：Enter 排队，Ctrl+Enter 插话" : "输入任务，Enter 发送，Shift+Enter 换行") : "正在启动 pi…"}
					className="min-h-[1.6em] w-full resize-none bg-transparent text-[14.5px] leading-relaxed outline-none placeholder:text-muted/70"
				/>
			</div>
			{images.length > 0 && (
				<div className="flex flex-wrap gap-2 px-5 pb-1.5">
					{images.map((image, i) => (
						<div key={i} className="relative">
							<ImageThumb image={image} alt={`待发送图片 ${i + 1}`} thumbClassName="h-16 max-w-[160px]" />
							<button
								type="button"
								onClick={() => setImages((prev) => prev.filter((_, index) => index !== i))}
								title="移除这张图片"
								className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-panel-2 text-[11px] leading-none text-muted hover:bg-highlight hover:text-fg"
							>
								×
							</button>
						</div>
					))}
				</div>
			)}
			<ComposerToolbar
				canSend={ready && (text.trim().length > 0 || images.length > 0)}
				onSend={submit}
			/>
		</div>
	);
}

/** 输入框底部：审批模式、思考等级、模型，以及发送 / 中断按钮 */
function ComposerToolbar({ canSend, onSend }: { canSend: boolean; onSend: () => void }) {
	const state = useApp((s) => s.state);
	const models = useApp((s) => s.models);
	const isRunning = useApp((s) => s.isRunning);
	const approvalMode = useApp((s) => s.approvalMode);
	const isOps = useApp((s) => !!s.state?.ops);
	const { setModel, setThinkingLevel, setApprovalMode, abort } = useApp.getState();
	const currentKey = state?.model ? `${state.model.provider}/${state.model.id}` : "";
	const selectCls = "h-8 shrink-0 rounded-full bg-transparent px-3 text-[12.5px] outline-none hover:bg-panel-2";

	return (
		<div className="flex items-center gap-1 px-3.5 pt-1 pb-3 whitespace-nowrap">
			<select
				value={approvalMode}
				onChange={(e) => void setApprovalMode(e.target.value as ApprovalMode)}
				className={`${selectCls} ${approvalMode === "auto" ? "text-warn" : "text-muted hover:text-fg"}`}
				title={isOps ? "命令审批（高危命令始终需要确认）" : "工具审批"}
			>
				{isOps ? (
					<>
						<option value="ask_writes">审批：只读自动，改动确认</option>
						<option value="ask_all">审批：每条都确认</option>
						<option value="auto">审批：全部自动，只拦高危</option>
					</>
				) : (
					<>
						<option value="ask_writes">审批：修改与命令</option>
						<option value="ask_all">审批：全部工具</option>
						<option value="auto">审批：关闭（自动执行）</option>
					</>
				)}
			</select>
			{state &&
				(state.availableThinkingLevels.length > 1 ? (
					<select
						value={state.thinkingLevel}
						onChange={(e) => void setThinkingLevel(e.target.value as ThinkingLevel)}
						className={`${selectCls} text-muted hover:text-fg`}
						title="思考强度"
					>
						{state.availableThinkingLevels.map((level) => (
							<option
								key={level}
								value={level}
							>
								思考 {thinkingLabel(level)}
							</option>
						))}
					</select>
				) : (
					<select
						disabled
						value="off"
						className={`${selectCls} text-faint`}
						title="该模型没有声明支持思考，所以只有「关闭」。在 设置 → 自定义端点 里为该模型打开「思考」后即可选择强度"
					>
						<option value="off">思考 关闭（模型不支持）</option>
					</select>
				))}
			<div className="flex-1" />
			{models.length > 0 && (
				<select
					value={currentKey}
					onChange={(e) => {
						const model = models.find((m) => `${m.provider}/${m.id}` === e.target.value);
						if (model) void setModel(model);
					}}
					className={`${selectCls} max-w-72 min-w-0 font-medium text-fg`}
					title="切换模型"
				>
					{!currentKey && <option value="">选择模型</option>}
					{models.map((m) => (
						<option
							key={`${m.provider}/${m.id}`}
							value={`${m.provider}/${m.id}`}
						>
							{m.provider}/{m.id}
							{m.reasoning ? " · 可思考" : ""}
						</option>
					))}
				</select>
			)}
			{isRunning && !canSend ? (
				<button
					type="button"
					onClick={() => void abort()}
					title="中断当前任务"
					className="ml-1 flex h-9 items-center gap-2 rounded-full bg-panel-2 px-4 text-[13px] font-medium text-fg hover:bg-highlight"
				>
					<Icon
						name="stop"
						className="size-3.5"
					/>
					中断
					<kbd className="font-mono text-[11px] text-faint">Esc</kbd>
				</button>
			) : (
				<button
					type="button"
					disabled={!canSend}
					onClick={onSend}
					title={isRunning ? "加入队列（Enter）· Ctrl+Enter 插话" : "发送（Enter）"}
					className="ml-1 flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary-strong disabled:bg-panel-2 disabled:text-faint"
				>
					<Icon name="arrow-up" />
				</button>
			)}
		</div>
	);
}

export function TerminalView() {
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

	// 内容长高就跟随：覆盖流式文本、工具输出、图片加载、Markdown 重排等所有情况
	useEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		const observer = new ResizeObserver(follow);
		observer.observe(content);
		return () => observer.disconnect();
	}, [follow]);

	// 内容高度没变但状态变了（例如刚开始运行）也跟随一次
	useEffect(() => {
		follow();
	}, [messages, streaming, isRunning, pendingCount, follow]);

	useEffect(
		() => () => {
			if (followFrame.current) cancelAnimationFrame(followFrame.current);
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
		<div className="flex min-h-0 flex-1">
			<div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-term">
				<SessionHeader />
				<FilePreview />
				<div className="relative min-h-0 flex-1">
					<div
						ref={scrollRef}
						onScroll={onScroll}
						className="h-full overflow-y-auto px-6 py-5 text-[14px]"
					>
						<div
							ref={contentRef}
							className="mx-auto flex max-w-4xl flex-col gap-5"
						>
							<Welcome />
							<TrustBanner />
							{connecting ? (
								<div className="text-muted">
									<Spinner /> 正在启动 pi…
								</div>
							) : (
								<Transcript />
							)}
							<ApprovalPanel />
							<ExtDialogPanel />
							<RunningLine />
						</div>
					</div>
					{!atBottom && (
						<button
							type="button"
							onClick={scrollToBottom}
							title="回到最新输出"
							className="fw-float absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-4 py-2 text-[12.5px] text-muted hover:text-fg"
						>
							<Icon
								name="arrow-down"
								className="size-3.5"
							/>
							回到最新
						</button>
					)}
				</div>
				<div className="shrink-0 px-6 pt-1 pb-4">
					<div className="mx-auto max-w-4xl">
						<ExtWidgets placement="aboveEditor" />
						<QueueList />
						<PromptInput />
						<ExtWidgets placement="belowEditor" />
					</div>
				</div>
			</div>
			<SessionRail scrollRef={scrollRef} />
			<RightPanel />
			<QuickOpen />
		</div>
	);
}
