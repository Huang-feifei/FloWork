/**
 * 设置页：左侧导航 + 右侧内容。顶部一行显示配置目录与“打开配置文件”。
 * Apple 体系：28px 页面标题、白卡片内容区、左侧导航是内缩圆角行，选中态用蓝色软底。
 */
import { type SettingsTab, useApp } from "../../store";
import { Icon, type IconName } from "../Icon";
import { AppearanceTab } from "./AppearanceTab";
import { CustomProvidersTab } from "./CustomProvidersTab";
import { PreferencesTab } from "./PreferencesTab";
import { SubagentTab } from "./SubagentTab";
import { KernelTab } from "./KernelTab";
import { ProvidersTab } from "./ProvidersTab";
import { RawConfigTab } from "./RawConfigTab";
import { ResourcesTab } from "./ResourcesTab";

const TABS: Array<{ id: SettingsTab; label: string; icon: IconName; desc: string }> = [
	{ id: "providers", label: "模型供应商", icon: "cpu", desc: "pi 内置的供应商：填写 API Key 并测试连接。写入 auth.json。" },
	{ id: "custom", label: "自定义端点", icon: "git-fork", desc: "OpenAI / Anthropic 兼容接口、本地模型、中转服务，写入 models.json。" },
	{ id: "resources", label: "技能与扩展", icon: "files", desc: "当前项目可用的技能、扩展、提示模板与 pi 包；导入、启用 / 禁用、删除。" },
	{ id: "preferences", label: "偏好设置", icon: "settings", desc: "默认模型、工具、Shell、代理等 pi 设置，写入 settings.json。" },
	{ id: "subagent", label: "子代理", icon: "git-fork", desc: "子代理总开关、并行任务上限、并发数与默认模型；写入 settings.json。" },
	{ id: "appearance", label: "外观", icon: "palette", desc: "主题、强调色、字体与窗口背景；只保存在本机，不改变会话与模型行为。" },
	{ id: "raw", label: "配置文件", icon: "file-json", desc: "直接编辑 settings.json 与 models.json。" },
	{ id: "kernel", label: "内核更新", icon: "cpu", desc: "通过 GitHub Releases 独立更新 Pi 内核，无需重新安装 FloWork。" },
];

export function SettingsView() {
	const tab = useApp((s) => s.settingsTab);
	const info = useApp((s) => s.info);
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const { setView } = useApp.getState();
	const current = TABS.find((t) => t.id === tab) ?? TABS[0];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-chrome px-6">
				<span className="text-[13px] text-muted">设置</span>
				<span className="text-faint">/</span>
				<span className="text-[13px] font-medium text-fg">{current?.label}</span>
				<div className="flex-1" />
				<span className="truncate font-mono text-[11.5px] text-faint">{info?.agentDir}</span>
				<button
					type="button"
					onClick={() => setView("settings", "raw")}
					className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-panel-2 px-3.5 text-[12.5px] text-muted hover:text-fg"
				>
					<Icon name="file-json" className="size-3.5" />
					打开配置文件
				</button>
			</div>

			<div className="flex min-h-0 flex-1">
				<nav className="w-[240px] shrink-0 space-y-0.5 overflow-y-auto border-r border-border bg-sidebar p-3">
					{TABS.map((t) => (
						<button
							type="button"
							key={t.id}
							onClick={() => setView("settings", t.id)}
							className={`flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13.5px] ${
								t.id === tab ? "bg-primary-soft font-medium text-primary" : "text-muted hover:bg-panel-2 hover:text-fg"
							}`}
						>
							<Icon name={t.icon} className="size-4 shrink-0" />
							<span className="truncate">{t.label}</span>
						</button>
					))}
					<div className="mt-3 border-t border-border px-3 pt-3">
						<button
							type="button"
							onClick={() => setView(hasProject ? "chat" : "welcome")}
							className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg"
						>
							<Icon name="arrow-left" className="size-3.5" />
							返回工作台
						</button>
					</div>
				</nav>

				<div className="min-w-0 flex-1 overflow-y-auto bg-bg px-8 py-6">
					<div className="max-w-[980px]">
						<h1 className="text-[28px] font-semibold tracking-tight">{current?.label}</h1>
						<p className="mt-2 mb-6 text-[15px] leading-relaxed text-muted">{current?.desc}</p>
						{tab === "providers" && <ProvidersTab />}
						{tab === "custom" && <CustomProvidersTab />}
						{tab === "resources" && <ResourcesTab />}
						{tab === "preferences" && <PreferencesTab />}
						{tab === "subagent" && <SubagentTab />}
						{tab === "appearance" && <AppearanceTab />}
						{tab === "raw" && <RawConfigTab />}
						{tab === "kernel" && <KernelTab />}
					</div>
				</div>
			</div>
		</div>
	);
}
