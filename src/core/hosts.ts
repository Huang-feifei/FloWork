/**
 * SSH 主机注册表：保存在 ~/.flowork/hosts.json。
 *
 * 只记录连接参数，不保存会话。
 *
 * 口令：外壳提供 SecretCodec（桌面版用 Electron safeStorage，即 Windows DPAPI 等系统加密）时，
 * 落盘为 passwordEnc（"enc:v1:" + base64 密文），旧的明文 password 在读取后自动迁移；
 * 没有 codec（网页版）时仍以明文存放。桌面版加密过的口令，网页版无法解密，需要在网页版重新填写。
 * 内存里只用解密后的 password；解密失败的密文原样保留，避免把用户数据写丢。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SshHost, SshHostInput } from "@shared/protocol";
import { getFloworkDataDir } from "./paths";

/** 外壳提供的系统级加密；encrypt 的输出与 decrypt 的输入都是 base64 文本 */
export interface SecretCodec {
	available(): boolean;
	encrypt(plain: string): string;
	decrypt(cipherBase64: string): string;
}

const ENC_PREFIX = "enc:v1:";

/** 内存中的主机：passwordEnc 只在密文无法解密时保留 */
type StoredHost = SshHost & { passwordEnc?: string };

interface StoredState {
	version: 1;
	hosts: StoredHost[];
}

function publicHost(host: StoredHost): SshHost {
	const { passwordEnc: _enc, ...rest } = host;
	return { ...rest };
}

/** 去掉用户可能误填的空白与协议前缀（例如从 ssh:// 或 scp 命令里粘过来） */
function cleanHost(raw: string): string {
	return raw.trim().replace(/^ssh:\/\//i, "").replace(/\/+$/, "");
}

function normalizeInput(input: SshHostInput): SshHostInput {
	const host = cleanHost(input.host);
	if (!host) throw new Error("请填写主机地址");
	if (/[@\s]/.test(host)) throw new Error("主机地址里不要带 user@ 或空格，请填到「用户名」一栏");
	const port = input.port ? Number(input.port) : undefined;
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("端口需在 1-65535 之间");
	const auth = input.auth ?? "agent";
	if (auth === "key" && !input.keyPath?.trim()) throw new Error("请选择私钥文件");
	return {
		...input,
		host,
		port,
		user: input.user?.trim() || undefined,
		name: input.name?.trim() || undefined,
		keyPath: auth === "key" ? input.keyPath?.trim() : undefined,
		password: auth === "password" ? input.password : undefined,
		defaultPath: input.defaultPath?.trim() || undefined,
	};
}

export class HostStore {
	private state: StoredState | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly file = join(getFloworkDataDir(), "hosts.json"),
		private readonly secrets?: SecretCodec,
	) {}

	private canEncrypt(): boolean {
		try {
			return !!this.secrets?.available();
		} catch {
			return false;
		}
	}

	/** 把磁盘上的一条记录还原成内存形态；返回是否需要迁移（明文口令待加密） */
	private revive(host: StoredHost): boolean {
		const enc = host.passwordEnc;
		// 加密不可用（例如 Electron 尚未 ready）时不尝试解密，密文原样保留
		if (enc?.startsWith(ENC_PREFIX) && this.secrets && this.canEncrypt()) {
			try {
				host.password = this.secrets.decrypt(enc.slice(ENC_PREFIX.length));
				delete host.passwordEnc;
			} catch {
				// 解密失败（换了系统用户 / 机器）：保留密文，不覆盖
			}
			return false;
		}
		return !!host.password && !host.passwordEnc && this.canEncrypt();
	}

	private async load(): Promise<StoredState> {
		if (this.state) return this.state;
		let migrate = false;
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoredState>;
			const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
			// 每条都要执行 revive，不能用 some() 短路
			for (const host of hosts) if (this.revive(host)) migrate = true;
			this.state = { version: 1, hosts };
		} catch {
			this.state = { version: 1, hosts: [] };
		}
		// 已有的明文口令立即改写为密文
		if (migrate) await this.persist().catch(() => undefined);
		return this.state;
	}

	/** 落盘形态：能加密时口令只以密文出现 */
	private serialize(host: StoredHost): StoredHost {
		const { password, passwordEnc, ...rest } = host;
		if (password) {
			if (this.secrets && this.canEncrypt()) return { ...rest, passwordEnc: ENC_PREFIX + this.secrets.encrypt(password) };
			return { ...rest, password };
		}
		return passwordEnc ? { ...rest, passwordEnc } : rest;
	}

	private async persist(): Promise<void> {
		if (!this.state) return;
		await mkdir(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		const onDisk = { version: 1, hosts: this.state.hosts.map((h) => this.serialize(h)) };
		await writeFile(tmp, `${JSON.stringify(onDisk, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(tmp, this.file);
	}

	private mutate<T>(fn: (state: StoredState) => T): Promise<T> {
		const run = this.queue.then(async () => {
			const state = await this.load();
			const result = fn(state);
			await this.persist();
			return result;
		});
		this.queue = run.catch(() => undefined);
		return run;
	}

	async list(): Promise<SshHost[]> {
		return (await this.load()).hosts.map(publicHost);
	}

	async get(id: string): Promise<SshHost | undefined> {
		const host = (await this.load()).hosts.find((h) => h.id === id);
		if (!host) return undefined;
		return publicHost(host);
	}

	/** 取主机并确保存在，找不到时抛出可读错误 */
	async require(id: string): Promise<SshHost> {
		const host = await this.get(id);
		if (!host) throw new Error("主机不存在，可能已被删除");
		if (host.auth === "password" && !host.password) {
			const locked = (await this.load()).hosts.find((h) => h.id === id)?.passwordEnc;
			if (locked) throw new Error("该主机的密码由桌面版加密保存，当前环境无法解密，请在主机设置里重新填写密码");
		}
		return host;
	}

	add(input: SshHostInput) {
		return this.mutate((state) => {
			const host: SshHost = { id: randomUUID(), createdAt: Date.now(), ...normalizeInput(input) };
			state.hosts.push(host);
			return publicHost(host);
		});
	}

	update(id: string, patch: Partial<SshHostInput>) {
		return this.mutate((state) => {
			const host = state.hosts.find((h) => h.id === id);
			if (!host) throw new Error("主机不存在");
			const { passwordEnc: _enc, ...current } = host;
			const merged = normalizeInput({ ...current, ...patch } as SshHostInput);
			Object.assign(host, merged);
			// 换了认证方式或填了新口令：旧密文作废
			if (merged.auth !== "password" || merged.password) delete host.passwordEnc;
			return publicHost(host);
		});
	}

	remove(id: string) {
		return this.mutate((state) => {
			state.hosts = state.hosts.filter((h) => h.id !== id);
		});
	}

	/** 连接测试后记录探测到的平台 */
	setPlatform(id: string, platform: SshHost["platform"]) {
		return this.mutate((state) => {
			const host = state.hosts.find((h) => h.id === id);
			if (host) host.platform = platform;
		});
	}
}
