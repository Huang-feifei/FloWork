import { useEffect, useMemo, useState } from "react";
import { type ModelEntry, type ShellInfo, THINKING_LEVELS } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { Button, Field, Input, Select, TextArea } from "../ui";
import { parseObject, useConfigFile } from "./useConfigFile";

const BUILTIN_TOOLS = [
	{ id: "read", desc: "读取文件" },
	{ id: "bash", desc: "执行 Shell 命令（Windows 上使用 Git Bash）" },
	{ id: "edit", desc: "精确替换编辑文件" },
	{ id: "write", desc: "写入 / 新建文件" },
	{ id: "grep", desc: "搜索文件内容" },
	{ id: "find", desc: "按名称查找文件" },
	{ id: "ls", desc: "列出目录" },
	{ id: "powershell", desc: "执行 PowerShell 命令（仅 Windows）" },
];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

type Settings = Record<string, unknown>;

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function nested(settings: Settings, key: string): Record<string, unknown> {
	const v = settings[key];
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 设置值；空字符串 / undefined 表示删除该键，交给 pi 使用默认值 */
function assign(target: Settings, key: string, value: unknown): void {
	if (value === undefined || value === "") delete target[key];
	else target[key] = value;
}

function ShellStatus({ shell, onUse }: { shell: ShellInfo; onUse: (path: string) => void }) {
	const bad = shell.resolved === null || shell.isWsl;
	return (
		<div
			className={`rounded-lg border px-3 py-2 text-[12px] leading-5 ${bad ? "border-err/40 bg-err/5" : "border-border bg-panel"}`}
		>
			<div>
				bash 工具当前使用：
				<span className="font-mono">{shell.resolved ?? "（未找到）"}</span>
				{shell.isWsl && <span className="ml-1 text-err">— 这是 WSL 启动器，命令会在 WSL 中执行或直接失败</span>}
				{!bad && shell.resolved === shell.gitBash && !shell.shellPathSetting && <span className="ml-1 text-muted">（自动识别的 Git Bash）</span>}
				{shell.shellPathSetting && <span className="ml-1 text-muted">（来自 shellPath 设置）</span>}
			</div>
			{shell.error && <div className="text-err">{shell.error}</div>}
			{bad && shell.gitBash && (
				<div className="mt-1 flex items-center gap-2">
					<span className="text-muted">检测到 Git Bash：<span className="font-mono">{shell.gitBash}</span></span>
					<Button size="sm" onClick={() => onUse(shell.gitBash as string)}>
						填入 shellPath
					</Button>
				</div>
			)}
			{bad && !shell.gitBash && (
				<div className="mt-1 text-muted">
					未找到 Git Bash。请安装 Git for Windows，或在下方填写 bash.exe 路径；也可以在“工具”中改用 powershell。
				</div>
			)}
		</div>
	);
}

export function PreferencesTab() {
	const { file, error, save } = useConfigFile("settings");
	const pushNotice = useApp((s) => s.pushNotice);
	const configVersion = useApp((s) => s.configVersion);
	const [draft, setDraft] = useState<Settings | null>(null);
	const [models, setModels] = useState<ModelEntry[]>([]);
	const [saving, setSaving] = useState(false);
	const [shell, setShell] = useState<ShellInfo | null>(null);

	const base = useMemo(() => {
		try {
			return parseObject(file?.text);
		} catch {
			return null;
		}
	}, [file]);

	useEffect(() => {
		if (base) setDraft(structuredClone(base));
	}, [base]);

	useEffect(() => {
		void api
			.service({ type: "get_shell_info" })
			.then(setShell)
			.catch(() => undefined);
	}, [configVersion]);

	useEffect(() => {
		void api
			.service({ type: "list_models", availableOnly: true })
			.then(setModels)
			.catch(() => undefined);
	}, [configVersion]);

	if (error) return <div className="rounded border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</div>;
	if (file && !base)
		return <div className="rounded border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">settings.json 解析失败，请在“配置文件”页修复。</div>;
	if (!draft) return <div className="py-10 text-center text-muted">读取中…</div>;

	const set = (key: string, value: unknown) =>
		setDraft((prev) => {
			const next = { ...(prev ?? {}) };
			assign(next, key, value);
			return next;
		});
	const setNested = (key: string, sub: string, value: unknown) =>
		setDraft((prev) => {
			const next = { ...(prev ?? {}) };
			const obj = { ...nested(next, key) };
			assign(obj, sub, value);
			assign(next, key, Object.keys(obj).length > 0 ? obj : undefined);
			return next;
		});

	const defaultModelKey = draft.defaultProvider && draft.defaultModel ? `${str(draft.defaultProvider)}/${str(draft.defaultModel)}` : "";
	const tools = Array.isArray(draft.defaultTools) ? (draft.defaultTools as string[]) : undefined;
	const toolsAreModifiers = tools?.some((t) => t.startsWith("+") || t.startsWith("-")) ?? false;
	const effectiveTools = tools && !toolsAreModifiers ? tools : DEFAULT_TOOLS;
	const skills = Array.isArray(draft.skills) ? (draft.skills as string[]) : [];
	const dirty = JSON.stringify(draft) !== JSON.stringify(base);

	const onSave = async () => {
		setSaving(true);
		try {
			await save(`${JSON.stringify(draft, null, 2)}\n`);
			pushNotice("info", "设置已保存，已通知打开的会话重新加载");
		} catch (e) {
			pushNotice("error", errorText(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-6">
			<section className="space-y-3">
				<h3 className="text-sm font-semibold">模型</h3>
				<div className="grid grid-cols-2 gap-4">
					<Field label="新会话默认模型" hint="只列出凭据可用的模型；留空由 pi 自动选择">
						<Select
							value={defaultModelKey}
							onChange={(e) => {
								const m = models.find((x) => `${x.provider}/${x.id}` === e.target.value);
								setDraft((prev) => {
									const next = { ...(prev ?? {}) };
									assign(next, "defaultProvider", m?.provider);
									assign(next, "defaultModel", m?.id);
									return next;
								});
							}}
						>
							<option value="">（自动）</option>
							{defaultModelKey && !models.some((m) => `${m.provider}/${m.id}` === defaultModelKey) && (
								<option value={defaultModelKey}>{defaultModelKey}（当前不可用）</option>
							)}
							{models.map((m) => (
								<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
									{m.provider} / {m.name}
								</option>
							))}
						</Select>
					</Field>
					<Field label="默认思考等级" hint="超出模型支持范围时 pi 会自动收敛">
						<Select value={str(draft.defaultThinkingLevel)} onChange={(e) => set("defaultThinkingLevel", e.target.value)}>
							<option value="">（默认）</option>
							{THINKING_LEVELS.map((l) => (
								<option key={l} value={l}>
									{l}
								</option>
							))}
						</Select>
					</Field>
				</div>
			</section>

			<section className="space-y-3">
				<h3 className="text-sm font-semibold">工具</h3>
				{toolsAreModifiers ? (
					<div className="text-xs text-warn">
						defaultTools 使用了 +/- 增减语法（{tools?.join(", ")}），请在“配置文件”页编辑。
					</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
							{BUILTIN_TOOLS.map((t) => (
								<label key={t.id} className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={effectiveTools.includes(t.id)}
										onChange={(e) => {
											const next = e.target.checked
												? [...effectiveTools, t.id]
												: effectiveTools.filter((x) => x !== t.id);
											const same = next.length === DEFAULT_TOOLS.length && DEFAULT_TOOLS.every((x) => next.includes(x));
											set("defaultTools", same ? undefined : next);
										}}
									/>
									<span className="font-mono">{t.id}</span>
									<span className="text-xs text-muted">{t.desc}</span>
								</label>
							))}
						</div>
						<div className="text-[11px] text-muted">默认启用 read / bash / edit / write。修改对新会话生效。</div>
					</>
				)}
			</section>

			<section className="space-y-3">
				<h3 className="text-sm font-semibold">Shell 与网络</h3>
				{shell && <ShellStatus shell={shell} onUse={(path) => set("shellPath", path)} />}
				<div className="grid grid-cols-2 gap-4">
					<Field label="Bash 路径（shellPath）" hint="留空时自动使用识别到的 Git Bash；Windows 上请勿使用 WSL 的 bash.exe">
						<Input value={str(draft.shellPath)} onChange={(e) => set("shellPath", e.target.value)} placeholder="C:\Program Files\Git\bin\bash.exe" />
					</Field>
					<Field label="命令前缀（shellCommandPrefix）" hint="拼接在每条 bash 命令前，例如加载别名">
						<Input value={str(draft.shellCommandPrefix)} onChange={(e) => set("shellCommandPrefix", e.target.value)} />
					</Field>
					<Field label="HTTP 代理（httpProxy）" hint="作为 HTTP_PROXY / HTTPS_PROXY 用于 pi 发出的请求">
						<Input value={str(draft.httpProxy)} onChange={(e) => set("httpProxy", e.target.value)} placeholder="http://127.0.0.1:7890" />
					</Field>
					<Field label="项目信任（defaultProjectTrust）" hint="是否加载项目 .pi/ 目录中的扩展、技能等；桌面版暂无交互式信任提示">
						<Select value={str(draft.defaultProjectTrust)} onChange={(e) => set("defaultProjectTrust", e.target.value)}>
							<option value="">（默认：ask，非交互模式下等同于不加载）</option>
							<option value="always">always：总是加载</option>
							<option value="ask">ask</option>
							<option value="never">never：从不加载</option>
						</Select>
					</Field>
				</div>
			</section>

			<section className="space-y-3">
				<h3 className="text-sm font-semibold">会话行为</h3>
				<div className="grid grid-cols-2 gap-4">
					<Field label="运行中插话（steeringMode）">
						<Select value={str(draft.steeringMode)} onChange={(e) => set("steeringMode", e.target.value)}>
							<option value="">（默认：one-at-a-time）</option>
							<option value="one-at-a-time">one-at-a-time：逐条送达</option>
							<option value="all">all：一次全部送达</option>
						</Select>
					</Field>
					<Field label="排队消息（followUpMode）">
						<Select value={str(draft.followUpMode)} onChange={(e) => set("followUpMode", e.target.value)}>
							<option value="">（默认：one-at-a-time）</option>
							<option value="one-at-a-time">one-at-a-time</option>
							<option value="all">all</option>
						</Select>
					</Field>
				</div>
				<div className="flex flex-wrap gap-6 text-sm">
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={nested(draft, "compaction").enabled !== false}
							onChange={(e) => setNested("compaction", "enabled", e.target.checked ? undefined : false)}
						/>
						自动压缩上下文
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={nested(draft, "retry").enabled !== false}
							onChange={(e) => setNested("retry", "enabled", e.target.checked ? undefined : false)}
						/>
						请求失败自动重试
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={draft.enableSkillCommands !== false}
							onChange={(e) => set("enableSkillCommands", e.target.checked ? undefined : false)}
						/>
						技能注册为 /skill:名称 命令
					</label>
				</div>
			</section>

			<section className="space-y-3">
				<h3 className="text-sm font-semibold">资源路径</h3>
				<Field
					label="额外的 Skills 目录（每行一个）"
					hint="配置目录下的 skills/、~/.agents/skills/ 与项目内 .agents/skills/ 会自动发现，这里只需填写额外位置"
				>
					<TextArea
						rows={3}
						value={skills.join("\n")}
						onChange={(e) => {
							const list = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
							set("skills", list.length > 0 ? list : undefined);
						}}
					/>
				</Field>
			</section>

			<div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border bg-bg/95 py-3">
				{dirty && <span className="text-xs text-warn">有未保存的修改</span>}
				<Button disabled={!dirty} onClick={() => base && setDraft(structuredClone(base))}>
					撤销修改
				</Button>
				<Button variant="primary" disabled={!dirty || saving} onClick={() => void onSave()}>
					{saving ? "保存中…" : "保存到 settings.json"}
				</Button>
			</div>
		</div>
	);
}
