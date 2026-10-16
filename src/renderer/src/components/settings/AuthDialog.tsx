/** 供应商登录 / 配置 API Key 的对话框：OAuth 设备码、授权链接、手动输入。
 *  Apple 体系：说明与设备码都放进浅灰圆角块（去掉自绘边框），主按钮是唯一的蓝色 pill。 */
import { useEffect, useRef, useState } from "react";
import type { AuthNotice } from "@shared/protocol";
import { useAuth } from "../../authStore";
import { Button, Input, Modal } from "../ui";

function NoticeView({ notice }: { notice: AuthNotice }) {
	switch (notice.type) {
		case "info":
			return (
				<div className="text-[13.5px] leading-relaxed">
					{notice.message}
					{notice.links?.map((l) => (
						<a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="ml-2 text-primary underline underline-offset-2">
							{l.label ?? l.url}
						</a>
					))}
				</div>
			);
		case "progress":
			return <div className="text-[12.5px] text-muted">{notice.message}</div>;
		case "auth_url":
			return (
				<div className="space-y-3 rounded-xl bg-panel-2 p-4 text-[13.5px]">
					<div>{notice.instructions ?? "请在浏览器中完成授权："}</div>
					<div className="flex items-center gap-2">
						<Button variant="primary" size="sm" onClick={() => window.open(notice.url, "_blank")}>
							打开授权页面
						</Button>
						<Button size="sm" onClick={() => void navigator.clipboard.writeText(notice.url)}>
							复制链接
						</Button>
					</div>
					<div className="truncate font-mono text-[11.5px] text-muted" title={notice.url}>
						{notice.url}
					</div>
				</div>
			);
		case "device_code":
			return (
				<div className="space-y-3 rounded-xl bg-panel-2 p-4 text-[13.5px]">
					<div>在授权页面输入以下代码：</div>
					<div className="font-mono text-[26px] font-semibold tracking-widest text-fg">{notice.userCode}</div>
					<div className="flex gap-2">
						<Button variant="primary" size="sm" onClick={() => window.open(notice.verificationUri, "_blank")}>
							打开 {notice.verificationUri}
						</Button>
						<Button size="sm" onClick={() => void navigator.clipboard.writeText(notice.userCode)}>
							复制代码
						</Button>
					</div>
				</div>
			);
	}
}

export function AuthDialog() {
	const flow = useAuth((s) => s.flow);
	const { answer, cancel, close } = useAuth.getState();
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const promptId = flow?.prompt?.promptId;

	useEffect(() => {
		setValue("");
		if (promptId) inputRef.current?.focus();
	}, [promptId]);

	if (!flow) return null;
	const prompt = flow.prompt?.prompt;
	const finished = flow.status !== "running";

	return (
		<Modal
			title={`${flow.method === "oauth" ? "登录" : "配置 API Key"}：${flow.providerName}`}
			onClose={() => void (finished ? close() : cancel())}
			footer={
				finished ? (
					<Button variant="primary" onClick={close}>
						完成
					</Button>
				) : (
					<Button onClick={() => void cancel()}>取消</Button>
				)
			}
		>
			<div className="space-y-3">
				{flow.notices.map((n, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 通知按顺序追加
					<NoticeView key={i} notice={n} />
				))}

				{prompt && (
					<form
						className="space-y-2.5"
						onSubmit={(e) => {
							e.preventDefault();
							if (prompt.type !== "select" && value.trim()) void answer(value.trim());
						}}
					>
						<div className="text-[13.5px]">{prompt.message}</div>
						{prompt.type === "select" ? (
							<div className="space-y-2">
								{prompt.options.map((o) => (
									<button
										type="button"
										key={o.id}
										onClick={() => void answer(o.id)}
										className="block w-full rounded-xl bg-panel-2 px-3.5 py-2.5 text-left hover:bg-highlight"
									>
										<div className="text-[13.5px] text-fg">{o.label}</div>
										{o.description && <div className="mt-0.5 text-[12px] text-muted">{o.description}</div>}
									</button>
								))}
							</div>
						) : (
							<div className="flex gap-2">
								<Input
									ref={inputRef}
									type={prompt.type === "secret" ? "password" : "text"}
									value={value}
									onChange={(e) => setValue(e.target.value)}
									placeholder={prompt.placeholder ?? (prompt.type === "manual_code" ? "粘贴授权码或回调地址" : "")}
									autoComplete="off"
								/>
								<Button type="submit" variant="primary" disabled={!value.trim()}>
									确定
								</Button>
							</div>
						)}
					</form>
				)}

				{flow.status === "running" && !prompt && (
					<div className="text-[13.5px] text-muted animate-pulse">等待中…</div>
				)}
				{flow.status === "done" && (
					<div className="rounded-xl bg-ok-soft px-3.5 py-2.5 text-[13.5px] text-accent-strong">
						已保存。可以在供应商列表中展开该项测试连接。
					</div>
				)}
				{flow.status === "error" && (
					<div className="rounded-xl bg-err-soft px-3.5 py-2.5 text-[13.5px] text-err">{flow.error}</div>
				)}
			</div>
		</Modal>
	);
}
