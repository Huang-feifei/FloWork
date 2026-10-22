/**
 * 回归：运维会话的后端链路（隔离后端，不调用模型）。
 *   node scripts/test-ops-session.mjs（需先 npm run build && npm run build:test）
 *
 * 需要测试主机（与 test-ops-tools.mjs 相同的环境变量；只用第一台），未设置时跳过：
 *   FLOWORK_TEST_SSH="127.0.0.1:2222"  FLOWORK_TEST_SSH_PASSWORD="..."  [FLOWORK_TEST_SSH_USER=root]
 *
 * 覆盖：添加主机 → 添加远程项目 → 打开会话（worker 拿到占位 cwd，界面看到远程路径）→ 主机画像推送 →
 * 会话列表按远程项目归档 → 远程终端用密码登录。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, createChecks, deadline, startIsolatedBackend } from "./lib/isolated-backend.mjs";
import { startMockOpenAI } from "./lib/mock-openai.mjs";
import { reportSkip } from "./lib/test-results.mjs";

const spec = (process.env.FLOWORK_TEST_SSH ?? "").split(",")[0]?.trim();

async function main(checks) {
	const [hostName, port] = spec.split(":");
	// 模拟模型：第一轮依次发出「只读命令」「改动命令」「高危命令」「写配置文件」，第二轮结束
	const mock = await startMockOpenAI([
		{ toolCalls: [{ name: "bash", arguments: { command: "cat /etc/os-release | head -1; df -h / | tail -1" } }] },
		{ toolCalls: [{ name: "bash", arguments: { command: "mkdir -p /tmp/flowork-ops-session && echo created" } }] },
		{ toolCalls: [{ name: "bash", arguments: { command: "systemctl stop sshd" } }] },
		{ toolCalls: [{ name: "write", arguments: { path: "/tmp/flowork-ops-session/app.conf", content: "listen 80;\n" } }] },
		{ toolCalls: [{ name: "edit", arguments: { path: "/tmp/flowork-ops-session/app.conf", edits: [{ oldText: "listen 80;", newText: "listen 8080;" }] } }] },
		{ text: "完成" },
	]);
	const backend = await startIsolatedBackend({ label: "ops" });
	let client;
	let handleId;
	let terminalId;
	try {
		const agentDir = process.env.FLOWORK_PI_AGENT_DIR;
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: mock.url, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-1", contextWindow: 32000, maxTokens: 2000 }] } } }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-1", packages: [], skills: [], prompts: [], extensions: [] }));
		client = await connect(await backend.waitReady());
		const { host } = await client.call("hosts.add", {
			host: hostName,
			port: port ? Number(port) : undefined,
			user: process.env.FLOWORK_TEST_SSH_USER ?? "root",
			auth: "password",
			password: process.env.FLOWORK_TEST_SSH_PASSWORD,
		});
		const test = await client.call("hosts.test", { id: host.id });
		checks.check(`连接测试（密码登录，无需 sshpass）：${test.ok ? test.platform : test.error}`, test.ok === true);

		const added = await client.call("projects.addRemote", { hostId: host.id, path: "/root" });
		const addedProject = added.state.projects.find((p) => p.hostId === host.id && p.path === "/root");
		checks.check("远程项目不被标记为 missing（不用本地 existsSync 判断服务器路径）", addedProject?.missing === false);
		// projects.addRemote 返回的 project 字段应是项目本身
		checks.check("projects.addRemote 返回的 project 是项目对象", added.project?.path === "/root" && added.project?.hostId === host.id);

		const opened = await client.call("session.open", { cwd: "/root" });
		handleId = opened.handleId;
		checks.check("打开运维会话：state.cwd 为远程路径", opened.state.cwd === "/root");
		checks.check("打开运维会话：state.ops 带主机信息", opened.state.ops?.hostId === host.id && opened.state.ops.remoteCwd === "/root");
		checks.check("运维会话没有项目信任横幅", !opened.state.trust);

		// 主机画像在后台探测，完成后推送 session_changed
		const profiled = await deadline(
			(async () => {
				for (;;) {
					const push = client.pushes.find((p) => p.type === "session_event" && p.handleId === handleId && p.event.type === "session_changed" && p.event.state.ops?.profile);
					if (push) return push.event.state;
					await new Promise((r) => setTimeout(r, 200));
				}
			})(),
			"主机画像推送",
			30_000,
		);
		checks.check(`主机画像推送：${profiled.ops.profile.facts.os}`, !!profiled.ops.profile.facts.os && profiled.cwd === "/root");

		const state = await client.call("session.send", { handleId, command: { type: "get_state" } });
		checks.check("get_state 同样返回远程路径", state.cwd === "/root" && !!state.ops);

		const fresh = await client.call("session.send", { handleId, command: { type: "new_session" } });
		checks.check("新建会话后仍是运维会话", fresh.cwd === "/root" && fresh.ops?.hostId === host.id);

		// ---- 一轮完整的运维对话（模拟模型）：审批模式 ask_writes ----
		const waitPush = (pred, label, ms = 30_000) =>
			deadline(
				(async () => {
					for (;;) {
						const hit = client.pushes.find((p, i) => !seen.has(i) && p.type === "session_event" && p.handleId === handleId && pred(p.event) && seen.add(i));
						if (hit) return hit.event;
						await new Promise((r) => setTimeout(r, 100));
					}
				})(),
				label,
				ms,
			);
		const seen = new Set();
		await client.call("session.send", { handleId, command: { type: "set_approval_mode", mode: "ask_writes" } });
		await client.call("session.send", { handleId, command: { type: "prompt", message: "检查一下服务器并做些配置" } });

		// 1. 只读命令：自动执行，不弹审批
		const readEnd = await waitPush((e) => e.type === "tool_execution_end" || e.type === "approval_request", "只读命令执行");
		checks.check("只读命令自动执行（不弹审批）", readEnd.type === "tool_execution_end");
		checks.check("只读命令在服务器上执行", /Ubuntu|Rocky|NAME/.test(JSON.stringify(readEnd)));

		// 2. 改动命令：弹审批（普通级别），允许后执行
		const writeReq = await waitPush((e) => e.type === "approval_request", "改动命令审批");
		checks.check("改动命令弹出审批，风险为 write", writeReq.risk?.level === "write" && /mkdir/.test(JSON.stringify(writeReq.args)));
		await client.call("session.send", { handleId, command: { type: "respond_approval", toolCallId: writeReq.toolCallId, decision: "allow" } });
		const writeEnd = await waitPush((e) => e.type === "tool_execution_end", "改动命令执行");
		checks.check("允许后改动命令执行", /created/.test(JSON.stringify(writeEnd)));

		// 3. 高危命令：红色审批，带原因；即使先切到「全部自动」也不会被放行；拒绝后不执行
		const dangerReq = await waitPush((e) => e.type === "approval_request", "高危命令审批");
		checks.check(`高危命令弹出审批：${dangerReq.risk?.reasons?.join("；")}`, dangerReq.risk?.level === "danger" && dangerReq.risk.reasons.length > 0);
		await client.call("session.send", { handleId, command: { type: "set_approval_mode", mode: "auto" } });
		await new Promise((r) => setTimeout(r, 500));
		checks.check("切到「全部自动」不会放行等待中的高危命令", !client.pushes.some((p) => p.type === "session_event" && p.event.type === "approval_resolved" && p.event.toolCallId === dangerReq.toolCallId));
		await client.call("session.send", { handleId, command: { type: "respond_approval", toolCallId: dangerReq.toolCallId, decision: "deny" } });
		const dangerEnd = await waitPush((e) => e.type === "tool_execution_end", "高危命令结果");
		checks.check("拒绝后高危命令未执行（结果为拒绝原因）", dangerEnd.isError === true && /拒绝/.test(JSON.stringify(dangerEnd)));

		// 4. 「全部自动」模式下：写文件与编辑自动执行；编辑已有文件时生成备份
		const writeFile = await waitPush((e) => e.type === "tool_execution_end" || e.type === "approval_request", "写文件");
		checks.check("全部自动模式下 write 自动执行", writeFile.type === "tool_execution_end" && !writeFile.isError);
		const editFile = await waitPush((e) => e.type === "tool_execution_end" || e.type === "approval_request", "编辑文件");
		const editText = JSON.stringify(editFile);
		checks.check("edit 结果带远程路径与备份路径", editFile.type === "tool_execution_end" && editText.includes("/tmp/flowork-ops-session/app.conf") && /flowork-bak-/.test(editText));
		await waitPush((e) => e.type === "agent_end" || e.type === "agent_settled", "一轮结束");

		// 工具结果确实送回了模型；系统提示词里有远程信息与主机画像
		const system = JSON.stringify(mock.requests[0]?.messages?.filter((m) => m.role === "system" || m.role === "developer") ?? []);
		checks.check("系统提示词：远程主机、运维守则与主机画像", /operating a remote server over SSH/.test(system) && /package_manager/.test(system) && /Operations rules/.test(system));
		const tools = (mock.requests[0]?.tools ?? []).map((t) => t.function?.name).sort();
		checks.check(`提供给模型的工具：${tools.join(",")}`, tools.join(",") === "bash,edit,read,write");
		checks.check("系统提示词不含本地占位目录", !/flowork[\\/]+hosts/i.test(system));
		const verify = await client.call("session.send", { handleId, command: { type: "get_messages" } });
		checks.check("会话记录包含本轮的工具调用", JSON.stringify(verify).includes("flowork-ops-session"));

		await client.call("session.send", { handleId, command: { type: "set_session_name", name: "装 nginx" } });
		const list = await client.call("service.send", { type: "list_sessions", cwd: "/root" });
		checks.check("会话列表按远程项目归档，cwd 显示远程路径", list.length >= 1 && list.every((s) => s.cwd === "/root") && list.some((s) => s.name === "装 nginx"));

		const target = list.find((s) => s.name === "装 nginx");
		if (target) {
			await client.call("sessions.rename", { cwd: "/root", path: target.path, name: "安装 nginx" });
			const renamed = await client.call("service.send", { type: "list_sessions", cwd: "/root" });
			checks.check("运维会话可重命名", renamed.some((s) => s.name === "安装 nginx"));
		}

		const term = await client.call("terminal.open", { cwd: "/root", cols: 80, rows: 24, hostId: host.id });
		terminalId = term.terminalId;
		const output = await deadline(
			(async () => {
				await client.call("terminal.write", { terminalId, data: "echo FLOWORK_$((40+2))\r" });
				for (;;) {
					const text = client.pushes.filter((p) => p.type === "terminal_data" && p.terminalId === terminalId).map((p) => p.data).join("");
					if (text.includes("FLOWORK_42")) return text;
					await new Promise((r) => setTimeout(r, 200));
				}
			})(),
			"远程终端输出",
			20_000,
		);
		checks.check("远程终端（密码登录）可交互", output.includes("FLOWORK_42"));
	} finally {
		if (terminalId) await client?.call("terminal.close", { terminalId }).catch(() => undefined);
		if (handleId) await client?.call("session.close", { handleId }).catch(() => undefined);
		await client?.close();
		await backend.stop();
		await mock.close();
	}
}

if (!spec) {
	reportSkip("未设置 FLOWORK_TEST_SSH（见脚本开头的说明）");
} else {
	const checks = createChecks();
	await main(checks).then(
		() => checks.finish("OPS SESSION REGRESSION OK（隔离 Electron IPC；未调用模型）"),
		(error) => {
			console.error(`OPS SESSION REGRESSION FAILED\n${error?.stack ?? error}`);
			process.exitCode = 1;
		},
	);
}
