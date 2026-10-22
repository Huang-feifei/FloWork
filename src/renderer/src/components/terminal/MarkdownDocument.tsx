/** 文档模式的 Markdown：原始 HTML 解析与 sanitize 体积较大，单独懒加载。 */
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from "rehype-sanitize";
import { Markdown, type MarkdownProps } from "./Markdown";

/**
 * 文档预览允许 README 里常见的排版属性，但脚本、事件属性和危险 URL 仍由
 * rehype-sanitize 的默认规则过滤。不要在这里放开 style / on*。
 */
const DOCUMENT_SANITIZE_SCHEMA: SanitizeOptions = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		div: [...(defaultSchema.attributes?.div ?? []), "align"],
		p: [...(defaultSchema.attributes?.p ?? []), "align"],
		img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "align"],
	},
};

const DOCUMENT_REHYPE_PLUGINS: NonNullable<MarkdownProps["rehypePlugins"]> = [
	rehypeRaw,
	[rehypeSanitize, DOCUMENT_SANITIZE_SCHEMA],
];

export function MarkdownDocument(props: Omit<MarkdownProps, "variant" | "rehypePlugins">) {
	return <Markdown {...props} variant="document" rehypePlugins={DOCUMENT_REHYPE_PLUGINS} />;
}

export default MarkdownDocument;
