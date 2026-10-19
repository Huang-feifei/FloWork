/**
 * 终端风格的会话记录：
 *   ❯ 用户输入
 *   ● 回复文本（Markdown）
 *   ✻ 思考过程（可展开）
 *   ● tool(参数)  ⎿ 结果
 *
 * 历史轮次里连续的「思考 + 工具调用」会收成一行摘要（会话头部「展开过程」可关掉），
 * 正在运行的那一轮始终展开，这样长会话不会满屏都是过程。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ContentBlock, ImageAttachment } from "@shared/protocol";
import { parseSkillInvocation } from "@shared/skill-text";
import { buildTurns, turnChangedFiles, turnKey, type Turn } from "../../lib/session-turns";
import type { SessionFile } from "../../lib/session-files";
import { useApp } from "../../store";
import { ImageThumb } from "./ImageThumb";
import { Markdown } from "./Markdown";
import { ToolBlock } from "./ToolBlock";
import { TurnFooter } from "./TurnFooter";

type ToolResultMap = Map<string, { content: ContentBlock[]; details?: unknown; isError: boolean }>;
type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;
type ThinkingBlock = Extract<ContentBlock, { type: "thinking" }>;
type ToolCallBlock = Extract<ContentBlock, { type: "toolCall" }>;
type ProcessBlock = ThinkingBlock | ToolCallBlock;

/** 一轮回复拆成「正文」和「过程」两类片段，过程片段由连续的思考 / 工具调用组成 */
type Segment = { kind: "text"; text: string } | { kind: "process"; blocks: ProcessBlock[] };

function segmentsOf(content: ContentBlock[]): Segment[] {
	const out: Segment[] = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text.trim()) out.push({ kind: "text", text: block.text });
			continue;
		}
		if (block.type !== "thinking" && block.type !== "toolCall") continue;
		const prev = out[out.length - 1];
		if (prev?.kind === "process") prev.blocks.push(block);
		else out.push({ kind: "process", blocks: [block] });
	}
	return out;
}

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

function ThinkingLine({ text, live }: { text: string; live: boolean }) {
	const [open, setOpen] = useState(false);
	if (!text.trim()) return null;
	const lines = text.trim().split("\n");
	const tail = lines.slice(-3).join("\n");
	return (
		<Gutter mark="✻" className="text-muted">
			<button type="button" onClick={() => setOpen(!open)} className="text-[12.5px] text-muted hover:text-fg">
				{live ? "思考中…" : `思考过程（${text.length} 字）`} {open ? "▾" : "▸"}
			</button>
			{(open || live) && (
				<div className="mt-1.5 max-h-72 overflow-y-auto border-l-2 border-border pl-3 font-mono text-[12.5px] leading-[1.7] whitespace-pre-wrap text-muted">
					{open ? text : tail}
				</div>
			)}
		</Gutter>
	);
}

/**
 * 一组连续的思考 / 工具调用。
 * folded 时只留一行摘要（思考字数与工具名），点击再展开；不折叠时保持原来的逐条展示。
 */
const ProcessGroup = memo(function ProcessGroup({
	blocks,
	toolResults,
	folded,
}: {
	blocks: ProcessBlock[];
	toolResults: ToolResultMap;
	folded: boolean;
}) {
	const [open, setOpen] = useState(false);
	// 关掉折叠时清掉逐组的展开状态，避免下次再折叠时残留展开
	useEffect(() => {
		if (!folded) setOpen(false);
	}, [folded]);

	const thinking = blocks.filter((b): b is ThinkingBlock => b.type === "thinking");
	const calls = blocks.filter((b): b is ToolCallBlock => b.type === "toolCall");
	const thinkingChars = thinking.reduce((n, b) => n + b.thinking.trim().length, 0);
	const names = [...new Set(calls.map((c) => c.name))];
	const parts: string[] = [];
	if (thinkingChars > 0) parts.push(`思考 ${thinkingChars} 字`);
	if (calls.length > 0) parts.push(`${calls.length} 个工具调用（${names.join("、")}）`);

	const body = blocks.map((block, i) =>
		block.type === "thinking" ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: 内容块按位置稳定，没有独立 id
			<ThinkingLine key={i} text={block.thinking} live={false} />
		) : (
			<ToolBlock key={i} call={block} result={toolResults.get(block.id)} />
		),
	);

	if (parts.length === 0) return null;
	if (!folded) return <>{body}</>;

	return (
		<>
			<Gutter mark={calls.length > 0 ? "●" : "✻"} className="text-muted">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					title={open ? "折叠思考与工具调用" : "展开思考与工具调用"}
					className="inline-flex items-center gap-1.5 rounded-full bg-panel-2 px-3 py-1 text-[12.5px] text-muted hover:text-fg"
				>
					<span className="text-[10px]">{open ? "▾" : "▸"}</span>
					{parts.join(" · ")}
				</button>
			</Gutter>
			{open && <div className="mt-2 ml-3 space-y-3 border-l-2 border-border pl-3">{body}</div>}
		</>
	);
});

/**
 * 历史消息用 memo 包住：流式输出时 messages 数组不变，只有正在生成的那条（streaming）重渲染，
 * 不会把整段会话记录重新算一遍。
 */
const AssistantBlocks = memo(function AssistantBlocks({
	message,
	toolResults,
	live,
	foldProcess,
	foldOverride,
}: {
	message: AssistantMessage;
	toolResults: ToolResultMap;
	live: boolean;
	foldProcess: boolean;
	/** 本轮显式指定的折叠状态；undefined 表示跟随全局设置 */
	foldOverride?: boolean;
}) {
	const segments = useMemo(() => segmentsOf(message.content), [message.content]);
	// 流式光标跟在最后一段正文后面
	let lastText = -1;
	segments.forEach((seg, i) => {
		if (seg.kind === "text") lastText = i;
	});
	const folded = (foldOverride ?? foldProcess) && !live;

	return (
		<>
			{segments.map((seg, i) =>
				seg.kind === "text" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 内容块按位置稳定，没有独立 id
					<Gutter key={i} mark="●">
						<div className="text-[14.5px] leading-relaxed">
							<Markdown text={seg.text} />
						</div>
						{live && i === lastText && <span className="term-cursor" />}
					</Gutter>
				) : (
					<ProcessGroup key={i} blocks={seg.blocks} toolResults={toolResults} folded={folded} />
				),
			)}
			{message.stopReason === "error" && (
				<Gutter mark="✗" className="text-err">
					<span className="text-err">{message.errorMessage || "请求失败"}</span>
				</Gutter>
			)}
			{message.stopReason === "aborted" && (
				<Gutter mark="⎿" className="text-muted">
					<span className="text-muted">已中断</span>
				</Gutter>
			)}
		</>
	);
});

const MessageView = memo(function MessageView({
	message,
	toolResults,
	foldProcess,
	foldOverride,
}: {
	message: ChatMessage;
	toolResults: ToolResultMap;
	foldProcess: boolean;
	foldOverride?: boolean;
}) {
	switch (message.role) {
		case "user":
			return <UserLine message={message} />;
		case "assistant":
			return (
				<AssistantBlocks
					message={message}
					toolResults={toolResults}
					live={false}
					foldProcess={foldProcess}
					foldOverride={foldOverride}
				/>
			);
		case "toolResult":
			// 工具结果合并显示在对应的工具调用下方
			return null;
		case "note":
			return (
				<Gutter mark="※" className="text-muted">
					<div className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
						<span className="mr-2">[{message.kind}]</span>
						{message.text}
					</div>
				</Gutter>
			);
	}
});

/**
 * 长会话分段渲染：首次只挂最近 INITIAL_ROWS 条可见消息（工具结果不单独成行，不计数），
 * 往上滚到顶部再每次多挂 MORE_ROWS 条。按条数而不是按轮数切：一轮里 agent 可能连续回复几十上百次。
 */
const INITIAL_ROWS = 80;
const MORE_ROWS = 80;

const isRow = (m: ChatMessage | undefined) => !!m && m.role !== "toolResult";

/** 从末尾往前数 rows 条可见消息，返回开始渲染的下标；不足时从 0 开始 */
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

/** 顶部的「更早内容」入口：滚到可见时自动加载，也可以点击一次加载全部 */
function LoadEarlier({ hidden, onMore, onAll }: { hidden: number; onMore: () => void; onAll: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		// root 为视口：会话滚动容器的裁剪同样计入相交判断；内容插在上方时浏览器的滚动锚定保持当前画面不跳
		// 只在「离开过可视区再回来」时自动加载：刚挂载时会话还没贴底，哨兵可能短暂可见，不能因此连锁加载全部
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
	const cwd = useApp((s) => s.cwd);
	const sessionKey = useApp((s) => s.state?.sessionId ?? "");
	const [rows, setRows] = useState(INITIAL_ROWS);
	/** 每轮过程折叠状态的显式覆盖：key 为轮次 key，未设置时跟随全局 foldProcess */
	const [turnFold, setTurnFold] = useState<Record<string, boolean>>({});

	// 切换会话时回到只显示最近的一段，并清掉上一会话的折叠覆盖
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在会话变化时重置
	useEffect(() => {
		setRows(INITIAL_ROWS);
		setTurnFold({});
	}, [sessionKey]);

	const start = useMemo(() => windowStart(messages, rows), [messages, rows]);
	const hidden = useMemo(() => countRows(messages, start), [messages, start]);
	const showMore = useCallback(() => setRows((n) => n + MORE_ROWS), []);
	const showAll = useCallback(() => setRows(Number.POSITIVE_INFINITY), []);

	// 每轮汇总条挂在「本轮最后一条会单独成行的消息」之后
	const turns = useMemo(() => buildTurns(messages), [messages]);
	const turnByRow = useMemo(() => {
		const map = new Map<number, Turn>();
		for (const turn of turns) map.set(turn.lastRowIndex, turn);
		return map;
	}, [turns]);
	const lastTurn = turns[turns.length - 1];
	const live = isRunning || !!streaming;
	// 本轮修改过的文件：既用于文件 chip，也用于决定是否显示汇总条
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

	return (
		<div className="flex flex-col gap-4">
			{hidden > 0 && <LoadEarlier hidden={hidden} onMore={showMore} onAll={showAll} />}
			{messages.map((m, i) => {
				// 窗口之前的消息不挂载；工具结果不单独成行，不需要 data-entry-id
				if (i < start || m.role === "toolResult") return null;
				const turn = turnByRow.get(i);
				const key = turn ? turnKey(turn) : "";
				const effectiveFold = turn ? (turnFold[key] ?? foldProcess) : foldProcess;
				const changed = turn ? (turnChanges.get(key) ?? []) : [];
				// 正在运行的最后一轮不显示；其余只在「最后一轮」或「本轮改过文件」时显示，避免长会话里太密
				const showFooter = !!turn && !(turn === lastTurn && live) && (turn === lastTurn || changed.length > 0);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: 消息按时间追加，索引稳定
					// data-entry-id 让会话树窄轨知道哪条消息在屏幕上
					<div key={i} data-entry-id={m.entryId}>
						<MessageView
							message={m}
							toolResults={toolResults}
							foldProcess={foldProcess}
							foldOverride={turn ? turnFold[key] : undefined}
						/>
						{showFooter && turn && (
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
			{streaming && <AssistantBlocks message={streaming} toolResults={toolResults} live foldProcess={foldProcess} />}
		</div>
	);
}
