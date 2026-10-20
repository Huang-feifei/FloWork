import { useState } from "react";
import type { DatabaseConnection, DatabaseInput, DatabaseKind } from "@shared/database";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Badge, Button, Field, Input, Modal, Segmented, Select, Toggle } from "../ui";

export function ConnectionDialog({ connection, onClose, onSaved }: { connection?: DatabaseConnection; onClose: () => void; onSaved: (c: DatabaseConnection) => void }) {
	const [draft, setDraft] = useState<DatabaseInput>(connection ? { ...connection } : { kind: "sqlite", name: "", file: "", host: "127.0.0.1", database: "", user: "", readOnly: true });
	const [busy, setBusy] = useState(false), [error, setError] = useState(""), [tested, setTested] = useState<string>();
	const hosts = useApp(s => s.hosts), info = useApp(s => s.info);
	const change = (patch: Partial<DatabaseInput>) => { setDraft(d => ({ ...d, ...patch })); setTested(undefined); setError(""); };
	const run = async (test: boolean) => {
		setBusy(true); setError(""); setTested(undefined);
		try {
			if (test) { const result = await api.database.test(draft, connection?.id); setTested(`连接成功 · ${result.durationMs} ms`); }
			else onSaved(await api.database.save(draft, connection?.id));
		} catch (e) { setError(errorText(e)); } finally { setBusy(false); }
	};
	return <Modal title={connection ? "编辑数据库连接" : "新建数据库连接"} width="w-[640px]" onClose={() => { if (!busy) onClose(); }} footer={<>
		<Button className="mr-auto" disabled={busy} onClick={() => void run(true)}>测试连接</Button>
		{busy && <Button size="sm" onClick={() => void api.database.cancel()}>取消操作</Button>}
		<Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void run(false)}>{busy ? "处理中…" : "保存连接"}</Button>
	</>}>
		<div className="space-y-5">
			<Segmented items={[{ id: "sqlite", label: "SQLite" }, { id: "postgres", label: "PostgreSQL" }, { id: "mysql", label: "MySQL" }]} active={draft.kind} onChange={kind => { if (!busy) change({ kind: kind as DatabaseKind, port: kind === "postgres" ? 5432 : 3306, sshHostId: undefined }); }} />
			<fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
				<Field label="连接名称" hint="不填时自动使用文件名或用户名@主机。"><Input value={draft.name} onChange={e => change({ name: e.target.value })} /></Field>
				{draft.kind === "sqlite" ? <Field label="SQLite 文件" hint={info?.nativeDialogs ? "只打开已有数据库，不会自动创建空文件。" : "填写后端所在机器上的绝对路径，不是浏览器本机路径。"}>
					<div className="flex gap-2"><Input aria-label="SQLite 文件" value={draft.file ?? ""} className="font-mono" onChange={e => change({ file: e.target.value })} />{info?.nativeDialogs && <Button onClick={() => void api.database.pickFile().then(file => { if (file) change({ file }); }).catch(e => setError(errorText(e)))}>选择…</Button>}</div>
				</Field> : <>
					<div className="grid grid-cols-[1fr_120px] gap-4"><Field label="主机地址"><Input value={draft.host ?? ""} onChange={e => change({ host: e.target.value })} /></Field><Field label="端口"><Input type="number" min={1} max={65535} value={draft.port ?? (draft.kind === "postgres" ? 5432 : 3306)} onChange={e => change({ port: Number(e.target.value) })} /></Field></div>
					<div className="grid grid-cols-2 gap-4"><Field label="数据库"><Input value={draft.database ?? ""} onChange={e => change({ database: e.target.value })} /></Field><Field label="用户名"><Input value={draft.user ?? ""} onChange={e => change({ user: e.target.value })} /></Field></div>
					<Field label="密码" hint={connection?.hasPassword ? "留空保留已保存密码；勾选下方选项可以清除。" : "桌面版优先使用系统加密保存；网页版没有系统加密时以明文存放。"}><Input type="password" autoComplete="new-password" value={draft.password ?? ""} placeholder={connection?.hasPassword ? "已保存（不显示）" : "可留空"} onChange={e => change({ password: e.target.value || undefined })} /></Field>
					{connection?.hasPassword && <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={draft.password === ""} onChange={e => change({ password: e.target.checked ? "" : undefined })} />清除已保存的密码</label>}
					<div className="flex items-center justify-between border-t border-border pt-4"><span>TLS（验证服务器证书）</span><Toggle on={draft.tls} onChange={tls => change({ tls })} /></div>
					<div className="border-t border-border pt-4"><div className="flex items-center justify-between"><span>通过 SSH 隧道</span><Toggle on={!!draft.sshHostId} onChange={enabled => { if (enabled && !hosts.length) { setError("请先在「远程主机」中添加 SSH 连接"); return; } change({ sshHostId: enabled ? hosts[0]?.id : undefined }); }} /></div>
						{draft.sshHostId && <Select className="mt-3" value={draft.sshHostId} onChange={e => change({ sshHostId: e.target.value })}>{hosts.map(h => <option key={h.id} value={h.id}>{h.name || `${h.user || ""}@${h.host}`}</option>)}</Select>}
						<p className="mt-2 text-xs leading-5 text-faint">复用已保存主机的系统 SSH 认证与密钥校验。隧道仅监听本机回环地址；数据库地址从远程 SSH 主机访问。</p>
					</div>
				</>}
				<div className="border-t border-border pt-4"><div className="flex items-center justify-between"><span>只读连接</span><Toggle on={draft.readOnly} onChange={readOnly => change({ readOnly })} /></div><p className="mt-2 text-xs leading-5 text-faint">默认只读，由数据库文件权限或事务强制执行。关闭后，每次写操作仍需要确认；建议使用数据库自身的只读账号。</p></div>
			</fieldset>
			{tested && <Badge tone="ok">{tested}</Badge>}{error && <div role="alert" className="whitespace-pre-wrap break-words rounded-xl bg-err-soft p-3 text-xs text-err">{error}</div>}
		</div>
	</Modal>;
}
