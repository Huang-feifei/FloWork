/**
 * 服务状态：远程主机的只读监控面板——负载 / 内存 / 磁盘、systemd 服务单元、
 * 监听端口、失败单元与最近的错误日志。支持手动刷新与自动刷新（默认 10 秒）。
 * 面板关闭时组件卸载，定时器随之停止，不会在后台持续跑 SSH。
 * 外观按 Apple 体系：资源收进白卡片，子页签用分段控件，占用条按阈值换色（绿 / 琥珀 / 红）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostMonitorSnapshot } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Icon } from "../Icon";
import { Button, Segmented, Toggle } from "../ui";

const REFRESH_MS = 10_000;

function percentTone(percent: number): string {
	if (percent >= 90) return "text-err";
	if (percent >= 75) return "text-warn";
	return "text-muted";
}

function bar(percent: number): string {
	return percent >= 90 ? "bg-err" : percent >= 75 ? "bg-warn" : "bg-accent";
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="border-b border-border">
			<div className="flex items-center gap-2 px-3.5 py-2 text-[11.5px] font-semibold text-muted">
				<span>{title}</span>
				<div className="flex-1" />
				{right}
			</div>
			{children}
		</div>
	);
}

export function ServerStatus() {
	const hostId = useApp((s) => s.projects.projects.find((p) => p.id === s.activeProjectId)?.hostId ?? null);
	const host = useApp((s) => s.hosts.find((h) => h.id === hostId));
	const [snapshot, setSnapshot] = useState<HostMonitorSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [auto, setAuto] = useState(true);
	const [tab, setTab] = useState<"services" | "ports" | "logs">("services");
	const [filter, setFilter] = useState("");
	const inFlight = useRef(false);

	const refresh = useCallback(async () => {
		if (!hostId || inFlight.current) return;
		inFlight.current = true;
		setLoading(true);
		try {
			const next = await api.server.monitor(hostId);
			setSnapshot(next);
			setError(null);
		} catch (e) {
			setError(errorText(e));
		} finally {
			inFlight.current = false;
			setLoading(false);
		}
	}, [hostId]);

	// 切换主机时清空旧数据并立即取一次
	useEffect(() => {
		setSnapshot(null);
		setError(null);
		void refresh();
	}, [hostId, refresh]);

	// 自动刷新
	useEffect(() => {
		if (!auto || !hostId) return;
		const timer = setInterval(() => void refresh(), REFRESH_MS);
		return () => clearInterval(timer);
	}, [auto, hostId, refresh]);

	const services = useMemo(() => {
		const list = snapshot?.services ?? [];
		const q = filter.trim().toLowerCase();
		const filtered = q ? list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : list;
		// 失败的排在最前，其余按名字
		return [...filtered].sort((a, b) => {
			const fa = a.active === "failed" ? 0 : 1;
			const fb = b.active === "failed" ? 0 : 1;
			return fa - fb || a.name.localeCompare(b.name);
		});
	}, [snapshot, filter]);

	if (!hostId) {
		return <div className="px-3 py-3 text-[12.5px] text-muted">当前项目不是远程项目，没有服务器状态。</div>;
	}

	const mem = snapshot?.memory;
	const failedCount = snapshot?.failed.length ?? 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
			{/* 顶部：刷新与自动刷新 */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-[11.5px] text-muted">
				<span className="truncate font-mono">{host ? host.name || `${host.user ? `${host.user}@` : ""}${host.host}` : "远程主机"}</span>
				<div className="flex-1" />
				{snapshot && <span className="shrink-0 tabular-nums text-faint">{new Date(snapshot.probedAt).toLocaleTimeString()}</span>}
				<span className="flex shrink-0 items-center gap-1.5">
					自动
					<Toggle on={auto} onChange={setAuto} title="每 10 秒自动刷新" />
				</span>
				<Button size="sm" variant="ghost" className="h-7 px-2 text-[11.5px]" onClick={() => void refresh()} disabled={loading}>
					<Icon name="refresh" className="size-3.5" />
					{loading ? "读取中…" : "刷新"}
				</Button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{error && <div className="px-3 py-2 text-err">{error}</div>}
				{!error && !snapshot && <div className="px-3 py-2 text-muted">正在读取服务器状态…</div>}

				{snapshot && (
					<>
						{/* 资源概览 */}
						<div className="p-2.5">
							<div className="fw-card p-3.5">
								<div className="mb-2.5 flex items-center gap-2">
									<span className="text-[11.5px] font-semibold text-muted">资源</span>
									<div className="flex-1" />
									{snapshot.uptime && <span className="text-[11px] text-faint">{snapshot.uptime}</span>}
								</div>
								<div className="flex items-center gap-2">
									<span className="w-12 shrink-0 text-muted">负载</span>
									<span className="term truncate text-fg">
										{snapshot.load || "—"}
										{snapshot.cores > 0 ? ` · ${snapshot.cores} 核` : ""}
									</span>
								</div>
								{mem && mem.totalMb > 0 && (
									<div className="mt-2.5">
										<div className="flex items-center gap-2">
											<span className="w-12 shrink-0 text-muted">内存</span>
											<span className={`shrink-0 font-medium tabular-nums ${percentTone(mem.percent)}`}>{mem.percent}%</span>
											<span className="min-w-0 flex-1 truncate text-right text-[11px] text-faint">
												{mem.usedMb} / {mem.totalMb} MB（可用 {mem.availableMb} MB）
											</span>
										</div>
										<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel-2">
											<div
												className={`h-full rounded-full ${bar(mem.percent)}`}
												style={{ width: `${Math.min(100, mem.percent)}%` }}
											/>
										</div>
									</div>
								)}
								{snapshot.disks.map((disk) => {
									const pct = Number.parseInt(disk.percent, 10) || 0;
									return (
										<div key={disk.mount} className="mt-2.5">
											<div className="flex items-center gap-2">
												<span className="term w-12 shrink-0 truncate text-muted" title={disk.mount}>
													{disk.mount}
												</span>
												<span className={`shrink-0 font-medium tabular-nums ${percentTone(pct)}`}>{disk.percent}</span>
												<span className="min-w-0 flex-1 truncate text-right text-[11px] text-faint">
													{disk.used} / {disk.size}（可用 {disk.free}）
												</span>
											</div>
											<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel-2">
												<div className={`h-full rounded-full ${bar(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} />
											</div>
										</div>
									);
								})}
							</div>
						</div>

						{/* 三个子页签 */}
						<div className="flex shrink-0 items-center gap-2 px-3 pb-2">
							<Segmented
								items={[
									{ id: "services", label: "服务", title: `systemd 服务单元 ${snapshot.services.length}` },
									{ id: "ports", label: "端口", title: `监听端口 ${snapshot.ports.length}` },
									{ id: "logs", label: "日志", title: `最近的错误日志 ${snapshot.logs.length}` },
								]}
								active={tab}
								onChange={(id) => setTab(id as "services" | "ports" | "logs")}
							/>
							<div className="flex-1" />
							{failedCount > 0 && (
								<button
									type="button"
									onClick={() => {
										setTab("services");
										setFilter("");
									}}
									title={snapshot.failed.join("\n")}
									className="shrink-0 rounded-full bg-err-soft px-2.5 py-0.5 text-[11px] font-medium text-err"
								>
									{failedCount} 个失败单元
								</button>
							)}
						</div>

						{tab === "services" && (
							<div className="min-h-0 flex-1 px-2.5 pb-2.5">
								<div className="flex h-8 items-center gap-2 rounded-full bg-panel-2 px-3 text-muted">
									<Icon name="search" className="size-3.5 text-faint" />
									<input
										value={filter}
										onChange={(e) => setFilter(e.target.value)}
										placeholder="过滤服务名或描述"
										spellCheck={false}
										className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-muted/70"
									/>
								</div>
								<div className="mt-2 space-y-0.5">
									{services.length === 0 && <div className="px-2 py-2 text-muted">没有匹配的服务</div>}
									{services.map((unit) => (
										<div
											key={unit.name}
											className={`flex h-8 items-center gap-2 rounded-[10px] px-2 ${
												unit.active === "failed" ? "bg-err-soft" : "hover:bg-panel-2"
											}`}
											title={unit.description}
										>
											<span
												className={`shrink-0 text-[11px] ${
													unit.active === "failed" ? "text-err" : unit.active === "active" ? "text-accent" : "text-faint"
												}`}
											>
												{unit.active === "active" ? "●" : unit.active === "failed" ? "✗" : "○"}
											</span>
											<span className={`term min-w-0 flex-1 truncate ${unit.active === "failed" ? "text-err" : "text-fg"}`}>
												{unit.name}
											</span>
											<span className="shrink-0 text-[11px] text-faint">{unit.sub}</span>
										</div>
									))}
								</div>
							</div>
						)}

						{tab === "ports" && (
							<div className="min-h-0 flex-1 px-2.5 pb-2.5">
								{snapshot.ports.length === 0 && <div className="px-2 py-2 text-muted">没有读到监听端口（需要 ss 命令）</div>}
								<div className="space-y-0.5">
									{snapshot.ports.map((port, i) => (
										<div
											key={`${port.proto}-${port.local}-${i}`}
											className="flex h-8 items-center gap-2 rounded-[10px] px-2 hover:bg-panel-2"
										>
											<span className="shrink-0 text-[11px] text-faint">{port.proto}</span>
											<span className="term min-w-0 flex-1 truncate text-fg">{port.local}</span>
											<span className="shrink-0 truncate text-[11px] text-muted">{port.process}</span>
										</div>
									))}
								</div>
							</div>
						)}

						{tab === "logs" && (
							<div className="min-h-0 flex-1 px-2.5 pb-2.5">
								{snapshot.logs.length === 0 && (
									<div className="px-2 py-2 text-muted">没有读到错误日志（journalctl 可能不可用或需要权限）</div>
								)}
								<pre className="term overflow-x-auto rounded-xl bg-panel-2 px-3 py-2.5 text-[11.5px] leading-[1.6] whitespace-pre-wrap text-muted">
									{snapshot.logs.join("\n")}
								</pre>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
