/**
 * 应用内的文本输入对话框，替代 window.prompt（Electron 不支持 prompt）。
 * 用法：const name = await askText({ title: "分组名称" }); // 取消时为 null
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { Button, Modal } from "./ui";

interface AskOptions {
	title: string;
	defaultValue?: string;
	placeholder?: string;
	/** 允许提交空字符串（例如“留空清除”） */
	allowEmpty?: boolean;
}

interface PromptState {
	request: (AskOptions & { resolve: (value: string | null) => void }) | null;
}

const usePrompt = create<PromptState>(() => ({ request: null }));

export function askText(options: AskOptions): Promise<string | null> {
	return new Promise((resolve) => {
		// 已有对话框时先按取消处理，避免悬空的 Promise
		usePrompt.getState().request?.resolve(null);
		usePrompt.setState({ request: { ...options, resolve } });
	});
}

function close(value: string | null) {
	const req = usePrompt.getState().request;
	usePrompt.setState({ request: null });
	req?.resolve(value);
}

export function PromptDialog() {
	const request = usePrompt((s) => s.request);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (request) inputRef.current?.select();
	}, [request]);

	if (!request) return null;

	const submit = () => {
		const value = inputRef.current?.value ?? "";
		if (!request.allowEmpty && !value.trim()) return;
		close(value);
	};

	return (
		<Modal
			title={request.title}
			onClose={() => close(null)}
			width="w-[420px]"
			footer={
				<>
					<Button onClick={() => close(null)}>取消</Button>
					<Button
						variant="primary"
						onClick={submit}
					>
						确定
					</Button>
				</>
			}
		>
			<input
				ref={inputRef}
				// biome-ignore lint/a11y/noAutofocus: 对话框打开即输入
				autoFocus
				defaultValue={request.defaultValue ?? ""}
				placeholder={request.placeholder}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing) {
						e.preventDefault();
						submit();
					} else if (e.key === "Escape") {
						e.preventDefault();
						close(null);
					}
				}}
				className="w-full rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
			/>
		</Modal>
	);
}
