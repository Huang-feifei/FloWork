/**
 * 第三方扩展的对话框（ctx.ui.select / confirm / input / editor），以终端提示的形式显示在会话末尾：
 *   ◆ 选择部署环境                         25s
 *     ❯ 1. staging
 *       2. production
 *     ↑↓ 选择 · Enter 确认 · Esc 取消
 * 同时只有第一个对话框可操作，其余排队显示。
 */
import { useEffect, useRef, useState } from "react";
import type { ExtUIRequest } from "@shared/protocol";
import { type ExtWidget, useApp } from "../../store";
import { Markdown } from "./Markdown";

type Respond = (response: { value?: string; confirmed?: boolean } | null) => void;

const KEY_HINT = "rounded border border-border-strong px-2 outline-none hover:bg-panel-2 focus:ring-2 focus:ring-accent/20";

/** 剩余秒数；没有超时返回 null */
function useCountdown(timeoutMs: number | undefined): number | null {
	const [receivedAt] = useState(() => Date.now());
	const [now, setNow] = useState(receivedAt);
	useEffect(() => {
		if (!timeoutMs) return;
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [timeoutMs]);
	return timeoutMs ? Math.max(0, Math.ceil((receivedAt + timeoutMs - now) / 1000)) : null;
}

function SelectBody({ request, active, respond }: { request: ExtUIRequest; active: boolean; respond: Respond }) {
	const options = request.options ?? [];
	const [index, setIndex] = useState(0);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (active) ref.current?.focus();
	}, [active]);
	return (
		<div
			ref={ref}
			role="listbox"
			tabIndex={active ? 0 : -1}
			aria-activedescendant={`ext-opt-${request.id}-${index}`}
			className="rounded outline-none focus:ring-2 focus:ring-accent/20"
			onKeyDown={(e) => {
				if (e.key === "ArrowDown") setIndex((i) => (i + 1) % options.length);
				else if (e.key === "ArrowUp") setIndex((i) => (i - 1 + options.length) % options.length);
				else if (e.key === "Enter" && options[index] !== undefined) respond({ value: options[index] });
				else if (e.key === "Escape") respond(null);
				else if (/^[1-9]$/.test(e.key) && options[Number(e.key) - 1] !== undefined) respond({ value: options[Number(e.key) - 1] });
				else return;
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			{options.map((option, i) => (
				<button
					key={`${i}-${option}`}
					id={`ext-opt-${request.id}-${i}`}
					type="button"
					role="option"
					aria-selected={i === index}
					tabIndex={-1}
					onMouseEnter={() => setIndex(i)}
					onClick={() => respond({ value: option })}
					className={`grid w-full grid-cols-[2ch_3ch_1fr] text-left ${i === index ? "bg-accent-soft text-accent" : ""}`}
				>
					<span>{i === index ? "❯" : ""}</span>
					<span className="text-muted">{i < 9 ? `${i + 1}.` : ""}</span>
					<span className="whitespace-pre-wrap break-all">{option}</span>
				</button>
			))}
			<div className="pt-1 text-faint">↑↓ 选择 · Enter 确认 · 1–9 快速选择 · Esc 取消</div>
		</div>
	);
}

function ConfirmBody({ request, active, respond }: { request: ExtUIRequest; active: boolean; respond: Respond }) {
	const ref = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (active) ref.current?.focus();
	}, [active]);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 键盘快捷键作用于内部按钮
		<div
			onKeyDown={(e) => {
				const key = e.key.toLowerCase();
				if (key === "y") respond({ confirmed: true });
				else if (key === "n" || key === "escape") respond({ confirmed: false });
				else return;
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			{request.message && (request.purpose === "plan"
				? <div className="my-2 max-h-[50vh] overflow-y-auto rounded-lg border border-border bg-panel p-3"><Markdown text={request.message} /></div>
				: <div className="my-1 border-l-2 border-accent/30 pl-3 whitespace-pre-wrap">{request.message}</div>)}
			<div className="flex flex-wrap gap-2 pt-1">
				<button
					ref={ref}
					type="button"
					onClick={() => respond({ confirmed: true })}
					className="rounded border border-ok/50 bg-ok-soft px-2 text-ok outline-none hover:bg-ok/20 focus:ring-2 focus:ring-ok/30"
				>
					[y] {request.confirmLabel ?? "确定"}
				</button>
				<button
					type="button"
					onClick={() => respond({ confirmed: false })}
					className={KEY_HINT}
				>
					[n] {request.cancelLabel ?? "取消"}
				</button>
			</div>
		</div>
	);
}

function TextBody({ request, active, respond }: { request: ExtUIRequest; active: boolean; respond: Respond }) {
	const multiline = request.method === "editor";
	const [value, setValue] = useState(request.prefill ?? "");
	const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
	useEffect(() => {
		if (active) ref.current?.focus();
	}, [active]);
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") respond(null);
		else if (e.key === "Enter" && (multiline ? e.ctrlKey || e.metaKey : !e.nativeEvent.isComposing)) respond({ value });
		else return;
		e.preventDefault();
		e.stopPropagation();
	};
	const field = "w-full rounded border border-border-strong bg-term px-2 py-1 outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/15";
	return (
		<div>
			{multiline ? (
				<textarea
					ref={ref}
					value={value}
					rows={Math.min(16, Math.max(4, value.split("\n").length + 1))}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={onKeyDown}
					className={`${field} resize-y`}
				/>
			) : (
				<input
					ref={ref}
					value={value}
					placeholder={request.placeholder}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={onKeyDown}
					className={field}
				/>
			)}
			<div className="flex flex-wrap items-center gap-2 pt-1">
				<button
					type="button"
					onClick={() => respond({ value })}
					className="rounded border border-ok/50 bg-ok-soft px-2 text-ok outline-none hover:bg-ok/20 focus:ring-2 focus:ring-ok/30"
				>
					{multiline ? "Ctrl+Enter 提交" : "Enter 提交"}
				</button>
				<button
					type="button"
					onClick={() => respond(null)}
					className={KEY_HINT}
				>
					Esc 取消
				</button>
			</div>
		</div>
	);
}

function ExtDialogItem({ request, active }: { request: ExtUIRequest; active: boolean }) {
	const respondExtUI = useApp((s) => s.respondExtUI);
	const remaining = useCountdown(request.timeoutMs);
	const respond: Respond = (response) => void respondExtUI(request.id, response);
	const Body = request.method === "select" ? SelectBody : request.method === "confirm" ? ConfirmBody : TextBody;
	return (
		<div
			className={`grid grid-cols-[2ch_1fr] gap-x-1 rounded-md border px-3 py-2 ${
				active ? "border-accent/50 bg-accent-soft/40" : "pointer-events-none border-border opacity-60"
			}`}
		>
			<span className="text-accent">◆</span>
			<div className="min-w-0">
				<div className="flex items-baseline gap-2">
					<span className="font-bold whitespace-pre-wrap">{request.title}</span>
					<span className="text-faint">{request.purpose === "plan" ? "计划审批" : request.purpose === "question" ? "需要你决策" : "扩展"}</span>
					<span className="flex-1" />
					{remaining !== null && (
						<span
							className={`tabular-nums ${remaining <= 5 ? "text-warn" : "text-muted"}`}
							title="超时后按取消处理"
						>
							{remaining}s
						</span>
					)}
				</div>
				<div className="pt-1">
					<Body
						request={request}
						active={active}
						respond={respond}
					/>
				</div>
			</div>
		</div>
	);
}

export function ExtDialogPanel() {
	const dialogs = useApp((s) => s.extDialogs);
	// 工具审批优先：有审批在等待时，对话框不抢焦点
	const approvalsWaiting = useApp((s) => s.pendingApprovals.length > 0);
	if (dialogs.length === 0) return null;
	return (
		<div className="flex flex-col gap-2">
			{dialogs.map((request, i) => (
				<ExtDialogItem
					key={request.id}
					request={request}
					active={i === 0 && !approvalsWaiting}
				/>
			))}
		</div>
	);
}

/** 扩展通过 ctx.ui.setWidget 放在输入框上方 / 下方的文本块 */
export function ExtWidgets({ placement }: { placement: ExtWidget["placement"] }) {
	const widgets = useApp((s) => s.extWidgets);
	const list = Object.entries(widgets).filter(([, w]) => w.placement === placement);
	if (list.length === 0) return null;
	return (
		<div className={`flex flex-col gap-1 font-mono text-[12px] text-muted ${placement === "aboveEditor" ? "pb-1.5" : "pt-1.5"}`}>
			{list.map(([key, w]) => (
				<pre
					key={key}
					title={`扩展小组件 · ${key}`}
					className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all"
				>
					{w.lines.join("\n")}
				</pre>
			))}
		</div>
	);
}
