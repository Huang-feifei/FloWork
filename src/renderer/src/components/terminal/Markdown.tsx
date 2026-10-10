import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 终端风格的 Markdown：标题前缀 #、列表用 –、代码块浅底（样式见 styles.css .term-md） */
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
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
