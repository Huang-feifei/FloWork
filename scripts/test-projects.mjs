/**
 * 开发辅助：对运行中的后端测试项目注册表接口。会临时创建两个目录并在结束时清理（包括从项目列表中移除）。
 *   node scripts/test-projects.mjs
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const port = Number(process.env.FLOWORK_PORT ?? 17321);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
let seq = 0;
const pending = new Map();
let pushes = 0;
ws.on("message", (data) => {
	const f = JSON.parse(String(data));
	if (f.push?.type === "projects_changed") pushes++;
	if (!f.id) return;
	const p = pending.get(f.id);
	pending.delete(f.id);
	f.ok ? p.resolve(f.result) : p.reject(new Error(f.error));
});
const call = (method, params) =>
	new Promise((resolve, reject) => {
		const id = String(++seq);
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
const check = (label, cond) => console.log(`${cond ? "✓" : "✗"} ${label}`);

ws.on("open", async () => {
	const base = join(tmpdir(), `flowork-projects-test-${Date.now()}`);
	const a = join(base, "alpha");
	const b = join(base, "beta");
	mkdirSync(a, { recursive: true });
	mkdirSync(b, { recursive: true });
	const ids = [];
	let groupId;
	try {
		const before = await call("projects.get");
		const added = await call("projects.add", { paths: [a, b, a.toUpperCase(), join(base, "missing")] });
		ids.push(...added.added.map((p) => p.id));
		check("导入 2 个，跳过重复与不存在的路径", added.added.length === 2 && added.skipped.length === 2);
		const g = await call("projects.groupCreate", { name: "工作" });
		groupId = g.group.id;
		let s = await call("projects.move", { ids: [ids[1], ids[0]], pinned: false, groupId });
		const inGroup = s.projects.filter((p) => p.groupId === groupId).sort((x, y) => x.order - y.order);
		check("拖入分组并按顺序排列", inGroup.map((p) => p.id).join() === [ids[1], ids[0]].join());
		s = await call("projects.update", { id: ids[0], patch: { name: "我的 Alpha", pinned: true } });
		const pa = s.projects.find((p) => p.id === ids[0]);
		check("重命名与置顶", pa.name === "我的 Alpha" && pa.pinned === true && pa.groupId === groupId);
		s = await call("projects.update", { id: ids[0], patch: { name: "alpha" } });
		check("名称与文件夹名相同时清除自定义名", s.projects.find((p) => p.id === ids[0]).name === undefined);
		s = await call("projects.groupRemove", { id: groupId });
		groupId = undefined;
		check("删除分组后项目回到未分组", s.projects.filter((p) => ids.includes(p.id)).every((p) => !p.groupId));
		rmSync(b, { recursive: true });
		s = await call("projects.get");
		check("文件夹被删除时标记 missing", s.projects.find((p) => p.id === ids[1]).missing === true);
		check("所有修改都推送了 projects_changed", pushes >= 5);
		check("测试前已有项目未受影响", before.projects.every((p) => s.projects.some((q) => q.id === p.id)));
	} catch (e) {
		console.error("测试失败：", e.message);
	} finally {
		for (const id of ids) await call("projects.remove", { id }).catch(() => undefined);
		if (groupId) await call("projects.groupRemove", { id: groupId }).catch(() => undefined);
		rmSync(base, { recursive: true, force: true });
		ws.close();
	}
});
