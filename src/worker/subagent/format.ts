import type { SubagentResult, SubagentUsage } from "./types";

export const MAX_OUTPUT_CHARS = 50 * 1024;

export function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = asRecord(block);
			return b.type === "text" ? str(b.text) : "";
		})
		.join("");
}

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n…（输出过长，已截断）`;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
	const path = str(args.path ?? args.file_path);
	switch (name) {
		case "bash":
			return `$ ${str(args.command)}`;
		case "read":
		case "write":
		case "edit":
			return `${name} ${path}`;
		case "grep":
		case "find":
			return `${name} ${str(args.pattern)}${path ? ` in ${path}` : ""}`;
		case "ls":
			return `ls ${path || "."}`;
		default: {
			const json = JSON.stringify(args);
			return `${name} ${json.length > 120 ? `${json.slice(0, 120)}…` : json}`;
		}
	}
}

export function usageZero(): SubagentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

export function addUsage(target: SubagentUsage, raw: unknown): void {
	const u = asRecord(raw);
	target.input += num(u.input);
	target.output += num(u.output);
	target.cacheRead += num(u.cacheRead);
	target.cacheWrite += num(u.cacheWrite);
	target.cost += num(asRecord(u.cost).total);
	target.contextTokens = num(u.totalTokens);
	target.turns += 1;
}

export function isFailed(result: SubagentResult): boolean {
	return result.aborted === true || Boolean(result.error);
}

export function resultText(result: SubagentResult): string {
	if (result.error) return result.output ? `${result.output}\n\n[错误] ${result.error}` : `[错误] ${result.error}`;
	return result.output || "(无输出)";
}
