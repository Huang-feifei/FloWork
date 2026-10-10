/**
 * 终端窗口式的会话区：标题栏 + 会话记录 + 输入行 + 状态栏（参考 pi / Claude Code 的 TUI 布局）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ThinkingLevel } from "@shared/protocol";
import { basename, formatTokens } from "../../lib/format";
import { useApp } from "../../store";
import { Spinner, useElapsed } from "./Spinner";
import { Transcript } from "./Transcript";

function TitleBar() {
	const state = useApp((s) => s.state);
	const cwd = useApp((s) => s.cwd);
	return (
		<div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-term-bar px-4">
			<div className="flex gap-1.5">
				<span className="size-2.5 rounded-full bg-[#e8786b]" />
				<span className="size-2.5 rounded-full bg-[#e8bb5a]" />
				<span className="size-2.5 rounded-full bg-[#7cc480]" />
			</div>
			<div className="min-w-0 flex-1 truncate text-center font-mono text-xs text-muted">
				{state?.sessionName || "新会话"} — {cwd ? basename(cwd) : ""}
			</div>
			<div className="w-10" />
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
	const [since, setSince] = useState<number | null>(null);
	useEffect(() => setSince(isRunning ? Date.now() : null), [isRunning]);
	const elapsed = useElapsed(since);
	if (!isRunning) return null;
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

	useEffect(() => {
		if (ready) ref.current?.focus();
	}, [ready]);

	// 自适应高度
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "0px";
		el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
	}, [text]);

	const submit = () => {
		if (!text.trim() || !ready) return;
		void sendPrompt(text);
		setText("");
	};

	return (
		<div className="rounded-md border border-border-strong bg-panel px-3 py-2 focus-within:border-accent">
			<div className="grid grid-cols-[2ch_1fr] gap-x-1">
				<span className="font-bold text-accent">❯</span>
				<textarea
					ref={ref}
					value={text}
					rows={1}
					disabled={!ready}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							submit();
						} else if (e.key === "Escape" && isRunning) {
							e.preventDefault();
							void abort();
						}
					}}
					placeholder={ready ? (isRunning ? "运行中，输入的消息会排在当前任务之后" : "输入任务…") : "正在启动 pi…"}
					className="term min-h-[1.65em] w-full resize-none bg-transparent outline-none placeholder:text-muted/70"
				/>
			</div>
		</div>
	);
}

function StatusLine() {
	const state = useApp((s) => s.state);
	const models = useApp((s) => s.models);
	const messages = useApp((s) => s.messages);
	const cwd = useApp((s) => s.cwd);
	const { setModel, setThinkingLevel } = useApp.getState();

	const totals = useMemo(() => {
		let input = 0;
		let output = 0;
		let cost = 0;
		let lastContext = 0;
		for (const m of messages) {
			if (m.role !== "assistant" || !m.usage) continue;
			input += m.usage.input + m.usage.cacheRead;
			output += m.usage.output;
			cost += m.usage.cost.total;
			if (m.usage.totalTokens > 0) lastContext = m.usage.totalTokens;
		}
		return { input, output, cost, lastContext };
	}, [messages]);

	const currentKey = state?.model ? `${state.model.provider}/${state.model.id}` : "";
	const contextWindow = state?.model?.contextWindow;
	const contextPct = contextWindow && totals.lastContext ? Math.round((totals.lastContext / contextWindow) * 100) : null;

	return (
		<div className="flex items-center gap-3 px-1 pt-1.5 text-[11.5px] text-muted">
			<span className="truncate" title={cwd ?? undefined}>
				{cwd}
			</span>
			<div className="flex-1" />
			{totals.input + totals.output > 0 && (
				<span title="累计输入 / 输出 token">
					↑{formatTokens(totals.input)} ↓{formatTokens(totals.output)}
					{totals.cost > 0 ? ` $${totals.cost.toFixed(3)}` : ""}
					{contextPct !== null ? ` · 上下文 ${contextPct}%` : ""}
				</span>
			)}
			{state && state.availableThinkingLevels.length > 1 && (
				<select
					value={state.thinkingLevel}
					onChange={(e) => void setThinkingLevel(e.target.value as ThinkingLevel)}
					className="bg-transparent text-muted outline-none hover:text-fg"
					title="思考等级"
				>
					{state.availableThinkingLevels.map((level) => (
						<option key={level} value={level}>
							思考 {level}
						</option>
					))}
				</select>
			)}
			{models.length > 0 && (
				<select
					value={currentKey}
					onChange={(e) => {
						const model = models.find((m) => `${m.provider}/${m.id}` === e.target.value);
						if (model) void setModel(model);
					}}
					className="max-w-72 bg-transparent font-medium text-fg outline-none"
					title="切换模型"
				>
					{!currentKey && <option value="">选择模型</option>}
					{models.map((m) => (
						<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
							{m.provider}/{m.id}
						</option>
					))}
				</select>
			)}
		</div>
	);
}

export function TerminalView() {
	const connecting = useApp((s) => s.connecting);
	const messages = useApp((s) => s.messages);
	const streaming = useApp((s) => s.streaming);
	const isRunning = useApp((s) => s.isRunning);
	const abort = useApp((s) => s.abort);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	// 用户上滚查看历史时不强制滚到底部
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
	}, [messages, streaming, isRunning]);

	// 运行中按 Esc 中断（焦点不在输入框时也生效）
	useEffect(() => {
		if (!isRunning) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) void abort();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isRunning, abort]);

	return (
		<div className="flex min-h-0 flex-1 flex-col p-4 pt-3">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-term shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(60,40,20,0.12)]">
				<TitleBar />
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
						{connecting ? (
							<div className="text-muted">
								<Spinner /> 正在启动 pi…
							</div>
						) : (
							<Transcript />
						)}
						<RunningLine />
					</div>
				</div>
				<div className="term shrink-0 border-t border-border bg-term px-6 pt-3 pb-2">
					<div className="mx-auto max-w-4xl">
						<PromptInput />
						<StatusLine />
					</div>
				</div>
			</div>
		</div>
	);
}
