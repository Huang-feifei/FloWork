/**
 * 侧边栏项目树：置顶区、分组（可折叠）、未分组。
 * 项目展开后显示其会话；支持右键 / 更多菜单、行内重命名、拖拽排序与拖入分组。
 * Apple 体系：行都是内缩圆角行，选中态用蓝色软底，图标走 Icon 组件。
 */
import { type DragEvent, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Project, ProjectGroup, SessionSummary } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { relativeTime } from "../../lib/format";
import { normalizedPath, projectName, selectOpenSession, useApp } from "../../store";
import { Icon } from "../Icon";
import { Spinner } from "../terminal/Spinner";
import { askText } from "../PromptDialog";
import { askConfirm } from "../ConfirmDialog";
import { Menu, type MenuItem } from "./Menu";

/** 一个排序区域：置顶 / 某个分组 / 未分组 */
interface Section {
	key: string;
	pinned: boolean;
	groupId: string | null;
	group?: ProjectGroup;
	title: string | null;
	projects: Project[];
}

const DRAG_TYPE = "application/x-flowork-project";
/** 项目展开后默认只列这么多条会话，其余折叠在「显示全部」后面，避免侧边栏被长会话列表淹没 */
const SESSIONS_PREVIEW = 3;

function buildSections(projects: Project[], groups: ProjectGroup[]): Section[] {
	const byOrder = (a: Project, b: Project) => a.order - b.order || a.addedAt - b.addedAt;
	const sections: Section[] = [];
	const pinned = projects.filter((p) => p.pinned).sort(byOrder);
	if (pinned.length > 0) sections.push({ key: "pinned", pinned: true, groupId: null, title: "置顶", projects: pinned });
	for (const g of groups) {
		sections.push({
			key: `g:${g.id}`,
			pinned: false,
			groupId: g.id,
			group: g,
			title: g.name,
			projects: projects.filter((p) => !p.pinned && p.groupId === g.id).sort(byOrder),
		});
	}
	const validGroups = new Set(groups.map((g) => g.id));
	const rest = projects.filter((p) => !p.pinned && (!p.groupId || !validGroups.has(p.groupId))).sort(byOrder);
	sections.push({
		key: "ungrouped",
		pinned: false,
		groupId: null,
		title: groups.length > 0 ? "未分组" : null,
		projects: rest,
	});
	return sections;
}

function StatusMark({ pid }: { pid: string }) {
	const status = useApp(useShallow((s) => s.projectStatus(pid)));
	if (status.waiting > 0)
		return (
			<span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[10.5px] font-medium text-warn" title="等待你确认">
				待确认 {status.waiting}
			</span>
		);
	if (status.running) return <Spinner className="shrink-0 text-[12px] text-primary" />;
	if (status.unread) return <span className="size-1.5 shrink-0 rounded-full bg-ok" title="后台任务已完成" />;
	if (status.open) return <span className="size-1.5 shrink-0 rounded-full border border-border-strong" title="pi 进程运行中（空闲）" />;
	return null;
}

/** 一条历史会话：点击打开；右键或 ⋯ 菜单重命名 / 删除 */
function SessionRow({ project, session }: { project: Project; session: SessionSummary }) {
	const busy = useApp((s) => s.sessionBusy(project.id, session.path));
	const pending = useApp((s) => s.sessionOperation(project.id, session.path));
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const label = session.name || session.firstMessage || "（空会话）";
	const locked = project.missing || !!pending;

	const rename = async () => {
		const value = await askText({
			title: "重命名会话",
			defaultValue: session.name ?? session.firstMessage ?? "",
			placeholder: "留空恢复默认标题",
			allowEmpty: true,
		});
		if (value === null) return;
		await useApp.getState().renameSession(project.id, session.path, value);
	};

	const items: MenuItem[] = [
		{ label: "重命名", disabled: locked, onClick: () => void rename() },
		{
			label: "删除会话",
			danger: true,
			hint: busy ? "运行中" : pending ? "处理中" : undefined,
			disabled: locked || busy,
			onClick: () => void useApp.getState().deleteSession(project.id, session.path),
		},
	];

	return (
		<div
			onContextMenu={(e) => {
				if (locked) return;
				e.preventDefault();
				setMenu({ x: e.clientX, y: e.clientY });
			}}
			className="group/session relative flex items-center rounded-[10px] hover:bg-panel-2"
		>
			<button
				type="button"
				onClick={() => void useApp.getState().openProject(project.id, session.path)}
				title={label}
				className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
			>
				<div className={`truncate text-[12.5px] ${pending ? "text-muted" : ""}`}>{label}</div>
				<div className="text-[11px] text-faint">
					{relativeTime(session.modified)} · {session.messageCount} 条
				</div>
			</button>
			<button
				type="button"
				disabled={locked}
				onClick={(e) => {
					const rect = e.currentTarget.getBoundingClientRect();
					setMenu({ x: rect.left, y: rect.bottom + 4 });
				}}
				title="会话操作"
				className="invisible mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted group-hover/session:visible hover:bg-panel-2 hover:text-fg disabled:opacity-40"
			>
				<Icon
					name="ellipsis"
					className="size-3.5"
				/>
			</button>
			{menu && <Menu items={items} position={menu} onClose={() => setMenu(null)} />}
		</div>
	);
}

/** 项目下打开中的会话（标签）：点击切换，× 关闭 */
const EMPTY_HANDLES: string[] = [];

function OpenSessionRow({ project, handleId }: { project: Project; handleId: string }) {
	const info = useApp(useShallow((s) => selectOpenSession(s, handleId)));
	const label = info.name || (info.draft ? "新会话" : "会话");
	return (
		<div className={`group/open relative flex items-center rounded-[10px] ${info.active ? "bg-primary-soft" : "hover:bg-panel-2"}`}>
			<button
				type="button"
				onClick={() => useApp.getState().activateSession(handleId)}
				title={label}
				className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left"
			>
				{info.waiting > 0 ? (
					<span className="shrink-0 rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-medium text-warn" title="等待你确认">
						待确认
					</span>
				) : info.running ? (
					<Spinner className="shrink-0 text-[11px] text-primary" />
				) : (
					<span className="size-1.5 shrink-0 rounded-full border border-border-strong" title="空闲" />
				)}
				<span className={`min-w-0 truncate text-[12.5px] ${info.active ? "font-medium text-primary" : ""}`}>{label}</span>
			</button>
			<button
				type="button"
				disabled={project.missing}
				onClick={() => void useApp.getState().closeSession(handleId)}
				title="关闭会话"
				className="invisible mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted group-hover/open:visible hover:bg-panel-2 hover:text-fg disabled:opacity-40"
			>
				<Icon
					name="x"
					className="size-3.5"
				/>
			</button>
		</div>
	);
}

function SessionList({ project }: { project: Project }) {
	const sessions = useApp((s) => s.projectSessions[project.id]);
	const handles = useApp((s) => s.projectHandles[project.id] ?? EMPTY_HANDLES);
	const openFiles = useApp(
		useShallow((s) =>
			(s.projectHandles[project.id] ?? [])
				.map((h) => (s.handleId === h ? s : s.background[h])?.state?.sessionFile ?? "")
				.filter(Boolean)
				.map(normalizedPath),
		),
	);
	const { newSessionIn } = useApp.getState();
	const [showAll, setShowAll] = useState(false);
	const openSet = new Set(openFiles);
	const list = (sessions ?? []).filter((s) => !openSet.has(normalizedPath(s.path)));
	const visible = showAll ? list : list.slice(0, SESSIONS_PREVIEW);
	const overflow = list.length > SESSIONS_PREVIEW;

	return (
		<div className="mt-0.5 mb-1 space-y-0.5 pl-6">
			<button
				type="button"
				disabled={project.missing}
				onClick={() => void newSessionIn(project.id)}
				className="flex w-full items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
			>
				<Icon
					name="plus"
					className="size-3.5"
				/>
				新会话
			</button>
			{handles.length > 0 && (
				<div className="space-y-0.5">
					{handles.map((handleId) => (
						<OpenSessionRow
							key={handleId}
							project={project}
							handleId={handleId}
						/>
					))}
				</div>
			)}
			{sessions === undefined && <div className="px-2.5 py-1 text-[11.5px] text-faint">加载中…</div>}
			{list.length > 0 && handles.length > 0 && <div className="px-2.5 pt-1.5 pb-0.5 text-[10.5px] font-semibold tracking-wide text-faint">历史会话</div>}
			{/* 展开全部时限制高度并在列表内部滚动，会话再多也不会把侧边栏撑长 */}
			<div className={showAll && overflow ? "max-h-[42vh] space-y-0.5 overflow-y-auto overscroll-contain" : "space-y-0.5"}>
				{visible.map((s) => (
					<SessionRow
						key={s.path}
						project={project}
						session={s}
					/>
				))}
			</div>
			{overflow && (
				<button
					type="button"
					onClick={() => setShowAll(!showAll)}
					title={showAll ? `只显示最近 ${SESSIONS_PREVIEW} 个会话` : `展开全部 ${list.length} 个会话`}
					className="flex w-full items-center gap-1.5 rounded-[10px] px-2.5 py-1 text-left text-[11.5px] text-primary hover:bg-panel-2"
				>
					<Icon
						name={showAll ? "chevron-up" : "chevron-down"}
						className="size-3.5"
					/>
					{showAll ? "收起" : `显示全部 ${list.length} 个`}
				</button>
			)}
		</div>
	);
}

function ProjectRow({
	project,
	section,
	groups,
	onDragStart,
	onDropOn,
}: {
	project: Project;
	section: Section;
	groups: ProjectGroup[];
	onDragStart: (e: DragEvent, project: Project) => void;
	onDropOn: (e: DragEvent, section: Section, beforeId: string | null) => void;
}) {
	const activeProjectId = useApp((s) => s.activeProjectId);
	const expanded = useApp((s) => !!s.expanded[project.id]);
	const open = useApp((s) => s.projectStatus(project.id).open);
	const { openProject, toggleExpanded, newSessionIn, stopProject, removeProject, pushNotice } = useApp.getState();
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [dropHint, setDropHint] = useState<"before" | "after" | null>(null);
	const active = activeProjectId === project.id;
	const name = projectName(project);

	const update = (patch: Parameters<typeof api.projects.update>[1]) =>
		void api.projects.update(project.id, patch).catch((e: unknown) => pushNotice("error", errorText(e)));

	const createGroupAndMove = async () => {
		const groupName = (await askText({ title: "移到新分组", placeholder: "分组名称" }))?.trim();
		if (!groupName?.trim()) return;
		try {
			const { group } = await api.projects.groupCreate(groupName);
			await api.projects.update(project.id, { groupId: group.id, pinned: false });
		} catch (e) {
			pushNotice("error", errorText(e));
		}
	};

	const items: MenuItem[] = [
		{ label: project.hostId ? "新运维会话" : "新会话", onClick: () => void newSessionIn(project.id), disabled: project.missing },
		{ label: "重命名", onClick: () => setRenaming(true) },
		{ label: project.pinned ? "取消置顶" : "置顶", onClick: () => update({ pinned: !project.pinned }) },
		{ separator: true, label: "" },
		...groups.map((g) => ({
			label: `移到「${g.name}」`,
			hint: project.groupId === g.id ? "当前" : undefined,
			disabled: project.groupId === g.id && !project.pinned,
			onClick: () => update({ groupId: g.id, pinned: false }),
		})),
		...(project.groupId
			? [{ label: "移出分组", onClick: () => update({ groupId: null, pinned: false }) }]
			: []),
		{ label: "移到新分组…", onClick: () => void createGroupAndMove() },
		{ separator: true, label: "" },
		{
			label: "复制路径",
			onClick: () => void navigator.clipboard.writeText(project.path).then(() => pushNotice("info", "已复制路径")),
		},
		...(open ? [{ label: "停止 pi 进程", onClick: () => void stopProject(project.id) }] : []),
		{ label: "从列表移除", danger: true, onClick: () => void removeProject(project.id) },
	];

	return (
		<div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: 拖拽目标 */}
			<div
				draggable={!renaming}
				onDragStart={(e) => onDragStart(e, project)}
				onDragOver={(e) => {
					if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
					e.preventDefault();
					const rect = e.currentTarget.getBoundingClientRect();
					setDropHint(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
				}}
				onDragLeave={() => setDropHint(null)}
				onDrop={(e) => {
					const hint = dropHint;
					setDropHint(null);
					const index = section.projects.findIndex((p) => p.id === project.id);
					const beforeId = hint === "before" ? project.id : (section.projects[index + 1]?.id ?? null);
					onDropOn(e, section, beforeId);
				}}
				onContextMenu={(e) => {
					e.preventDefault();
					setMenu({ x: e.clientX, y: e.clientY });
				}}
				className={`group relative flex items-center gap-1.5 rounded-[10px] py-1.5 pr-1 pl-1.5 ${
					active ? "bg-primary-soft" : "hover:bg-panel-2"
				} ${dropHint === "before" ? "shadow-[inset_0_2px_0_var(--color-accent)]" : ""} ${
					dropHint === "after" ? "shadow-[inset_0_-2px_0_var(--color-accent)]" : ""
				}`}
			>
				<button
					type="button"
					onClick={() => toggleExpanded(project.id)}
					className="flex size-4 shrink-0 items-center justify-center text-faint hover:text-fg"
					title={expanded ? "折叠会话" : "展开会话"}
				>
					<Icon
						name={expanded ? "chevron-down" : "chevron-right"}
						className="size-3.5"
					/>
				</button>
				{renaming ? (
					<input
						// biome-ignore lint/a11y/noAutofocus: 行内重命名
						autoFocus
						defaultValue={name}
						onBlur={(e) => {
							setRenaming(false);
							if (e.target.value.trim() !== name) update({ name: e.target.value });
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
							if (e.key === "Escape") setRenaming(false);
						}}
						className="min-w-0 flex-1 rounded-[10px] border border-primary/40 bg-surface-raised px-2 py-0.5 text-[13px] outline-none ring-4 ring-primary/10"
					/>
				) : (
					<button
						type="button"
						onClick={() => {
							void openProject(project.id);
							if (!expanded) toggleExpanded(project.id, true);
						}}
						onDoubleClick={() => setRenaming(true)}
						title={project.path}
						className="flex min-w-0 flex-1 items-center gap-2 text-left"
					>
						<Icon
							name={project.missing ? "shield-alert" : expanded ? "folder-open" : "folder"}
							className={`size-4 shrink-0 ${project.missing ? "text-warn" : active ? "text-primary" : "text-muted"}`}
						/>
						<span className={`min-w-0 truncate text-[13px] ${active ? "font-medium" : ""} ${project.missing ? "text-muted line-through" : ""}`}>
							{name}
						</span>
						{project.hostId && (
							<span className="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-[10.5px] font-medium text-muted">远程</span>
						)}
					</button>
				)}
				<StatusMark pid={project.id} />
				<button
					type="button"
					onClick={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						setMenu({ x: rect.left, y: rect.bottom + 4 });
					}}
					className="invisible flex size-6 shrink-0 items-center justify-center rounded-full text-muted group-hover:visible hover:bg-panel-2 hover:text-fg"
					title="更多操作"
				>
					<Icon
						name="ellipsis"
						className="size-3.5"
					/>
				</button>
			</div>
			{expanded && <SessionList project={project} />}
			{menu && <Menu items={items} position={menu} onClose={() => setMenu(null)} />}
		</div>
	);
}

function SectionHeader({ section, onDropOn }: { section: Section; onDropOn: (e: DragEvent, section: Section, beforeId: string | null) => void }) {
	const pushNotice = useApp((s) => s.pushNotice);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [over, setOver] = useState(false);
	const group = section.group;
	if (!section.title) return null;

	const items: MenuItem[] = group
		? [
				{
					label: "重命名分组",
					onClick: async () => {
						const name = (await askText({ title: "重命名分组", defaultValue: group.name }))?.trim();
						if (name) void api.projects.groupUpdate(group.id, { name }).catch((e: unknown) => pushNotice("error", errorText(e)));
					},
				},
				{
					label: "删除分组",
					danger: true,
					onClick: async () => {
						if (await askConfirm({ title: "删除分组", message: `删除分组「${group.name}」？组内项目会移到“未分组”。`, confirmLabel: "删除", danger: true }))
							void api.projects.groupRemove(group.id).catch((e: unknown) => pushNotice("error", errorText(e)));
					},
				},
			]
		: [];

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 拖拽目标
		<div
			onDragOver={(e) => {
				if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
				e.preventDefault();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				setOver(false);
				onDropOn(e, section, null);
			}}
			onContextMenu={(e) => {
				if (!group) return;
				e.preventDefault();
				setMenu({ x: e.clientX, y: e.clientY });
			}}
			className={`group mt-2 flex items-center gap-1.5 rounded-[10px] px-2.5 py-1 text-[11.5px] font-semibold text-faint ${
				over ? "bg-primary-soft text-primary" : ""
			}`}
		>
			{group ? (
				<button
					type="button"
					onClick={() => void api.projects.groupUpdate(group.id, { collapsed: !group.collapsed })}
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-fg"
				>
					<Icon
						name={group.collapsed ? "chevron-right" : "chevron-down"}
						className="size-3.5 shrink-0"
					/>
					<span className="truncate">{section.title}</span>
					<span className="font-normal tabular-nums">{section.projects.length}</span>
				</button>
			) : (
				<span className="flex-1 pl-5">{section.title}</span>
			)}
			{group && (
				<button
					type="button"
					onClick={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						setMenu({ x: rect.left, y: rect.bottom + 4 });
					}}
					className="invisible flex size-6 items-center justify-center rounded-full hover:bg-panel-2 hover:text-fg group-hover:visible"
				>
					<Icon
						name="ellipsis"
						className="size-3.5"
					/>
				</button>
			)}
			{menu && <Menu items={items} position={menu} onClose={() => setMenu(null)} />}
		</div>
	);
}

export function ProjectTree() {
	const projects = useApp((s) => s.projects.projects);
	const groups = useApp((s) => s.projects.groups);
	const pushNotice = useApp((s) => s.pushNotice);
	const sections = useMemo(() => buildSections(projects, groups), [projects, groups]);

	const onDragStart = (e: DragEvent, project: Project) => {
		e.dataTransfer.setData(DRAG_TYPE, project.id);
		e.dataTransfer.effectAllowed = "move";
	};

	/** 把拖动的项目放到目标区域 beforeId 之前（null 表示末尾） */
	const onDropOn = (e: DragEvent, section: Section, beforeId: string | null) => {
		const id = e.dataTransfer.getData(DRAG_TYPE);
		if (!id) return;
		e.preventDefault();
		const ids = section.projects.map((p) => p.id).filter((x) => x !== id);
		const index = beforeId ? ids.indexOf(beforeId) : -1;
		if (index >= 0) ids.splice(index, 0, id);
		else ids.push(id);
		void api.projects.move(ids, section.pinned, section.groupId).catch((err: unknown) => pushNotice("error", errorText(err)));
	};

	if (projects.length === 0) {
		return <div className="px-3.5 py-3 text-[12.5px] leading-relaxed text-muted">还没有项目。点击右上角的 + 导入文件夹，或用“发现项目”从已有会话中导入。</div>;
	}

	return (
		<div className="flex flex-col gap-0.5">
			{sections.map((section) => (
				<div key={section.key}>
					<SectionHeader section={section} onDropOn={onDropOn} />
					{!section.group?.collapsed &&
						section.projects.map((p) => (
							<ProjectRow key={p.id} project={p} section={section} groups={groups} onDragStart={onDragStart} onDropOn={onDropOn} />
						))}
					{section.group && !section.group.collapsed && section.projects.length === 0 && (
						<div className="py-1.5 pl-7 text-[11.5px] text-faint">拖动项目到这里</div>
					)}
				</div>
			))}
		</div>
	);
}
