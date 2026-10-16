/**
 * 运维会话开始时探测一次主机画像：发行版、包管理器、init、资源、常见服务、防火墙。
 * 结果写进系统提示词，也显示在会话头部。一次 SSH 调用完成，任何一项失败都不影响其余项。
 */
import type { HostProfile, SshHost } from "@shared/protocol";
import { sshRun } from "./ssh";

const SCRIPT = String.raw`
kv() { printf '%s\t%s\n' "$1" "$2"; }
if [ -r /etc/os-release ]; then . /etc/os-release; kv os "$PRETTY_NAME"; kv os_id "$ID"; kv os_like "$ID_LIKE"; else kv os "$(uname -s) $(uname -r)"; fi
kv kernel "$(uname -r) $(uname -m)"
kv hostname "$(hostname 2>/dev/null)"
kv user "$(id -un 2>/dev/null) (uid $(id -u 2>/dev/null))"
for pm in apt-get dnf yum zypper apk pacman; do if command -v $pm >/dev/null 2>&1; then kv package_manager "$pm"; break; fi; done
if [ -d /run/systemd/system ]; then kv init systemd; elif command -v rc-service >/dev/null 2>&1; then kv init openrc; else kv init "sysvinit/other"; fi
kv cpu "$(nproc 2>/dev/null) cores"
kv memory "$(free -h 2>/dev/null | awk '/^Mem:/{print $2" total, "$7" available"}')"
kv disk_root "$(df -h / 2>/dev/null | awk 'NR==2{print $2" total, "$4" free ("$5" used)"}')"
fw=""
command -v ufw >/dev/null 2>&1 && fw="$fw ufw($(ufw status 2>/dev/null | head -1 | awk '{print $2}'))"
command -v firewall-cmd >/dev/null 2>&1 && fw="$fw firewalld($(firewall-cmd --state 2>/dev/null || echo not-running))"
command -v nft >/dev/null 2>&1 && fw="$fw nftables"
command -v iptables >/dev/null 2>&1 && fw="$fw iptables"
kv firewall "\${fw# }"
command -v getenforce >/dev/null 2>&1 && kv selinux "$(getenforce 2>/dev/null)"
svc=""
for s in docker containerd nginx httpd apache2 mysqld mariadb mysql postgresql redis-server redis mongod php-fpm caddy k3s kubelet; do
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$s.service" >/dev/null 2>&1 && systemctl list-unit-files "$s.service" 2>/dev/null | grep -q "^$s"; then
    svc="$svc $s($(systemctl is-active "$s" 2>/dev/null))"
  fi
done
kv services "\${svc# }"
tools=""
for t in docker podman git curl wget python3 node java go nginx; do command -v $t >/dev/null 2>&1 && tools="$tools $t"; done
kv tools "\${tools# }"
kv shell "$(basename "\${SHELL:-sh}")"
`;

export async function probeHostProfile(host: SshHost): Promise<HostProfile> {
	const out = await sshRun(host, SCRIPT.replace(/\\\$\{/g, "${"), { timeoutMs: 30_000 });
	const facts: Record<string, string> = {};
	for (const line of out.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		const key = line.slice(0, tab).trim();
		const value = line.slice(tab + 1).trim();
		if (key && value) facts[key] = value;
	}
	return { facts, probedAt: Date.now() };
}
