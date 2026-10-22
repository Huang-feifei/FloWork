import { useEffect, useState } from "react";
import type { KernelUpdateStatus } from "@shared/kernel";
import { api, errorText } from "../../api/client";
import { Badge, Button, Card } from "../ui";

const PHASE_LABELS: Record<KernelUpdateStatus["phase"], string> = {
	idle: "等待检查", checking: "检查更新中…", downloading: "下载内核中…", verifying: "校验并自检中…", ready: "重启后生效", error: "操作失败",
};
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function KernelTab() {
	const [status, setStatus] = useState<KernelUpdateStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [requesting, setRequesting] = useState(false);

	useEffect(() => {
		let alive = true;
		let pushed = false;
		const unsubscribe = api.onPush((push) => {
			if (push.type === "kernel_update" && alive) { pushed = true; setStatus(push.status); }
		});
		void api.kernel.status().then((next) => { if (alive && !pushed) setStatus(next); }, (e) => { if (alive) setError(errorText(e)); });
		return () => { alive = false; unsubscribe(); };
	}, []);

	const busy = requesting || status?.phase === "checking" || status?.phase === "downloading" || status?.phase === "verifying";
	const run = async (action: () => Promise<unknown>) => {
		setError(null);
		setRequesting(true);
		try { await action(); }
		catch (e) { setError(errorText(e)); }
		finally { setRequesting(false); }
	};

	return (
		<div className="space-y-6">
			<Card>
				<div className="flex flex-wrap items-center gap-3">
					<h3 className="text-[15px] font-semibold">当前内核</h3>
					{status && <Badge tone="primary">{status.current.source === "bundled" ? "应用内置" : "独立更新"}</Badge>}
					<div className="flex-1" />
					{status && <Badge tone={status.phase === "error" ? "err" : status.pending ? "warn" : "muted"}>{PHASE_LABELS[status.phase]}</Badge>}
				</div>
				<dl className="mt-4 grid grid-cols-[100px_1fr] gap-y-2 text-[13.5px]">
					<dt className="text-muted">更新批次</dt><dd className="font-mono">{status?.current.version ?? "…"}</dd>
					<dt className="text-muted">Pi 版本</dt><dd className="font-mono">{status?.current.piVersion ?? "…"}</dd>
					<dt className="text-muted">发布仓库</dt><dd className="break-all">{status?.repository ? `GitHub · ${status.repository}` : "尚未配置"}</dd>
					<dt className="text-muted">内核来源</dt><dd>维护者签名完整包 · GitHub Releases</dd>
				</dl>
				{status?.message && <p className="mt-4 text-[13px] leading-6 text-muted">{status.message}</p>}
				{(error || status?.error) && <div role="alert" className="mt-4 rounded-xl bg-err-soft px-4 py-3 text-[13px] text-err">{error || status?.error}</div>}
				{status?.phase === "downloading" && (
					<div className="mt-4" aria-live="polite">
						<progress className="h-2 w-full" max={status.totalBytes || 1} value={status.downloadedBytes} aria-label="内核下载进度" />
						<p className="mt-1 text-[12px] text-muted">{megabytes(status.downloadedBytes)} / {megabytes(status.totalBytes)}</p>
					</div>
				)}
				<div className="mt-5 flex flex-wrap gap-2">
					<Button disabled={!status?.configured || busy} onClick={() => void run(api.kernel.check)}>检查更新</Button>
					{status?.latest && (
						<Button variant="primary" disabled={busy || status.pending?.version === status.latest.version} onClick={() => void run(api.kernel.install)}>
							下载并更新 Pi {status.latest.piVersion}
						</Button>
					)}
					{status?.pending && <Button variant="primary" disabled={busy} onClick={() => void run(api.kernel.restart)}>重启并应用</Button>}
					{(status?.current.source === "downloaded" || status?.pending) && (
						<Button disabled={busy} onClick={() => void run(api.kernel.useBundled)}>
							{status.current.source === "bundled" ? "取消待生效更新" : "恢复内置内核"}
						</Button>
					)}
				</div>
			</Card>
			{status?.pending && <Card><h3 className="text-[15px] font-semibold">待生效：{status.pending.version}</h3><p className="mt-2 text-[13px] leading-6 text-muted">Pi {status.pending.piVersion} · {status.pending.source === "bundled" ? "恢复应用内置版" : "已下载并通过签名校验与启动自检"}。当前进程继续使用原内核，下次启动时切换。</p></Card>}
			{status?.latest && (
				<Card>
					<h3 className="text-[15px] font-semibold">可用更新 · {status.latest.version} / Pi {status.latest.piVersion}</h3>
					<pre className="mt-3 whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-muted">{status.latest.notes || "此版本未提供更新说明。"}</pre>
					<a className="mt-3 inline-block text-[13px] text-primary hover:underline" href={status.latest.releaseUrl} target="_blank" rel="noreferrer">在 GitHub 查看发布详情</a>
				</Card>
			)}
			<p className="text-[12.5px] leading-6 text-faint">仅显示维护者测试并签名放行的 Pi 版本；完整内核包从维护者的 GitHub Releases 下载，不在客户端运行 npm，也不自动追随官方最新版。继续使用当前应用内置的 Worker 适配层，不从网络替换适配代码。启动自检失败会回退旧内核；更新不会删除会话与配置。运行中或等待交互的会话需先结束再重启。</p>
		</div>
	);
}
