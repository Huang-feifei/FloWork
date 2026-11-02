import { useState } from "react";
import type { McpServerConfig } from "@shared/protocol";
import { Button, Field, Input, Modal, Select, TextArea } from "../ui";

interface Template {
	label: string;
	name: string;
	type: "stdio" | "http";
	config: McpServerConfig;
}

const TEMPLATES: Template[] = [
	{
		label: "Fetch（网页与接口抓取）",
		name: "fetch",
		type: "stdio",
		config: {
			command: "uvx",
			args: ["mcp-server-fetch"],
			description: "网页抓取与转换工具，支持读取网页正文",
		},
	},
	{
		label: "Filesystem（本地目录文件系统）",
		name: "filesystem",
		type: "stdio",
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
			description: "通过 MCP 协议访问指定本地目录",
		},
	},
	{
		label: "Git（仓库检查与版本操作）",
		name: "git",
		type: "stdio",
		config: {
			command: "uvx",
			args: ["mcp-server-git"],
			description: "Git 仓库查询、分支与提交操作工具",
		},
	},
	{
		label: "Puppeteer（无头浏览器自动化）",
		name: "puppeteer",
		type: "stdio",
		config: {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-puppeteer"],
			description: "基于 Puppeteer 的真实浏览器渲染与自动化工具",
		},
	},
	{
		label: "SQLite（数据库查询）",
		name: "sqlite",
		type: "stdio",
		config: {
			command: "uvx",
			args: ["mcp-server-sqlite", "--db-path", "test.db"],
			description: "SQLite 数据库交互工具",
		},
	},
	{
		label: "远程 HTTP 服务（Streamable HTTP）",
		name: "remote-service",
		type: "http",
		config: {
			url: "https://mcp.example.com/mcp",
			headers: { Authorization: "Bearer ${TOKEN}" },
			description: "远程 streamable-http MCP 服务端点",
		},
	},
];

export interface McpDialogProps {
	initialName?: string;
	initialConfig?: McpServerConfig;
	existingNames: string[];
	onSave: (name: string, config: McpServerConfig) => Promise<void>;
	onClose: () => void;
}

export function McpDialog({ initialName, initialConfig, existingNames, onSave, onClose }: McpDialogProps) {
	const isEditing = !!initialName;
	const [name, setName] = useState(initialName ?? "");
	const [serverType, setServerType] = useState<"stdio" | "http">(initialConfig?.url ? "http" : "stdio");
	const [command, setCommand] = useState(initialConfig?.command ?? "npx");
	const [argsText, setArgsText] = useState((initialConfig?.args ?? []).join(" "));
	const [url, setUrl] = useState(initialConfig?.url ?? "");
	const [cwd, setCwd] = useState(initialConfig?.cwd ?? "");
	const [envText, setEnvText] = useState(
		Object.entries(initialConfig?.env ?? {})
			.map(([k, v]) => `${k}=${v}`)
			.join("\n"),
	);
	const [headersText, setHeadersText] = useState(
		Object.entries(initialConfig?.headers ?? {})
			.map(([k, v]) => `${k}: ${v}`)
			.join("\n"),
	);
	const [description, setDescription] = useState(initialConfig?.description ?? "");
	const [timeout, setTimeoutSec] = useState<string>(initialConfig?.timeout ? String(initialConfig.timeout) : "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const applyTemplate = (t: Template) => {
		setName(t.name);
		setServerType(t.type);
		setCommand(t.config.command ?? "npx");
		setArgsText((t.config.args ?? []).join(" "));
		setUrl(t.config.url ?? "");
		setCwd(t.config.cwd ?? "");
		setDescription(t.config.description ?? "");
		setEnvText(
			Object.entries(t.config.env ?? {})
				.map(([k, v]) => `${k}=${v}`)
				.join("\n"),
		);
		setHeadersText(
			Object.entries(t.config.headers ?? {})
				.map(([k, v]) => `${k}: ${v}`)
				.join("\n"),
		);
	};

	const parseArgs = (text: string): string[] => {
		const trimmed = text.trim();
		if (!trimmed) return [];
		// 优先拆分换行，如果只有单行则按空格拆分（支持引号）
		if (trimmed.includes("\n")) {
			return trimmed.split("\n").map((s) => s.trim()).filter(Boolean);
		}
		const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
		return (matches ?? []).map((s) => s.replace(/^["']|["']$/g, ""));
	};

	const parseEnv = (text: string): Record<string, string> | undefined => {
		const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
		if (lines.length === 0) return undefined;
		const out: Record<string, string> = {};
		for (const line of lines) {
			const idx = line.indexOf("=");
			if (idx > 0) {
				const key = line.slice(0, idx).trim();
				const val = line.slice(idx + 1).trim();
				if (key) out[key] = val;
			}
		}
		return Object.keys(out).length > 0 ? out : undefined;
	};

	const parseHeaders = (text: string): Record<string, string> | undefined => {
		const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
		if (lines.length === 0) return undefined;
		const out: Record<string, string> = {};
		for (const line of lines) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				const key = line.slice(0, idx).trim();
				const val = line.slice(idx + 1).trim();
				if (key) out[key] = val;
			}
		}
		return Object.keys(out).length > 0 ? out : undefined;
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		const trimmedName = name.trim();
		if (!trimmedName) {
			setError("服务标识不能为空");
			return;
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
			setError("服务标识只能包含英文字母、数字、下划线与短横线");
			return;
		}
		if (!isEditing && existingNames.includes(trimmedName)) {
			setError(`服务 "${trimmedName}" 已存在，请更换名称`);
			return;
		}

		const config: McpServerConfig = {
			enabled: initialConfig?.enabled ?? true,
			description: description.trim() || undefined,
			timeout: timeout ? Number(timeout) || undefined : undefined,
		};

		if (serverType === "stdio") {
			if (!command.trim()) {
				setError("命令行启动程序不能为空");
				return;
			}
			config.command = command.trim();
			const parsedArgs = parseArgs(argsText);
			if (parsedArgs.length > 0) config.args = parsedArgs;
			const parsedEnv = parseEnv(envText);
			if (parsedEnv) config.env = parsedEnv;
			if (cwd.trim()) config.cwd = cwd.trim();
		} else {
			if (!url.trim()) {
				setError("服务 URL 端点不能为空");
				return;
			}
			try {
				new URL(url.trim());
			} catch {
				setError("请输入合法的 HTTP/HTTPS 地址");
				return;
			}
			config.url = url.trim();
			const parsedHeaders = parseHeaders(headersText);
			if (parsedHeaders) config.headers = parsedHeaders;
		}

		setSaving(true);
		try {
			await onSave(trimmedName, config);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal title={isEditing ? `编辑 MCP 服务：${name}` : "添加 MCP 服务"} onClose={onClose} width="max-w-[560px]">
			<form onSubmit={handleSubmit} className="space-y-4">
				{!isEditing && (
					<Field label="快捷模板" hint="可选常用模板一键填入基础配置，填入后仍可按需调整">
						<Select
							value=""
							onChange={(e) => {
								const t = TEMPLATES.find((item) => item.name === e.target.value);
								if (t) applyTemplate(t);
							}}
						>
							<option value="">从预设模板选择…</option>
							{TEMPLATES.map((t) => (
								<option key={t.name} value={t.name}>
									{t.label}
								</option>
							))}
						</Select>
					</Field>
				)}

				<Field label="服务标识" hint="唯一服务名，调用工具时对应前缀 mcp__<服务名>__<工具名>">
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="如 fetch、github、database"
						disabled={isEditing}
						required
					/>
				</Field>

				<Field label="服务类型">
					<div className="flex gap-4">
						<label className="flex items-center gap-2 text-[13px] text-fg cursor-pointer">
							<input
								type="radio"
								name="serverType"
								value="stdio"
								checked={serverType === "stdio"}
								onChange={() => setServerType("stdio")}
							/>
							<span>本地命令行（stdio）</span>
						</label>
						<label className="flex items-center gap-2 text-[13px] text-fg cursor-pointer">
							<input
								type="radio"
								name="serverType"
								value="http"
								checked={serverType === "http"}
								onChange={() => setServerType("http")}
							/>
							<span>网络服务（streamable-http）</span>
						</label>
					</div>
				</Field>

				{serverType === "stdio" ? (
					<>
						<Field label="启动命令" hint="本地可执行命令，如 uvx、npx、node、python 或绝对路径">
							<Input
								value={command}
								onChange={(e) => setCommand(e.target.value)}
								placeholder="如 uvx 或 npx"
								required
							/>
						</Field>

						<Field label="命令参数" hint="空格或换行分隔参数，如 -y @modelcontextprotocol/server-filesystem .">
							<Input
								value={argsText}
								onChange={(e) => setArgsText(e.target.value)}
								placeholder="如 mcp-server-fetch"
							/>
						</Field>

						<Field label="环境变量（可选）" hint="每行一组 KEY=VALUE，可使用 ${ENV_VAR} 引用系统环境">
							<TextArea
								rows={3}
								value={envText}
								onChange={(e) => setEnvText(e.target.value)}
								placeholder={"GITHUB_TOKEN=ghp_xxx\nAPI_KEY=${LOCAL_KEY}"}
							/>
						</Field>

						<Field label="运行工作目录（可选）" hint="留空默认使用当前打开的项目目录">
							<Input
								value={cwd}
								onChange={(e) => setCwd(e.target.value)}
								placeholder="绝对路径或留空"
							/>
						</Field>
					</>
				) : (
					<>
						<Field label="端点 URL" hint="提供 Streamable HTTP 协议的 MCP 服务地址">
							<Input
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder="https://example.com/mcp"
								required
							/>
						</Field>

						<Field label="请求头 Headers（可选）" hint="每行一组 Header: Value，如 Authorization: Bearer xxx">
							<TextArea
								rows={3}
								value={headersText}
								onChange={(e) => setHeadersText(e.target.value)}
								placeholder="Authorization: Bearer ${API_TOKEN}"
							/>
						</Field>
					</>
				)}

				<Field label="服务说明（可选）" hint="一句话介绍，帮助模型和用户了解该服务提供的工具范围">
					<Input
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="如：抓取和阅读网页内容的工具集"
					/>
				</Field>

				{error && (
					<div className="rounded-xl bg-err-soft px-3.5 py-2.5 text-[12.5px] text-err">
						{error}
					</div>
				)}

				<div className="flex justify-end gap-2 pt-2">
					<Button type="button" onClick={onClose} disabled={saving}>
						取消
					</Button>
					<Button type="submit" variant="primary" disabled={saving}>
						{saving ? "保存中…" : isEditing ? "保存修改" : "添加服务"}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
