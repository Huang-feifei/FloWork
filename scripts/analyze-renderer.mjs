/** 可复现的 renderer 依赖体积报告：构建布局不变，按最终 chunk 字节数和模块贡献分别统计。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const r = spawnSync("npm", ["run", "build"], { cwd: root, env: { ...process.env, FLOWORK_ANALYZE: "1" }, stdio: "inherit", shell: process.platform === "win32" });
assert.equal(r.status, 0, "构建失败");
const chunks = JSON.parse(readFileSync(resolve(root, "out/renderer/bundle-analysis.json"), "utf8"));
console.table(chunks.slice(0, 8).map(c => ({ file:c.file, bytes:c.bytes, entry:c.entry, dynamicEntry:c.dynamicEntry })));
console.log("最大 chunk 的模块贡献（构建器 renderedLength，非 gzip，不能直接当作最终压缩后占比）：");
console.table(chunks[0].modules.slice(0, 12));
console.log("完整报告：out/renderer/bundle-analysis.json");
