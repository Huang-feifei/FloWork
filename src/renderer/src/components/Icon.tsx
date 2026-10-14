/**
 * 界面图标：线条风格，路径取自 Lucide（ISC 许可）。
 * 只收录用到的几个，避免为图标引入整个依赖包。
 */
import type { ReactNode } from "react";

const PATHS = {
	/* 活动栏 / 侧栏 */
	messages: (
		<>
			<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z" />
			<path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
		</>
	),
	files: (
		<>
			<path d="M20 7h-3a2 2 0 0 1-2-2V2" />
			<path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l5 5v9a2 2 0 0 1-2 2Z" />
			<path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8" />
		</>
	),
	search: (
		<>
			<circle
				cx="11"
				cy="11"
				r="8"
			/>
			<path d="m21 21-4.3-4.3" />
		</>
	),
	"git-compare": (
		<>
			<circle
				cx="18"
				cy="18"
				r="3"
			/>
			<circle
				cx="6"
				cy="6"
				r="3"
			/>
			<path d="M13 6h3a2 2 0 0 1 2 2v7" />
			<path d="M11 18H8a2 2 0 0 1-2-2V9" />
		</>
	),
	"square-terminal": (
		<>
			<path d="m7 11 2-2-2-2" />
			<path d="M11 13h4" />
			<rect
				width="18"
				height="18"
				x="3"
				y="3"
				rx="2"
			/>
		</>
	),
	terminal: (
		<>
			<path d="m4 17 6-6-6-6" />
			<path d="M12 19h8" />
		</>
	),

	/* 窗口框架 */
	"panel-left": (
		<>
			<rect
				width="18"
				height="18"
				x="3"
				y="3"
				rx="2"
			/>
			<path d="M9 3v18" />
		</>
	),
	"panel-right": (
		<>
			<rect
				width="18"
				height="18"
				x="3"
				y="3"
				rx="2"
			/>
			<path d="M15 3v18" />
		</>
	),
	"panel-bottom": (
		<>
			<rect
				width="18"
				height="18"
				x="3"
				y="3"
				rx="2"
			/>
			<path d="M3 15h18" />
		</>
	),
	minus: <path d="M5 12h14" />,
	square: (
		<rect
			width="18"
			height="18"
			x="3"
			y="3"
			rx="2"
		/>
	),
	x: (
		<>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</>
	),

	/* 通用操作 */
	"square-pen": (
		<>
			<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
			<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
		</>
	),
	pencil: (
		<>
			<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
			<path d="m15 5 4 4" />
		</>
	),
	"folder-plus": (
		<>
			<path d="M12 10v6" />
			<path d="M9 13h6" />
			<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
		</>
	),
	folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
	"folder-open": (
		<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
	),
	"file-code": (
		<>
			<path d="M10 12.5 8 15l2 2.5" />
			<path d="m14 12.5 2 2.5-2 2.5" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
		</>
	),
	"file-json": (
		<>
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
			<path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
			<path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
		</>
	),
	"message-square": <path d="M22 17a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />,
	plus: (
		<>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</>
	),
	"arrow-up": (
		<>
			<path d="m5 12 7-7 7 7" />
			<path d="M12 19V5" />
		</>
	),
	"arrow-left": (
		<>
			<path d="m12 19-7-7 7-7" />
			<path d="M19 12H5" />
		</>
	),
	"arrow-right": (
		<>
			<path d="m12 5 7 7-7 7" />
			<path d="M5 12h14" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M2 12h20" />
			<path d="M12 2a17 17 0 0 1 0 20 17 17 0 0 1 0-20" />
		</>
	),
	palette: (
		<>
			<circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
			<circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
			<circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
			<circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
			<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
		</>
	),
	"at-sign": (
		<>
			<circle
				cx="12"
				cy="12"
				r="4"
			/>
			<path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
		</>
	),
	"chevron-down": <path d="m6 9 6 6 6-6" />,
	"chevron-right": <path d="m9 18 6-6-6-6" />,
	"chevron-up": <path d="m18 15-6-6-6 6" />,
	"loader-circle": <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
	refresh: (
		<>
			<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
			<path d="M21 3v5h-5" />
			<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
			<path d="M8 16H3v5" />
		</>
	),
	stop: (
		<rect
			width="12"
			height="12"
			x="6"
			y="6"
			rx="2"
			fill="currentColor"
		/>
	),

	/* 会话区 */
	"git-fork": (
		<>
			<circle
				cx="12"
				cy="18"
				r="3"
			/>
			<circle
				cx="6"
				cy="6"
				r="3"
			/>
			<circle
				cx="18"
				cy="6"
				r="3"
			/>
			<path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
			<path d="M12 12v3" />
		</>
	),
	"list-tree": (
		<>
			<path d="M21 12h-8" />
			<path d="M21 6H8" />
			<path d="M21 18h-8" />
			<path d="M3 6v4c0 1.1.9 2 2 2h3" />
			<path d="M3 10v6c0 1.1.9 2 2 2h3" />
		</>
	),
	"git-branch": (
		<>
			<line
				x1="6"
				x2="6"
				y1="3"
				y2="15"
			/>
			<circle
				cx="18"
				cy="6"
				r="3"
			/>
			<circle
				cx="6"
				cy="18"
				r="3"
			/>
			<path d="M18 9a9 9 0 0 1-9 9" />
		</>
	),
	"shield-alert": (
		<>
			<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
			<path d="M12 8v4" />
			<path d="M12 16h.01" />
		</>
	),
	settings: (
		<>
			<path d="M20 7h-9" />
			<path d="M14 17H5" />
			<circle
				cx="17"
				cy="17"
				r="3"
			/>
			<circle
				cx="7"
				cy="7"
				r="3"
			/>
		</>
	),
	cpu: (
		<>
			<rect
				width="16"
				height="16"
				x="4"
				y="4"
				rx="2"
			/>
			<rect
				width="6"
				height="6"
				x="9"
				y="9"
				rx="1"
			/>
			<path d="M15 2v2" />
			<path d="M15 20v2" />
			<path d="M2 15h2" />
			<path d="M2 9h2" />
			<path d="M20 15h2" />
			<path d="M20 9h2" />
			<path d="M9 2v2" />
			<path d="M9 20v2" />
		</>
	),
	lock: (
		<>
			<rect
				width="18"
				height="11"
				x="3"
				y="11"
				rx="2"
				ry="2"
			/>
			<path d="M7 11V7a5 5 0 0 1 10 0v4" />
		</>
	),
	ellipsis: (
		<>
			<circle
				cx="12"
				cy="12"
				r="1"
			/>
			<circle
				cx="19"
				cy="12"
				r="1"
			/>
			<circle
				cx="5"
				cy="12"
				r="1"
			/>
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
