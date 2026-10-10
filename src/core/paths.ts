import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi 的配置目录（auth.json、models.json、settings.json、sessions/、skills/ …）。
 *
 * 默认与 pi CLI 的 ~/.pi/agent 隔离，避免桌面版与命令行互相修改设置。
 * 是否改为共用 ~/.pi/agent 尚待决定；可通过环境变量 FLOWORK_PI_AGENT_DIR 临时覆盖。
 * 该值通过 PI_CODING_AGENT_DIR 传给 worker，pi 的 getAgentDir() 会读取它。
 */
export function getPiAgentDir(): string {
	return process.env.FLOWORK_PI_AGENT_DIR || join(homedir(), ".flowork", "agent");
}

/** FloWork 自身的数据目录（项目列表等），与 pi 配置目录分开 */
export function getFloworkDataDir(): string {
	return process.env.FLOWORK_DATA_DIR || join(homedir(), ".flowork");
}

/** pi CLI 默认的会话目录；用于“发现项目”时一并扫描（只读） */
export function getPiCliSessionsDir(): string {
	return join(homedir(), ".pi", "agent", "sessions");
}
