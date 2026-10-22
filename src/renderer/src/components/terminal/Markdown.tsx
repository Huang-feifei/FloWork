import { isValidElement, memo, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

function MarkdownImage({
	src,
	alt,
	width,
	height,
	resolveImage,
	loadImage,
}: {
	src?: string;
	alt?: string;
	width?: number | string;
	height?: number | string;
	resolveImage?: (src: string) => string;
	loadImage?: (src: string) => Promise<string | null>;
}) {
	const syncSrc = src ? (resolveImage?.(src) ?? src) : undefined;
	const [resolved, setResolved] = useState(syncSrc);

	useEffect(() => {
		if (!src) {
			setResolved(undefined);
			return;
		}
		const fallback = resolveImage?.(src) ?? src;
		if (!loadImage) {
			setResolved(fallback);
			return;
		}
		let cancelled = false;
		setResolved(undefined);
		void loadImage(src).then(
			(next) => {
				if (!cancelled) setResolved(next ?? fallback);
			},
			() => {
				if (!cancelled) setResolved(fallback);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [src, resolveImage, loadImage]);

	if (!src) return null;
	if (!resolved) return <span className="text-muted">[图片加载中…]</span>;
	return <img src={resolved} alt={alt ?? ""} width={width} height={height} loading="lazy" />;
}

/** Markdown 渲染：对话里用终端风格，文件预览用 variant="document" 的文档排版。 */
export type MarkdownProps = {
	text: string;
	variant?: "terminal" | "document";
	/** 文档模式由 MarkdownDocument 懒加载注入；终端模式不解析原始 HTML */
	rehypePlugins?: ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
	/** 把本地相对图片改为预览服务地址；远程项目可换成 data URL 加载器 */
	resolveImage?: (src: string) => string;
	loadImage?: (src: string) => Promise<string | null>;
	/** 返回 true 表示已由应用内部打开，阻止默认跳转 */
	onOpenLink?: (href: string) => boolean;
};

export const Markdown = memo(function Markdown({
	text,
	variant = "terminal",
	rehypePlugins,
	resolveImage,
	loadImage,
	onOpenLink,
}: MarkdownProps) {
	const document = variant === "document";
	return (
		<div className={document ? "markdown-doc" : "term-md"}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={rehypePlugins}
				components={{
					a: ({ href, children }) => (
						<a
							href={href}
							target={href?.startsWith("#") ? undefined : "_blank"}
							rel="noreferrer"
							onClick={(event) => {
								if (href && onOpenLink?.(href)) event.preventDefault();
							}}
						>
							{children}
						</a>
					),
					img: ({ src, alt, width, height }) =>
						document ? (
							<MarkdownImage
								src={src}
								alt={alt}
								width={width}
								height={height}
								resolveImage={resolveImage}
								loadImage={loadImage}
							/>
						) : (
							<img src={src} alt={alt ?? ""} loading="lazy" />
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
