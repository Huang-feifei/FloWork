import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export function PageHeading({ title, detail, actions }: { title: string; detail?: ReactNode; actions?: ReactNode }) {
	return (
		<header className="fw-page-heading">
			<div className="min-w-0 flex-1">
				<h1 className="fw-page-title truncate" title={title}>{title}</h1>
				{detail && <div className="mt-1 min-w-0 text-[12px] leading-5 text-muted">{detail}</div>}
			</div>
			{actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
		</header>
	);
}

export function WorkbenchEmpty({ icon, title, detail, actions }: { icon: IconName; title: string; detail: string; actions?: ReactNode }) {
	return (
		<div className="fw-empty-workbench">
			<div className="fw-empty-mark" aria-hidden="true"><Icon name={icon} className="size-6" /></div>
			<h2 className="fw-page-title text-balance">{title}</h2>
			<p className="max-w-[420px] text-sm leading-6 text-muted">{detail}</p>
			{actions && <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div>}
		</div>
	);
}
