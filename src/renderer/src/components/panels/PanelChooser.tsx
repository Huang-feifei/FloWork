import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useBrowserOcclusion } from "../../lib/browser";
import type { RightPanel as Panel } from "../../store";
import { Icon, type IconName } from "../Icon";

export type PanelTab = { id: Panel; label: string; hint: string; icon: IconName; remoteOnly?: boolean };

export function PanelChooser({ tabs, active, onSelect }: { tabs: readonly PanelTab[]; active: Panel | null; onSelect: (panel: Panel) => void }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const current = tabs.find(tab => tab.id === active) ?? tabs[0];
	const showMenu = open && tabs.length > 1;
	useBrowserOcclusion(showMenu);

	useLayoutEffect(() => {
		if (showMenu) (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector("button"))?.focus();
	}, [showMenu]);

	useEffect(() => {
		if (!showMenu) return;
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [showMenu]);

	function close() {
		setOpen(false);
		trigger.current?.focus();
	}

	function navigate(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
			return;
		}
		if (event.key === "Tab") {
			// 从触发按钮继续 Tab，不逐个经过菜单选项。
			close();
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
		if (!items.length) return;
		event.preventDefault();
		const index = items.indexOf(event.target as HTMLButtonElement);
		const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
		items[next]?.focus();
	}

	if (!current) return null;
	if (tabs.length === 1) return <h2 className="fw-inspector-title"><Icon name={current.icon} className="size-4 shrink-0" />{current.label}</h2>;
	return (
		<div className="min-w-0" ref={root} onBlur={(event) => {
			if (showMenu && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
		}}>
			<button type="button" ref={trigger} className="fw-inspector-trigger" aria-label={`切换工具页签：${current.label}`} aria-haspopup="menu" aria-expanded={showMenu} aria-controls={showMenu ? menuId : undefined} data-panel={current.id}
				onClick={() => setOpen(value => !value)} onKeyDown={(event) => {
					if (!showMenu && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setOpen(true); }
					else if (showMenu && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
				}}>
				<Icon name={current.icon} className="size-4 shrink-0 text-muted" />
				<span className="truncate">{current.label}</span>
				<Icon name={showMenu ? "chevron-up" : "chevron-down"} className="size-3.5 shrink-0 text-muted" />
			</button>
			{showMenu && <div ref={menu} id={menuId} role="menu" aria-label="切换工具页签" className="fw-inspector-menu fw-float" onKeyDown={navigate}>
				{tabs.map(tab => (
					<button type="button" key={tab.id} role="menuitemradio" tabIndex={-1} aria-checked={current.id === tab.id} data-panel={tab.id} className="fw-inspector-menu-item" onClick={() => { close(); onSelect(tab.id); }}>
						<Icon name={tab.icon} className="size-4" />
						<span className="min-w-0"><span className="block text-[13px] font-semibold">{tab.label}</span><span className="block truncate text-[11.5px] text-muted" title={tab.hint}>{tab.hint}</span></span>
						{current.id === tab.id && <Icon name="check" className="size-4" />}
					</button>
				))}
			</div>}
		</div>
	);
}
