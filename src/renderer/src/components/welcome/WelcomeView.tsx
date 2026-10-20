/**
 * 首次启动 · 欢迎：左侧是环境自检与快捷键，右侧从已有的 pi 会话中发现项目。
 * 自检项都来自真实状态：Node 版本、Git Bash、已配置的模型、项目数量。
 * 外观按 Apple 体系：正文用系统字 + 大字号，自检收进白卡片，按钮是 pill。
 */
import { useEffect, useMemo, useState } from "react";
import type { DiscoveredProject, ModelEntry, ShellInfo } from "@shared/protocol";
import { api } from "../../api/client";
import { useApp } from "../../store";
import { Icon } from "../Icon";
import { Button } from "../ui";

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
			<span className={state === "ok" ? "text-accent-strong" : state === "bad" ? "text-warn" : "text-faint"}>
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
			<section className="flex min-h-0 flex-col justify-center overflow-y-auto px-24 py-12">
				<div className="flex items-baseline gap-4">
					<span className="text-[52px] leading-none text-primary">✻</span>
					<span className="text-[40px] font-semibold tracking-tight text-fg">flowork</span>
					<span className="rounded-full bg-primary-soft px-3 py-1 text-[12.5px] font-medium text-primary">
						v{info?.version ?? "…"} · {info?.shell === "web" ? "网页版" : "桌面版"}
					</span>
				</div>
				<p className="mt-4 max-w-[600px] text-[17px] leading-relaxed text-muted">
					以 pi coding agent 为内核的开发者工作台。把任务交给 pi，在这里审批命令、审查改动；多个项目可以在后台并行跑。
				</p>

				<div className="fw-card mt-9 max-w-[600px] p-5">
					<div className="term text-[12.5px] leading-[1.9]">
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
				</div>

				<div className="mt-8 flex flex-wrap items-center gap-3">
					<Button variant="primary" size="lg" onClick={() => void useApp.getState().importProjects()}>
						<Icon name="folder-plus" className="size-4" />
						导入项目文件夹
						<span className="font-normal opacity-70">Ctrl+O</span>
					</Button>
					<Button size="lg" onClick={() => setView("database")}>
						<Icon name="database" className="size-4" />数据库工作台
					</Button>
					<Button size="lg" onClick={() => setView("settings", "providers")}>
						配置模型
					</Button>
					{projects.length > 0 && (
						<Button variant="link" onClick={() => setView("chat")}>
							进入工作台
							<Icon name="chevron-right" className="size-4" />
						</Button>
					)}
				</div>

				<div className="mt-11 max-w-[600px]">
					<div className="mb-3 text-[12px] font-semibold text-faint">常用快捷键</div>
					<div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
						{KEYS.map(([k, v]) => (
							<div key={k} className="flex items-center gap-2.5 text-[12.5px]">
								<span className="rounded-md bg-panel-2 px-2 py-1 font-mono text-[11px] text-muted">{k}</span>
								<span className="truncate text-muted">{v}</span>
							</div>
						))}
					</div>
				</div>
			</section>

			<aside className="flex min-h-0 flex-col overflow-y-auto border-l border-border bg-surface-raised px-8 py-12">
				<div className="text-[21px] font-semibold tracking-tight">发现已有的项目</div>
				<div className="mt-2 text-[13.5px] leading-relaxed text-muted">
					来自 pi 的会话记录。勾选后导入为项目，会话历史原样保留，不会复制文件。
				</div>

				<div className="mt-5 space-y-0.5">
					{found === null && <div className="px-3 py-2 text-[13px] text-muted">读取中…</div>}
					{found?.length === 0 && (
						<div className="px-3 py-2 text-[13px] leading-relaxed text-muted">没有发现尚未导入的项目。可以从左侧导入任何文件夹。</div>
					)}
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
								className={`flex h-12 w-full items-center gap-3 rounded-[10px] px-3 text-left hover:bg-panel-2 ${
									disabled ? "opacity-60" : ""
								}`}
							>
								<span
									className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border ${
										on || imported ? "border-primary bg-primary text-primary-foreground" : "border-border-strong"
									}`}
								>
									{(on || imported) && <span className="text-[10px] leading-none">✓</span>}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13.5px] text-fg">{pathName(p.path)}</span>
									<span className="block truncate font-mono text-[11px] text-faint">{p.path}</span>
								</span>
								<span className="shrink-0 text-[11.5px] tabular-nums text-muted">
									{imported ? "已导入" : !p.exists ? "文件夹不存在" : `${p.sessionCount} sessions`}
								</span>
							</button>
						);
					})}
				</div>

				{found && found.length > 0 && (
					<div className="mt-5 flex items-center gap-3">
						<Button disabled={busy || pending.length === 0} onClick={() => void importSelected()}>
							{busy ? "导入中…" : `导入选中的 ${pending.length} 个项目`}
						</Button>
						<Button variant="ghost" onClick={() => setView("chat")}>
							跳过
						</Button>
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
