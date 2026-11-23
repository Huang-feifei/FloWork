/** 远程工作台的主机设置与目录选择。 */
import { useCallback, useEffect, useState } from "react";
import type { RemoteDirListing, SshHost, SshHostInput, SshTestResult } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Icon } from "../Icon";
import { Button, Field, Input, Modal, Select } from "../ui";

function hostLabel(host: SshHost): string {
	return host.name || `${host.user ? `${host.user}@` : ""}${host.host}`;
}

export function RemoteHostDialog({ host, onClose }: { host: SshHost | null; onClose: () => void }) {
	const [form, setForm] = useState<SshHostInput>(() => ({
		name: host?.name ?? "", host: host?.host ?? "", user: host?.user ?? "", port: host?.port,
		auth: host?.auth ?? "agent", keyPath: host?.keyPath ?? "", password: "", defaultPath: host?.defaultPath ?? "",
	}));
	const [id, setId] = useState(host?.id);
	const [busy, setBusy] = useState<"save" | "test" | null>(null);
	const [result, setResult] = useState<SshTestResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const patch = (p: Partial<SshHostInput>) => {
		setForm((f) => ({ ...f, ...p }));
		setResult(null);
	};

	const submit = async (action: "save" | "test") => {
		setBusy(action);
		setError(null);
		setResult(null);
		try {
			// 测试需要已保存的主机 ID；新增后记住 ID，后续操作不重复创建。
			const { password, ...config } = form;
			const input = password ? { ...config, password } : config;
			let hostId = id;
			if (hostId) {
				await api.hosts.update(hostId, input);
			} else {
				hostId = (await api.hosts.add(input)).host.id;
				setId(hostId);
			}
			if (action === "test") setResult(await api.hosts.test(hostId));
			else onClose();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(null);
		}
	};

	return (
		<Modal title={host ? `编辑主机 · ${hostLabel(host)}` : "新建主机"} width="w-[500px]" onClose={() => !busy && onClose()}
			footer={<>
				<Button disabled={!!busy} onClick={onClose}>取消</Button>
				<Button title="先保存当前配置，再测试连接" disabled={!!busy || !form.host.trim()} onClick={() => void submit("test")}>
					{busy === "test" ? "测试中…" : "保存并测试"}
				</Button>
				<Button variant="primary" disabled={!!busy || !form.host.trim()} onClick={() => void submit("save")}>
					{busy === "save" ? "保存中…" : "保存"}
				</Button>
			</>}
		>
			<div className="space-y-3">
				<Field label="显示名（可选）">
					<Input value={form.name ?? ""} onChange={(e) => patch({ name: e.target.value })} placeholder="例如 测试机" disabled={!!busy} />
				</Field>
				<div className="grid grid-cols-[1fr_88px] gap-2">
					<Field label="主机地址">
						<Input value={form.host} onChange={(e) => patch({ host: e.target.value })} placeholder="IP 地址或域名" disabled={!!busy} />
					</Field>
					<Field label="端口">
						<Input value={form.port ?? ""} inputMode="numeric" onChange={(e) => patch({ port: e.target.value ? Number(e.target.value) : undefined })} placeholder="22" disabled={!!busy} />
					</Field>
				</div>
				<Field label="用户名（可选，默认用 SSH 配置）">
					<Input value={form.user ?? ""} onChange={(e) => patch({ user: e.target.value })} disabled={!!busy} />
				</Field>
				<Field label="认证方式">
					<Select value={form.auth} onChange={(e) => patch({ auth: e.target.value as SshHostInput["auth"] })} disabled={!!busy}>
						<option value="agent">ssh-agent / ~/.ssh/config（推荐）</option>
						<option value="key">私钥文件</option>
						<option value="password">密码</option>
					</Select>
				</Field>
				{form.auth === "key" && (
					<Field label="私钥文件">
						<div className="flex gap-2">
							<Input value={form.keyPath ?? ""} onChange={(e) => patch({ keyPath: e.target.value })} disabled={!!busy} />
							<Button disabled={!!busy} onClick={() => void api.hosts.pickKey().then((p) => p && patch({ keyPath: p })).catch((e) => setError(errorText(e)))}>浏览…</Button>
						</div>
					</Field>
				)}
				{form.auth === "password" && (
					<Field label="密码" hint={host?.auth === "password" ? "留空保留原密码。密码由系统加密后存储。" : "密码由系统加密后存储。"}>
						<Input type="password" value={form.password ?? ""} onChange={(e) => patch({ password: e.target.value })} disabled={!!busy} />
					</Field>
				)}
				<Field label="默认目录（可选）" hint="留空则使用登录用户的主目录。">
					<Input value={form.defaultPath ?? ""} onChange={(e) => patch({ defaultPath: e.target.value })} placeholder="/var/www" disabled={!!busy} />
				</Field>
				{error && <p role="alert" className="rounded bg-err-soft px-3 py-2 text-err">{error}</p>}
				{result && <p role="status" className={`rounded px-3 py-2 ${result.ok ? "bg-ok-soft text-ok" : "bg-err-soft text-err"}`}>
					{result.ok ? <>连接成功（{result.latencyMs}ms）· {result.platform} · 主目录 {result.home} · Node {result.node ?? "未安装"}</> : <>连接失败：{result.error}</>}
				</p>}
			</div>
		</Modal>
	);
}

export function RemoteProjectDialog({ host, onClose }: { host: SshHost; onClose: () => void }) {
	const [listing, setListing] = useState<RemoteDirListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(true);
	const [adding, setAdding] = useState(false);
	const { addRemoteProject } = useApp.getState();
	const load = useCallback(async (path?: string) => {
		setBusy(true);
		setError(null);
		try {
			setListing(await api.hosts.listDirs(host.id, path));
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}, [host.id]);

	useEffect(() => void load(host.defaultPath || undefined), [host.defaultPath, load]);

	return (
		<Modal title={`选择远程目录 · ${hostLabel(host)}`} width="w-[580px]" onClose={onClose}
			footer={<>
				<Button onClick={onClose}>取消</Button>
				<Button variant="primary" disabled={!listing || busy || adding || !!error} onClick={() => {
					if (!listing) return;
					setAdding(true);
					void addRemoteProject(host.id, listing.path, host.name || undefined).finally(() => setAdding(false));
				}}>{adding ? "正在添加…" : "添加此目录为项目"}</Button>
			</>}
		>
			<div className="flex h-[min(300px,48vh)] flex-col">
				<div className="flex items-center gap-1 border-b border-border pb-2">
					<Button variant="ghost" size="sm" disabled={busy || adding || !listing?.parent} onClick={() => void load(listing?.parent ?? undefined)}>
						<Icon name="arrow-up" className="size-3.5" />上级
					</Button>
					<Button variant="ghost" size="sm" disabled={busy || adding} onClick={() => void load()}>主目录</Button>
					<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted" title={listing?.path}>{listing?.path}</span>
					<Button variant="ghost" size="sm" aria-label="刷新目录" title="刷新目录" disabled={busy || adding} onClick={() => void load(listing?.path ?? host.defaultPath)}>
						<Icon name="refresh" className="size-3.5" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto py-2" aria-busy={busy}>
					{busy && <p className="px-2 py-1 text-muted">正在读取目录…</p>}
					{error && <p role="alert" className="px-2 py-1 text-err">{error}</p>}
					{!busy && !error && listing?.entries.length === 0 && <p className="px-2 py-1 text-muted">这个目录没有子目录。</p>}
					{listing?.entries.map((entry) => (
						<button key={entry.path} type="button" disabled={busy || adding} onClick={() => void load(entry.path)} title={entry.path}
							className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel-2 disabled:opacity-50">
							<Icon name="folder" className="size-4 text-muted" />
							<span className="min-w-0 flex-1 truncate">{entry.name}</span>
						</button>
					))}
				</div>
			</div>
		</Modal>
	);
}
