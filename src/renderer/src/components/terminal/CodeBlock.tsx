/** 对话中的代码块：按 ```lang 加载语言包做静态语法高亮，附带语言标签与复制按钮 */
import { Language, type LanguageSupport, type StreamLanguage } from "@codemirror/language";
import { highlightCode } from "@lezer/highlight";
import { type ReactNode, useEffect, useState } from "react";
import { StyleModule } from "style-mod";
import { highlightStyle, languageKeyForFence, loadLanguage } from "../../lib/code-highlight";

let stylesMounted = false;
function mountStyles() {
	if (stylesMounted || !highlightStyle.module) return;
	StyleModule.mount(document, highlightStyle.module);
	stylesMounted = true;
}

function parserOf(lang: LanguageSupport | StreamLanguage<unknown>) {
	return lang instanceof Language ? lang.parser : lang.language.parser;
}

function highlight(code: string, lang: LanguageSupport | StreamLanguage<unknown>): ReactNode[] {
	const out: ReactNode[] = [];
	let key = 0;
	highlightCode(
		code,
		parserOf(lang).parse(code),
		highlightStyle,
		(text, classes) => {
			out.push(classes ? <span key={key++} className={classes}>{text}</span> : text);
		},
		() => out.push("\n"),
	);
	return out;
}

/** 超过这个长度的代码块不做高亮，避免流式输出时卡顿 */
const MAX_HIGHLIGHT_CHARS = 60_000;

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
	const [nodes, setNodes] = useState<ReactNode[] | null>(null);
	const [copied, setCopied] = useState(false);
	const key = languageKeyForFence(lang);

	useEffect(() => {
		if (!key || code.length > MAX_HIGHLIGHT_CHARS) {
			setNodes(null);
			return;
		}
		let cancelled = false;
		void loadLanguage(key).then((language) => {
			if (cancelled || !language) return;
			mountStyles();
			try {
				setNodes(highlight(code, language));
			} catch {
				setNodes(null);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [code, key]);

	return (
		<div className="group relative">
			<pre>
				<code>{nodes ?? code}</code>
			</pre>
			<div className="absolute top-2 right-2.5 flex items-center gap-2 text-[11.5px] text-faint">
				{lang && <span className="font-mono group-hover:hidden">{lang}</span>}
				<button
					type="button"
					onClick={() =>
						void navigator.clipboard.writeText(code).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						})
					}
					className="hidden rounded-full bg-surface-raised px-2.5 py-0.5 text-muted shadow-sm hover:text-fg group-hover:block"
				>
					{copied ? "已复制" : "复制"}
				</button>
			</div>
		</div>
	);
}
