import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

/** 终端风格的 Markdown：标题前缀 #、列表用 –、代码块带语法高亮（样式见 styles.css .term-md） */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="term-md">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => (
						<a href={href} target="_blank" rel="noreferrer">
							{children}
						</a>
					),
					code: ({ children }) => (
						<code className="rounded-md bg-inline-code-bg px-[0.35em] py-[0.05em] font-mono text-[12.5px] text-inline-code-fg">
							{children}
						</code>
					),
					pre: ({ children }) => {
						const code = Array.isArray(children) ? children[0] : children;
						const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? "") : "";
						const lang = /language-([\w#+.-]+)/.exec(className)?.[1];
						return <CodeBlock code={textOf(children).replace(/\n$/, "")} lang={lang} />;
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
