/**
 * 工具审批：在会话末尾以终端提示的形式请求确认。
 *   ◆ 允许执行 bash？
 *     │ npm install
 *     [y] 允许   [a] 本会话始终允许 bash   [n] 拒绝
 *     高危操作和数据库 / SSH 连接不显示 [a]，只能逐次确认。
 */
import { useEffect, useRef } from "react";
import type { ApprovalDecision } from "@shared/protocol";
import { type PendingApproval, useApp } from "../../store";

const PREVIEW_LINES = 14;

function clip(lines: string[]): string[] {
	return lines.length > PREVIEW_LINES ? [...lines.slice(0, PREVIEW_LINES), `… 共 ${lines.length} 行`] : lines;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function Preview({ approval }: { approval: PendingApproval }) {
	const cwd = useApp((s) => s.cwd);
	const args = (approval.args && typeof approval.args === "object" ? approval.args : {}) as Record<string, unknown>;
	const rel = (p: string) =>
		cwd && p.replaceAll("\\", "/").toLowerCase().startsWith(`${cwd.replaceAll("\\", "/").toLowerCase()}/`)
			? p.slice(cwd.length + 1)
			: p;

	switch (approval.toolName) {
		case "bash":
		case "powershell":
			return <pre className="whitespace-pre-wrap break-all">{clip(str(args.command).split("\n")).join("\n")}</pre>;
		case "write": {
			const content = str(args.content);
			return (
				<div>
					<div>
						写入 <span className="font-bold">{rel(str(args.path))}</span>
						<span className="text-muted">（{content.split("\n").length} 行）</span>
					</div>
					<pre className="mt-1 whitespace-pre-wrap break-all text-diff-add-fg">
						{clip(content.split("\n"))
							.map((l) => `+ ${l}`)
							.join("\n")}
					</pre>
				</div>
			);
		}
		case "edit": {
			const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : [];
			return (
				<div>
					<div>
						修改 <span className="font-bold">{rel(str(args.path))}</span>
						<span className="text-muted">（{edits.length} 处）</span>
					</div>
					{edits.slice(0, 4).map((edit, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 编辑项没有 id
						<pre key={i} className="mt-1 whitespace-pre-wrap break-all">
							{clip(str(edit.oldText).split("\n")).map((l) => (
								<div key={`o${l}`} className="bg-diff-del text-diff-del-fg">
									- {l}
								</div>
							))}
							{clip(str(edit.newText).split("\n")).map((l) => (
								<div key={`n${l}`} className="bg-diff-add text-diff-add-fg">
									+ {l}
								</div>
							))}
						</pre>
					))}
				</div>
			);
		}
		default:
			return <pre className="whitespace-pre-wrap break-all text-muted">{clip(JSON.stringify(args, null, 2).split("\n")).join("\n")}</pre>;
	}
}

function ApprovalItem({ approval, active }: { approval: PendingApproval; active: boolean }) {
	const respond = useApp((s) => s.respondApproval);
	const host = useApp((s) => s.state?.ops?.label);
	const allowRef = useRef<HTMLButtonElement>(null);
	const danger = approval.risk?.level === "danger";
	const forced = approval.risk?.forced === true;
	const singleOnly = danger || forced;
	const decide = (decision: ApprovalDecision) => void respond(approval.toolCallId, decision);

	useEffect(() => {
		if (active) allowRef.current?.focus();
	}, [active]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 键盘快捷键作用于内部按钮
		<div
			className={`fw-card grid grid-cols-[2ch_1fr] gap-x-2 px-4 py-3.5 ${
				danger ? (active ? "ring-1 ring-err/40" : "opacity-70") : active ? "ring-1 ring-warn/40" : "opacity-70"
			}`}
			onKeyDown={(e) => {
				const key = e.key.toLowerCase();
				if (key === "y") decide("allow");
				else if (key === "a" && !singleOnly) decide("allow_session");
				else if (key === "n" || key === "escape") decide("deny");
				else return;
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			<span className={danger ? "text-err" : "text-warn"}>{danger ? "▲" : "◆"}</span>
			<div className="min-w-0">
				<div className="text-[14px] leading-relaxed">
					{danger ? <span className="mr-1 font-medium text-err">高危操作</span> : null}
					{forced && !danger ? <span className="mr-1 font-medium text-warn">连接操作</span> : null}
					允许{host ? <>在 <span className="font-mono">{host}</span> 上</> : null}执行 <span className="font-medium text-fg">{approval.toolName}</span>？
				</div>
				{(danger || forced) && approval.risk?.reasons.length ? (
					<ul className={`mt-1.5 list-disc pl-4 text-[12.5px] leading-relaxed ${danger ? "text-err" : "text-warn"}`}>
						{approval.risk.reasons.map((r) => (
							<li key={r}>{r}</li>
						))}
					</ul>
				) : null}
				<div className="my-2.5 max-h-72 overflow-y-auto rounded-xl bg-panel-2 px-3.5 py-2.5 font-mono text-[12.5px] leading-[1.7]">
					<Preview approval={approval} />
				</div>
				<div className="flex flex-wrap items-center gap-2 pt-2.5">
					<button
						ref={allowRef}
						type="button"
						onClick={() => decide("allow")}
						className="rounded-full bg-primary px-3.5 py-1.5 text-[12.5px] font-medium text-primary-foreground outline-none hover:bg-primary-strong focus:ring-4 focus:ring-primary/20"
					>
						[y] 允许
					</button>
					{/* 高危操作、数据库 / SSH 连接只能逐条确认 */}
					{!singleOnly && (
						<button
							type="button"
							onClick={() => decide("allow_session")}
						className="rounded-full bg-panel-2 px-3.5 py-1.5 text-[12.5px] text-fg outline-none hover:bg-highlight focus:ring-4 focus:ring-primary/10"
						>
							[a] 本会话始终允许 {approval.toolName}
						</button>
					)}
					<button
						type="button"
						onClick={() => decide("deny")}
						className="rounded-full bg-panel-2 px-3.5 py-1.5 text-[12.5px] text-fg outline-none hover:bg-highlight focus:ring-4 focus:ring-primary/10"
					>
						[n] 拒绝
					</button>
				</div>
			</div>
		</div>
	);
}

export function ApprovalPanel() {
	const pending = useApp((s) => s.pendingApprovals);
	if (pending.length === 0) return null;
	return (
		<div className="flex flex-col gap-2">
			{pending.map((approval, i) => (
				<ApprovalItem key={approval.toolCallId} approval={approval} active={i === 0} />
			))}
		</div>
	);
}
