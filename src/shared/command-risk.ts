/**
 * 运维会话的命令风险分级：只读 / 有改动 / 高危。
 *
 * 这是减少打扰的启发式规则，不是安全边界：
 * - 只读按白名单判断，管道、`;`、`&&`、`||` 拆开后每一段都必须只读；出现重定向写文件、命令替换、
 *   无法识别的命令时一律算「有改动」。宁可多确认，不漏放。
 * - 高危按黑名单判断，在任何审批模式下都要确认，且不允许「本会话始终允许」。
 *
 * 界面（审批面板的红色警告）与 worker（是否需要确认）共用这一份实现。
 */

export type CommandRisk = "read" | "write" | "danger";

export interface RiskAssessment {
	risk: CommandRisk;
	/** 高危原因（用于审批面板展示）；只读 / 普通改动时为空 */
	reasons: string[];
}

// ---------- 高危规则 ----------

interface DangerRule {
	pattern: RegExp;
	reason: string;
	/** 只在命令会写入时才算高危（例如 cat /etc/ssh/sshd_config 只是查看） */
	onlyIfWrites?: boolean;
}

/** 系统关键目录：作为 rm -r / chmod -R / chown -R 的目标时视为高危 */
const CRITICAL_PATHS = String.raw`(?:/|/\*|/(?:bin|boot|dev|etc|lib|lib32|lib64|opt|proc|root|sbin|srv|sys|usr|var|home)(?:/\*?)?|~/?|\$HOME/?|\*)`;
const PATH_END = String.raw`(?=$|[\s;&|)])`;

const DANGER_RULES: DangerRule[] = [
	{ pattern: new RegExp(String.raw`\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z-]+\s+)*(?:--\s+)?["']?${CRITICAL_PATHS}["']?${PATH_END}`), reason: "递归删除系统关键目录" },
	{ pattern: /\brm\s+.*--no-preserve-root/, reason: "rm --no-preserve-root" },
	{ pattern: /\bmkfs(?:\.\w+)?\b/, reason: "格式化文件系统（mkfs）" },
	{ pattern: /\b(?:wipefs|sgdisk\s+--zap|shred)\b/, reason: "擦除磁盘 / 分区" },
	{ pattern: /\bdd\b[^|;&]*\bof=\/dev\//, reason: "dd 直接写入块设备" },
	{ pattern: /(?:^|[^>])>\s*\/dev\/(?:sd|nvme|vd|xvd|hd|mmcblk)\w*/, reason: "重定向覆盖块设备" },
	{ pattern: /\b(?:fdisk|parted|gdisk|cfdisk)\b/, reason: "修改磁盘分区" },
	{ pattern: /\b(?:reboot|poweroff|halt)\b/, reason: "重启 / 关机" },
	{ pattern: /\bshutdown\b/, reason: "关机 / 重启（shutdown）" },
	{ pattern: /\binit\s+[06]\b/, reason: "切换运行级别到关机 / 重启" },
	{ pattern: /\bsystemctl\s+(?:reboot|poweroff|halt|kexec|emergency|rescue)\b/, reason: "systemctl 重启 / 关机 / 救援模式" },
	{ pattern: /\bsystemctl\s+(?:stop|disable|mask|kill)\s+(?:[\w@.-]+\s+)*(?:ssh|sshd)(?:\.service)?\b/, reason: "停止或禁用 SSH 服务（会断开当前连接）" },
	{ pattern: /\bservice\s+sshd?\s+stop\b/, reason: "停止 SSH 服务（会断开当前连接）" },
	{ pattern: /\b(?:sshd_config|ssh\/sshd_config\.d)\b/, reason: "修改 SSH 服务配置（可能把自己锁在外面）", onlyIfWrites: true },
	{ pattern: /\biptables(?:-legacy|-nft)?\s+(?:-[a-zA-Z]*\s+)*-(?:F|X|P|-flush|-policy)\b/, reason: "清空 / 修改 iptables 规则或默认策略" },
	{ pattern: /\bip6?tables-restore\b/, reason: "整体替换 iptables 规则" },
	{ pattern: /\bnft\s+(?:flush|delete)\b/, reason: "清空 / 删除 nftables 规则" },
	{ pattern: /\bufw\s+(?:enable|disable|reset|default)\b/, reason: "启停或重置 ufw 防火墙" },
	{ pattern: /\bfirewall-cmd\b[^;&|]*--(?:panic-on|set-default-zone|remove-service=ssh|remove-port=22\b|complete-reload)/, reason: "可能切断 SSH 的 firewalld 操作" },
	{ pattern: /\bsystemctl\s+(?:stop|disable|mask)\s+(?:[\w@.-]+\s+)*(?:firewalld|ufw|nftables|iptables)\b/, reason: "停止防火墙服务" },
	// 作为命令出现的 passwd（不是 /etc/passwd 这样的路径）；-S 只是查看状态
	{ pattern: /(?:^|[;&|(]\s*|\bsudo\s+)passwd\b(?!\s+-S\b)/, reason: "修改用户密码" },
	{ pattern: /\bchpasswd\b/, reason: "批量修改用户密码" },
	{ pattern: /\b(?:userdel|deluser|groupdel)\b/, reason: "删除用户 / 用户组" },
	{ pattern: /\busermod\b[^;&|]*\s-(?:L|-lock|s\s+\S*nologin|-expiredate)\b/, reason: "锁定用户或禁止登录" },
	{ pattern: /\/etc\/(?:passwd|shadow|sudoers|group)\b/, reason: "修改账号 / sudo 配置文件", onlyIfWrites: true },
	{ pattern: /\bvisudo\b/, reason: "修改 sudo 配置" },
	{ pattern: /\.ssh\/authorized_keys/, reason: "修改 authorized_keys（可能影响登录）", onlyIfWrites: true },
	{ pattern: new RegExp(String.raw`\bch(?:mod|own|grp)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*R[a-zA-Z]*\s+(?:\S+\s+)?["']?${CRITICAL_PATHS}["']?${PATH_END}`), reason: "递归修改系统关键目录的权限 / 属主" },
	{ pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork 炸弹" },
	{ pattern: /\b(?:kill|pkill|killall)\s+(?:-\S+\s+)*(?:-1\b|1\b(?!\d)|sshd\b|init\b|systemd\b)/, reason: "结束系统关键进程" },
	{ pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, reason: "下载脚本并直接执行" },
	{ pattern: /\b(?:apt(?:-get)?|yum|dnf|zypper)\s+(?:-\S+\s+)*(?:remove|purge|erase|autoremove)\b[^;&|]*\b(?:openssh|systemd|glibc|libc6|bash|sudo|coreutils|kernel|linux-image|grub)/, reason: "卸载系统核心软件包" },
	{ pattern: /\b(?:crontab\s+-r)\b/, reason: "删除整个 crontab" },
	{ pattern: /\b(?:swapoff\s+-a|umount\s+(?:-\S+\s+)*\/(?:\s|$))/, reason: "卸载根分区 / 关闭全部交换分区" },
	{ pattern: /\bsetenforce\s+0|\bSELINUX=disabled/, reason: "关闭 SELinux" },
	// Windows / PowerShell
	{ pattern: /\b(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|diskpart)\b/i, reason: "格式化 / 清空磁盘" },
	{ pattern: /\b(?:Restart-Computer|Stop-Computer)\b|\bshutdown(?:\.exe)?\s+\/[rsp]\b/i, reason: "重启 / 关机" },
	{ pattern: /\bRemove-Item\b[^;|]*-Recurse[^;|]*\b(?:[A-Za-z]:\\(?:Windows|Program Files|Users)?\\?|\$env:SystemRoot)/i, reason: "递归删除系统目录" },
	{ pattern: /\b(?:netsh\s+advfirewall|Set-NetFirewallProfile|Remove-NetFirewallRule|Disable-NetFirewallRule)\b/i, reason: "修改 Windows 防火墙" },
	{ pattern: /\b(?:Stop-Service|Set-Service)\b[^;|]*\b(?:sshd|WinRM|TermService)\b/i, reason: "停止远程管理服务（可能断开连接）" },
	{ pattern: /\b(?:Remove-LocalUser|Disable-LocalUser|net\s+user\s+\S+\s+\/delete)\b/i, reason: "删除 / 禁用本地用户" },
	{ pattern: /\bSet-LocalUser\b[^;|]*-Password|\bnet\s+user\s+\S+\s+\S+/i, reason: "修改用户密码" },
];

// ---------- 只读规则 ----------

/** 任何参数都只读的命令 */
const READ_ONLY_COMMANDS = new Set([
	"cat", "tac", "head", "tail", "less", "more", "nl", "wc", "grep", "egrep", "fgrep", "rg", "ag", "zcat", "zgrep", "bzcat", "xzcat",
	"ls", "ll", "la", "dir", "tree", "stat", "file", "du", "df", "find", "locate", "which", "whereis", "type", "realpath", "readlink", "basename", "dirname", "pwd",
	"echo", "printf", "true", "false", "test", "[", "date", "cal", "uptime", "uname", "hostname", "hostnamectl", "whoami", "id", "groups", "who", "w", "last", "lastlog", "users",
	"ps", "pgrep", "pstree", "top", "htop", "free", "vmstat", "iostat", "mpstat", "sar", "lsof", "lscpu", "lsblk", "lsmem", "lspci", "lsusb", "lsmod", "blkid", "dmesg", "nproc", "getconf",
	"ss", "netstat", "ping", "traceroute", "tracepath", "mtr", "dig", "nslookup", "host", "arp", "route",
	"env", "printenv", "getent", "ulimit", "locale", "timedatectl", "localectl",
	"md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "diff", "cmp", "comm", "sort", "uniq", "cut", "tr", "column", "jq", "yq", "awk", "sed", "xargs", "tee",
	"journalctl", "systemd-analyze", "loginctl", "getenforce", "sestatus", "nginx", "httpd", "apachectl", "php", "python", "python3", "node", "java", "go", "openssl",
	// PowerShell
	"get-content", "get-childitem", "get-item", "get-itemproperty", "get-process", "get-service", "get-eventlog", "get-winevent", "get-computerinfo", "get-ciminstance", "get-wmiobject",
	"get-netipaddress", "get-netadapter", "get-nettcpconnection", "get-netfirewallrule", "get-volume", "get-disk", "get-psdrive", "get-hotfix", "get-windowsfeature", "get-localuser", "get-acl",
	"test-path", "test-netconnection", "resolve-dnsname", "select-object", "select-string", "where-object", "sort-object", "format-table", "format-list", "measure-object", "out-string", "write-output", "ipconfig", "systeminfo", "tasklist", "whoami.exe", "hostname.exe",
]);

/** 默认只读、但特定参数会写入的命令：返回 true 表示这次调用会写 */
const ARG_WRITERS: Record<string, (args: string[]) => boolean> = {
	sed: (a) => a.some((x) => /^-[a-zA-Z]*i/.test(x) || x.startsWith("--in-place")),
	awk: (a) => a.some((x) => /system\s*\(|print\s*>|-i\s*inplace/.test(x)) || a.includes("inplace"),
	find: (a) => a.some((x) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(x)),
	xargs: () => true, // 执行任意命令
	tee: (a) => a.some((x) => !x.startsWith("-")) && !a.every((x) => x === "/dev/null" || x.startsWith("-")),
	sort: (a) => a.some((x) => x === "-o" || x.startsWith("--output")),
	env: (a) => a.some((x) => !x.includes("=") && !x.startsWith("-")), // env 后跟命令
	date: (a) => a.some((x) => x === "-s" || x.startsWith("--set")),
	hostname: (a) => a.some((x) => !x.startsWith("-")),
	hostnamectl: (a) => a.some((x) => x.startsWith("set-")),
	timedatectl: (a) => a.some((x) => x.startsWith("set-")),
	localectl: (a) => a.some((x) => x.startsWith("set-")),
	nginx: (a) => !(a.includes("-t") || a.includes("-T") || a.includes("-v") || a.includes("-V")),
	httpd: (a) => !(a.includes("-t") || a.includes("-v") || a.includes("-V") || a.includes("-S")),
	apachectl: (a) => !a.some((x) => ["configtest", "-t", "-v", "-V", "-S"].includes(x)),
	php: (a) => !(a.includes("-v") || a.includes("-m") || a.includes("-i") || a.includes("--version")),
	python: (a) => !(a.includes("--version") || a.includes("-V")),
	python3: (a) => !(a.includes("--version") || a.includes("-V")),
	node: (a) => !(a.includes("--version") || a.includes("-v")),
	java: (a) => !(a.includes("-version") || a.includes("--version")),
	go: (a) => !(a[0] === "version" || a[0] === "env"),
	openssl: (a) => !["version", "x509", "s_client", "verify", "ciphers", "req"].includes(a[0] ?? "") || a.includes("-out"),
	top: (a) => !a.includes("-b") && !a.includes("-n"), // 交互式 top 会卡住会话，按「需要确认」处理
	htop: () => true,
	less: () => true,
	more: () => true,
	ping: (a) => !a.some((x) => x === "-c" || /^-c\d+/.test(x)), // 不带 -c 会一直运行
	"get-content": (a) => a.some((x) => /^-wait$/i.test(x)),
	// 持续跟随输出的命令不会自己结束，会卡住会话：按「需要确认」处理
	tail: (a) => a.some((x) => /^-[a-zA-Z]*[fF]/.test(x) || x === "--follow"),
	journalctl: (a) => a.some((x) => /^-[a-zA-Z]*f/.test(x) || x === "--follow") || a.some((x) => x.startsWith("--vacuum") || x === "--rotate" || x === "--flush"),
	watch: () => true,
	dmesg: (a) => a.some((x) => /^-[a-zA-Z]*[wWC]/.test(x) || x === "--follow" || x === "--clear"),
};

/** 子命令决定读写的命令：列出只读的子命令 */
const READ_SUBCOMMANDS: Record<string, (args: string[]) => boolean> = {
	systemctl: (a) => {
		const sub = a.find((x) => !x.startsWith("-"));
		return !sub || ["status", "show", "cat", "list-units", "list-unit-files", "list-timers", "list-sockets", "list-dependencies", "is-active", "is-enabled", "is-failed", "get-default"].includes(sub);
	},
	service: (a) => a[1] === "status" || a[0] === "--status-all",
	docker: (a) => {
		const args = a.filter((x) => !x.startsWith("-"));
		const [sub, sub2] = args;
		const follows = a.some((x) => x === "-f" || x === "--follow");
		if (["ps", "images", "inspect", "version", "info", "port", "diff", "history"].includes(sub ?? "")) return true;
		if (sub === "logs") return !follows;
		// stats / events / top 默认持续输出
		if (sub === "stats") return a.includes("--no-stream");
		if (["container", "image", "volume", "network", "compose", "system", "context", "node", "service"].includes(sub ?? "")) return ["ls", "list", "ps", "inspect", "logs", "df", "config", "images", "top", "port", "version"].includes(sub2 ?? "") && !a.some((x) => x === "-f" || x === "--follow");
		return false;
	},
	"docker-compose": (a) => ["ps", "logs", "config", "images", "top", "version", "ls"].includes(a.find((x) => !x.startsWith("-")) ?? "") && !a.some((x) => x === "-f" || x === "--follow"),
	podman: (a) => ["ps", "images", "logs", "inspect", "stats", "version", "info"].includes(a.find((x) => !x.startsWith("-")) ?? "") && !a.some((x) => x === "-f" || x === "--follow"),
	kubectl: (a) => ["get", "describe", "logs", "top", "version", "explain", "api-resources", "cluster-info"].includes(a.find((x) => !x.startsWith("-")) ?? "") && !a.some((x) => x === "-f" || x === "--follow" || x === "-w" || x === "--watch"),
	git: (a) => ["status", "log", "diff", "show", "branch", "remote", "describe", "rev-parse", "ls-files", "blame", "config"].includes(a.find((x) => !x.startsWith("-")) ?? "") && !(a[0] === "config" && !a.some((x) => ["--get", "--list", "-l", "--get-all"].includes(x))),
	apt: (a) => ["list", "show", "search", "policy", "depends", "rdepends"].includes(a.find((x) => !x.startsWith("-")) ?? ""),
	"apt-cache": () => true,
	dpkg: (a) => a.some((x) => ["-l", "-L", "-s", "-S", "--list", "--listfiles", "--status", "--search", "-p", "--print-architecture"].includes(x)),
	"dpkg-query": () => true,
	yum: (a) => ["list", "info", "search", "provides", "whatprovides", "repolist", "history", "check-update", "deplist"].includes(a.find((x) => !x.startsWith("-")) ?? "") && !a.includes("-y"),
	dnf: (a) => ["list", "info", "search", "provides", "repolist", "history", "check-update", "repoquery", "deplist"].includes(a.find((x) => !x.startsWith("-")) ?? "") && !a.includes("-y"),
	rpm: (a) => a.some((x) => /^-q/.test(x) || x === "--query" || x === "-V" || x === "--verify"),
	snap: (a) => ["list", "info", "find", "version", "services"].includes(a[0] ?? ""),
	pip: (a) => ["list", "show", "freeze", "--version", "check"].includes(a[0] ?? ""),
	pip3: (a) => ["list", "show", "freeze", "--version", "check"].includes(a[0] ?? ""),
	npm: (a) => ["ls", "list", "view", "info", "outdated", "--version", "-v", "config"].includes(a[0] ?? "") && !(a[0] === "config" && a[1] !== "get" && a[1] !== "list"),
	ip: (a) => {
		const sub = a.find((x) => !x.startsWith("-"));
		if (!sub) return true;
		const verb = a[a.indexOf(sub) + 1];
		return !verb || ["show", "list", "ls", "s", "get"].includes(verb);
	},
	ufw: (a) => a[0] === "status" || a[0] === "app" && a[1] === "list",
	"firewall-cmd": (a) => a.every((x) => /^--(?:state|get-|list-|query-|info-|zone=|permanent$)/.test(x)) && a.some((x) => /^--(?:state|get-|list-|query-|info-)/.test(x)),
	iptables: (a) => a.some((x) => /^-[a-zA-Z]*[LS]/.test(x) || x === "--list" || x === "--list-rules") && !a.some((x) => /^-[AIDRFZXNEP]$/.test(x)),
	nft: (a) => a[0] === "list",
	crontab: (a) => a.includes("-l"),
	passwd: (a) => a.includes("-S") || a.includes("--status"),
	chage: (a) => a.includes("-l") || a.includes("--list"),
	mysql: (a) => a.some((x) => x === "--version" || x === "-V"),
	redis: () => false,
	certbot: (a) => a[0] === "certificates",
	sysctl: (a) => !a.some((x) => x.includes("=") || x === "-w" || x === "-p" || x === "--system"),
	mount: (a) => a.length === 0 || a.every((x) => x === "-l" || x.startsWith("-t")),
	"get-command": () => true,
};

// ---------- 解析 ----------

/** 引号外的字符扫描：把命令按 ; && || | 换行 拆成片段，并报告是否有写文件的重定向 / 命令替换 */
function splitSegments(command: string): { segments: string[]; writesRedirect: boolean; substitution: boolean } {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let writesRedirect = false;
	let substitution = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		const next = command[i + 1];
		if (quote) {
			if (ch === quote) quote = null;
			else if (quote === '"' && (ch === "`" || (ch === "$" && next === "("))) substitution = true;
			if (ch === "\\" && quote === '"' && next !== undefined) {
				current += ch + next;
				i++;
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === "\\" && next !== undefined) {
			current += ch + next;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "`" || (ch === "$" && next === "(")) substitution = true;
		if (ch === "<" && next === "(") substitution = true;
		if (ch === ">") {
			// 2>&1、>&2、>/dev/null、2>/dev/null 不算写文件
			const rest = command.slice(i + 1).replace(/^>/, "").trimStart();
			const prevDigit = /\d$/.test(current);
			if (!(rest.startsWith("&") || rest.startsWith("/dev/null") || (prevDigit && rest.startsWith("&")))) writesRedirect = true;
			if (ch === ">" && next === "(") substitution = true;
		}
		if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && next === "&")) {
			if (ch === "&" || (ch === "|" && next === "|")) i++;
			segments.push(current);
			current = "";
			continue;
		}
		if (ch === "&" && next !== ">" && command[i - 1] !== ">") {
			// 后台运行：同样拆段
			segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return { segments: segments.map((s) => s.trim()).filter(Boolean), writesRedirect, substitution };
}

/** 粗略分词：按空白拆开，去掉成对引号 */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
	for (const m of segment.matchAll(re)) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
	return tokens;
}

/** 去掉前置的 sudo / 环境变量赋值 / time / nice 等包装，返回真正执行的命令与参数 */
function unwrap(tokens: string[]): { name: string; args: string[] } | null {
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i] as string;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			i++;
			continue;
		}
		if (t === "sudo") {
			i++;
			while (i < tokens.length && (tokens[i] as string).startsWith("-")) {
				// -u user 这类带值的参数
				if (["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U"].includes(tokens[i] as string)) i++;
				i++;
			}
			continue;
		}
		if (["time", "nice", "ionice", "nohup", "stdbuf", "timeout", "command", "exec", "builtin", "chroot"].includes(t)) {
			i++;
			// timeout 30 / nice -n 10 之类的数值参数
			while (i < tokens.length && /^(?:-\S+|\d+[smhd]?)$/.test(tokens[i] as string)) i++;
			continue;
		}
		break;
	}
	const name = tokens[i];
	if (!name) return null;
	const base = name.replace(/^.*\//, "").toLowerCase();
	return { name: base, args: tokens.slice(i + 1) };
}

function segmentIsReadOnly(segment: string): boolean {
	const parsed = unwrap(tokenize(segment));
	if (!parsed) return true;
	const { name, args } = parsed;
	const sub = READ_SUBCOMMANDS[name];
	if (sub) return sub(args);
	if (!READ_ONLY_COMMANDS.has(name)) return false;
	const writer = ARG_WRITERS[name];
	return !writer || !writer(args);
}

/** 评估一条 shell / PowerShell 命令 */
export function assessCommand(command: string): RiskAssessment {
	const text = command.trim();
	if (!text) return { risk: "read", reasons: [] };
	const { segments, writesRedirect, substitution } = splitSegments(text);
	const writes = writesRedirect || substitution || !segments.every(segmentIsReadOnly);
	const reasons: string[] = [];
	for (const rule of DANGER_RULES) {
		if (rule.onlyIfWrites && !writes) continue;
		if (rule.pattern.test(text) && !reasons.includes(rule.reason)) reasons.push(rule.reason);
	}
	if (reasons.length > 0) return { risk: "danger", reasons };
	return { risk: writes ? "write" : "read", reasons: [] };
}

/** 写入文件的路径是否高危（write / edit 工具） */
export function assessFileWrite(path: string): RiskAssessment {
	const p = path.replace(/\\/g, "/");
	const reasons: string[] = [];
	if (/(?:^|\/)sshd_config(?:$|\.d\/)|\/etc\/ssh\/sshd_config/.test(p)) reasons.push("修改 SSH 服务配置（可能把自己锁在外面）");
	if (/^\/etc\/(?:passwd|shadow|group|gshadow|sudoers)(?:$|\.d\/)/.test(p)) reasons.push("修改账号 / sudo 配置文件");
	if (/\.ssh\/authorized_keys$/.test(p)) reasons.push("修改 authorized_keys（可能影响登录）");
	if (/^\/etc\/(?:fstab|crypttab)$/.test(p)) reasons.push("修改挂载配置（写错会导致无法开机）");
	if (/^\/etc\/(?:selinux\/config|sysconfig\/iptables|iptables\/rules\.v[46]|nftables\.conf|ufw\/)/.test(p)) reasons.push("修改防火墙 / SELinux 配置");
	if (/^\/boot\/|^\/etc\/default\/grub$/.test(p)) reasons.push("修改引导配置");
	return reasons.length > 0 ? { risk: "danger", reasons } : { risk: "write", reasons: [] };
}

/** 运维会话中的工具调用评估：bash / powershell 看命令，write / edit 看路径，read 只读 */
export function assessToolCall(toolName: string, input: unknown): RiskAssessment {
	const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	if (toolName === "bash" || toolName === "powershell") return assessCommand(typeof args.command === "string" ? args.command : "");
	if (toolName === "write" || toolName === "edit") return assessFileWrite(typeof args.path === "string" ? args.path : "");
	if (toolName === "read") return { risk: "read", reasons: [] };
	return { risk: "write", reasons: [] };
}
