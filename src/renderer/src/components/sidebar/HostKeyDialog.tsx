/**
 * 主机密钥已变化：并排显示本机记录的旧指纹与服务器当前的新指纹，用户确认后更新 known_hosts。
 *
 * 任何 SSH 操作（打开运维会话、文件浏览、AI 工具、远程终端）遇到 host key 变化时，store 会设置 hostKeyPrompt 打开本对话框。
 */
import { useEffect, useState } from "react";
import type { HostKeyReport } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Button, Modal } from "../ui";

export function HostKeyDialog() {
	const hostId = useApp((s) => s.hostKeyPrompt);
	const host = useApp((s) => s.hosts.find((h) => h.id === s.hostKeyPrompt));
	const { setHostKeyPrompt, pushNotice } = useApp.getState();
	const [report, setReport] = useState<HostKeyReport | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirmed, setConfirmed] = useState(false);

	useEffect(() => {
		setReport(null);
		setError(null);
		setConfirmed(false);
		if (!hostId) return;
		let cancelled = false;
		api.hosts
			.inspectKey(hostId)
			.then((r) => !cancelled && setReport(r))
			.catch((e) => !cancelled && setError(errorText(e)));
		return () => {
			cancelled = true;
		};
	}, [hostId]);

	if (!hostId) return null;
	const close = () => setHostKeyPrompt(null);
	const label = host ? host.name || `${host.user ? `${host.user}@` : ""}${host.host}` : "远程主机";

	const accept = async () => {
		if (!report) return;
		setBusy(true);
		try {
			await api.hosts.acceptKey(hostId, report.current.map((c) => c.fingerprint));
			const retry = useApp.getState().hostKeyRetry;
			pushNotice("info", `已更新「${label}」的主机密钥，正在重新连接`);
			close();
			if (retry) retry();
			else {
				// 当前打开的就是这台主机的项目时，自动重连
				const s = useApp.getState();
				const active = s.projects.projects.find((p) => p.id === s.activeProjectId);
				if (active?.hostId === hostId && !s.handleId) void s.openProject(active.id);
			}
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	// 只列出发生变化的类型；旧记录里没有对应新类型时也展示，便于比对
	const changedTypes = report ? [...new Set(report.known.map((k) => k.type))] : [];

	return (
		<Modal
			title="服务器的主机密钥已变化"
			width="w-[640px]"
			onClose={close}
			footer={
				<>
					<Button onClick={close}>取消</Button>
					<Button variant="primary" disabled={!report?.changed || !confirmed || busy} onClick={() => void accept()}>
						{busy ? "正在更新…" : "我已确认，更新指纹"}
					</Button>
				</>
			}
		>
			<div className="space-y-3 text-[12.5px] leading-relaxed">
				<p>
					连接 <span className="font-mono font-medium">{report?.target ?? label}</span> 时，服务器出示的身份指纹与本机
					<span className="font-mono"> known_hosts </span>
					里的记录不一致，SSH 因此拒绝连接。
				</p>
				<ul className="list-disc space-y-0.5 pl-5 text-muted">
					<li>最常见：服务器重装了系统，或重新生成了 SSH 密钥。</li>
					<li>这个 IP 换成了另一台机器（例如云服务器释放后重新分配）。</li>
					<li>少见但需要警惕：连接被他人劫持（中间人攻击）。</li>
				</ul>

				{error && <div className="rounded border border-err/40 bg-err-soft px-3 py-2 text-err">{error}</div>}
				{!report && !error && <div className="text-muted">正在读取本机记录与服务器当前的指纹…</div>}

				{report && (
					<div className="overflow-hidden rounded-md border border-border">
						<table className="w-full font-mono text-[11.5px]">
							<thead className="bg-panel-2 text-left text-muted">
								<tr>
									<th className="px-2 py-1 font-normal">类型</th>
									<th className="px-2 py-1 font-normal">本机记录（旧）</th>
									<th className="px-2 py-1 font-normal">服务器当前（新）</th>
								</tr>
							</thead>
							<tbody>
								{[...new Set([...changedTypes, ...report.current.map((c) => c.type)])].map((type) => {
									const olds = report.known.filter((k) => k.type === type);
									const now = report.current.find((c) => c.type === type);
									const diff = olds.length > 0 && !!now && !olds.some((o) => o.fingerprint === now.fingerprint);
									return (
										<tr key={type} className="border-t border-border align-top">
											<td className="px-2 py-1 whitespace-nowrap">{type.replace(/^ssh-/, "")}</td>
											<td className={`px-2 py-1 break-all ${diff ? "text-err line-through" : "text-muted"}`}>
												{olds.length ? olds.map((o) => <div key={o.fingerprint}>{o.fingerprint}</div>) : "（无记录）"}
											</td>
											<td className={`px-2 py-1 break-all ${diff ? "font-medium text-ok" : "text-muted"}`}>{now?.fingerprint ?? "（未提供）"}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}

				{report && !report.changed && (
					<div className="rounded border border-ok/40 bg-ok-soft px-3 py-2">
						服务器当前的指纹与本机记录一致，不需要更新。可以直接重新连接；如果仍然失败，请检查网络或认证设置。
					</div>
				)}

				{report?.changed && (
					<>
						<div className="rounded border border-warn/40 bg-warn-soft px-3 py-2">
							<div className="font-medium">更新前请先确认新指纹确实属于你的服务器</div>
							<div className="mt-1 text-muted">
								通过云厂商控制台的网页终端（VNC）登录这台服务器，执行下面的命令，输出的 SHA256 应与上表「服务器当前」一致：
							</div>
							<pre className="mt-1 rounded bg-panel px-2 py-1 font-mono text-[11.5px] select-all">
								for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
							</pre>
						</div>
						<label className="flex items-start gap-2">
							<input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
							<span>我已核对，新指纹属于我的服务器（例如我刚重装过系统）。</span>
						</label>
						<div className="text-[11.5px] text-muted">
							更新会删除这台主机在 known_hosts 中的旧记录（OpenSSH 会把原文件备份为 known_hosts.old），然后写入上表的新指纹。
							写入前会再扫描一次，若指纹又变了则取消更新。
						</div>
					</>
				)}
			</div>
		</Modal>
	);
}
