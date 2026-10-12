import { type SettingsTab, useApp } from "../../store";
import { CustomProvidersTab } from "./CustomProvidersTab";
import { PreferencesTab } from "./PreferencesTab";
import { ProvidersTab } from "./ProvidersTab";
import { RawConfigTab } from "./RawConfigTab";
import { ResourcesTab } from "./ResourcesTab";

const TABS: Array<{ id: SettingsTab; label: string; desc: string }> = [
	{ id: "providers", label: "模型供应商", desc: "pi 内置的供应商：填写 API Key 或订阅登录，并测试连接" },
	{ id: "custom", label: "自定义端点", desc: "OpenAI / Anthropic 兼容接口、本地模型、中转服务，写入 models.json" },
	{ id: "resources", label: "技能与扩展", desc: "当前项目可用的技能、扩展、提示模板与 pi 包；导入、启用 / 禁用、删除" },
	{ id: "preferences", label: "偏好设置", desc: "默认模型、工具、Shell、代理等 pi 设置，写入 settings.json" },
	{ id: "raw", label: "配置文件", desc: "直接编辑 settings.json 与 models.json" },
];

export function SettingsView() {
	const tab = useApp((s) => s.settingsTab);
	const info = useApp((s) => s.info);
	const { setView } = useApp.getState();
	const current = TABS.find((t) => t.id === tab) ?? TABS[0];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-4xl px-8 pt-8 pb-10">
					<div className="mb-6 flex items-end gap-4">
						<div className="flex-1">
							<h1 className="text-2xl font-semibold tracking-tight">设置</h1>
							<div className="mt-1 text-[13px] text-muted">
								配置目录 <span className="font-mono text-[12px]">{info?.agentDir}</span>
							</div>
						</div>
						<button type="button" onClick={() => setView("chat")} className="text-[13px] text-muted hover:text-fg">
							返回对话 →
						</button>
					</div>

					<div className="mb-2 flex gap-1 border-b border-border">
						{TABS.map((t) => (
							<button
								type="button"
								key={t.id}
								onClick={() => setView("settings", t.id)}
								className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
									t.id === tab ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
								}`}
							>
								{t.label}
							</button>
						))}
					</div>
					<div className="mb-5 text-[12px] text-muted">{current?.desc}</div>

					{tab === "providers" && <ProvidersTab />}
					{tab === "custom" && <CustomProvidersTab />}
					{tab === "resources" && <ResourcesTab />}
					{tab === "preferences" && <PreferencesTab />}
					{tab === "raw" && <RawConfigTab />}
				</div>
			</div>
		</div>
	);
}
