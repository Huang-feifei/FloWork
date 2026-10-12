/** 运行外壳判断：桌面版由 preload 注入 floworkTransport，网页版没有 */
export const isDesktop = typeof window !== "undefined" && !!window.floworkTransport;

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
