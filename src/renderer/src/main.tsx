import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { applyTheme, storedTheme, syncDesktopTheme } from "./theme";
import { applyAppearance, storedAppearance } from "./appearance";

// 首次渲染前同步应用主题：窗口延迟到 ready-to-show 才显示，这样首帧就是正确主题，不会闪烁
applyTheme(storedTheme());
// 同时告诉主进程：否则选深色启动时原生控件（菜单、滚动条、系统对话框）仍跟系统走
syncDesktopTheme(storedTheme());
// 外观偏好（字体 / 强调色 / 背景 / 辅助功能）同样在首帧前应用，避免闪一下默认值
applyAppearance(storedAppearance());

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
