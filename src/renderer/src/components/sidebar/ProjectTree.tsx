/**
 * 侧边栏项目树：置顶区、分组（可折叠）、未分组。
 * 项目展开后显示其会话；支持右键 / 更多菜单、行内重命名、拖拽排序与拖入分组。
 */
import { type DragEvent, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Project, ProjectGroup, SessionSummary } from "@shared/protocol";
import { api, errorText } from "../../api/client";
import { relativeTime } from "../../lib/format";
import { projectName, useApp } from "../../store";
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
			<span className="shrink-0 rounded bg-warn/15 px-1 text-[10px] font-medium text-warn" title="等待你确认">
				待确认 {status.waiting}
			</span>
		);
	if (status.running) return <Spinner className="shrink-0 text-[12px] text-accent" />;
	if (status.unread) return <span className="size-1.5 shrink-0 rounded-full bg-ok" title="后台任务已完成" />;
	if (status.open) return <span className="size-1.5 shrink-0 rounded-full border border-muted/60" title="pi 进程运行中（空闲）" />;
	return null;
}

/** 一条历史会话：点击打开；右键或 ⋯ 菜单重命名 / 删除 */
function SessionRow({ project, session, active }: { project: Project; session: SessionSummary; active: boolean }) {
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
			className={`group/session relative flex items-center rounded-md ${
				active ? "bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.05)]" : "hover:bg-panel-2"
			}`}
		>
			<button
				type="button"
				onClick={() => void useApp.getState().openProject(project.id, session.path)}
				title={label}
				className="min-w-0 flex-1 px-2 py-1 text-left"
			>
				<div className={`truncate text-[12px] ${active ? "font-medium" : ""} ${pending ? "text-muted" : ""}`}>{label}</div>
				<div className="text-[10.5px] text-muted">
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
				className="invisible mr-0.5 shrink-0 rounded px-1 text-muted group-hover/session:visible hover:bg-panel-2 hover:text-fg disabled:opacity-40"
			>
				⋯
			</button>
			{menu && <Menu items={items} position={menu} onClose={() => setMenu(null)} />}
		</div>
	);
}

function SessionList({ project }: { project: Project }) {
	const sessions = useApp((s) => s.projectSessions[project.id]);
	const activeProjectId = useApp((s) => s.activeProjectId);
	const activeFile = useApp((s) => s.state?.sessionFile);
	const view = useApp((s) => s.view);
	const { openProject, newSessionIn } = useApp.getState();
	const [showAll, setShowAll] = useState(false);
	const list = sessions ?? [];
	const visible = showAll ? list : list.slice(0, SESSIONS_PREVIEW);
	const overflow = list.length > SESSIONS_PREVIEW;

	return (
		<div className="mb-1 ml-[18px] border-l border-border pl-1.5">
			<button
				type="button"
				disabled={project.missing}
				onClick={() => void newSessionIn(project.id)}
				className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
			>
				<span className="text-accent">+</span> 新会话
			</button>
			{sessions === undefined && <div className="px-2 py-1 text-[11px] text-muted">加载中…</div>}
			{/* 展开全部时限制高度并在列表内部滚动，会话再多也不会把侧边栏撑长 */}
			<div className={showAll && overflow ? "max-h-[42vh] overflow-y-auto overscroll-contain" : undefined}>
				{visible.map((s) => (
					<SessionRow
						key={s.path}
						project={project}
						session={s}
						active={activeProjectId === project.id && s.path === activeFile && view === "chat"}
					/>
				))}
			</div>
			{overflow && (
				<button
					type="button"
					onClick={() => setShowAll(!showAll)}
					title={showAll ? `只显示最近 ${SESSIONS_PREVIEW} 个会话` : `展开全部 ${list.length} 个会话`}
					className="flex w-full items-center gap-1 rounded-md px-2 py-0.5 text-left text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
				>
					<span className="text-[9px]">{showAll ? "▾" : "▸"}</span>
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
				className={`group relative flex items-center gap-1 rounded-lg py-1.5 pr-1 pl-1 ${
					active ? "bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.05)]" : "hover:bg-panel-2"
				} ${dropHint === "before" ? "shadow-[inset_0_2px_0_var(--color-accent)]" : ""} ${
					dropHint === "after" ? "shadow-[inset_0_-2px_0_var(--color-accent)]" : ""
				}`}
			>
				<button
					type="button"
					onClick={() => toggleExpanded(project.id)}
					className="w-4 shrink-0 text-center text-[10px] text-muted hover:text-fg"
					title={expanded ? "折叠会话" : "展开会话"}
				>
					{expanded ? "▾" : "▸"}
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
						className="min-w-0 flex-1 rounded border border-accent bg-panel px-1 text-[13px] outline-none"
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
						className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
					>
						<span className={`text-[13px] ${project.missing ? "text-muted line-through" : active ? "text-accent" : "text-muted"}`}>
							{project.missing ? "⚠" : "▣"}
						</span>
						<span className={`min-w-0 truncate text-[13px] ${active ? "font-medium" : ""} ${project.missing ? "text-muted" : ""}`}>
							{name}
						</span>
						{project.hostId && (
							<span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-normal text-accent">远程</span>
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
					className="invisible shrink-0 rounded px-1 text-muted group-hover:visible hover:bg-panel-2 hover:text-fg"
					title="更多操作"
				>
					⋯
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
			className={`group mt-2 flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium tracking-wide text-muted ${
				over ? "bg-accent-soft text-accent" : ""
			}`}
		>
			{group ? (
				<button
					type="button"
					onClick={() => void api.projects.groupUpdate(group.id, { collapsed: !group.collapsed })}
					className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-fg"
				>
					<span className="w-3 text-[9px]">{group.collapsed ? "▸" : "▾"}</span>
					<span className="truncate">{section.title}</span>
					<span className="font-normal">{section.projects.length}</span>
				</button>
			) : (
				<span className="flex-1 pl-4">{section.title}</span>
			)}
			{group && (
				<button
					type="button"
					onClick={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						setMenu({ x: rect.left, y: rect.bottom + 4 });
					}}
					className="invisible rounded px-1 group-hover:visible hover:bg-panel-2 hover:text-fg"
				>
					⋯
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
		return <div className="px-3 py-2 text-[12px] leading-5 text-muted">还没有项目。点击右上角的 + 导入文件夹，或用“发现项目”从已有会话中导入。</div>;
	}

	return (
		<div className="flex flex-col">
			{sections.map((section) => (
				<div key={section.key}>
					<SectionHeader section={section} onDropOn={onDropOn} />
					{!section.group?.collapsed &&
						section.projects.map((p) => (
							<ProjectRow key={p.id} project={p} section={section} groups={groups} onDragStart={onDragStart} onDropOn={onDropOn} />
						))}
					{section.group && !section.group.collapsed && section.projects.length === 0 && (
						<div className="py-1 pl-6 text-[11px] text-muted/80">拖动项目到这里</div>
					)}
				</div>
			))}
		</div>
	);
}
