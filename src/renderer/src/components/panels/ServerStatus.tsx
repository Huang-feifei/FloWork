/**
 * 服务状态：远程主机的只读监控面板——负载 / 内存 / 磁盘、systemd 服务单元、
 * 监听端口、失败单元与最近的错误日志。支持手动刷新与自动刷新（默认 10 秒）。
 * 面板关闭时组件卸载，定时器随之停止，不会在后台持续跑 SSH。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostMonitorSnapshot } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";

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
			<div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted">
				<span className="font-medium">{title}</span>
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
		return <div className="p-3 text-[12px] text-muted">当前项目不是远程项目，没有服务器状态。</div>;
	}

	const mem = snapshot?.memory;
	const failedCount = snapshot?.failed.length ?? 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col text-[12px]">
			{/* 顶部：刷新与自动刷新 */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted">
				<span className="truncate">{host ? host.name || `${host.user ? `${host.user}@` : ""}${host.host}` : "远程主机"}</span>
				<div className="flex-1" />
				{snapshot && <span className="shrink-0 text-faint">{new Date(snapshot.probedAt).toLocaleTimeString()}</span>}
				<label className="flex shrink-0 cursor-pointer items-center gap-1">
					<input
						type="checkbox"
						checked={auto}
						onChange={(e) => setAuto(e.target.checked)}
					/>
					自动
				</label>
				<button
					type="button"
					onClick={() => void refresh()}
					disabled={loading}
					className="shrink-0 rounded px-1.5 py-0.5 hover:bg-panel-2 hover:text-fg disabled:opacity-40"
				>
					{loading ? "读取中…" : "刷新"}
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{error && <div className="px-3 py-2 text-err">{error}</div>}
				{!error && !snapshot && <div className="px-3 py-2 text-muted">正在读取服务器状态…</div>}

				{snapshot && (
					<>
						{/* 资源概览 */}
						<Section title="资源">
							<div className="space-y-1.5 px-3 pb-2">
								<div className="flex items-center gap-2">
									<span className="w-16 shrink-0 text-muted">负载</span>
									<span className="term truncate">
										{snapshot.load || "—"}
										{snapshot.cores > 0 ? ` · ${snapshot.cores} 核` : ""}
									</span>
								</div>
								{snapshot.uptime && <div className="text-faint">{snapshot.uptime}</div>}
								{mem && mem.totalMb > 0 && (
									<div>
										<div className="flex items-center gap-2">
											<span className="w-16 shrink-0 text-muted">内存</span>
											<span className={`shrink-0 ${percentTone(mem.percent)}`}>{mem.percent}%</span>
											<span className="truncate text-faint">
												{mem.usedMb} / {mem.totalMb} MB（可用 {mem.availableMb} MB）
											</span>
										</div>
										<div className="mt-1 h-1 overflow-hidden rounded bg-panel-2">
											<div
												className={`h-full ${bar(mem.percent)}`}
												style={{ width: `${Math.min(100, mem.percent)}%` }}
											/>
										</div>
									</div>
								)}
								{snapshot.disks.map((disk) => {
									const pct = Number.parseInt(disk.percent, 10) || 0;
									return (
										<div key={disk.mount}>
											<div className="flex items-center gap-2">
												<span className="term w-16 shrink-0 truncate text-muted" title={disk.mount}>
													{disk.mount}
												</span>
												<span className={`shrink-0 ${percentTone(pct)}`}>{disk.percent}</span>
												<span className="truncate text-faint">
													{disk.used} / {disk.size}（可用 {disk.free}）
												</span>
											</div>
											<div className="mt-1 h-1 overflow-hidden rounded bg-panel-2">
												<div
													className={`h-full ${bar(pct)}`}
													style={{ width: `${Math.min(100, pct)}%` }}
												/>
											</div>
										</div>
									);
								})}
							</div>
						</Section>

						{/* 三个子页签 */}
						<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
							{(
								[
									["services", `服务 ${snapshot.services.length}`],
									["ports", `端口 ${snapshot.ports.length}`],
									["logs", `日志 ${snapshot.logs.length}`],
								] as const
							).map(([id, label]) => (
								<button
									type="button"
									key={id}
									onClick={() => setTab(id)}
									className={`rounded px-2 py-0.5 text-[11.5px] ${tab === id ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
								>
									{label}
								</button>
							))}
							<div className="flex-1" />
							{failedCount > 0 && (
								<button
									type="button"
									onClick={() => {
										setTab("services");
										setFilter("");
									}}
									className="shrink-0 rounded bg-err/15 px-1.5 py-0.5 text-[11px] text-err"
									title={snapshot.failed.join("\n")}
								>
									{failedCount} 个失败单元
								</button>
							)}
						</div>

						{tab === "services" && (
							<div className="min-h-0 flex-1">
								<div className="px-3 py-1.5">
									<input
										value={filter}
										onChange={(e) => setFilter(e.target.value)}
										placeholder="过滤服务名或描述"
										spellCheck={false}
										className="w-full rounded border border-border bg-panel px-2 py-1 text-[11.5px] outline-none focus:border-accent"
									/>
								</div>
								{services.length === 0 && <div className="px-3 py-2 text-muted">没有匹配的服务</div>}
								{services.map((unit) => (
									<div
										key={unit.name}
										className="flex items-center gap-2 px-3 py-[3px] hover:bg-panel-2"
										title={unit.description}
									>
										<span
											className={`shrink-0 ${
												unit.active === "failed" ? "text-err" : unit.active === "active" ? "text-ok" : "text-faint"
											}`}
										>
											{unit.active === "active" ? "●" : unit.active === "failed" ? "✗" : "○"}
										</span>
										<span className="term min-w-0 flex-1 truncate">{unit.name}</span>
										<span className="shrink-0 text-[11px] text-faint">{unit.sub}</span>
									</div>
								))}
							</div>
						)}

						{tab === "ports" && (
							<div className="min-h-0 flex-1">
								{snapshot.ports.length === 0 && <div className="px-3 py-2 text-muted">没有读到监听端口（需要 ss 命令）</div>}
								{snapshot.ports.map((port, i) => (
									<div
										key={`${port.proto}-${port.local}-${i}`}
										className="flex items-center gap-2 px-3 py-[3px] hover:bg-panel-2"
									>
										<span className="shrink-0 text-faint">{port.proto}</span>
										<span className="term min-w-0 flex-1 truncate">{port.local}</span>
										<span className="shrink-0 truncate text-[11px] text-muted">{port.process}</span>
									</div>
								))}
							</div>
						)}

						{tab === "logs" && (
							<div className="min-h-0 flex-1">
								{snapshot.logs.length === 0 && <div className="px-3 py-2 text-muted">没有读到错误日志（journalctl 可能不可用或需要权限）</div>}
								<pre className="px-3 py-1.5 whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.5] text-muted">
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
