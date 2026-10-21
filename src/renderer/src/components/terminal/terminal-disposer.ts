/**
 * 终端实例的释放入口。
 *
 * store 需要在停止项目时释放终端，但 store 本身不能静态依赖 xterm：否则即使终端面板
 * 从未打开，xterm 也会被打进首屏 chunk。这里只保存一个回调，由 TerminalPanel 在真正
 * 加载后注册。
 */
type TerminalDisposer = (cwd: string, hostId?: string) => void;

let disposer: TerminalDisposer | undefined;

export function setTerminalDisposer(next: TerminalDisposer): void {
	disposer = next;
}

export function disposeTerminal(cwd: string, hostId?: string): void {
	disposer?.(cwd, hostId);
}
