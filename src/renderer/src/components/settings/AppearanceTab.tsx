/**
 * 外观设置：界面主题（深色 / 浅色 / 跟随系统）。
 * 只影响界面外观，保存在本机 localStorage，不写入 pi 的 settings.json。
 * Apple 体系：三个主题选项做成带迷你预览的白色卡片，选中态是蓝色软底 + 蓝色单选圈。
 */
import { useApp } from "../../store";
import type { ThemeMode } from "../../theme";

const OPTIONS: Array<{ id: ThemeMode; label: string; desc: string }> = [
	{ id: "system", label: "跟随系统", desc: "随操作系统的浅色 / 深色设置自动切换" },
	{ id: "dark", label: "深色", desc: "深石墨底 + 琥珀橙强调" },
	{ id: "light", label: "浅色", desc: "白卡片 + 蓝色强调（默认）" },
];

/** 迷你窗口预览：左半浅右半深表示跟随系统 */
function Preview({ mode }: { mode: ThemeMode }) {
	const dark = mode === "dark";
	const split = mode === "system";

	return (
		<div className="flex h-[58px] overflow-hidden rounded-lg border border-border">
			{!dark && (
				<div className={`flex flex-col bg-surface-raised ${split ? "w-1/2 border-r border-border" : "w-full"}`}>
					<div className="flex h-4 items-center gap-1 border-b border-border bg-surface px-2">
						<span className="size-1.5 rounded-full bg-border-strong" />
						<span className="size-1.5 rounded-full bg-border-strong" />
					</div>
					<div className="space-y-1.5 p-2">
						<div className="h-1.5 w-2/3 rounded-full bg-border" />
						<div className="h-1.5 w-1/2 rounded-full bg-panel-2" />
						<div className="grid grid-cols-2 gap-1.5 pt-0.5">
							<div className="h-3 rounded bg-panel-2" />
							<div className="h-3 rounded bg-panel-2" />
						</div>
					</div>
				</div>
			)}

			{(dark || split) && (
				<div className={`flex flex-col bg-fg ${split ? "w-1/2" : "w-full"}`}>
					<div className="flex h-4 items-center gap-1 border-b border-white/10 bg-white/10 px-2">
						<span className="size-1.5 rounded-full bg-white/30" />
						<span className="size-1.5 rounded-full bg-white/30" />
					</div>
					<div className="space-y-1.5 p-2">
						<div className="h-1.5 w-2/3 rounded-full bg-white/25" />
						<div className="h-1.5 w-1/2 rounded-full bg-white/15" />
						<div className="grid grid-cols-2 gap-1.5 pt-0.5">
							<div className="h-3 rounded bg-white/15" />
							<div className="h-3 rounded bg-white/15" />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export function AppearanceTab() {
	const theme = useApp((s) => s.theme);
	const resolved = useApp((s) => s.resolvedTheme);
	const setTheme = useApp((s) => s.setTheme);

	return (
		<div className="space-y-6">
			<div className="fw-card p-5">
				<div className="mb-4 text-[15px] font-semibold tracking-tight">界面主题</div>
				<div className="grid grid-cols-3 gap-4">
					{OPTIONS.map((option) => {
						const active = theme === option.id;
						return (
							<button
								type="button"
								key={option.id}
								onClick={() => setTheme(option.id)}
								className={`rounded-2xl border p-3 text-left ${
									active ? "border-primary/40 bg-primary-soft" : "border-border hover:bg-panel-2"
								}`}
							>
								<Preview mode={option.id} />
								<div className="mt-3 flex items-center gap-2">
									<span className={`flex-1 text-[13.5px] ${active ? "font-medium text-primary" : "text-fg"}`}>
										{option.label}
									</span>
									<span
										className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
											active ? "border-primary" : "border-border-strong"
										}`}
									>
										{active && <span className="size-2 rounded-full bg-primary" />}
									</span>
								</div>
								<div className="mt-1 text-[12px] leading-relaxed text-muted">{option.desc}</div>
							</button>
						);
					})}
				</div>
			</div>

			<div className="fw-card p-5">
				<div className="flex items-center gap-3">
					<span className="text-[13.5px] text-muted">当前生效</span>
					<span className="flex items-center gap-1.5 rounded-full bg-panel-2 px-2.5 py-0.5 text-[12.5px] font-medium text-fg">
						{resolved === "dark" ? "深色" : "浅色"}
						{theme === "system" && <span className="font-normal text-muted">（跟随系统）</span>}
					</span>
				</div>
				<div className="mt-3 text-[12px] leading-5 text-faint">主题只影响界面外观，保存在本机，不写入 pi 配置。</div>
			</div>
		</div>
	);
}
