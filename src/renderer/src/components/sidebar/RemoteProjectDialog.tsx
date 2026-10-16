/**
 * 添加远程项目：管理 SSH 主机 + 浏览服务器目录。
 *
 * 左侧是主机列表（可新增 / 编辑 / 测试连接），右侧是远程目录浏览器。
 * 选好目录后把「主机 + 目录」作为一个远程项目加入侧边栏。
 */
import { useCallback, useEffect, useState } from "react";
import type { RemoteDirListing, SshHost, SshHostInput, SshTestResult } from "@shared/protocol";
import { api, errorText, hostKeyErrorHost } from "../../api/client";
import { isDesktop } from "../../lib/desktop";
import { useApp } from "../../store";
import { Badge, Button, Field, Input, Modal, Select } from "../ui";

const EMPTY_FORM: SshHostInput = { name: "", host: "", user: "", port: undefined, auth: "agent", keyPath: "", password: "", defaultPath: "" };

function hostLabel(host: SshHost): string {
	return host.name || `${host.user ? `${host.user}@` : ""}${host.host}`;
}

/** 主机编辑表单 */
function HostForm({
	initial,
	onCancel,
	onSaved,
}: {
	initial: { id?: string; input: SshHostInput };
	onCancel: () => void;
	onSaved: (host: SshHost) => void;
}) {
	const [form, setForm] = useState<SshHostInput>(initial.input);
	const [id, setId] = useState<string | undefined>(initial.id);
	const [test, setTest] = useState<{ busy: boolean; result: SshTestResult | null }>({ busy: false, result: null });
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const patch = (p: Partial<SshHostInput>) => setForm((f) => ({ ...f, ...p }));

	/** 落盘并返回主机（新增时记住 id，之后重复保存 / 测试都是更新） */
	const persist = async (): Promise<SshHost | null> => {
		if (id) {
			await api.hosts.update(id, form);
			const list = await api.hosts.list();
			return list.find((h) => h.id === id) ?? null;
		}
		const r = await api.hosts.add(form);
		setId(r.host.id);
		return r.host;
	};

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const host = await persist();
			if (host) onSaved(host);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setSaving(false);
		}
	};

	/** 先保存再测试：测试需要主机已有 id（后端按 id 读取） */
	const testConnection = async () => {
		setTest({ busy: true, result: null });
		setError(null);
		try {
			const host = await persist();
			if (!host) {
				setTest({ busy: false, result: null });
				return;
			}
			setTest({ busy: false, result: await api.hosts.test(host.id) });
		} catch (e) {
			setTest({ busy: false, result: null });
			setError(errorText(e));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
			<Field label="显示名（可选）">
				<Input value={form.name ?? ""} onChange={(e) => patch({ name: e.target.value })} placeholder="例如 测试机" />
			</Field>
			<div className="grid grid-cols-[1fr_88px] gap-2">
				<Field label="主机地址">
					<Input value={form.host} onChange={(e) => patch({ host: e.target.value })} placeholder="192.168.1.10 或 example.com" />
				</Field>
				<Field label="端口">
					<Input
						value={form.port ?? ""}
						inputMode="numeric"
						onChange={(e) => patch({ port: e.target.value ? Number(e.target.value) : undefined })}
						placeholder="22"
					/>
				</Field>
			</div>
			<Field label="用户名（可选，默认用 ssh 配置）">
				<Input value={form.user ?? ""} onChange={(e) => patch({ user: e.target.value })} placeholder="root" />
			</Field>
			<Field label="认证方式">
				<Select value={form.auth} onChange={(e) => patch({ auth: e.target.value as SshHostInput["auth"] })}>
					<option value="agent">ssh-agent / ~/.ssh/config（推荐）</option>
					<option value="key">私钥文件</option>
					<option value="password">密码</option>
				</Select>
			</Field>
			{form.auth === "key" && (
				<Field label="私钥文件">
					<div className="flex gap-2">
						<Input value={form.keyPath ?? ""} onChange={(e) => patch({ keyPath: e.target.value })} placeholder="C:\\Users\\me\\.ssh\\id_ed25519" />
						<Button
							className="shrink-0"
							onClick={() => void api.hosts.pickKey().then((p) => p && patch({ keyPath: p })).catch((e) => setError(errorText(e)))}
						>
							浏览…
						</Button>
					</div>
				</Field>
			)}
			{form.auth === "password" && (
				<Field label="密码" hint={isDesktop ? "密码经系统加密（Windows DPAPI）后保存在本机 ~/.flowork/hosts.json。" : "网页版以明文保存在本机 ~/.flowork/hosts.json（桌面版会加密）。"}>
					<Input type="password" value={form.password ?? ""} onChange={(e) => patch({ password: e.target.value })} />
				</Field>
			)}
			<Field label="默认目录（可选）" hint="留空则打开服务器 home 目录">
				<Input value={form.defaultPath ?? ""} onChange={(e) => patch({ defaultPath: e.target.value })} placeholder="/var/www" />
			</Field>

			{error && <div className="rounded border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">{error}</div>}
			{test.result && (
				<div className={`rounded border px-3 py-2 text-[12px] ${test.result.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-err/40 bg-err/10 text-err"}`}>
					{test.result.ok ? (
						<>
							连接成功（{test.result.latencyMs}ms）· 平台 {test.result.platform} · home {test.result.home} · Node{" "}
							{test.result.node ?? "未安装"}
						</>
					) : (
						<>连接失败：{test.result.error}</>
					)}
				</div>
			)}

			<div className="mt-auto flex justify-end gap-2 pt-2">
				<Button onClick={onCancel}>取消</Button>
				<Button disabled={test.busy} onClick={() => void testConnection()}>
					{test.busy ? "测试中…" : "测试连接"}
				</Button>
				<Button variant="primary" disabled={saving || !form.host.trim()} onClick={() => void save()}>
					保存
				</Button>
			</div>
		</div>
	);
}

/** 远程目录浏览器 */
function DirBrowser({ host, onPick }: { host: SshHost; onPick: (path: string) => void }) {
	const [listing, setListing] = useState<RemoteDirListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(
		async (path?: string) => {
			setBusy(true);
			setError(null);
			try {
				setListing(await api.hosts.listDirs(host.id, path));
			} catch (e) {
				setError(errorText(e));
			} finally {
				setBusy(false);
			}
		},
		[host.id],
	);

	useEffect(() => {
		setListing(null);
		void load(host.defaultPath || undefined);
	}, [host.id, host.defaultPath, load]);

	const segments = listing ? listing.path.split("/").filter(Boolean) : [];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-1 border-b border-border pb-2 text-[12px]">
				<button
					type="button"
					disabled={!listing?.parent}
					onClick={() => listing?.parent && void load(listing.parent)}
					className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
				>
					↑ 上级
				</button>
				<button type="button" onClick={() => void load()} className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg">
					home
				</button>
				<div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={listing?.path}>
					/{segments.join("/")}
				</div>
				<button type="button" onClick={() => void load(listing?.path)} className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg">
					↻
				</button>
			</div>
			<div className="term min-h-0 flex-1 overflow-y-auto py-1 text-[12.5px]">
				{busy && !listing && <div className="px-2 py-1 text-muted">正在读取远程目录…</div>}
				{error && <div className="px-2 py-1 text-err">{error}</div>}
				{listing?.entries.length === 0 && <div className="px-2 py-1 text-muted">（没有子目录）</div>}
				{listing?.entries.map((entry) => (
					<button
						key={entry.path}
						type="button"
						onDoubleClick={() => void load(entry.path)}
						onClick={() => void load(entry.path)}
						title={entry.path}
						className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel-2"
					>
						<span className="shrink-0">📁</span>
						<span className="min-w-0 flex-1 truncate">{entry.name}</span>
					</button>
				))}
			</div>
			<div className="flex items-center gap-2 border-t border-border pt-2">
				<div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={listing?.path}>
					{listing?.path}
				</div>
				<Button variant="primary" disabled={!listing || busy} onClick={() => listing && onPick(listing.path)}>
					添加此目录为项目
				</Button>
			</div>
		</div>
	);
}

export function RemoteProjectDialog() {
	const open = useApp((s) => s.remoteOpen);
	const hosts = useApp((s) => s.hosts);
	const sshAvailable = useApp((s) => s.info?.ssh ?? null);
	const { setRemoteOpen, addRemoteProject } = useApp.getState();

	/** 运维会话：项目路径取主机默认目录，没有时取远程 home */
	const connectHost = async (host: SshHost) => {
		try {
			const path = host.defaultPath || (await api.hosts.listDirs(host.id)).home;
			await addRemoteProject(host.id, path, hostLabel(host));
		} catch (e) {
			if (hostKeyErrorHost(e)) {
				useApp.getState().setHostKeyPrompt(host.id, () => void connectHost(host));
				return;
			}
			useApp.getState().pushNotice("error", `连接主机失败：${errorText(e)}`);
		}
	};
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ id?: string; input: SshHostInput } | null>(null);

	// 打开时默认选中第一台主机
	useEffect(() => {
		if (!open) {
			setEditing(null);
			return;
		}
		if (!selectedId && hosts[0]) setSelectedId(hosts[0].id);
	}, [open, hosts, selectedId]);

	if (!open) return null;
	const selected = hosts.find((h) => h.id === selectedId) ?? null;

	return (
		<Modal
			title="远程主机（SSH）"
			width="w-[820px]"
			onClose={() => setRemoteOpen(false)}
			footer={<Button onClick={() => setRemoteOpen(false)}>关闭</Button>}
		>
			{!sshAvailable && (
				<div className="mb-3 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
					未找到 ssh 可执行文件。Windows 10/11 自带 OpenSSH 客户端（设置 → 应用 → 可选功能 → OpenSSH 客户端），或设置环境变量 FLOWORK_SSH 指向 ssh。
				</div>
			)}
			<div className="flex min-h-[380px] gap-4">
				<div className="flex w-[280px] shrink-0 flex-col gap-2 border-r border-border pr-3">
					<div className="flex items-center gap-2">
						<div className="text-[12px] font-medium text-muted">主机</div>
						<div className="flex-1" />
						<Button size="sm" onClick={() => setEditing({ input: { ...EMPTY_FORM } })}>
							＋ 新增
						</Button>
					</div>
					{hosts.length === 0 && <div className="text-[12px] text-muted">还没有主机，先新增一台服务器。</div>}
					<div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
						{hosts.map((h) => (
							<div
								key={h.id}
								className={`group flex items-center gap-1 rounded-md border px-2 py-1.5 ${
									h.id === selectedId ? "border-accent/50 bg-accent-soft" : "border-border hover:bg-panel-2"
								}`}
							>
								<button type="button" onClick={() => setSelectedId(h.id)} className="min-w-0 flex-1 text-left">
									<div className="truncate text-[12.5px]">{hostLabel(h)}</div>
									<div className="truncate font-mono text-[11px] text-muted">
										{h.host}
										{h.port ? `:${h.port}` : ""}
										{h.platform ? ` · ${h.platform}` : ""}
									</div>
								</button>
								<button
									type="button"
									title="编辑"
									className="shrink-0 rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:text-fg"
									onClick={() =>
										setEditing({
											id: h.id,
											input: {
												name: h.name ?? "",
												host: h.host,
												port: h.port,
												user: h.user ?? "",
												auth: h.auth,
												keyPath: h.keyPath ?? "",
												password: h.password ?? "",
												defaultPath: h.defaultPath ?? "",
											},
										})
									}
								>
									✎
								</button>
								<button
									type="button"
									title="删除主机"
									className="shrink-0 rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:text-err"
									onClick={() => {
										if (!window.confirm(`删除主机「${hostLabel(h)}」？`)) return;
										void api.hosts.remove(h.id).then(() => {
											if (selectedId === h.id) setSelectedId(null);
										});
									}}
								>
									✕
								</button>
							</div>
						))}
					</div>
				</div>

				<div className="flex min-w-0 flex-1 flex-col">
					{editing ? (
						<>
							<div className="mb-2 flex items-center gap-2">
								<div className="text-[12.5px] font-medium">{editing.id ? "编辑主机" : "新增主机"}</div>
								{editing.id && hosts.find((h) => h.id === editing.id)?.platform && (
									<Badge tone="accent">{hosts.find((h) => h.id === editing.id)?.platform}</Badge>
								)}
							</div>
							<HostForm
								key={editing.id ?? "new"}
								initial={editing}
								onCancel={() => setEditing(null)}
								onSaved={(host) => {
									setSelectedId(host.id);
									setEditing(null);
								}}
							/>
						</>
					) : selected ? (
						<>
							<div className="mb-2 flex items-center gap-2">
								<div className="min-w-0 truncate text-[12.5px] font-medium">{hostLabel(selected)}</div>
								{selected.platform && <Badge tone="accent">{selected.platform}</Badge>}
								<div className="flex-1" />
								<Button
									variant="primary"
									size="sm"
									title="以主机为单位打开运维会话：从默认目录（未设置时为登录用户的 home）开始，AI 可以操作整台服务器"
									onClick={() => void connectHost(selected)}
								>
									连接主机（运维）
								</Button>
							</div>
							<div className="mb-2 text-[11.5px] text-muted">
								「连接主机」直接打开运维会话，AI 在整台服务器上执行命令、修改配置；也可以在下面选一个目录作为项目。
							</div>
							<DirBrowser
								host={selected}
								onPick={(path) => void addRemoteProject(selected.id, path, selected.name ? `${selected.name}` : undefined)}
							/>
						</>
					) : (
						<div className="flex flex-1 items-center justify-center text-[12px] text-muted">选择或新增一台主机后浏览它的目录</div>
					)}
				</div>
			</div>
		</Modal>
	);
}
