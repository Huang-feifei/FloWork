import type { ContentBlock, ImageAttachment } from "@shared/protocol";

export function shortPath(path: string, cwd: string | null): string {
	if (!cwd) return path;
	const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");
	const base = norm(cwd);
	const target = norm(path);
	return target.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? target.slice(base.length + 1) : path;
}

export function describe(name: string, args: Record<string, unknown>, cwd: string | null): string {
	const s = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	switch (name) {
		case "bash":
		case "powershell":
			return s("command") ?? "";
		case "read":
		case "write":
		case "edit": {
			const path = s("path") ?? s("file_path") ?? "";
			return shortPath(path, cwd);
		}
		case "grep":
		case "find":
			return [s("pattern"), s("path") ? shortPath(s("path") as string, cwd) : undefined].filter(Boolean).join(", ");
		case "ls":
			return shortPath(s("path") ?? ".", cwd);
		case "subagent": {
			const agent = s("agent");
			if (agent) {
				const task = s("task") ?? "";
				return task ? `${agent} · ${task.length > 60 ? `${task.slice(0, 60)}…` : task}` : agent;
			}
			const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
			if (tasks > 0) return `parallel · ${tasks} 个任务`;
			const chain = Array.isArray(args.chain) ? args.chain.length : 0;
			if (chain > 0) return `chain · ${chain} 步`;
			return "";
		}
		default: {
			const json = JSON.stringify(args);
			return json.length > 100 ? `${json.slice(0, 100)}…` : json;
		}
	}
}

export function textOf(content: ContentBlock[] | undefined): string {
	return (content ?? [])
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("\n")
		.replace(/\s+$/, "");
}

export function partialTextOf(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content) ? textOf(content as ContentBlock[]) : "";
}

export function imagesOf(content: ContentBlock[] | undefined): ImageAttachment[] {
	return (content ?? []).filter((b): b is ImageAttachment => b.type === "image");
}

export function getDiff(details: unknown): string | undefined {
	if (details && typeof details === "object" && "diff" in details) {
		const diff = (details as { diff: unknown }).diff;
		return typeof diff === "string" && diff.length > 0 ? diff : undefined;
	}
	return undefined;
}
