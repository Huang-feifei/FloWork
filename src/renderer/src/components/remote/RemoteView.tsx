/**
 * 远程项目工作区：左侧项目文件，右侧远程终端。
 *
 * 远程项目不启动本地 pi 会话（AI 在服务器上运行还在规划中），所以这里不显示对话区，
 * 只提供文件浏览 / 编辑与一台真正的远程 shell，用于直接操作服务器。
 */
import { useApp } from "../../store";
import { FilePreview } from "../panels/FilePreview";
import { ProjectFiles } from "../panels/ProjectFiles";
import { TerminalTab } from "../terminal/TerminalPanel";
import { Badge } from "../ui";

export function RemoteView() {
	const project = useApp((s) => s.projects.projects.find((p) => p.id === s.activeProjectId));
	const host = useApp((s) => s.hosts.find((h) => h.id === project?.hostId));
	const name = project?.name || project?.path.split("/").filter(Boolean).pop() || project?.path || "";
	const hostLabel = host ? host.name || `${host.user ? `${host.user}@` : ""}${host.host}` : "已删除的主机";

	return (
		<div className="flex min-h-0 flex-1">
			<aside className="flex w-[300px] shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar">
				<div className="flex items-center gap-2 border-b border-border px-3 py-2">
					<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{name}</span>
					<Badge tone="accent">远程</Badge>
				</div>
				<ProjectFiles />
			</aside>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-term">
				<div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-1">
					<h1 className="min-w-0 truncate text-[13.5px] font-semibold">{hostLabel}</h1>
					<span className="min-w-0 truncate font-mono text-[11px] text-muted" title={project?.path}>
						{project?.path}
					</span>
					<div className="flex-1" />
					<span className="shrink-0 text-[11px] text-muted">远程 AI 会话尚未开放，当前可直接操作文件与终端</span>
				</div>
				<FilePreview />
				<TerminalTab />
			</div>
		</div>
	);
}
