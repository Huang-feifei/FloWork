/** 一次性生成发行密钥。私钥只放在忽略目录或 GitHub Actions Secret，不能随应用分发。 */
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(import.meta.dirname, "../.kernel-keys");
await mkdir(directory, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
await writeFile(resolve(directory, "signing-private.pem"), privateKey, { flag: "wx", mode: 0o600 });
await writeFile(resolve(directory, "signing-public.pem"), publicKey, { flag: "wx" });
console.log(`私钥已写入 ${directory}/signing-private.pem（请安全备份，不要提交）`);
console.log("将以下 publicKey 值写入 kernel.config.json：");
console.log(JSON.stringify(publicKey));
