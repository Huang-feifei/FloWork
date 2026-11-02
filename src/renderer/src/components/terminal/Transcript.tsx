/**
 * 终端风格的会话记录：
 *   ❯ 用户输入
 *   ● 回复文本（Markdown）
 *   🌲 任务执行进度树（聚合思考与工具调用）
 *
 * 彻底重构了历史轮次与运行中过程的展示：
 * - 连续的思考与工具调用聚合为单个结构化的「任务执行进度树」，去除了零碎割裂的黑胶囊与悬空圆点；
 * - 折叠状态为精致的单行状态栏，展开状态为优雅的树状导轨线；
 * - 支持一键跳转右侧面板查看全景执行树。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ContentBlock, ImageAttachment } from "@shared/protocol";
import { parseSkillInvocation } from "@shared/skill-text";
import { buildTurns, turnChangedFiles, turnKey, type Turn } from "../../lib/session-turns";
import { buildTurnFlowBlocks, type ToolResultMap, type TurnContentBlock } from "../../lib/session-flow";
import type { SessionFile } from "../../lib/session-files";
import { useApp } from "../../store";
import { ExecutionTree } from "./ExecutionTree";
import { ImageThumb } from "./ImageThumb";
import { Markdown } from "./Markdown";
import { TurnFooter } from "./TurnFooter";

function Gutter({ mark, className = "", children }: { mark: React.ReactNode; className?: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[2ch_1fr] gap-x-2">
			<div className={className}>{mark}</div>
			<div className="min-w-0">{children}</div>
		</div>
	);
}

function imagesOf(content: ContentBlock[]): ImageAttachment[] {
	return content.filter((b): b is ImageAttachment => b.type === "image");
}

function UserLine({ message }: { message: Extract<ChatMessage, { role: "user" }> }) {
	// 图片单独渲染，文本里不再插占位符，避免污染 /skill: 解析
	const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
	const images = imagesOf(message.content);
	const skill = parseSkillInvocation(text);
	return (
		<div className="-mx-2 rounded-2xl bg-panel-2 px-4 py-3">
			<Gutter mark="❯" className="font-semibold text-primary">
				{skill ? <SkillInvocation skill={skill} /> : <div className="text-[14.5px] leading-relaxed whitespace-pre-wrap">{text}</div>}
				{images.length > 0 && (
					<div className="mt-1 flex flex-wrap gap-2">
						{images.map((image, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 消息内容块按位置稳定，没有独立 id
							<ImageThumb key={i} image={image} alt={`消息中的图片 ${i + 1}`} />
						))}
					</div>
				)}
			</Gutter>
		</div>
	);
}

/** /skill:名称 调用：折叠显示，点击可查看展开进消息的技能全文 */
function SkillInvocation({ skill }: { skill: { skill: string; args: string; body: string } }) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				title="查看技能内容"
				className="mr-2 rounded-full bg-primary-soft px-2 py-0.5 font-medium text-primary hover:bg-primary/15"
			>
				/skill:{skill.skill} {open ? "▾" : "▸"}
			</button>
			<span className="whitespace-pre-wrap">{skill.args}</span>
			{open && (
				<div className="mt-1.5 max-h-72 overflow-y-auto border-l-2 border-border pl-3 whitespace-pre-wrap text-muted">{skill.body}</div>
			)}
		</div>
	);
}

function NoteLine({ kind, text }: { kind: string; text: string }) {
	return (
		<Gutter mark="※" className="text-muted">
			<div className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
				<span className="mr-2 font-mono">[{kind}]</span>
				{text}
			</div>
		</Gutter>
	);
}

/** 单个轮次内聚合后的内容流视图 */
const TurnBlocksView = memo(function TurnBlocksView({
	blocks,
	folded,
	onOpenPanel,
}: {
	blocks: TurnContentBlock[];
	folded: boolean;
	onOpenPanel: () => void;
}) {
	return (
		<div className="space-y-3">
			{blocks.map((block) => {
				if (block.type === "execution") {
					return (
						<ExecutionTree
							key={block.group.id}
							group={block.group}
							folded={folded}
							onOpenPanel={onOpenPanel}
						/>
					);
				}

				if (block.type === "text") {
					return (
						<div key={block.id} className="text-[14.5px] leading-relaxed">
							{block.text && (
								<Gutter mark="●">
									<Markdown text={block.text} />
									{block.live && <span className="term-cursor" />}
								</Gutter>
							)}
							{block.stopReason === "error" && (
								<Gutter mark="✗" className="text-err">
									<span className="text-err">{block.errorMessage || "请求失败"}</span>
								</Gutter>
							)}
							{block.stopReason === "aborted" && (
								<Gutter mark="⎿" className="text-muted">
									<span className="text-muted">已中断</span>
								</Gutter>
							)}
						</div>
					);
				}

				if (block.type === "note") {
					return <NoteLine key={block.id} kind={block.kind} text={block.text} />;
				}

				return null;
			})}
		</div>
	);
});

/**
 * 长会话分段渲染：首次只挂最近 INITIAL_ROWS 条可见消息，
 * 往上滚到顶部再每次多挂 MORE_ROWS 条。
 */
const INITIAL_ROWS = 80;
const MORE_ROWS = 80;

const isRow = (m: ChatMessage | undefined) => !!m && m.role !== "toolResult";

function windowStart(messages: readonly ChatMessage[], rows: number): number {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isRow(messages[i]) && ++seen === rows) return i;
	}
	return 0;
}

function countRows(messages: readonly ChatMessage[], end: number): number {
	let n = 0;
	for (let i = 0; i < end; i++) if (isRow(messages[i])) n++;
	return n;
}

function LoadEarlier({ hidden, onMore, onAll }: { hidden: number; onMore: () => void; onAll: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let armed = false;
		const observer = new IntersectionObserver((entries) => {
			const visible = entries.some((e) => e.isIntersecting);
			if (!visible) armed = true;
			else if (armed) {
				armed = false;
				onMore();
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [onMore]);
	return (
		<div ref={ref} className="flex items-center justify-center gap-3 rounded-full bg-panel-2 py-1.5 text-[12.5px] text-muted">
			<span>更早还有 {hidden} 条消息未显示</span>
			<button type="button" onClick={onMore} className="font-medium text-primary hover:underline">
				再显示 {Math.min(MORE_ROWS, hidden)} 条
			</button>
			<button type="button" onClick={onAll} className="text-muted hover:text-fg hover:underline">
				全部显示
			</button>
		</div>
	);
}

export function Transcript() {
	const messages = useApp((s) => s.messages);
	const streaming = useApp((s) => s.streaming);
	const foldProcess = useApp((s) => s.foldProcess);
	const isRunning = useApp((s) => s.isRunning);
	const setRightPanel = useApp((s) => s.setRightPanel);
	const cwd = useApp((s) => s.cwd);
	const sessionKey = useApp((s) => s.state?.sessionId ?? "");
	const [rows, setRows] = useState(INITIAL_ROWS);
	/** 每轮过程折叠状态的显式覆盖：key 为轮次 key */
	const [turnFold, setTurnFold] = useState<Record<string, boolean>>({});

	useEffect(() => {
		setRows(INITIAL_ROWS);
		setTurnFold({});
	}, [sessionKey]);

	const start = useMemo(() => windowStart(messages, rows), [messages, rows]);
	const hidden = useMemo(() => countRows(messages, start), [messages, start]);
	const showMore = useCallback(() => setRows((n) => n + MORE_ROWS), []);
	const showAll = useCallback(() => setRows(Number.POSITIVE_INFINITY), []);

	const turns = useMemo(() => buildTurns(messages), [messages]);
	const lastTurn = turns[turns.length - 1];
	const live = isRunning || !!streaming;

	const turnChanges = useMemo(() => {
		const map = new Map<string, SessionFile[]>();
		for (const turn of turns) map.set(turnKey(turn), turnChangedFiles(turn, cwd));
		return map;
	}, [turns, cwd]);

	const toolResults = useMemo(() => {
		const map: ToolResultMap = new Map();
		for (const m of messages) {
			if (m.role === "toolResult") map.set(m.toolCallId, { content: m.content, details: m.details, isError: m.isError });
		}
		return map;
	}, [messages]);

	const handleOpenExecutionPanel = useCallback(() => {
		setRightPanel("execution");
	}, [setRightPanel]);

	// 前置的纯系统 note 消息（若在第一轮提问之前出现）
	const leadingNotes = useMemo(() => {
		const out: Extract<ChatMessage, { role: "note" }>[] = [];
		for (const m of messages) {
			if (m.role === "user") break;
			if (m.role === "note") out.push(m);
		}
		return out;
	}, [messages]);

	return (
		<div className="flex flex-col gap-6">
			{hidden > 0 && <LoadEarlier hidden={hidden} onMore={showMore} onAll={showAll} />}

			{leadingNotes.map((n, i) => (
				<NoteLine key={n.entryId ?? `leading-note-${i}`} kind={n.kind} text={n.text} />
			))}

			{turns.map((turn) => {
				// 该轮如果完全在窗口起始下标之前，跳过挂载
				if (turn.endIndex < start) return null;

				const key = turnKey(turn);
				const isLast = turn === lastTurn;
				const isLiveThisTurn = isLast && live;
				const effectiveFold = turnFold[key] ?? foldProcess;
				const changed = turnChanges.get(key) ?? [];
				const showFooter = !isLiveThisTurn && (isLast || changed.length > 0);

				const flowBlocks = buildTurnFlowBlocks(
					turn.messages,
					toolResults,
					isLiveThisTurn ? streaming : null,
				);

				return (
					<div key={key} data-entry-id={turn.user.entryId} className="space-y-4">
						{/* 用户提问行 */}
						<UserLine message={turn.user} />

						{/* 轮次内的内容流（任务执行进度树 + 助手正文） */}
						<TurnBlocksView
							blocks={flowBlocks}
							folded={effectiveFold}
							onOpenPanel={handleOpenExecutionPanel}
						/>

						{/* 轮次汇总条 */}
						{showFooter && (
							<TurnFooter
								turn={turn}
								changed={changed}
								foldOpen={!effectiveFold}
								onToggleFold={() => setTurnFold((f) => ({ ...f, [key]: !effectiveFold }))}
							/>
						)}
					</div>
				);
			})}

			{/* 如果对话刚开始且仅有 streaming 产生 */}
			{turns.length === 0 && streaming && (
				<TurnBlocksView
					blocks={buildTurnFlowBlocks([], toolResults, streaming)}
					folded={foldProcess}
					onOpenPanel={handleOpenExecutionPanel}
				/>
			)}
		</div>
	);
}
