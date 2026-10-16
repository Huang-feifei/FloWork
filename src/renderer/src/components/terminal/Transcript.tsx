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
import { memo, useEffect, useMemo, useState } from "react";
import type { ChatMessage, ContentBlock, ImageAttachment } from "@shared/protocol";
import { parseSkillInvocation } from "@shared/skill-text";
import { useApp } from "../../store";
import { ImageThumb } from "./ImageThumb";
import { Markdown } from "./Markdown";
import { ToolBlock } from "./ToolBlock";

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
		<div className="grid grid-cols-[2ch_1fr] gap-x-1">
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
		<div className="-mx-3 rounded-md bg-term-prompt px-3 py-1.5">
			<Gutter mark="❯" className="font-bold text-accent">
				{skill ? <SkillInvocation skill={skill} /> : <div className="whitespace-pre-wrap">{text}</div>}
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
				className="mr-2 rounded bg-accent-soft px-1.5 font-bold text-accent hover:bg-accent/15"
			>
				/skill:{skill.skill} {open ? "▾" : "▸"}
			</button>
			<span className="whitespace-pre-wrap">{skill.args}</span>
			{open && (
				<div className="mt-1 max-h-72 overflow-y-auto border-l-2 border-accent/30 pl-3 whitespace-pre-wrap text-muted">{skill.body}</div>
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
			<button type="button" onClick={() => setOpen(!open)} className="text-muted italic hover:text-fg">
				{live ? "思考中…" : `思考过程（${text.length} 字）`} {open ? "▾" : "▸"}
			</button>
			{(open || live) && (
				<div className="max-h-72 overflow-y-auto border-l border-border-strong pl-3 whitespace-pre-wrap text-muted italic">
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
					className="text-muted hover:text-fg"
				>
					<span className="mr-1 text-[10px]">{open ? "▾" : "▸"}</span>
					{parts.join(" · ")}
				</button>
			</Gutter>
			{open && <div className="ml-3 border-l border-border pl-2">{body}</div>}
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
}: {
	message: AssistantMessage;
	toolResults: ToolResultMap;
	live: boolean;
	foldProcess: boolean;
}) {
	const segments = useMemo(() => segmentsOf(message.content), [message.content]);
	// 流式光标跟在最后一段正文后面
	let lastText = -1;
	segments.forEach((seg, i) => {
		if (seg.kind === "text") lastText = i;
	});
	const folded = foldProcess && !live;

	return (
		<>
			{segments.map((seg, i) =>
				seg.kind === "text" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: 内容块按位置稳定，没有独立 id
					<Gutter key={i} mark="●">
						<Markdown text={seg.text} />
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
}: {
	message: ChatMessage;
	toolResults: ToolResultMap;
	foldProcess: boolean;
}) {
	switch (message.role) {
		case "user":
			return <UserLine message={message} />;
		case "assistant":
			return <AssistantBlocks message={message} toolResults={toolResults} live={false} foldProcess={foldProcess} />;
		case "toolResult":
			// 工具结果合并显示在对应的工具调用下方
			return null;
		case "note":
			return (
				<Gutter mark="※" className="text-muted">
					<div className="whitespace-pre-wrap text-muted">
						<span className="mr-2">[{message.kind}]</span>
						{message.text}
					</div>
				</Gutter>
			);
	}
});

export function Transcript() {
	const messages = useApp((s) => s.messages);
	const streaming = useApp((s) => s.streaming);
	const foldProcess = useApp((s) => s.foldProcess);

	const toolResults = useMemo(() => {
		const map: ToolResultMap = new Map();
		for (const m of messages) {
			if (m.role === "toolResult") map.set(m.toolCallId, { content: m.content, details: m.details, isError: m.isError });
		}
		return map;
	}, [messages]);

	return (
		<div className="flex flex-col gap-3">
			{messages.map((m, i) =>
				// 工具结果不单独成行，不需要 data-entry-id
				m.role === "toolResult" ? null : (
					// biome-ignore lint/suspicious/noArrayIndexKey: 消息按时间追加，索引稳定
					// data-entry-id 让会话树窄轨知道哪条消息在屏幕上
					<div key={i} data-entry-id={m.entryId}>
						<MessageView message={m} toolResults={toolResults} foldProcess={foldProcess} />
					</div>
				),
			)}
			{streaming && <AssistantBlocks message={streaming} toolResults={toolResults} live foldProcess={foldProcess} />}
		</div>
	);
}
