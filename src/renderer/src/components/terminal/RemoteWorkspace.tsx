import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { SshHost } from "@shared/protocol";
import { api, errorText, hostKeyErrorHost } from "../../api/client";
import { relativeTime } from "../../lib/format";
import { type RemoteSection, useApp } from "../../store";
import { askConfirm } from "../ConfirmDialog";
import { Icon, type IconName } from "../Icon";
import { Menu } from "../sidebar/Menu";
import { RemoteHostDialog, RemoteProjectDialog } from "../sidebar/RemoteProjectDialog";
import type { RemoteTerminalRequest } from "./TerminalPanel";
import "./remote-workspace.css";

const RemoteTerminal = lazy(() => import("./TerminalPanel").then((m) => ({ default: m.TerminalTab })));
const NAV: { id: RemoteSection; icon: IconName; label: string }[] = [
	{ id: "hosts", icon: "server", label: "全部主机" },
	{ id: "recent", icon: "refresh", label: "最近连接" },
	{ id: "terminal", icon: "square-terminal", label: "远程终端" },
];

function address(host: SshHost): string {
	const endpoint = host.port && host.host.includes(":") && !host.host.startsWith("[") ? `[${host.host}]` : host.host;
	return `${host.user ? `${host.user}@` : ""}${endpoint}${host.port ? `:${host.port}` : ""}`;
}

function HostCard({ host, time, busy, connecting, expanded, onConnect, onMenu }: {
	host: SshHost;
	time?: number;
	busy: boolean;
	connecting: boolean;
	expanded: boolean;
	onConnect: () => void;
	onMenu: (button: HTMLButtonElement) => void;
}) {
	const label = host.name || address(host);
	return (
		<article className="fw-remote-card">
			<button type="button" className="fw-remote-card-main" aria-label={`连接终端：${label}`} title={`连接终端 · ${address(host)}`}
				disabled={busy} onClick={onConnect}>
				<span className="fw-remote-host-icon"><Icon name={connecting ? "loader-circle" : "server"} className={`size-5 ${connecting ? "animate-spin" : ""}`} /></span>
				<span className="min-w-0 flex-1">
					<strong className="block truncate">{label}</strong>
					<span className="fw-remote-address truncate" title={address(host)}>{address(host)}</span>
					{time !== undefined && <time className="fw-remote-meta truncate" dateTime={new Date(time).toISOString()}>{relativeTime(time)}</time>}
				</span>
			</button>
			<button type="button" className="fw-remote-icon-button fw-remote-card-menu" title="主机操作" aria-label={`主机操作：${label}`}
				aria-expanded={expanded} onClick={(event) => onMenu(event.currentTarget)}>
				<Icon name="ellipsis" className="size-4" />
			</button>
		</article>
	);
}

export function RemoteWorkspace() {
	const hosts = useApp((s) => s.hosts);
	const { projects, groups } = useApp((s) => s.projects);
	const history = useApp((s) => s.recentRemoteHosts);
	const sshAvailable = useApp((s) => s.info?.ssh);
	const section = useApp((s) => s.remoteSection);
	const { setRemoteSection, addRemoteProject, setHostKeyPrompt, pushNotice } = useApp.getState();
	const [query, setQuery] = useState("");
	const [groupId, setGroupId] = useState<string | null>(null);
	const [request, setRequest] = useState<RemoteTerminalRequest | null>(null);
	const [pendingHost, setPendingHost] = useState<string | null>(null);
	const [dialog, setDialog] = useState<{ type: "edit"; host: SshHost | null } | { type: "directory"; host: SshHost } | null>(null);
	const [menu, setMenu] = useState<{ id: string; area: string; x: number; y: number } | null>(null);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);

	const hostIds = new Set(hosts.map((host) => host.id));
	const groupedHosts = new Map<string, Set<string>>();
	for (const project of projects) {
		if (!project.groupId || !project.hostId || !hostIds.has(project.hostId)) continue;
		const groupHosts = groupedHosts.get(project.groupId) ?? new Set<string>();
		groupHosts.add(project.hostId);
		groupedHosts.set(project.groupId, groupHosts);
	}
	const remoteGroups = groups.filter((group) => groupedHosts.has(group.id));
	const activeGroup = section === "hosts" ? remoteGroups.find((group) => group.id === groupId) : undefined;
	const queryTerms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const matches = hosts.filter((host) => {
		const haystack = `${host.name ?? ""} ${address(host)}`.toLowerCase();
		return (!activeGroup || groupedHosts.get(activeGroup.id)?.has(host.id)) && queryTerms.every((word) => haystack.includes(word));
	});
	const recentTimes = new Map(Object.entries(history));
	for (const project of projects) {
		if (project.hostId && project.lastOpenedAt) {
			recentTimes.set(project.hostId, Math.max(project.lastOpenedAt, recentTimes.get(project.hostId) ?? 0));
		}
	}
	const recent = matches.filter((host) => recentTimes.has(host.id)).sort((a, b) => recentTimes.get(b.id)! - recentTimes.get(a.id)!);
	const shown = section === "recent" ? recent : matches;
	const quickHost = shown.length === 1 ? shown[0] : null;
	const menuHost = menu && hosts.find((host) => host.id === menu.id);
	const changeSection = useCallback((next: RemoteSection) => {
		setMenu(null);
		setGroupId(null);
		setRemoteSection(next);
	}, [setRemoteSection]);
	const browseHosts = useCallback(() => changeSection("hosts"), [changeSection]);
	const clearRequest = useCallback(() => setRequest(null), []);

	const connect = async (host: SshHost, mode: "terminal" | "session") => {
		if (!mounted.current) return;
		setPendingHost(host.id);
		try {
			const cwd = host.defaultPath || (await api.hosts.listDirs(host.id)).home;
			if (!mounted.current || useApp.getState().view !== "remote" || !useApp.getState().hosts.some((item) => item.id === host.id)) return;
			if (mode === "session") await addRemoteProject(host.id, cwd, host.name || address(host));
			else {
				setRequest({ hostId: host.id, cwd });
				changeSection("terminal");
			}
		} catch (e) {
			if (!mounted.current) return;
			const changedHost = hostKeyErrorHost(e);
			if (changedHost) setHostKeyPrompt(changedHost, () => void connect(host, mode));
			else pushNotice("error", `连接「${host.name || address(host)}」失败：${errorText(e)}`);
		} finally {
			if (mounted.current) setPendingHost(null);
		}
	};

	const remove = async (host: SshHost) => {
		if (!(await askConfirm({ title: "删除主机", message: `从 FloWork 移除「${host.name || address(host)}」的连接配置？不会删除服务器上的文件。`, confirmLabel: "删除主机", danger: true }))) return;
		try {
			await api.hosts.remove(host.id);
		} catch (e) {
			pushNotice("error", `删除主机失败：${errorText(e)}`);
		}
	};

	const cards = (list: SshHost[], area: "all" | "recent") => (
		<div className="fw-remote-grid">
			{list.map((host) => <HostCard key={host.id} host={host} time={area === "recent" ? recentTimes.get(host.id) : undefined}
				busy={!!pendingHost || sshAvailable === null} connecting={pendingHost === host.id}
				expanded={menu?.id === host.id && menu.area === area}
				onConnect={() => void connect(host, "terminal")}
				onMenu={(button) => {
					const rect = button.getBoundingClientRect();
					setMenu({ id: host.id, area, x: rect.left, y: rect.bottom + 4 });
				}} />)}
		</div>
	);

	return (
		<div className="fw-remote-workspace">
			<aside className="fw-remote-sidebar">
				<div className="fw-remote-sidebar-heading">
					<span className="fw-remote-sidebar-icon"><Icon name="terminal" className="size-[18px]" /></span>
					<span>远程工作台</span>
				</div>
				<nav aria-label="远程工作台导航" className="fw-remote-nav">
					{NAV.map((item) => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined} onClick={() => changeSection(item.id)}>
						<Icon name={item.icon} className="size-4" />{item.label}
						{item.id === "hosts" && <span className="fw-remote-count">{hosts.length}</span>}
					</button>)}
				</nav>
				<div className="fw-remote-sidebar-note"><Icon name="lock" className="size-3.5" />连接配置保存在本机</div>
			</aside>

			<div className="fw-remote-main">
				<header className="fw-remote-header">
					<div className="fw-remote-kicker">远程工作台 <span> / </span> SSH</div>
					<h1>{section === "hosts" ? "远程主机" : section === "recent" ? "最近连接" : "远程终端"}</h1>
				</header>
				{section !== "terminal" ? (
					<>
						<div className="fw-remote-toolbar">
							<form className="fw-remote-searchbar" onSubmit={(event) => {
								event.preventDefault();
								if (quickHost && !pendingHost && sshAvailable !== null) void connect(quickHost, "terminal");
							}}>
								<div className="fw-remote-search">
									<Icon name="search" className="size-4" />
									<input type="text" aria-label="查找主机" placeholder="查找主机名称、地址或用户名" value={query}
										onChange={(event) => { setMenu(null); setQuery(event.target.value); }} />
									{query && <button type="button" className="fw-remote-icon-button" aria-label="清空搜索" title="清空搜索" onClick={() => setQuery("")}><Icon name="x" className="size-3.5" /></button>}
								</div>
								<button type="submit" className="fw-remote-button" disabled={!quickHost || !!pendingHost || sshAvailable === null}
									title={quickHost ? `连接 ${quickHost.name || address(quickHost)}` : "搜索到唯一主机后，可在这里直接连接"}>连接</button>
							</form>
							<button type="button" className="fw-remote-button fw-remote-primary" onClick={() => setDialog({ type: "edit", host: null })}>
								<Icon name="plus" className="size-4" />新建主机
							</button>
							<button type="button" className="fw-remote-button" onClick={() => changeSection("terminal")}><Icon name="square-terminal" className="size-4" />终端</button>
						</div>
						<div className="fw-remote-content" onScroll={() => menu && setMenu(null)}>
							{sshAvailable === null && <p role="status" className="fw-remote-warning"><Icon name="shield-alert" className="size-4" />未找到 OpenSSH 客户端。安装后重启 FloWork，即可连接远程主机。</p>}
							{section === "hosts" && !activeGroup && !queryTerms.length && recent.length > 0 && (
								<section className="fw-remote-group" aria-label="最近连接">
									<div className="fw-remote-group-title"><h2><Icon name="refresh" className="size-3.5" />最近连接</h2><button type="button" className="fw-remote-link" onClick={() => changeSection("recent")}>查看记录 <Icon name="chevron-right" className="size-3.5" /></button></div>
									{cards(recent.slice(0, 3), "recent")}
								</section>
							)}
							{section === "hosts" && !activeGroup && !queryTerms.length && remoteGroups.length > 0 && (
								<section className="fw-remote-group" aria-label="项目分组">
									<div className="fw-remote-group-title"><h2>项目分组</h2><span>{remoteGroups.length} 个分组</span></div>
									<div className="fw-remote-grid">
										{remoteGroups.map((group) => <button key={group.id} type="button" className="fw-remote-card fw-remote-card-main" onClick={() => setGroupId(group.id)}>
											<span className="fw-remote-host-icon fw-remote-folder-icon"><Icon name="folder-open" className="size-5" /></span>
											<span className="min-w-0 flex-1"><strong className="block truncate">{group.name}</strong><span className="fw-remote-meta">{groupedHosts.get(group.id)?.size} 台主机</span></span>
											<Icon name="chevron-right" className="mr-1 size-3.5" />
										</button>)}
									</div>
								</section>
							)}
							<section className="fw-remote-group" aria-label={activeGroup ? `分组：${activeGroup.name}` : queryTerms.length ? "搜索结果" : section === "recent" ? "连接记录" : "全部主机"}>
								<div className="fw-remote-group-title">
									<h2>{activeGroup?.name ?? (queryTerms.length ? "搜索结果" : section === "recent" ? "连接记录" : "全部主机")}</h2>
									{activeGroup ? <button type="button" className="fw-remote-link" onClick={() => setGroupId(null)}>返回全部主机 <Icon name="x" className="size-3.5" /></button> : <span>{shown.length} 台主机</span>}
								</div>
								{shown.length > 0 ? cards(shown, section === "recent" ? "recent" : "all") : (
									<div className="fw-remote-empty">
										<Icon name={queryTerms.length ? "search" : section === "recent" ? "refresh" : "server"} className="size-6" />
										<h3>{queryTerms.length ? "没有找到匹配的主机" : section === "recent" ? "暂无连接记录" : "还没有远程主机"}</h3>
										<p>{queryTerms.length ? "试试其他名称、地址或用户名。" : section === "recent" ? "打开远程终端或远程项目后，主机会显示在这里。" : "保存一台服务器的 SSH 配置，即可从这里连接。"}</p>
									</div>
								)}
							</section>
						</div>
					</>
				) : (
					<div id="fw-remote-terminal" className="fw-remote-console">
						<Suspense fallback={<div className="fw-remote-empty flex-1" role="status">正在加载终端…</div>}>
							<RemoteTerminal remote={{ request, onRequestHandled: clearRequest, onBrowseHosts: browseHosts }} />
						</Suspense>
					</div>
				)}
			</div>

			{section !== "terminal" && menu && menuHost && <Menu position={menu} onClose={() => setMenu(null)} items={[
				{ label: "打开运维会话", disabled: !!pendingHost || sshAvailable === null, onClick: () => void connect(menuHost, "session") },
				{ label: "添加远程目录为项目…", disabled: sshAvailable === null, onClick: () => setDialog({ type: "directory", host: menuHost }) },
				{ label: "编辑 / 测试连接…", onClick: () => setDialog({ type: "edit", host: menuHost }) },
				{ label: "", separator: true },
				{ label: "删除主机…", danger: true, onClick: () => void remove(menuHost) },
			]} />}
			{dialog?.type === "edit" && <RemoteHostDialog host={dialog.host} onClose={() => setDialog(null)} />}
			{dialog?.type === "directory" && <RemoteProjectDialog host={dialog.host} onClose={() => setDialog(null)} />}
		</div>
	);
}
