/**
 * 主机密钥（host key）变化的检测与处理。
 *
 * 服务器重装系统或换了机器后，ssh 会因 known_hosts 里的旧指纹拒绝连接（StrictHostKeyChecking）。
 * 这里提供：
 * - inspectHostKey：取出 known_hosts 里记录的旧指纹，并让 ssh 连一次（不认证）取服务器当前的指纹，交给界面让用户比对；
 * - acceptHostKey：用户确认后，ssh-keygen -R 删除旧记录（ssh-keygen 自己会备份为 known_hosts.old），
 *   再把刚才扫描到、且与用户看到的指纹一致的新公钥写回 known_hosts。
 *
 * 只写入用户确认过的那把公钥：如果确认前后扫描结果不同（指纹又变了），拒绝写入，避免确认的是 A 却信任了 B。
 * 主机名、端口与 known_hosts 路径用 `ssh -G` 解析，因此 ~/.ssh/config 里的别名、Port、UserKnownHostsFile 都生效。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HostKeyEntry, HostKeyReport, SshHost } from "@shared/protocol";
import { sshBinary, sshConfigArgs } from "./ssh";

/** ssh 报错里是否是「主机密钥变化」 */
export function isHostKeyChangedError(text: string): boolean {
	return /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Host key for .* has changed/i.test(text);
}

/** 与 ssh.exe 同目录的工具（ssh-keygen / ssh-keyscan） */
function sshTool(name: "ssh-keygen"): string {
	const ssh = sshBinary();
	if (ssh) {
		const ext = process.platform === "win32" ? ".exe" : "";
		const candidate = join(dirname(ssh), name + ext);
		if (existsSync(candidate)) return candidate;
	}
	return name;
}

function run(command: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${command} 超时`));
		}, timeoutMs);
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

interface Resolved {
	hostname: string;
	port: number;
	/** known_hosts 中的主机标记：端口 22 为 host，否则为 [host]:port */
	pattern: string;
	knownHostsFiles: string[];
}

/** 用 ssh -G 解析实际连接参数（不会真正连接） */
async function resolveTarget(host: SshHost): Promise<Resolved> {
	const ssh = sshBinary();
	if (!ssh) throw new Error("未找到 ssh 可执行文件");
	const args = [...sshConfigArgs(), "-G"];
	if (host.port) args.push("-p", String(host.port));
	args.push(host.user ? `${host.user}@${host.host}` : host.host);
	const { stdout } = await run(ssh, args);
	const pick = (key: string) => stdout.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${key} `))?.slice(key.length + 1).trim();
	const hostname = pick("hostname") || host.host;
	const port = Number(pick("port")) || host.port || 22;
	const alias = pick("hostkeyalias");
	const base = alias || hostname;
	const pattern = port === 22 ? base : `[${base}]:${port}`;
	const files = (pick("userknownhostsfile") ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.map((f) => f.replace(/^~(?=[/\\])/, homedir()));
	return { hostname, port, pattern, knownHostsFiles: files.length ? files : [join(homedir(), ".ssh", "known_hosts")] };
}

/** OpenSSH 风格的 SHA256 指纹 */
function fingerprint(base64Key: string): string {
	const digest = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("base64").replace(/=+$/, "");
	return `SHA256:${digest}`;
}

function parseKeyLine(line: string): { type: string; key: string } | null {
	const parts = line.trim().split(/\s+/);
	// known_hosts：[@marker] hosts type key [comment]；keyscan：host type key
	const idx = parts[0]?.startsWith("@") ? 2 : 1;
	const type = parts[idx];
	const key = parts[idx + 1];
	if (!type || !key || !/^(ssh-|ecdsa-|sk-)/.test(type)) return null;
	return { type, key };
}

/** known_hosts 中这台主机已记录的公钥（ssh-keygen -F 能匹配哈希过的主机名） */
async function knownEntries(r: Resolved): Promise<HostKeyEntry[]> {
	const keygen = sshTool("ssh-keygen");
	const out: HostKeyEntry[] = [];
	for (const file of r.knownHostsFiles) {
		if (!existsSync(file)) continue;
		const { stdout } = await run(keygen, ["-F", r.pattern, "-f", file]).catch(() => ({ stdout: "" }));
		for (const line of stdout.split(/\r?\n/)) {
			if (!line || line.startsWith("#")) continue;
			const parsed = parseKeyLine(line);
			if (parsed) out.push({ type: parsed.type, fingerprint: fingerprint(parsed.key), file });
		}
	}
	return out;
}

/**
 * 取服务器当前公钥。
 * 不用 ssh-keyscan：Windows 自带的 ssh-keyscan 不支持部分新的密钥交换算法（sntrup761x25519），会直接失败。
 * 改为让 ssh 本身连一次：指向临时的空 known_hosts、StrictHostKeyChecking=accept-new、不做任何认证，
 * ssh 会把服务器出示的公钥写进临时文件——与真实连接时校验的是同一把。每种类型各连一次以取全。
 */
async function scan(r: Resolved): Promise<Array<{ type: string; key: string }>> {
	const ssh = sshBinary();
	if (!ssh) throw new Error("未找到 ssh 可执行文件");
	const dir = await mkdtemp(join(tmpdir(), "flowork-hostkey-"));
	try {
		const keys: Array<{ type: string; key: string }> = [];
		let lastError = "";
		for (const algo of ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512,rsa-sha2-256,ssh-rsa"]) {
			const file = join(dir, `kh-${keys.length}-${algo.split(",")[0]}`);
			await writeFile(file, "");
			const { stderr } = await run(ssh, [
				...sshConfigArgs(),
				"-o", `UserKnownHostsFile=${file}`,
				"-o", `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
				"-o", "StrictHostKeyChecking=accept-new",
				"-o", "BatchMode=yes",
				"-o", "PreferredAuthentications=none",
				"-o", `HostKeyAlgorithms=${algo}`,
				"-o", "ConnectTimeout=10",
				"-o", "LogLevel=ERROR",
				"-p", String(r.port),
				`flowork-hostkey-probe@${r.hostname}`,
				"true",
			], 25_000).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
			const content = await readFile(file, "utf8").catch(() => "");
			const parsed = content.split(/\r?\n/).map(parseKeyLine).find((k) => k);
			// rsa 的签名算法名不同，known_hosts 里都记为 ssh-rsa
			if (parsed && !keys.some((k) => k.key === parsed.key)) keys.push(parsed);
			else if (!parsed) lastError = stderr.trim();
		}
		if (keys.length === 0) throw new Error(`无法获取服务器的主机密钥：${lastError || "没有响应"}`);
		return keys;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function inspectHostKey(host: SshHost): Promise<HostKeyReport> {
	const r = await resolveTarget(host);
	const [known, current] = await Promise.all([knownEntries(r), scan(r)]);
	const currentEntries = current.map((k) => ({ type: k.type, fingerprint: fingerprint(k.key) }));
	// 同一类型的指纹不同才算「变化」；只是多了新类型的 key 不算
	const changed = known.some((k) => currentEntries.some((c) => c.type === k.type && c.fingerprint !== k.fingerprint));
	return { hostId: host.id, target: r.pattern, known, current: currentEntries, changed };
}

/**
 * 用户确认后更新：删除这台主机的全部旧记录，写入扫描到的公钥。
 * expected 是用户在界面上看到并确认的指纹；重新扫描后必须仍包含它，否则拒绝。
 */
export async function acceptHostKey(host: SshHost, expected: string[]): Promise<{ removedFrom: string[] }> {
	if (expected.length === 0) throw new Error("没有可确认的指纹");
	const r = await resolveTarget(host);
	const current = await scan(r);
	const matched = current.filter((k) => expected.includes(fingerprint(k.key)));
	if (matched.length === 0) throw new Error("服务器的指纹与刚才确认的不一致（可能又发生了变化），已取消更新，请重新检查");

	const keygen = sshTool("ssh-keygen");
	const removedFrom: string[] = [];
	for (const file of r.knownHostsFiles) {
		if (!existsSync(file)) continue;
		const before = await readFile(file, "utf8").catch(() => "");
		const { code, stderr } = await run(keygen, ["-R", r.pattern, "-f", file]);
		if (code !== 0) throw new Error(`删除旧记录失败：${stderr.trim()}`);
		const after = await readFile(file, "utf8").catch(() => "");
		if (after !== before) removedFrom.push(file);
	}
	const target = r.knownHostsFiles[0] as string;
	const lines = matched.map((k) => `${r.pattern} ${k.type} ${k.key}`).join("\n");
	const existing = existsSync(target) ? await readFile(target, "utf8") : "";
	await appendFile(target, `${existing && !existing.endsWith("\n") ? "\n" : ""}${lines}\n`, "utf8");
	return { removedFrom };
}
