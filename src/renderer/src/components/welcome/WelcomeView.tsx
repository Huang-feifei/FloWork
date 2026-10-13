/**
 * 首次启动 · 欢迎：左侧是环境自检与快捷键，右侧从已有的 pi 会话中发现项目。
 * 自检项都来自真实状态：Node 版本、Git Bash、已配置的模型、项目数量。
 */
import { useEffect, useMemo, useState } from "react";
import type { DiscoveredProject, ModelEntry, ShellInfo } from "@shared/protocol";
import { api } from "../../api/client";
import { useApp } from "../../store";
import { Icon } from "../Icon";

const KEYS: Array<[string, string]> = [
	["Ctrl+K", "命令面板"],
	["Ctrl+P", "快速打开文件"],
	["Ctrl+N", "新会话"],
	["Ctrl+`", "终端"],
	["Esc", "中断运行中的任务"],
	["y / a / n", "审批：允许 / 始终允许 / 拒绝"],
];

type CheckState = "ok" | "bad" | "note";

function CheckRow({ state, children }: { state: CheckState; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[3ch_1fr]">
			<span className={state === "ok" ? "text-ok" : state === "bad" ? "text-warn" : "text-faint"}>
				{state === "ok" ? "✓" : state === "bad" ? "!" : "·"}
			</span>
			<span className={state === "ok" ? "text-fg/85" : state === "bad" ? "text-warn" : "text-muted"}>{children}</span>
		</div>
	);
}

export function WelcomeView() {
	const info = useApp((s) => s.info);
	const projects = useApp((s) => s.projects.projects);
	const models = useApp((s) => s.models);
	const activeProjectId = useApp((s) => s.activeProjectId);
	const activeModels = activeProjectId ? models : [];
	const { addProjects, setView } = useApp.getState();

	const [shell, setShell] = useState<ShellInfo | null>(null);
	const [available, setAvailable] = useState<ModelEntry[]>([]);
	const [found, setFound] = useState<DiscoveredProject[] | null>(null);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void api
			.service({ type: "get_shell_info" })
			.then(setShell)
			.catch(() => setShell(null));
		void api
			.service({ type: "list_models", availableOnly: true })
			.then((list) => setAvailable(list.slice(0, 6)))
			.catch(() => setAvailable([]));
		void api.projects
			.discover()
			.then((list) => {
				setFound(list);
				setChecked(new Set(list.filter((p) => p.exists).slice(0, 2).map((p) => p.path)));
			})
			.catch(() => setFound([]));
	}, []);

	/** 已配置凭据的供应商，及各自可用的模型数量 */
	const providerSummary = useMemo(() => {
		const byProvider = new Map<string, number>();
		for (const m of available) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
		return [...byProvider.entries()].sort((a, b) => b[1] - a[1]);
	}, [available]);

	const toggle = (path: string) =>
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});

	const pending = [...checked].filter((p) => !projects.some((x) => x.path.toLowerCase() === p.toLowerCase()));

	const importSelected = async () => {
		if (pending.length === 0) return;
		setBusy(true);
		try {
			await addProjects(pending, true);
			setView("chat");
		} finally {
			setBusy(false);
		}
	};

	const node = info?.versions.node;
	const nodeOk = !!node && Number.parseInt(node.split(".")[0] ?? "0", 10) >= 22;
	const shellOk = !!shell?.resolved && !shell.isWsl;
	const pathName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

	return (
		<div className="grid h-full grid-cols-[1fr_540px]">
			<section className="flex min-h-0 flex-col justify-center overflow-y-auto px-24 py-10 font-mono">
				<div className="flex items-baseline gap-3">
					<span className="text-[40px] leading-none text-accent">✻</span>
					<span className="text-[28px] font-semibold tracking-tight text-fg">flowork</span>
					<span className="text-[12px] text-faint">
						v{info?.version ?? "…"} · {info?.shell === "web" ? "网页版" : "桌面版"}
					</span>
				</div>
				<p className="mt-3 max-w-[560px] font-sans text-[14px] leading-relaxed text-muted">
					以 pi coding agent 为内核的开发者工作台。把任务交给 pi，在这里审批命令、审查改动；多个项目可以在后台并行跑。
				</p>

				<div className="mt-9 text-[12.5px] leading-[1.9]">
					<CheckRow state="note">$ flowork doctor</CheckRow>
					<CheckRow state={nodeOk ? "ok" : "bad"}>
						Node {node ?? "（未知）"}
						{info?.shell === "electron" ? "（Electron 内置）" : ""}
					</CheckRow>
					<CheckRow state={shellOk ? "ok" : "bad"}>
						{shell?.resolved ? (
							<>
								{shell.resolved === shell.gitBash && !shell.shellPathSetting ? "Git Bash" : "bash"} {shell.resolved}
							</>
						) : (
							"未找到可用的 bash（Windows 上建议安装 Git for Windows）"
						)}
					</CheckRow>
					{providerSummary.length > 0 ? (
						<CheckRow state="ok">模型：{providerSummary.map(([provider, count]) => `${provider} ${count}`).join("、")}</CheckRow>
					) : (
						<CheckRow state="bad">还没有配置可用的模型</CheckRow>
					)}
					<CheckRow state={projects.length > 0 ? "ok" : "bad"}>
						{projects.length > 0 ? `${projects.length} 个项目` : "还没有项目"}
					</CheckRow>
				</div>

				<div className="mt-6 flex items-center gap-2">
					<button
						type="button"
						onClick={() => void useApp.getState().importProjects()}
						className="flex h-8 items-center gap-2 rounded bg-accent px-3 text-[12.5px] font-semibold text-accent-foreground hover:bg-accent-strong"
					>
						<Icon
							name="folder-plus"
							className="size-4"
						/>
						导入项目文件夹
						<span className="font-normal opacity-60">Ctrl+O</span>
					</button>
					<button
						type="button"
						onClick={() => setView("settings", "providers")}
						className="flex h-8 items-center rounded border border-border-strong px-3 text-[12.5px] text-fg hover:bg-panel-2"
					>
						配置模型
					</button>
					{projects.length > 0 && (
						<button
							type="button"
							onClick={() => setView("chat")}
							className="flex h-8 items-center rounded px-3 text-[12.5px] text-muted hover:text-fg"
						>
							进入工作台 →
						</button>
					)}
				</div>

				<div className="mt-11 grid max-w-[560px] grid-cols-[110px_1fr] gap-y-1.5 text-[12px]">
					{KEYS.map(([k, v]) => (
						<div
							key={k}
							className="contents"
						>
							<span className="text-fg/85">{k}</span>
							<span className="font-sans text-muted">{v}</span>
						</div>
					))}
				</div>
			</section>

			<aside className="flex min-h-0 flex-col overflow-y-auto border-l border-border bg-sidebar px-8 py-9">
				<div className="font-mono text-[10.5px] font-semibold tracking-[0.06em] text-faint">发现已有的项目</div>
				<div className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
					来自 pi 的会话记录。勾选后导入为项目，会话历史原样保留，不会复制文件。
				</div>

				<div className="mt-5 font-mono text-[12.5px]">
					{found === null && <div className="px-2 text-muted">读取中…</div>}
					{found?.length === 0 && <div className="px-2 leading-relaxed text-muted">没有发现尚未导入的项目。可以从左侧导入任何文件夹。</div>}
					{found?.map((p) => {
						const on = checked.has(p.path);
						const imported = projects.some((x) => x.path.toLowerCase() === p.path.toLowerCase());
						const disabled = imported || !p.exists;
						return (
							<button
								type="button"
								key={p.path}
								disabled={disabled}
								onClick={() => toggle(p.path)}
								className={`grid h-[46px] w-full grid-cols-[4ch_1fr_auto] items-center gap-x-1 rounded px-2 text-left ${
									on || imported ? "bg-panel" : "hover:bg-panel"
								} ${disabled ? "opacity-60" : ""}`}
							>
								<span className={on || imported ? "text-accent" : "text-faint"}>{on || imported ? "[x]" : "[ ]"}</span>
								<span className="min-w-0">
									<span className="block truncate text-fg">{pathName(p.path)}</span>
									<span className="block truncate text-[11px] text-faint">{p.path}</span>
								</span>
								<span className="text-[11.5px] text-muted tabular-nums">
									{imported ? "已导入" : !p.exists ? "文件夹不存在" : `${p.sessionCount} sessions`}
								</span>
							</button>
						);
					})}
				</div>

				{found && found.length > 0 && (
					<div className="mt-5 flex items-center gap-3">
						<button
							type="button"
							disabled={busy || pending.length === 0}
							onClick={() => void importSelected()}
							className="flex h-8 items-center rounded border border-accent/60 px-3 font-mono text-[12.5px] text-accent hover:bg-accent-soft disabled:opacity-40"
						>
							{busy ? "导入中…" : `导入选中的 ${pending.length} 个项目`}
						</button>
						<button
							type="button"
							onClick={() => setView("chat")}
							className="font-mono text-[12.5px] text-faint hover:text-fg"
						>
							跳过
						</button>
					</div>
				)}

				<div className="mt-auto pt-8 font-mono text-[11px] leading-relaxed text-faint">
					配置目录 {info?.agentDir}
					<br />
					与 pi 命令行的 ~/.pi/agent 互不影响
					{activeModels.length > 0 && (
						<>
							<br />
							当前会话有 {activeModels.length} 个可用模型
						</>
					)}
				</div>
			</aside>
		</div>
	);
}
