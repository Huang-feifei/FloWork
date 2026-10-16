/**
 * 应用内的确认对话框，替代 window.confirm。
 * Electron 的原生确认框由系统渲染，标题是页面 title、配色也跟随系统，与应用主题不一致，所以统一改用它。
 * 用法：if (!(await askConfirm({ title: "删除会话", message: "…" }))) return;
 */
import { useEffect } from "react";
import { create } from "zustand";
import { Button, Modal } from "./ui";

interface ConfirmOptions {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** 危险操作（删除、丢弃修改）：确认按钮用错误色 */
	danger?: boolean;
}

interface ConfirmState {
	request: (ConfirmOptions & { resolve: (value: boolean) => void }) | null;
}

const useConfirm = create<ConfirmState>(() => ({ request: null }));

export function askConfirm(options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		// 已有对话框时先按取消处理，避免悬空的 Promise
		useConfirm.getState().request?.resolve(false);
		useConfirm.setState({ request: { ...options, resolve } });
	});
}

function close(value: boolean) {
	const req = useConfirm.getState().request;
	useConfirm.setState({ request: null });
	req?.resolve(value);
}

export function ConfirmDialog() {
	const request = useConfirm((s) => s.request);

	// Esc 取消（按钮获得焦点时 Enter 由按钮自身的默认行为触发）
	useEffect(() => {
		if (!request) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				event.preventDefault();
				close(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [request]);

	if (!request) return null;

	return (
		<Modal
			title={request.title}
			onClose={() => close(false)}
			width="w-[440px]"
			footer={
				<>
					<Button onClick={() => close(false)}>{request.cancelLabel ?? "取消"}</Button>
					<Button
						// biome-ignore lint/a11y/noAutofocus: 对话框打开即聚焦确认按钮
						autoFocus
						variant={request.danger ? "danger" : "primary"}
						onClick={() => close(true)}
					>
						{request.confirmLabel ?? "确定"}
					</Button>
				</>
			}
		>
			<p className="text-[14px] leading-relaxed whitespace-pre-wrap text-fg">{request.message}</p>
		</Modal>
	);
}
