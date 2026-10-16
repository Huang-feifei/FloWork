/** 少量通用界面元素，保持各页面风格一致。
 *  外观按 Apple 体系（DESIGN.md）：按钮一律 pill，主操作用唯一的蓝，破坏性操作用红；
 *  输入框 10px 圆角 + 发丝边框 + 蓝色 focus ring；徽标是软色胶囊；分段控件优先于页签，开关优先于复选框。 */
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { useBrowserOcclusion } from "../lib/browser";

type Variant = "primary" | "default" | "danger" | "ghost" | "link";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
	primary: "bg-primary font-medium text-primary-foreground hover:bg-primary-strong",
	default: "bg-panel-2 text-fg hover:bg-highlight",
	danger: "bg-danger font-medium text-danger-foreground hover:bg-danger-strong",
	ghost: "text-muted hover:bg-panel-2 hover:text-fg",
	link: "h-auto px-0 font-medium text-primary hover:underline underline-offset-2",
};

const SIZE: Record<Size, string> = {
	sm: "h-8 px-3.5 text-[12.5px]",
	md: "h-9 px-4 text-[13.5px]",
	lg: "h-11 px-5 text-[15px]",
};

export function Button({
	variant = "default",
	size = "md",
	className = "",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
	const sizing = variant === "link" ? "" : SIZE[size];
	return (
		<button
			type="button"
			{...props}
			className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full transition-colors ${
				sizing
			} ${VARIANT[variant]} disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
		/>
	);
}

const FIELD =
	"w-full rounded-[10px] border border-border bg-surface-raised px-3 py-2 text-[13.5px] text-fg outline-none placeholder:text-muted/70 focus:border-primary/40 focus:ring-4 focus:ring-primary/10";

export function Input({ className = "", ...props }: ComponentProps<"input">) {
	return <input {...props} className={`${FIELD} ${className}`} />;
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
	return <select {...props} className={`${FIELD} cursor-pointer ${className}`} />;
}

export function TextArea({ className = "", ...props }: ComponentProps<"textarea">) {
	return <textarea {...props} className={`${FIELD} resize-none font-mono text-[12.5px] leading-5 ${className}`} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<label className="block">
			<div className="mb-1.5 text-[12.5px] font-medium text-fg">{label}</div>
			{children}
			{hint && <div className="mt-1.5 text-[11.5px] leading-4 text-muted">{hint}</div>}
		</label>
	);
}

export function Badge({
	tone = "muted",
	children,
}: {
	tone?: "muted" | "ok" | "warn" | "accent" | "err" | "primary";
	children: ReactNode;
}) {
	const tones = {
		muted: "bg-panel-2 text-muted",
		ok: "bg-ok-soft text-accent-strong",
		warn: "bg-warn-soft text-warn",
		accent: "bg-accent-soft text-accent-strong",
		err: "bg-err-soft text-err",
		primary: "bg-primary-soft text-primary",
	};
	return (
		<span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap ${tones[tone]}`}>
			{children}
		</span>
	);
}

/** 白卡片：DESIGN.md 里 24–32px 内边距的圆角大块 */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
	return <div className={`fw-card p-6 ${className}`}>{children}</div>;
}

/** 开关：优先于复选框（DESIGN.md: toggles over checkboxes） */
export function Toggle({ on = false, onChange, title }: { on?: boolean; onChange?: (next: boolean) => void; title?: string }) {
	return (
		<button
			type="button"
			title={title}
			role="switch"
			aria-checked={on}
			onClick={() => onChange?.(!on)}
			className={`inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-[2px] transition-colors ${
				on ? "bg-accent" : "bg-border-strong"
			}`}
		>
			<span className={`size-[18px] rounded-full bg-white shadow-sm transition-transform ${on ? "ml-auto" : ""}`} />
		</button>
	);
}

/** 分段控件：优先于页签（DESIGN.md: segmented controls over tabs） */
export function Segmented({
	items,
	active,
	onChange,
}: {
	items: { id: string; label: string; title?: string }[];
	active: string;
	onChange?: (id: string) => void;
}) {
	return (
		<div className="fw-seg">
			{items.map((i) => (
				<button
					type="button"
					key={i.id}
					title={i.title}
					onClick={() => onChange?.(i.id)}
					className={`fw-seg-item ${i.id === active ? "fw-seg-item-active" : ""}`}
				>
					{i.label}
				</button>
			))}
		</div>
	);
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
	useBrowserOcclusion();
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6 backdrop-blur-[2px]">
			<div className={`fw-float flex max-h-full ${width} max-w-full flex-col overflow-hidden rounded-[20px]`}>
				<div className="flex items-center gap-3 px-6 pt-5 pb-4">
					<div className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">{title}</div>
					<button
						type="button"
						onClick={onClose}
						className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-fg"
					>
						<span className="icon-[lucide--x] size-4" />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">{children}</div>
				{footer && <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">{footer}</div>}
			</div>
		</div>
	);
}
