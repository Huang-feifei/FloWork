/**
 * 外观设置：界面主题（深色 / 浅色 / 跟随系统）。
 * 只影响界面外观，保存在本机 localStorage，不写入 pi 的 settings.json。
 */
import { useApp } from "../../store";
import type { ThemeMode } from "../../theme";

const OPTIONS: Array<{ id: ThemeMode; label: string; desc: string }> = [
	{ id: "system", label: "跟随系统", desc: "随操作系统的浅色 / 深色设置自动切换" },
	{ id: "dark", label: "深色", desc: "深石墨底 + 琥珀橙强调（默认）" },
	{ id: "light", label: "浅色", desc: "浅灰白底 + 琥珀橙强调" },
];

export function AppearanceTab() {
	const theme = useApp((s) => s.theme);
	const resolved = useApp((s) => s.resolvedTheme);
	const setTheme = useApp((s) => s.setTheme);

	return (
		<section className="space-y-3">
			<h3 className="text-sm font-semibold">界面主题</h3>
			<div className="grid gap-2">
				{OPTIONS.map((option) => {
					const active = theme === option.id;
					return (
						<button
							type="button"
							key={option.id}
							onClick={() => setTheme(option.id)}
							className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-left ${
								active ? "border-accent bg-accent-soft" : "border-border hover:bg-panel-2"
							}`}
						>
							<span
								className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
									active ? "border-accent bg-accent" : "border-border-strong"
								}`}
							>
								{active && <span className="size-1.5 rounded-full bg-accent-foreground" />}
							</span>
							<span className="min-w-0">
								<span className="block text-[13px] font-medium">{option.label}</span>
								<span className="mt-0.5 block text-[12px] text-muted">{option.desc}</span>
							</span>
						</button>
					);
				})}
			</div>
			<p className="text-[12px] text-muted">
				当前生效：{resolved === "dark" ? "深色" : "浅色"}
				{theme === "system" && "（跟随系统）"}
			</p>
			<p className="text-[12px] text-faint">主题只影响界面外观，保存在本机，不写入 pi 配置。</p>
		</section>
	);
}
