/**
 * 设置页：左侧导航 + 右侧内容。顶部一行显示配置目录与“打开配置文件”。
 * 与原型（设置 · 模型供应商）一致：内容区是等宽小标题 + 表格式列表。
 */
import { type SettingsTab, useApp } from "../../store";
import { Icon, type IconName } from "../Icon";
import { AppearanceTab } from "./AppearanceTab";
import { CustomProvidersTab } from "./CustomProvidersTab";
import { PreferencesTab } from "./PreferencesTab";
import { ProvidersTab } from "./ProvidersTab";
import { RawConfigTab } from "./RawConfigTab";
import { ResourcesTab } from "./ResourcesTab";

const TABS: Array<{ id: SettingsTab; label: string; icon: IconName; desc: string }> = [
	{ id: "providers", label: "模型供应商", icon: "cpu", desc: "pi 内置的供应商：填写 API Key 并测试连接。写入 auth.json。" },
	{ id: "custom", label: "自定义端点", icon: "git-fork", desc: "OpenAI / Anthropic 兼容接口、本地模型、中转服务，写入 models.json。" },
	{ id: "resources", label: "技能与扩展", icon: "files", desc: "当前项目可用的技能、扩展、提示模板与 pi 包；导入、启用 / 禁用、删除。" },
	{ id: "preferences", label: "偏好设置", icon: "settings", desc: "默认模型、工具、Shell、代理等 pi 设置，写入 settings.json。" },
	{ id: "appearance", label: "外观", icon: "palette", desc: "界面主题：深色 / 浅色 / 跟随系统。只影响外观，保存在本机。" },
	{ id: "raw", label: "配置文件", icon: "file-json", desc: "直接编辑 settings.json 与 models.json。" },
];

export function SettingsView() {
	const tab = useApp((s) => s.settingsTab);
	const info = useApp((s) => s.info);
	const hasProject = useApp((s) => s.activeProjectId !== null);
	const { setView } = useApp.getState();
	const current = TABS.find((t) => t.id === tab) ?? TABS[0];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-chrome px-5">
				<span className="font-mono text-[11.5px] font-semibold tracking-[0.06em] text-faint">设置</span>
				<span className="text-faint">|</span>
				<span className="text-[13px] text-fg">{current?.label}</span>
				<div className="flex-1" />
				<span className="truncate font-mono text-[11.5px] text-faint">{info?.agentDir}</span>
				<button
					type="button"
					onClick={() => setView("settings", "raw")}
					className="flex h-7 shrink-0 items-center gap-1.5 rounded border border-border px-2.5 font-mono text-[11.5px] text-muted hover:bg-panel-2 hover:text-fg"
				>
					<Icon
						name="file-json"
						className="size-3.5"
					/>
					打开配置文件
				</button>
			</div>

			<div className="flex min-h-0 flex-1">
				<nav className="w-[220px] shrink-0 overflow-y-auto border-r border-border bg-sidebar py-2">
					{TABS.map((t) => (
						<button
							type="button"
							key={t.id}
							onClick={() => setView("settings", t.id)}
							className={`relative flex h-8 w-full items-center gap-2 px-4 text-left text-[13px] ${
								t.id === tab ? "bg-accent-soft text-fg" : "text-muted hover:bg-panel-2 hover:text-fg"
							}`}
						>
							{t.id === tab && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
							<Icon
								name={t.icon}
								className="size-3.5 shrink-0"
							/>
							<span className="truncate">{t.label}</span>
						</button>
					))}
					<div className="mt-2 border-t border-border px-4 pt-3">
						<button
							type="button"
							onClick={() => setView(hasProject ? "chat" : "welcome")}
							className="flex items-center gap-1.5 text-[12px] text-muted hover:text-fg"
						>
							<Icon
								name="arrow-left"
								className="size-3.5"
							/>
							返回工作台
						</button>
					</div>
				</nav>

				<div className="min-w-0 flex-1 overflow-y-auto bg-bg px-8 pt-6 pb-10">
					<div className="max-w-[960px]">
						<h1 className="text-[17px] font-semibold">{current?.label}</h1>
						<p className="mt-1 text-[13px] leading-relaxed text-muted">{current?.desc}</p>
						<div className="mt-5">
							{tab === "providers" && <ProvidersTab />}
							{tab === "custom" && <CustomProvidersTab />}
							{tab === "resources" && <ResourcesTab />}
							{tab === "preferences" && <PreferencesTab />}
							{tab === "appearance" && <AppearanceTab />}
							{tab === "raw" && <RawConfigTab />}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
