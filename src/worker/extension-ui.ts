/**
 * 第三方扩展的 ctx.ui：把对话框和界面更新转成 SessionEvent 发给界面，等待 respond_ext_ui 应答。
 * 行为参照 pi 的 RPC 模式（modes/rpc/rpc-mode.ts）：
 * - select / confirm / input / editor 需要应答；超时、中止或会话切换时返回默认值（undefined / false）
 * - notify / setStatus / setWidget（仅字符串数组）/ setEditorText 单向推送
 * - 依赖终端界面的能力（自定义组件、页眉页脚、主题、原始按键）空实现
 */
import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import type { ExtUIRequest, SessionEvent } from "@shared/protocol";

export interface ExtUIResponse {
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

interface Pending {
	settle: (response: ExtUIResponse) => void;
}

type DialogFields = Omit<ExtUIRequest, "id" | "startedAt">;

/**
 * 扩展可能调用 theme.fg("accent", text) 之类的着色方法；界面不渲染 ANSI 颜色，
 * 这里让任何方法都原样返回最后一个字符串参数，属性访问返回空串。
 */
const plainTheme: unknown = new Proxy(
	{},
	{
		get: (_target, prop) => {
			if (prop === Symbol.toPrimitive || prop === "then") return undefined;
			return (...args: unknown[]) => {
				for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === "string") return args[i];
				return "";
			};
		},
	},
);

export class ExtensionUI {
	private readonly pending = new Map<string, Pending>();

	constructor(private readonly emit: (event: SessionEvent) => void) {}

	/** 界面应答对话框；id 不存在（已超时 / 已取消）时忽略 */
	respond(id: string, response: ExtUIResponse): void {
		this.pending.get(id)?.settle(response);
	}

	/** 会话切换 / 关闭时取消所有未完成的对话框 */
	cancelAll(): void {
		for (const p of [...this.pending.values()]) p.settle({ cancelled: true });
	}

	private dialog<T>(
		fields: DialogFields,
		timeoutMs: number | undefined,
		signal: AbortSignal | undefined,
		parse: (response: ExtUIResponse) => T,
	): Promise<T> {
		if (signal?.aborted) return Promise.resolve(parse({ cancelled: true }));
		const id = randomUUID();
		return new Promise<T>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => settle({ cancelled: true });
			const settle = (response: ExtUIResponse) => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.emit({ type: "ext_ui_closed", id });
				resolve(parse(response));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutMs && timeoutMs > 0) timer = setTimeout(() => settle({ cancelled: true }), timeoutMs);
			this.pending.set(id, { settle });
			this.emit({ type: "ext_ui_request", request: { ...fields, id, timeoutMs, startedAt: Date.now() } });
		});
	}

	createContext(): ExtensionUIContext {
		const value = (r: ExtUIResponse) => (r.cancelled ? undefined : r.value);
		const ctx = {
			select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) =>
				this.dialog({ method: "select", title, options }, opts?.timeout, opts?.signal, value),
			confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
				this.dialog({ method: "confirm", title, message }, opts?.timeout, opts?.signal, (r) => !r.cancelled && !!r.confirmed),
			input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
				this.dialog({ method: "input", title, placeholder }, opts?.timeout, opts?.signal, value),
			editor: (title: string, prefill?: string) => this.dialog({ method: "editor", title, prefill }, undefined, undefined, value),
			notify: (message: string, type?: "info" | "warning" | "error") =>
				this.emit({ type: "notice", level: type ?? "info", text: message }),
			setStatus: (key: string, text: string | undefined) => this.emit({ type: "ext_status", key, text: text || undefined }),
			setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) => {
				// 组件工厂函数依赖 TUI，无法在图形界面中渲染，忽略
				if (content !== undefined && !Array.isArray(content)) return;
				this.emit({
					type: "ext_widget",
					key,
					lines: content as string[] | undefined,
					placement: options?.placement ?? "aboveEditor",
				});
			},
			setEditorText: (text: string) => this.emit({ type: "ext_editor_text", text }),
			pasteToEditor: (text: string) => this.emit({ type: "ext_editor_text", text }),
			getEditorText: () => "",
			setTitle: () => {},
			onTerminalInput: () => () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setFooter: () => {},
			setHeader: () => {},
			custom: async () => undefined as never,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return plainTheme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "FloWork 不支持切换终端主题" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
		return ctx as unknown as ExtensionUIContext;
	}
}
