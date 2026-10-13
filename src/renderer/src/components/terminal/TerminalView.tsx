/**
 * 会话区：会话头 + 会话记录（终端风格）+ 输入区（含工具栏）+ 右侧面板。
 * 窗口级的标题栏与状态栏在 App 中。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApprovalMode, ThinkingLevel } from "@shared/protocol";
import { useApp, waitingCount } from "../../store";
import { Icon } from "../Icon";
import { ApprovalPanel } from "./ApprovalPanel";
import { ExtDialogPanel, ExtWidgets } from "./ExtDialogPanel";
import { Spinner, useElapsed } from "./Spinner";
import { SlashMenu, useSlashMenu } from "./SlashMenu";
import { Transcript } from "./Transcript";
import { TrustBanner } from "./TrustBanner";
import { FilePreview } from "../panels/FilePreview";
import { QuickOpen } from "../panels/QuickOpen";
import { PANEL_TABS, RightPanel, useChangedCount } from "../panels/RightPanel";
import { displayUserText } from "@shared/skill-text";

function SessionHeader() {
	const state = useApp((s) => s.state);
	const isRunning = useApp((s) => s.isRunning);
	const waiting = useApp((s) => waitingCount(s));
	const rightPanel = useApp((s) => s.rightPanel);
	const setRightPanel = useApp((s) => s.setRightPanel);
	const changedCount = useChangedCount();
	const firstPrompt = useApp((s) => {
		const first = s.messages.find((m) => m.role === "user");
		return first?.role === "user" ? displayUserText(first.content.map((b) => (b.type === "text" ? b.text : "")).join("")).slice(0, 80) : "";
	});
	return (
		<div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-5">
			<h1 className="min-w-0 truncate text-[13.5px] font-semibold">{state?.sessionName || firstPrompt || "新会话"}</h1>
			{waiting > 0 ? (
				<span className="flex shrink-0 items-center gap-1 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">
					<span className="size-1.5 rounded-full bg-warn" />
					等待确认
				</span>
			) : (
				isRunning && (
					<span className="flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
						<span className="size-1.5 rounded-full bg-accent" />
					运行中
					</span>
				)
			)}
			<div className="flex-1" />
			<div className="flex shrink-0 gap-0.5">
				{PANEL_TABS.map((tab) => (
					<button
						type="button"
						key={tab.id}
						onClick={() => setRightPanel(rightPanel === tab.id ? null : tab.id)}
						title={tab.hint}
						className={`rounded-md px-2 py-1 text-[12px] ${rightPanel === tab.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-2 hover:text-fg"}`}
					>
						{tab.label}
						{tab.id === "session" && changedCount > 0 && <span className="ml-1 text-warn">{changedCount}</span>}
					</button>
				))}
			</div>
		</div>
	);
}

function Welcome() {
	const cwd = useApp((s) => s.cwd);
	const models = useApp((s) => s.models);
	const setView = useApp((s) => s.setView);
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

function PromptInput() {
	const [text, setText] = useState("");
	const isRunning = useApp((s) => s.isRunning);
	const ready = useApp((s) => s.handleId !== null);
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

	const submit = () => {
		if (!text.trim() || !ready) return;
		void sendPrompt(text);
		setText("");
	};

	return (
		<div className="fw-float relative rounded-xl border border-border-strong focus-within:border-accent/70">
			<SlashMenu menu={menu} onPick={(c) => pickCommand(c.name)} />
			<div className="grid grid-cols-[2ch_1fr] gap-x-1 px-3.5 pt-3 pb-1">
				<span className="term font-bold text-accent">❯</span>
				<textarea
					ref={ref}
					value={text}
					rows={1}
					disabled={!ready}
					onChange={(e) => setText(e.target.value)}
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
							submit();
						} else if (e.key === "Escape" && isRunning) {
							e.preventDefault();
							void abort();
						}
					}}
					placeholder={ready ? (isRunning ? "运行中，输入的消息会排在当前任务之后" : "输入任务，Enter 发送，Shift+Enter 换行") : "正在启动 pi…"}
					className="term min-h-[1.65em] w-full resize-none bg-transparent outline-none placeholder:text-muted/70"
				/>
			</div>
			<ComposerToolbar
				canSend={ready && text.trim().length > 0}
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
	const { setModel, setThinkingLevel, setApprovalMode, abort } = useApp.getState();
	const currentKey = state?.model ? `${state.model.provider}/${state.model.id}` : "";
	const selectCls = "h-7 shrink-0 rounded-md bg-transparent px-1.5 text-[12px] outline-none hover:bg-panel-2";

	return (
		<div className="flex items-center gap-1 px-2 pb-2 whitespace-nowrap">
			<select
				value={approvalMode}
				onChange={(e) => void setApprovalMode(e.target.value as ApprovalMode)}
				className={`${selectCls} ${approvalMode === "auto" ? "text-warn" : "text-muted hover:text-fg"}`}
				title="工具审批"
			>
				<option value="ask_writes">审批：修改与命令</option>
				<option value="ask_all">审批：全部工具</option>
				<option value="auto">审批：关闭（自动执行）</option>
			</select>
			{state && state.availableThinkingLevels.length > 1 && (
				<select
					value={state.thinkingLevel}
					onChange={(e) => void setThinkingLevel(e.target.value as ThinkingLevel)}
					className={`${selectCls} text-muted hover:text-fg`}
					title="思考等级"
				>
					{state.availableThinkingLevels.map((level) => (
						<option
							key={level}
							value={level}
						>
							思考 {level}
						</option>
					))}
				</select>
			)}
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
						</option>
					))}
				</select>
			)}
			{isRunning && !canSend ? (
				<button
					type="button"
					onClick={() => void abort()}
					title="中断当前任务"
					className="ml-1 flex h-8 items-center gap-1.5 rounded-lg bg-panel-2 px-3 text-[12.5px] font-medium text-fg hover:bg-highlight"
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
					title={isRunning ? "加入队列（Enter）" : "发送（Enter）"}
					className="ml-1 flex size-8 items-center justify-center rounded-lg bg-accent text-accent-foreground hover:bg-accent-strong disabled:bg-panel-2 disabled:text-faint"
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
	const stickToBottom = useRef(true);

	// 用户上滚查看历史时不强制滚到底部
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
	}, [messages, streaming, isRunning, pendingCount]);

	// 运行中按 Esc 中断（焦点不在输入框时也生效）
	useEffect(() => {
		if (!isRunning) return;
		const onKey = (e: KeyboardEvent) => {
			const target = e.target instanceof Element ? e.target : null;
			if (e.key === "Escape" && !(target instanceof HTMLTextAreaElement) && !target?.closest(".cm-editor, input")) void abort();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isRunning, abort]);

	return (
		<div className="flex min-h-0 flex-1">
			<div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-term">
				<SessionHeader />
				<FilePreview />
				<div
					ref={scrollRef}
					onScroll={(e) => {
						const el = e.currentTarget;
						stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
					}}
					className="term min-h-0 flex-1 overflow-y-auto px-6 py-4"
				>
					<div className="mx-auto flex max-w-4xl flex-col gap-3">
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
				<div className="shrink-0 px-6 pt-1 pb-4">
					<div className="mx-auto max-w-4xl">
						<ExtWidgets placement="aboveEditor" />
						<PromptInput />
						<ExtWidgets placement="belowEditor" />
					</div>
				</div>
			</div>
			<RightPanel />
			<QuickOpen />
		</div>
	);
}
