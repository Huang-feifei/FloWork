/**
 * 工具审批：在会话末尾以终端提示的形式请求确认。
 *   ◆ 允许执行 bash？
 *     │ npm install
 *     [y] 允许   [a] 本会话始终允许 bash   [n] 拒绝
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
	const allowRef = useRef<HTMLButtonElement>(null);
	const decide = (decision: ApprovalDecision) => void respond(approval.toolCallId, decision);

	useEffect(() => {
		if (active) allowRef.current?.focus();
	}, [active]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 键盘快捷键作用于内部按钮
		<div
			className={`grid grid-cols-[2ch_1fr] gap-x-1 rounded-md border px-3 py-2 ${
				active ? "border-warn/60 bg-warn-soft" : "border-border opacity-70"
			}`}
			onKeyDown={(e) => {
				const key = e.key.toLowerCase();
				if (key === "y") decide("allow");
				else if (key === "a") decide("allow_session");
				else if (key === "n" || key === "escape") decide("deny");
				else return;
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			<span className="text-warn">◆</span>
			<div className="min-w-0">
				<div>
					允许执行 <span className="font-bold">{approval.toolName}</span>？
				</div>
				<div className="my-1 max-h-72 overflow-y-auto border-l-2 border-warn/40 pl-3">
					<Preview approval={approval} />
				</div>
				<div className="flex flex-wrap gap-2 pt-1">
					<button
						ref={allowRef}
						type="button"
						onClick={() => decide("allow")}
						className="rounded border border-ok/50 bg-ok-soft px-2 text-ok outline-none hover:bg-ok/20 focus:ring-2 focus:ring-ok/30"
					>
						[y] 允许
					</button>
					<button
						type="button"
						onClick={() => decide("allow_session")}
						className="rounded border border-border-strong px-2 outline-none hover:bg-panel-2 focus:ring-2 focus:ring-accent/20"
					>
						[a] 本会话始终允许 {approval.toolName}
					</button>
					<button
						type="button"
						onClick={() => decide("deny")}
						className="rounded border border-err/40 px-2 text-err outline-none hover:bg-err-soft focus:ring-2 focus:ring-err/20"
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
