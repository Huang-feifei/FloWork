/**
 * 项目信任。
 *
 * pi 的项目级配置（.pi/settings.json、.pi/extensions、.pi/skills、项目内 .agents/skills 等）可能包含会在本机执行的代码。
 * pi 命令行在交互模式下会先询问；但 SDK 的 SettingsManager.create 默认把项目视为可信。
 * FloWork 改为：项目含这类配置且用户未做决定时不加载，由界面提示用户决定。决定保存在 pi 的 trust.json 中。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ProjectTrust } from "@shared/protocol";

const PROJECT_CONFIG_ITEMS = [
	"settings.json",
	"mcp.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"agents",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
];

/** `.pi/agents` 也是仓库控制的提示词来源，应与扩展/技能一样先确认信任。 */
function hasTrustRequiringItems(cwd: string): boolean {
	return hasTrustRequiringProjectResources(cwd) || existsSync(join(cwd, ".pi", "agents"));
}

/** 列出项目中需要信任才会加载的配置（相对路径，用于界面说明） */
function trustRequiringItems(cwd: string): string[] {
	const items = PROJECT_CONFIG_ITEMS.filter((name) => existsSync(join(cwd, ".pi", name))).map((name) => `.pi/${name}`);
	const userSkills = resolve(homedir(), ".agents", "skills").toLowerCase();
	let dir = resolve(cwd);
	while (true) {
		const skills = join(dir, ".agents", "skills");
		if (skills.toLowerCase() !== userSkills && existsSync(skills)) {
			items.push(dir === resolve(cwd) ? ".agents/skills" : skills);
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return items;
}

export function getProjectTrust(cwd: string): ProjectTrust {
	if (!hasTrustRequiringItems(cwd)) return { state: "not_needed", decided: false, items: [] };
	const decision = new ProjectTrustStore(getAgentDir()).get(cwd);
	return {
		state: decision === true ? "trusted" : "untrusted",
		decided: decision !== null,
		items: trustRequiringItems(cwd),
	};
}

/** 传给 SettingsManager 的 projectTrusted：只有明确信任或不需要信任时才加载项目配置 */
export function isProjectTrusted(cwd: string): boolean {
	const trust = getProjectTrust(cwd);
	return trust.state !== "untrusted";
}

export function setProjectTrust(cwd: string, trusted: boolean): void {
	new ProjectTrustStore(getAgentDir()).set(cwd, trusted);
}
