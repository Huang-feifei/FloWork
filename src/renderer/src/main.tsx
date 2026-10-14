import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { applyTheme, storedTheme } from "./theme";

// 首次渲染前同步应用主题：窗口延迟到 ready-to-show 才显示，这样首帧就是正确主题，不会闪烁
applyTheme(storedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
