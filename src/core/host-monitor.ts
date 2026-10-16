/**
 * 服务器状态快照：负载 / 内存 / 磁盘 / systemd 服务单元 / 监听端口 / 失败单元与错误日志。
 *
 * 全部是只读命令，一次 SSH 调用取回（用 ##section 分段），任何一段失败都不影响其余段。
 * 解析逻辑单独导出（parseMonitorOutput），便于用样本输出做验证。
 */
import type { HostMonitorSnapshot, SshHost } from "@shared/protocol";
import { sshRun } from "./ssh";

/** 端口与日志的条数上限，避免面板被刷爆 */
const MAX_PORTS = 60;
const MAX_LOGS = 15;

const SCRIPT = String.raw`
echo "##load"
uptime 2>/dev/null || true
nproc 2>/dev/null || true
cat /proc/loadavg 2>/dev/null || true
echo "##mem"
free -m 2>/dev/null || true
echo "##disk"
df -hP 2>/dev/null | grep -vE '^(tmpfs|devtmpfs|overlay|shm|udev|none)' || true
echo "##services"
systemctl list-units --type=service --all --plain --no-legend --no-pager 2>/dev/null || true
echo "##ports"
ss -tulpnH 2>/dev/null || true
echo "##failed"
systemctl --failed --plain --no-legend --no-pager 2>/dev/null || true
echo "##logs"
journalctl -p err -n ${MAX_LOGS} --no-pager -o short-iso 2>/dev/null | tail -n ${MAX_LOGS} || true
`;

/** 按 ##section 切分脚本输出 */
function sections(text: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	let current = "";
	for (const line of text.split(/\r?\n/)) {
		const marker = /^##(\w+)\s*$/.exec(line);
		if (marker) {
			current = marker[1] ?? "";
			out[current] = [];
			continue;
		}
		if (current && line.trim()) (out[current] as string[]).push(line);
	}
	return out;
}

function nonEmpty(lines: string[] | undefined): string[] {
	return (lines ?? []).map((l) => l.trim()).filter(Boolean);
}

/** 从 ss 的 users:(("nginx",pid=1,fd=6)) 里取进程名 */
function processOf(line: string): string {
	const match = /users:\(\("([^"]+)"(?:,pid=(\d+))?/.exec(line);
	if (!match) return "";
	return match[2] ? `${match[1]}(${match[2]})` : (match[1] as string);
}

export function parseMonitorOutput(text: string, probedAt = Date.now()): HostMonitorSnapshot {
	const s = sections(text);

	// 负载：uptime 行里取 "load average: a, b, c"，没有就退回 /proc/loadavg
	const loadLines = nonEmpty(s.load);
	const uptimeLine = loadLines.find((l) => l.includes("load average")) ?? "";
	const avg = /load average[s]?:\s*([\d.,\s]+)/.exec(uptimeLine)?.[1];
	const procLoad = loadLines.find((l) => /^\d+\.\d+\s+\d+\.\d+\s+\d+\.\d+/.test(l))?.split(/\s+/).slice(0, 3).join(" ");
	const load = (avg ? avg.split(",").map((v) => v.trim()).join(" ") : procLoad) ?? "";
	const uptime = uptimeLine
		.replace(/^.*?up\s+/, "up ")
		.replace(/,?\s*\d+\s+users?,.*$/, "")
		.replace(/,?\s*load average.*$/, "")
		.replace(/\s+/g, " ")
		.trim();
	const cores = Number(loadLines.find((l) => /^\d+$/.test(l)) ?? 0) || 0;

	// 内存：free -m 的 Mem 行（total used free shared buff/cache available）
	const memLine = nonEmpty(s.mem).find((l) => /^Mem:/.test(l)) ?? "";
	const mem = memLine.split(/\s+/).slice(1);
	const memTotal = Number(mem[0] ?? 0) || 0;
	const memAvailable = Number(mem[6] ?? mem[5] ?? 0) || 0;
	const memory = {
		totalMb: memTotal,
		usedMb: Number(mem[1] ?? 0) || 0,
		availableMb: memAvailable,
		percent: memTotal > 0 ? Math.round(((memTotal - memAvailable) / memTotal) * 100) : 0,
	};

	// 磁盘：df -hP 的 文件系统 容量 已用 可用 已用% 挂载点
	const disks = nonEmpty(s.disk)
		.filter((l) => !/^Filesystem/i.test(l))
		.map((l) => l.split(/\s+/))
		.filter((parts) => parts.length >= 6)
		.map((parts) => ({
			mount: parts.slice(5).join(" "),
			size: parts[1] as string,
			used: parts[2] as string,
			free: parts[3] as string,
			percent: parts[4] as string,
		}))
		.slice(0, 20);

	// 服务：UNIT LOAD ACTIVE SUB DESCRIPTION
	const services = nonEmpty(s.services)
		.map((line) => {
			const parts = line.split(/\s+/);
			const descriptionAt = line.indexOf(parts[4] ?? "");
			return {
				name: parts[0] ?? "",
				load: parts[1] ?? "",
				active: parts[2] ?? "",
				sub: parts[3] ?? "",
				description: descriptionAt > 0 ? line.slice(descriptionAt) : "",
			};
		})
		.filter((unit) => unit.name);

	// 监听端口：ss -tulpnH 的 Netid State Recv-Q Send-Q Local Address:Port Peer Process
	const ports = nonEmpty(s.ports)
		.map((line) => {
			const parts = line.split(/\s+/);
			return { proto: parts[0] ?? "", local: parts[4] ?? "", process: processOf(line) };
		})
		.filter((port) => port.proto && port.local)
		.slice(0, MAX_PORTS);

	const failed = nonEmpty(s.failed)
		.map((line) => line.split(/\s+/)[0] ?? "")
		.filter(Boolean);

	const logs = nonEmpty(s.logs).slice(-MAX_LOGS);

	return { probedAt, load, cores, uptime, memory, disks, services, ports, failed, logs };
}

export async function probeHostMonitor(host: SshHost): Promise<HostMonitorSnapshot> {
	const out = await sshRun(host, SCRIPT, { timeoutMs: 30_000 });
	return parseMonitorOutput(out);
}
