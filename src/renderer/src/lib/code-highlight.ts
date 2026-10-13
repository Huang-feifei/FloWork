/**
 * 语法高亮：编辑器（CodeMirror）与对话中的代码块共用同一套语言识别和配色。
 * 语言包按需动态加载，避免增大首屏体积。
 */
import { HighlightStyle, type LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** 深色主题配色，与界面的石墨底、琥珀橙强调一致 */
export const highlightStyle = HighlightStyle.define([
	{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "#ff9fd0" },
	{ tag: [t.string, t.special(t.string), t.regexp], color: "#9ce29f" },
	{ tag: [t.number, t.bool, t.null, t.atom], color: "#ffb37a" },
	{ tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#7b8494", fontStyle: "italic" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#7cc4ff" },
	{ tag: [t.typeName, t.className, t.namespace], color: "#e3c07a" },
	{ tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e6eaf2" },
	{ tag: [t.propertyName, t.attributeName], color: "#9fc7f0" },
	{ tag: [t.tagName, t.angleBracket], color: "#ff9d8a" },
	{ tag: [t.heading], color: "#f0883e", fontWeight: "700" },
	{ tag: [t.emphasis], fontStyle: "italic" },
	{ tag: [t.strong], fontWeight: "700" },
	{ tag: [t.link, t.url], color: "#6cb6ff", textDecoration: "underline" },
	{ tag: [t.meta, t.processingInstruction], color: "#9aa1ac" },
	{ tag: [t.inserted], color: "#8ee69a", backgroundColor: "rgb(46 160 67 / 0.17)" },
	{ tag: [t.deleted], color: "#ffa198", backgroundColor: "rgb(248 81 73 / 0.16)" },
	{ tag: [t.invalid], color: "#f85149" },
]);

type Loader = () => Promise<LanguageSupport | StreamLanguage<unknown>>;

const legacy = (load: () => Promise<StreamParser<unknown>>): Loader => async () => StreamLanguage.define(await load());

const LOADERS: Record<string, Loader> = {
	js: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
	ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
	json: async () => (await import("@codemirror/lang-json")).json(),
	css: async () => (await import("@codemirror/lang-css")).css(),
	html: async () => (await import("@codemirror/lang-html")).html(),
	markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
	python: async () => (await import("@codemirror/lang-python")).python(),
	java: async () => (await import("@codemirror/lang-java")).java(),
	rust: async () => (await import("@codemirror/lang-rust")).rust(),
	go: async () => (await import("@codemirror/lang-go")).go(),
	sql: async () => (await import("@codemirror/lang-sql")).sql(),
	yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
	xml: async () => (await import("@codemirror/lang-xml")).xml(),
	cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	shell: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
	powershell: legacy(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
	toml: legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml),
	dockerfile: legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
	properties: legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties),
	diff: legacy(async () => (await import("@codemirror/legacy-modes/mode/diff")).diff),
	lua: legacy(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua),
	ruby: legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby),
	swift: legacy(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift),
	kotlin: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin),
	csharp: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp),
	nginx: legacy(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx),
};

/** 代码块语言名（```ts）与文件扩展名都映射到 LOADERS 的键 */
const ALIASES: Record<string, string> = {
	javascript: "js", mjs: "js", cjs: "js", jsx: "js",
	typescript: "ts", mts: "ts", cts: "ts",
	md: "markdown", mdx: "markdown",
	htm: "html", vue: "html", svelte: "html",
	scss: "css", less: "css",
	py: "python", pyi: "python",
	rs: "rust",
	golang: "go",
	yml: "yaml",
	svg: "xml", xsd: "xml", csproj: "xml",
	c: "cpp", h: "cpp", cc: "cpp", hpp: "cpp", cxx: "cpp", "c++": "cpp",
	sh: "shell", bash: "shell", zsh: "shell", console: "shell",
	ps1: "powershell", psm1: "powershell", pwsh: "powershell",
	ini: "properties", env: "properties", cfg: "properties", conf: "properties",
	patch: "diff",
	rb: "ruby",
	kt: "kotlin", kts: "kotlin",
	cs: "csharp", "c#": "csharp",
	jsonc: "json", json5: "json",
};

const SPECIAL_FILES: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "shell",
	".bashrc": "shell",
	".zshrc": "shell",
	".gitignore": "properties",
	".npmrc": "properties",
	".editorconfig": "properties",
};

function keyFor(name: string): string | undefined {
	const k = name.toLowerCase();
	if (LOADERS[k]) return k;
	return ALIASES[k];
}

export function languageKeyForPath(path: string): string | undefined {
	const base = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
	if (SPECIAL_FILES[base]) return SPECIAL_FILES[base];
	if (base.startsWith(".env")) return "properties";
	const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
	return ext ? keyFor(ext) : undefined;
}

export function languageKeyForFence(name: string | undefined): string | undefined {
	return name ? keyFor(name.trim()) : undefined;
}

const cache = new Map<string, Promise<LanguageSupport | StreamLanguage<unknown>>>();

export function loadLanguage(key: string | undefined): Promise<LanguageSupport | StreamLanguage<unknown> | null> {
	if (!key || !LOADERS[key]) return Promise.resolve(null);
	let p = cache.get(key);
	if (!p) {
		p = (LOADERS[key] as Loader)();
		cache.set(key, p);
	}
	return p.catch(() => null);
}
