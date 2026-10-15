/**
 * 终端风格的会话记录：
 *   ❯ 用户输入
 *   ● 回复文本（Markdown）
 *   ✻ 思考过程（可展开）
 *   ● tool(参数)  ⎿ 结果
 */
import { memo, useMemo, useState } from "react";
import type { ChatMessage, ContentBlock, ImageAttachment } from "@shared/protocol";
import { parseSkillInvocation } from "@shared/skill-text";
import { useApp } from "../../store";
import { ImageThumb } from "./ImageThumb";
import { Markdown } from "./Markdown";
import { ToolBlock } from "./ToolBlock";

type ToolResultMap = Map<string, { content: ContentBlock[]; details?: unknown; isError: boolean }>;
type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

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
 * 历史消息用 memo 包住：流式输出时 messages 数组不变，只有正在生成的那条（streaming）重渲染，
 * 不会把整段会话记录重新算一遍。
 */
const AssistantBlocks = memo(function AssistantBlocks({
	message,
	toolResults,
	live,
}: {
	message: AssistantMessage;
	toolResults: ToolResultMap;
	live: boolean;
}) {
	const last = message.content.length - 1;

	return (
		<>
			{message.content.map((block, i) => {
				const key = `${i}-${block.type}`;
				switch (block.type) {
					case "text":
						if (!block.text.trim()) return null;
						return (
							<Gutter key={key} mark="●">
								<Markdown text={block.text} />
								{live && i === last && <span className="term-cursor" />}
							</Gutter>
						);
					case "thinking":
						return <ThinkingLine key={key} text={block.thinking} live={live && i === last} />;
					case "toolCall":
						return (
							<ToolBlock
								key={key}
								call={block}
								result={toolResults.get(block.id)}
							/>
						);
					default:
						return null;
				}
			})}
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

const MessageView = memo(function MessageView({ message, toolResults }: { message: ChatMessage; toolResults: ToolResultMap }) {
	switch (message.role) {
		case "user":
			return <UserLine message={message} />;
		case "assistant":
			return <AssistantBlocks message={message} toolResults={toolResults} live={false} />;
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
						<MessageView message={m} toolResults={toolResults} />
					</div>
				),
			)}
			{streaming && <AssistantBlocks message={streaming} toolResults={toolResults} live />}
		</div>
	);
}
