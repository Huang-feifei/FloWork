/**
 * 技能、扩展、提示模板与 pi 包的管理（针对当前打开的项目）。
 * 列表来自 pi 的资源解析，包含被禁用的条目；启用 / 禁用写入全局 settings.json。
 */
import { useCallback, useEffect, useState } from "react";
import type { ResourceInfo, ResourceKind, ResourcesResult } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { projectName, useApp } from "../../store";
import { Badge, Button, Input, Select } from "../ui";

const KIND_LABEL: Record<ResourceKind, string> = { skill: "技能", extension: "扩展", prompt: "提示模板" };
const KIND_HINT: Record<ResourceKind, string> = {
	skill: "包含 SKILL.md 的文件夹。AI 会按描述自动选用，也可以在输入框用 /skill:名称 调用。",
	extension: "TypeScript / JavaScript 扩展，可注册工具、命令和事件钩子。扩展代码在本机执行，只导入可信来源。",
	prompt: "Markdown 提示模板，在输入框用 /名称 调用。",
};
const IMPORT_HINT: Record<ResourceKind, string> = {
	skill: "技能文件夹路径（含 SKILL.md）",
	extension: ".ts / .js 文件或扩展文件夹路径",
	prompt: ".md 文件路径",
};

function scopeBadge(r: ResourceInfo) {
	if (r.origin === "package") return <Badge tone="accent">pi 包</Badge>;
	if (r.scope === "project") return <Badge tone="warn">项目</Badge>;
	if (r.scope === "user") return <Badge>全局</Badge>;
	return <Badge>{r.scope}</Badge>;
}

function ResourceRow({ r, cwd, onChanged }: { r: ResourceInfo; cwd: string; onChanged: () => void }) {
	const pushNotice = useApp((s) => s.pushNotice);
	const [busy, setBusy] = useState(false);
	const run = async (fn: () => Promise<unknown>, done: string) => {
		setBusy(true);
		try {
			await fn();
			pushNotice("info", done);
			onChanged();
		} catch (e) {
			pushNotice("error", errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className={`flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-b-0 ${r.enabled ? "" : "opacity-60"}`}>
			<label className="mt-0.5 flex shrink-0 cursor-pointer items-center" title={r.enabled ? "已启用，点击禁用" : "已禁用，点击启用"}>
				<input
					type="checkbox"
					checked={r.enabled}
					disabled={busy}
					onChange={(e) =>
						void run(
							() => api.service({ type: "set_resource_enabled", cwd, kind: r.kind, path: r.path, enabled: e.target.checked }),
							`${e.target.checked ? "已启用" : "已禁用"} ${r.name}`,
						)
					}
				/>
			</label>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="font-medium">{r.name}</span>
					{scopeBadge(r)}
					{!r.enabled && <Badge>已禁用</Badge>}
				</div>
				{r.description && <div className="mt-0.5 text-[12px] leading-5 text-muted">{r.description}</div>}
				<div className="mt-0.5 truncate font-mono text-[11px] text-muted/80" title={r.path}>
					{r.path}
				</div>
			</div>
			<div className="flex shrink-0 gap-1">
				<Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(r.path).then(() => pushNotice("info", "已复制路径"))}>
					复制路径
				</Button>
				{r.removable && (
					<Button
						size="sm"
						variant="danger"
						disabled={busy}
						onClick={() => {
							if (!window.confirm(`删除${KIND_LABEL[r.kind]}「${r.name}」？\n会删除磁盘上的文件：${r.path}`)) return;
							void run(() => api.service({ type: "remove_resource", cwd, kind: r.kind, path: r.path }), `已删除 ${r.name}`);
						}}
					>
						删除
					</Button>
				)}
			</div>
		</div>
	);
}

function ImportForm({ kind, cwd, projectTrusted, onDone }: { kind: ResourceKind; cwd: string; projectTrusted: boolean; onDone: () => void }) {
	const nativeDialogs = useApp((s) => s.info?.nativeDialogs);
	const pushNotice = useApp((s) => s.pushNotice);
	const [path, setPath] = useState("");
	const [scope, setScope] = useState<"user" | "project">("user");
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		setBusy(true);
		try {
			const r = await api.service({ type: "import_resource", cwd, kind, sourcePath: path.trim(), scope });
			pushNotice("info", `已导入 ${r.name}，各会话会自动重新加载`);
			setPath("");
			onDone();
		} catch (e) {
			pushNotice("error", errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex items-center gap-2 border-t border-border bg-panel-2/40 px-3 py-2">
			<Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={IMPORT_HINT[kind]} className="flex-1" />
			{nativeDialogs && kind !== "prompt" && (
				<Button size="sm" onClick={() => void api.pickFolder().then((p) => p && setPath(p))}>
					选择文件夹
				</Button>
			)}
			<Select value={scope} onChange={(e) => setScope(e.target.value as "user" | "project")} className="w-36">
				<option value="user">全局（所有项目）</option>
				<option value="project" disabled={!projectTrusted}>
					仅当前项目{projectTrusted ? "" : "（需先信任）"}
				</option>
			</Select>
			<Button size="sm" variant="primary" disabled={busy || !path.trim()} onClick={() => void submit()}>
				{busy ? "导入中…" : "导入"}
			</Button>
		</div>
	);
}

export function ResourcesTab() {
	const projectId = useApp((s) => s.activeProjectId);
	const project = useApp((s) => s.projects.projects.find((p) => p.id === s.activeProjectId));
	const handleId = useApp((s) => s.handleId);
	const version = useApp((s) => s.resourcesVersion);
	const pushNotice = useApp((s) => s.pushNotice);
	const [data, setData] = useState<ResourcesResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pkg, setPkg] = useState("");
	const [pkgScope, setPkgScope] = useState<"user" | "project">("user");
	const [installing, setInstalling] = useState(false);
	const cwd = project?.path;

	const load = useCallback(async () => {
		if (!cwd) return;
		try {
			setData(await api.service({ type: "list_resources", cwd }));
			setError(null);
		} catch (e) {
			setError(errorText(e));
		}
	}, [cwd]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: version 只用于触发刷新
	useEffect(() => {
		void load();
	}, [load, version]);

	if (!projectId || !cwd) {
		return <div className="rounded-md border border-border bg-panel px-4 py-6 text-center text-muted">先在左侧打开一个项目。技能与扩展的列表取决于项目（项目可以有自己的 .pi 配置）。</div>;
	}

	const setTrust = async (trusted: boolean) => {
		if (!handleId) return;
		try {
			const state = await api.session(handleId, { type: "set_project_trust", trusted });
			useApp.setState({ state });
			await load();
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const installPackage = async () => {
		setInstalling(true);
		try {
			await api.service({ type: "install_package", cwd, source: pkg.trim(), scope: pkgScope });
			pushNotice("info", `已安装 ${pkg.trim()}`);
			setPkg("");
			await load();
		} catch (e) {
			pushNotice("error", `安装失败：${errorText(e)}`);
		} finally {
			setInstalling(false);
		}
	};

	const trust = data?.trust;
	const projectTrusted = trust?.state !== "untrusted";

	return (
		<div className="space-y-6">
			<div className="text-[12px] text-muted">
				当前项目：<span className="font-medium text-fg">{project ? projectName(project) : ""}</span>
				<span className="ml-2 font-mono">{cwd}</span>
			</div>

			{trust && trust.state !== "not_needed" && (
				<div className={`rounded-lg border px-4 py-3 text-[13px] ${projectTrusted ? "border-border bg-panel-2" : "border-warn/50 bg-warn-soft"}`}>
					<div className="flex items-center gap-2">
						<span className="font-medium">项目信任：{projectTrusted ? "已信任，项目配置已加载" : trust.decided ? "不信任，项目配置未加载" : "尚未决定，项目配置未加载"}</span>
						<div className="flex-1" />
						{projectTrusted ? (
							<Button size="sm" onClick={() => void setTrust(false)}>
								改为不信任
							</Button>
						) : (
							<Button size="sm" variant="primary" onClick={() => void setTrust(true)}>
								信任并加载
							</Button>
						)}
					</div>
					<div className="mt-1 text-[12px] text-muted">项目配置：{trust.items.join("、")}</div>
				</div>
			)}

			{error && <div className="rounded border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</div>}
			{!data && !error && <div className="py-8 text-center text-muted">读取中…</div>}

			{data &&
				(["skill", "extension", "prompt"] as const).map((kind) => {
					const list = data.resources.filter((r) => r.kind === kind);
					return (
						<section key={kind}>
							<div className="mb-1.5 flex items-baseline gap-2">
								<h3 className="text-sm font-semibold">{KIND_LABEL[kind]}</h3>
								<span className="text-[12px] text-muted">{list.length} 个</span>
							</div>
							<div className="mb-2 text-[12px] leading-5 text-muted">
								{KIND_HINT[kind]} 全局目录：<span className="font-mono">{data.dirs.user[kind]}</span>
							</div>
							<div className="overflow-hidden rounded-lg border border-border bg-panel">
								{list.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-muted">还没有{KIND_LABEL[kind]}</div>}
								{list.map((r) => (
									<ResourceRow key={r.path} r={r} cwd={cwd} onChanged={() => void load()} />
								))}
								<ImportForm kind={kind} cwd={cwd} projectTrusted={projectTrusted} onDone={() => void load()} />
							</div>
						</section>
					);
				})}

			{data && (
				<section>
					<div className="mb-1.5 flex items-baseline gap-2">
						<h3 className="text-sm font-semibold">pi 包</h3>
						<span className="text-[12px] text-muted">{data.packages.length} 个</span>
					</div>
					<div className="mb-2 text-[12px] leading-5 text-muted">
						一个 pi 包可以同时提供技能、扩展和提示模板。来源写法：<span className="font-mono">npm:包名</span>、
						<span className="font-mono">git:github.com/用户/仓库</span> 或 https 地址。需要本机装有 npm 或 git。
					</div>
					<div className="overflow-hidden rounded-lg border border-border bg-panel">
						{data.packages.map((p) => (
							<div key={`${p.scope}:${p.source}`} className="flex items-center gap-3 border-b border-border px-3 py-2">
								<span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{p.source}</span>
								<Badge>{p.scope === "project" ? "项目" : "全局"}</Badge>
								<Button
									size="sm"
									variant="danger"
									onClick={() => {
										if (!window.confirm(`卸载 ${p.source}？`)) return;
										void api
											.service({ type: "remove_package", cwd, source: p.source, scope: p.scope })
											.then(() => load(), (e: unknown) => pushNotice("error", errorText(e)));
									}}
								>
									卸载
								</Button>
							</div>
						))}
						<div className="flex items-center gap-2 bg-panel-2/40 px-3 py-2">
							<Input value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="npm:@scope/pi-skills" className="flex-1" />
							<Select value={pkgScope} onChange={(e) => setPkgScope(e.target.value as "user" | "project")} className="w-36">
								<option value="user">全局（所有项目）</option>
								<option value="project" disabled={!projectTrusted}>
									仅当前项目
								</option>
							</Select>
							<Button size="sm" variant="primary" disabled={installing || !pkg.trim()} onClick={() => void installPackage()}>
								{installing ? "安装中…" : "安装"}
							</Button>
						</div>
					</div>
				</section>
			)}
		</div>
	);
}
