/**
 * 开发辅助：在隔离后端（out/ 下的临时数据目录与空闲端口，不碰 ~/.flowork）测试项目注册表接口。
 *   node scripts/test-projects.mjs（需先 npm run build:web）
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect, createChecks, installRelayFromEnv, startIsolatedBackend } from "./lib/isolated-backend.mjs";

async function main(checks) {
	const backend = await startIsolatedBackend({ label: "projects" });
	const base = join(backend.root, "fixtures");
	const a = join(base, "alpha");
	const b = join(base, "beta");
	const seed = join(base, "seed");
	for (const dir of [a, b, seed]) mkdirSync(dir, { recursive: true });
	let client;
	const ids = [];
	let groupId;
	try {
		client = await connect(await backend.waitReady());
		// 预置一个项目，让「测试前已有项目未受影响」不是空集合
		await client.call("projects.add", { paths: [seed] });
		const pushStart = client.pushes.length;
		const before = await client.call("projects.get");
		const added = await client.call("projects.add", { paths: [a, b, a.toUpperCase(), join(base, "missing")] });
		ids.push(...added.added.map((p) => p.id));
		checks.check("导入 2 个，跳过重复与不存在的路径", added.added.length === 2 && added.skipped.length === 2);
		const g = await client.call("projects.groupCreate", { name: "工作" });
		groupId = g.group.id;
		let s = await client.call("projects.move", { ids: [ids[1], ids[0]], pinned: false, groupId });
		const inGroup = s.projects.filter((p) => p.groupId === groupId).sort((x, y) => x.order - y.order);
		checks.check("拖入分组并按顺序排列", inGroup.map((p) => p.id).join() === [ids[1], ids[0]].join());
		s = await client.call("projects.update", { id: ids[0], patch: { name: "我的 Alpha", pinned: true } });
		const pa = s.projects.find((p) => p.id === ids[0]);
		checks.check("重命名与置顶", pa.name === "我的 Alpha" && pa.pinned === true && pa.groupId === groupId);
		s = await client.call("projects.update", { id: ids[0], patch: { name: "alpha" } });
		checks.check("名称与文件夹名相同时清除自定义名", s.projects.find((p) => p.id === ids[0]).name === undefined);
		s = await client.call("projects.groupRemove", { id: groupId });
		groupId = undefined;
		checks.check("删除分组后项目回到未分组", s.projects.filter((p) => ids.includes(p.id)).every((p) => !p.groupId));
		rmSync(b, { recursive: true });
		s = await client.call("projects.get");
		checks.check("文件夹被删除时标记 missing", s.projects.find((p) => p.id === ids[1]).missing === true);
		checks.check(
			"所有修改都推送了 projects_changed",
			client.pushes.slice(pushStart).filter((p) => p.type === "projects_changed").length >= 5,
		);
		checks.check(
			"测试前已有项目未受影响",
			before.projects.length === 1 && before.projects.every((p) => s.projects.some((q) => q.id === p.id)),
		);
	} finally {
		for (const id of ids) await client?.call("projects.remove", { id }).catch(() => undefined);
		if (groupId) await client?.call("projects.groupRemove", { id: groupId }).catch(() => undefined);
		await client?.close();
		await backend.stop();
	}
}

const checks = createChecks();
if (!installRelayFromEnv()) await main(checks).then(
	() => checks.finish("PROJECTS REGRESSION OK（隔离后端；未调用模型）"),
	(error) => {
		console.error(`PROJECTS REGRESSION FAILED\n${error?.stack ?? error}`);
		process.exitCode = 1;
	},
);
