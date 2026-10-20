/**
 * 等待你决定的卡片：内置 ask_user / submit_plan，以及第三方扩展的 ctx.ui.* 对话框。
 * 停靠在输入框上方（不再插入会话流），因此永远贴着你要动手的地方：
 *   ┌ 需要你决策                    12s
 *   │ 这个问题…（正文可 Markdown）
 *   │ 1 ▸ 选项                     ← 选中项高亮
 *   │ ↑↓ 选择 · Enter 确认 · Esc 取消
 * 同时只有第一个可操作，其余排队显示条数。
 */
import { useEffect, useRef, useState } from "react";
import type { ExtUIRequest } from "@shared/protocol";
import { type ExtWidget, useApp } from "../../store";
import { Markdown } from "./Markdown";

type Respond = (response: { value?: string; confirmed?: boolean } | null) => void;

const FIELD =
	"w-full rounded-[10px] border border-border-strong bg-surface-raised px-3 py-2 text-[13px] text-fg outline-none placeholder:text-muted/70 focus:border-accent/50 focus:ring-4 focus:ring-accent/10";
const PRIMARY =
	"inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[12.5px] font-medium text-primary-foreground outline-none hover:bg-primary-strong focus:ring-4 focus:ring-primary/20";
const SECONDARY =
	"inline-flex items-center gap-1.5 rounded-full bg-panel-2 px-3.5 py-1.5 text-[12.5px] text-fg outline-none hover:bg-highlight focus:ring-4 focus:ring-primary/10";

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

function Hint({ children }: { children: React.ReactNode }) {
	return <div className="pt-2 text-[11.5px] leading-4 text-faint">{children}</div>;
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
			className="flex flex-col gap-0.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
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
					className={`flex w-full items-start gap-2.5 rounded-xl border px-2.5 py-2 text-left text-[13px] leading-5 transition-colors ${
						i === index ? "border-accent/40 bg-accent-soft text-fg" : "border-transparent text-muted hover:bg-panel-2 hover:text-fg"
					}`}
				>
					<span
						className={`mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10.5px] font-medium tabular-nums ${
							i === index ? "bg-accent text-accent-foreground" : "bg-panel-2 text-muted"
						}`}
					>
						{i < 9 ? i + 1 : "·"}
					</span>
					<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{option}</span>
				</button>
			))}
			<Hint>↑↓ 选择 · Enter 确认 · 1–9 快速选择 · Esc 取消</Hint>
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
				? (
						<div className="max-h-[34vh] overflow-y-auto rounded-xl border border-border bg-surface px-3.5 py-2.5">
							<Markdown text={request.message} />
						</div>
					)
				: <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{request.message}</div>)}
			<div className="flex flex-wrap items-center gap-2 pt-2.5">
				<button
					ref={ref}
					type="button"
					onClick={() => respond({ confirmed: true })}
					className={PRIMARY}
				>
					{request.confirmLabel ?? "确认"}
				</button>
				<button
					type="button"
					onClick={() => respond({ confirmed: false })}
					className={SECONDARY}
				>
					{request.cancelLabel ?? "取消"}
				</button>
				<span className="text-[11.5px] text-faint">Y 确认 · N / Esc 取消</span>
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
	return (
		<div>
			{multiline ? (
				<textarea
					ref={ref}
					value={value}
					rows={Math.min(14, Math.max(4, value.split("\n").length + 1))}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={onKeyDown}
					className={`${FIELD} resize-y font-mono text-[12.5px] leading-5`}
				/>
			) : (
				<input
					ref={ref}
					value={value}
					placeholder={request.placeholder}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={onKeyDown}
					className={FIELD}
				/>
			)}
			<div className="flex flex-wrap items-center gap-2 pt-2.5">
				<button
					type="button"
					onClick={() => respond({ value })}
					className={PRIMARY}
				>
					{multiline ? "提交（Ctrl+Enter）" : "提交（Enter）"}
				</button>
				<button
					type="button"
					onClick={() => respond(null)}
					className={SECONDARY}
				>
					取消（Esc）
				</button>
			</div>
		</div>
	);
}

const PURPOSE_TONE = {
	question: "bg-accent-soft text-accent",
	plan: "bg-warn-soft text-warn",
	other: "bg-panel-2 text-muted",
} as const;

const PURPOSE_LABEL = { question: "需要你决策", plan: "计划审批", other: "扩展请求" } as const;

function ExtDialogItem({ request, active }: { request: ExtUIRequest; active: boolean }) {
	const respondExtUI = useApp((s) => s.respondExtUI);
	const remaining = useCountdown(request.timeoutMs);
	const respond: Respond = (response) => void respondExtUI(request.id, response);
	const Body = request.method === "select" ? SelectBody : request.method === "confirm" ? ConfirmBody : TextBody;
	const purpose = request.purpose ?? "other";
	return (
		<div
			className={`w-full min-w-0 overflow-hidden rounded-[18px] border bg-surface-raised transition-colors ${
				active ? "border-accent/35 shadow-[0_10px_30px_-24px_var(--color-shadow)]" : "border-border/70 opacity-60"
			}`}
		>
			<div className="flex items-start gap-2.5 px-4 pt-3.5">
				<span
					className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10.5px] font-medium ${
						PURPOSE_TONE[purpose]
					}`}
				>
					{purpose === "question" ? "?" : "◆"}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${PURPOSE_TONE[purpose]}`}>
							{PURPOSE_LABEL[purpose]}
						</span>
						<span className="flex-1" />
						{remaining !== null && (
							<span
								className={`tabular-nums text-[11.5px] ${remaining <= 5 ? "text-warn" : "text-faint"}`}
								title="超时后按取消处理"
							>
								{remaining}s
							</span>
						)}
					</div>
					<div className="pt-1 text-[14px] leading-[1.55] font-medium whitespace-pre-wrap text-fg">{request.title}</div>
				</div>
			</div>
			<div className={`px-4 pt-1.5 pb-3.5 ${active ? "" : "pointer-events-none"}`}>
				<Body
					request={request}
					active={active}
					respond={respond}
				/>
			</div>
		</div>
	);
}

export function ExtDialogPanel() {
	const dialogs = useApp((s) => s.extDialogs);
	// 工具审批优先：有审批在等待时，对话框不抢焦点
	const approvalsWaiting = useApp((s) => s.pendingApprovals.length > 0);
	const head = dialogs[0];
	if (!head) return null;
	return (
		<div className="flex w-full flex-col gap-1.5">
			<ExtDialogItem
				key={head.id}
				request={head}
				active={!approvalsWaiting}
			/>
			{dialogs.length > 1 && (
				<div className="px-1 text-[11.5px] text-faint">另有 {dialogs.length - 1} 个对话框排队，先处理上面这个</div>
			)}
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
