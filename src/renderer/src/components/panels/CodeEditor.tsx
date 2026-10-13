/**
 * CodeMirror 6 封装：只读查看与编辑共用。由 FileViewer 通过 React.lazy 按需加载。
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { highlightStyle, languageKeyForPath, loadLanguage } from "../../lib/code-highlight";

const theme = EditorView.theme({
	"&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--color-term)" },
	".cm-gutters": {
		backgroundColor: "var(--color-term-bar)",
		color: "#66707c",
		borderRight: "1px solid var(--color-border)",
	},
	".cm-activeLineGutter": { backgroundColor: "var(--color-panel-2)", color: "var(--color-fg)" },
	".cm-activeLine": { backgroundColor: "rgb(255 255 255 / 0.04)" },
	"&.cm-focused": { outline: "none" },
	".cm-cursor": { borderLeftColor: "var(--color-accent)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgb(240 136 62 / 0.28) !important" },
	".cm-searchMatch": { backgroundColor: "rgb(227 179 65 / 0.3)" },
	".cm-searchMatch-selected": { backgroundColor: "rgb(227 179 65 / 0.5)" },
	".cm-panels": { backgroundColor: "var(--color-term-bar)", borderColor: "var(--color-border)" },
	".cm-panel input, .cm-panel button": { fontFamily: "var(--font-sans)", fontSize: "12px" },
	".cm-foldGutter span": { color: "#66707c" },
});

interface Props {
	path: string;
	value: string;
	editable: boolean;
	onChange?: (value: string) => void;
	onSave?: () => void;
	/** 内容变化来自外部（重新加载）时递增，用于替换编辑器文档 */
	revision: number;
}

export default function CodeEditor({ path, value, editable, onChange, onSave, revision }: Props) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const editableComp = useRef(new Compartment());
	const languageComp = useRef(new Compartment());
	const handlers = useRef({ onChange, onSave });
	handlers.current = { onChange, onSave };

	// 创建编辑器
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时创建，后续通过 compartment 与 revision 更新
	useEffect(() => {
		if (!host.current) return;
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					lineNumbers(),
					foldGutter(),
					highlightActiveLineGutter(),
					drawSelection(),
					history(),
					indentOnInput(),
					bracketMatching(),
					highlightSelectionMatches(),
					search({ top: true }),
					syntaxHighlighting(highlightStyle),
					keymap.of([
						{
							key: "Mod-s",
							preventDefault: true,
							run: () => {
								handlers.current.onSave?.();
								return true;
							},
						},
						...searchKeymap,
						...historyKeymap,
						...defaultKeymap,
						indentWithTab,
					]),
					theme,
					languageComp.current.of([]),
					editableComp.current.of(editableExtensions(editable)),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
					}),
				],
			}),
		});
		view.current = v;
		return () => {
			v.destroy();
			view.current = null;
		};
	}, []);

	// 外部重新加载内容
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 revision 变化时替换文档
	useEffect(() => {
		const v = view.current;
		if (!v || v.state.doc.toString() === value) return;
		v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
	}, [revision]);

	useEffect(() => {
		view.current?.dispatch({ effects: editableComp.current.reconfigure(editableExtensions(editable)) });
		if (editable) view.current?.focus();
	}, [editable]);

	useEffect(() => {
		let cancelled = false;
		void loadLanguage(languageKeyForPath(path)).then((lang) => {
			if (!cancelled && lang) view.current?.dispatch({ effects: languageComp.current.reconfigure(lang) });
		});
		return () => {
			cancelled = true;
		};
	}, [path]);

	return <div ref={host} className="h-full min-h-0" />;
}

function editableExtensions(editable: boolean) {
	return [EditorView.editable.of(editable), EditorState.readOnly.of(!editable), editable ? highlightActiveLine() : []];
}
