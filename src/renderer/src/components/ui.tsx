/** 少量通用界面元素，保持各页面风格一致 */
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

type Variant = "primary" | "default" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
	primary: "bg-accent text-accent-foreground hover:bg-accent-strong font-medium",
	default: "border border-border-strong bg-panel-2 hover:border-border-strong hover:bg-highlight",
	danger: "border border-err/50 text-err hover:bg-err-soft",
	ghost: "text-muted hover:text-fg hover:bg-panel-2",
};

export function Button({
	variant = "default",
	size = "md",
	className = "",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
	const sizing = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
	return (
		<button
			type="button"
			{...props}
			className={`rounded-md ${sizing} ${VARIANT[variant]} disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
		/>
	);
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
	return (
		<input
			{...props}
			className={`w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent ${className}`}
		/>
	);
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
	return (
		<select
			{...props}
			className={`w-full rounded-md border border-border bg-panel px-2 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 ${className}`}
		/>
	);
}

export function TextArea({ className = "", ...props }: ComponentProps<"textarea">) {
	return (
		<textarea
			{...props}
			className={`w-full rounded-md border border-border bg-panel px-2.5 py-1.5 font-mono text-xs leading-5 outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 ${className}`}
		/>
	);
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<label className="block">
			<div className="mb-1 text-xs font-medium text-fg/90">{label}</div>
			{children}
			{hint && <div className="mt-1 text-[11px] leading-4 text-muted">{hint}</div>}
		</label>
	);
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "ok" | "warn" | "accent" | "err"; children: ReactNode }) {
	const tones = {
		muted: "bg-panel-2 text-muted",
		ok: "bg-ok/15 text-ok",
		warn: "bg-warn/15 text-warn",
		accent: "bg-accent/15 text-accent",
		err: "bg-err/15 text-err",
	};
	return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

export function Modal({
	title,
	onClose,
	children,
	footer,
	width = "w-[560px]",
}: {
	title: ReactNode;
	onClose: () => void;
	children: ReactNode;
	footer?: ReactNode;
	width?: string;
}) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6 backdrop-blur-[2px]">
			<div className={`fw-float flex max-h-full ${width} max-w-full flex-col rounded-xl border border-border-strong`}>
				<div className="flex items-center gap-2 border-b border-border px-4 py-3">
					<div className="min-w-0 flex-1 truncate font-medium">{title}</div>
					<button type="button" onClick={onClose} className="text-muted hover:text-fg">
						✕
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
				{footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
			</div>
		</div>
	);
}
