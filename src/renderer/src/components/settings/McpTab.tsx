import { useMemo, useState } from "react";
import type { McpConfig, McpServerConfig } from "@shared/protocol";
import { errorText } from "../../api/client";
import { useApp } from "../../store";
import { askConfirm } from "../ConfirmDialog";
import { Badge, Button, Card, Toggle } from "../ui";
import { isMtimeConflict, useConfigFile } from "./useConfigFile";
import { McpDialog } from "./McpDialog";

export function McpTab() {
	const { file, error, conflict, reload, save } = useConfigFile("mcp");
	const pushNotice = useApp((s) => s.pushNotice);
	const setView = useApp((s) => s.setView);

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingServer, setEditingServer] = useState<{ name: string; config: McpServerConfig } | null>(null);
	const [testStatus, setTestStatus] = useState<Record<string, { ok: boolean; msg: string; time?: number } | "testing">>({});

	const parsedConfig: McpConfig = useMemo(() => {
		if (!file || !file.text) return { mcpServers: {} };
		try {
			const parsed = JSON.parse(file.text) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as McpConfig;
			}
		} catch {
			// 不是合法 JSON 时回退
		}
		return { mcpServers: {} };
	}, [file]);

	const servers = parsedConfig.mcpServers ?? {};
	const serverEntries = Object.entries(servers);

	const saveMcpConfig = async (nextConfig: McpConfig) => {
		try {
			const text = `${JSON.stringify(nextConfig, null, 2)}\n`;
			await save(text, { force: false });
			pushNotice("info", "MCP 服务配置已更新");
		} catch (e) {
			if (!isMtimeConflict(e)) pushNotice("error", errorText(e));
			throw e;
		}
	};

	const handleToggleEnable = async (name: string, current: McpServerConfig) => {
		const nextServers = {
			...servers,
			[name]: { ...current, enabled: current.enabled === false },
		};
		await saveMcpConfig({ ...parsedConfig, mcpServers: nextServers });
	};

	const handleDelete = async (name: string) => {
		const ok = await askConfirm({
			title: `删除 MCP 服务 "${name}"`,
			message: "确定要移除该服务吗？会话将不再挂载它提供的工具。",
			danger: true,
			confirmLabel: "删除",
		});
		if (!ok) return;

		const nextServers = { ...servers };
		delete nextServers[name];
		await saveMcpConfig({ ...parsedConfig, mcpServers: nextServers });
	};

	const handleSaveServer = async (name: string, config: McpServerConfig) => {
		const nextServers = {
			...servers,
			[name]: config,
		};
		await saveMcpConfig({ ...parsedConfig, mcpServers: nextServers });
	};

	const handleTest = async (name: string, conf: McpServerConfig) => {
		setTestStatus((prev) => ({ ...prev, [name]: "testing" }));
		const start = performance.now();
		try {
			if (conf.url) {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 4000);
				try {
					await fetch(conf.url, { method: "HEAD", signal: controller.signal, mode: "no-cors" });
					clearTimeout(timer);
					const duration = Math.round(performance.now() - start);
					setTestStatus((prev) => ({ ...prev, [name]: { ok: true, msg: "端点连通正常", time: duration } }));
				} catch (err: unknown) {
					clearTimeout(timer);
					const isTimeout = err instanceof Error && err.name === "AbortError";
					setTestStatus((prev) => ({
						...prev,
						[name]: { ok: false, msg: isTimeout ? "连接超时（>4s）" : "连接失败，请确认服务已启动并可访问" },
					}));
				}
			} else {
				const cmd = conf.command?.trim();
				if (!cmd) {
					setTestStatus((prev) => ({ ...prev, [name]: { ok: false, msg: "未指定 command 启动命令" } }));
					return;
				}
				setTestStatus((prev) => ({ ...prev, [name]: { ok: true, msg: `命令格式正确 (${cmd})` } }));
			}
		} catch (e: unknown) {
			setTestStatus((prev) => ({ ...prev, [name]: { ok: false, msg: errorText(e) } }));
		}
	};

	return (
		<div className="space-y-6">
			{error && <div className="rounded-xl bg-err-soft px-4 py-3 text-[13px] text-err">{error}</div>}
			{conflict && (
				<div className="rounded-xl bg-warn-soft p-4 text-[13px] leading-relaxed text-warn">
					<div>mcp.json 在其他程序中被修改。请先重新加载，再执行更新。</div>
					<div className="mt-3">
						<Button size="sm" onClick={() => void reload()}>
							重新加载磁盘版本
						</Button>
					</div>
				</div>
			)}

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="text-[13.5px] font-medium text-fg">配置的 MCP 服务（{serverEntries.length}）</div>
					<div className="text-[12px] text-muted">通过 Model Context Protocol 扩展本地或网络工具，服务将在会话启动时自动加载</div>
				</div>
				<div className="flex gap-2">
					<Button
						size="sm"
						onClick={() => {
							setEditingServer(null);
							setDialogOpen(true);
						}}
						variant="primary"
					>
						+ 添加 MCP 服务
					</Button>
					<Button size="sm" onClick={() => setView("settings", "raw")}>
						编辑原始 JSON
					</Button>
				</div>
			</div>

			{serverEntries.length === 0 ? (
				<Card>
					<div className="py-8 text-center">
						<div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary-soft text-xl text-primary">
							⚙
						</div>
						<h3 className="text-[15px] font-semibold tracking-tight">尚未配置 MCP 服务</h3>
						<p className="mx-auto mt-2 max-w-[480px] text-[13px] leading-relaxed text-muted">
							MCP（Model Context Protocol）可以让 AI 调用你本地系统中的命令行脚本、数据库或远程 HTTP 工具，扩展文件读写之外的能力。
						</p>
						<div className="mt-5 flex justify-center gap-3">
							<Button
								variant="primary"
								onClick={() => {
									setEditingServer(null);
									setDialogOpen(true);
								}}
							>
								添加第一个服务
							</Button>
						</div>
					</div>
				</Card>
			) : (
				<div className="grid gap-3">
					{serverEntries.map(([name, conf]) => {
						const isStdio = !conf.url;
						const isEnabled = conf.enabled !== false;
						return (
							<Card key={name}>
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-mono text-[14.5px] font-semibold text-fg">{name}</span>
											<Badge tone={isStdio ? "muted" : "primary"}>{isStdio ? "stdio" : "http"}</Badge>
											<Badge tone={isEnabled ? "ok" : "muted"}>{isEnabled ? "已启用" : "已停用"}</Badge>
										</div>

										{conf.description && (
											<p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{conf.description}</p>
										)}

										<div className="mt-3 rounded-lg bg-surface-raised px-3 py-2 font-mono text-[12px] text-fg">
											{isStdio ? (
												<div className="truncate">
													<span className="text-muted">{conf.command}</span>
													{conf.args && conf.args.length > 0 && <span> {conf.args.join(" ")}</span>}
												</div>
											) : (
												<div className="truncate text-primary">{conf.url}</div>
											)}
										</div>

										<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
											{conf.cwd && <span>目录: {conf.cwd}</span>}
											{conf.env && Object.keys(conf.env).length > 0 && (
												<span>环境: {Object.keys(conf.env).length} 个变量</span>
											)}
											{conf.timeout && <span>超时: {conf.timeout}s</span>}
										</div>

										{testStatus[name] && (
											<div className="mt-2 text-[12px]">
												{testStatus[name] === "testing" ? (
													<span className="text-muted">正在探测连通性…</span>
												) : testStatus[name].ok ? (
													<span className="text-ok font-medium">
														✓ {testStatus[name].msg}
														{testStatus[name].time !== undefined && ` (${testStatus[name].time}ms)`}
													</span>
												) : (
													<span className="text-err font-medium">✗ {testStatus[name].msg}</span>
												)}
											</div>
										)}
									</div>

									<div className="flex shrink-0 items-center gap-2">
										<Button
											size="sm"
											disabled={testStatus[name] === "testing"}
											onClick={() => void handleTest(name, conf)}
											title="测试该服务的连通性"
										>
											{testStatus[name] === "testing" ? "测试中…" : "测试"}
										</Button>
										<Toggle
											on={isEnabled}
											onChange={() => void handleToggleEnable(name, conf)}
											title={`启用或停用 ${name}`}
										/>
										<Button
											size="sm"
											onClick={() => {
												setEditingServer({ name, config: conf });
												setDialogOpen(true);
											}}
										>
											编辑
										</Button>
										<Button
											size="sm"
											variant="ghost"
											className="text-danger hover:bg-danger-soft hover:text-danger"
											onClick={() => void handleDelete(name)}
										>
											删除
										</Button>
									</div>
								</div>
							</Card>
						);
					})}
				</div>
			)}

			<div className="text-[12px] leading-5 text-faint">
				提示：添加或更新 MCP 服务后，新建或切换会话时将自动连接生效。项目级专属配置可保存在该项目根目录下的 <span className="font-mono">.pi/mcp.json</span> 中。
			</div>

			{dialogOpen && (
				<McpDialog
					initialName={editingServer?.name}
					initialConfig={editingServer?.config}
					existingNames={Object.keys(servers)}
					onSave={handleSaveServer}
					onClose={() => {
						setDialogOpen(false);
						setEditingServer(null);
					}}
				/>
			)}
		</div>
	);
}
