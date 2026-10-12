/**
 * 界面图标：线条风格，路径取自 Lucide（ISC 许可）。
 * 只收录用到的几个，避免为图标引入整个依赖包。
 */
import type { ReactNode } from "react";

const PATHS = {
	search: (
		<>
			<circle cx="11" cy="11" r="8" />
			<path d="m21 21-4.3-4.3" />
		</>
	),
	"panel-left": (
		<>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M9 3v18" />
		</>
	),
	"panel-right": (
		<>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M15 3v18" />
		</>
	),
	"square-pen": (
		<>
			<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
			<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
		</>
	),
	"folder-plus": (
		<>
			<path d="M12 10v6" />
			<path d="M9 13h6" />
			<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
		</>
	),
	settings: (
		<>
			<path d="M20 7h-9" />
			<path d="M14 17H5" />
			<circle cx="17" cy="17" r="3" />
			<circle cx="7" cy="7" r="3" />
		</>
	),
	ellipsis: (
		<>
			<circle cx="12" cy="12" r="1" />
			<circle cx="19" cy="12" r="1" />
			<circle cx="5" cy="12" r="1" />
		</>
	),
	"arrow-up": (
		<>
			<path d="m5 12 7-7 7 7" />
			<path d="M12 19V5" />
		</>
	),
	stop: <rect width="12" height="12" x="6" y="6" rx="2" fill="currentColor" />,
	terminal: (
		<>
			<path d="m4 17 6-6-6-6" />
			<path d="M12 19h8" />
		</>
	),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={`shrink-0 ${className}`}
		>
			{PATHS[name]}
		</svg>
	);
}
