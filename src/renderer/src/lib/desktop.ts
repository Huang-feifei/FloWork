/** 桌面平台差异（macOS 使用系统窗口按钮与 Command 快捷键）。 */
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
