/**
 * 项目信任提示：项目含 .pi/ 配置（扩展、技能、设置等）且用户尚未决定时显示。
 * 未决定前这些配置不会加载；扩展是会在本机执行的代码，需要用户确认来源可靠。
 */
import { useState } from "react";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";

export function TrustBanner() {
	const trust = useApp((s) => s.state?.trust);
	const handleId = useApp((s) => s.handleId);
	const isRunning = useApp((s) => s.isRunning);
	const { pushNotice, setView } = useApp.getState();
	const [busy, setBusy] = useState(false);
	if (!trust || trust.state === "not_needed" || trust.decided || !handleId) return null;

	const decide = async (trusted: boolean) => {
		setBusy(true);
		try {
			const state = await api.session(handleId, { type: "set_project_trust", trusted });
			useApp.setState({ state });
			pushNotice("info", trusted ? "已信任该项目，项目配置已加载" : "已记录：不加载该项目的配置");
		} catch (e) {
			pushNotice("error", errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="rounded-md border border-warn/50 bg-warn-soft px-4 py-3 font-sans text-[13px] leading-5">
			<div className="font-medium">这个项目包含 pi 的项目级配置，目前没有加载</div>
			<div className="mt-1 text-muted">
				发现：<span className="font-mono text-[12px] text-fg">{trust.items.join("、")}</span>。其中的扩展是会在本机执行的代码，技能和设置会影响
				AI 的行为。请确认项目来源可靠后再信任。
			</div>
			<div className="mt-2 flex items-center gap-2">
				<button
					type="button"
					disabled={busy || isRunning}
					onClick={() => void decide(true)}
					className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-accent-foreground disabled:opacity-40"
				>
					信任并加载
				</button>
				<button
					type="button"
					disabled={busy || isRunning}
					onClick={() => void decide(false)}
					className="rounded-md border border-border-strong px-3 py-1 text-[12px] hover:bg-panel-2 disabled:opacity-40"
				>
					不加载
				</button>
				<button type="button" onClick={() => setView("settings", "resources")} className="ml-auto text-[12px] text-muted underline hover:text-fg">
					查看这些配置
				</button>
			</div>
		</div>
	);
}
