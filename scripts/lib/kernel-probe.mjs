/** 放行前验证官方 Pi + 内置适配层：无用户配置、无模型请求的 service/session IPC 回归。 */
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendRuntime } from "../web-build-options.mjs";

function exchange(child, message, predicate) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("内核发行自检超时")), 60_000);
		const onMessage = (reply) => {
			if (reply.kind === "init_error" || (reply.kind === "response" && !reply.ok)) finish(new Error(reply.error));
			else if (predicate(reply)) finish(null, reply);
		};
		const onExit = (code) => finish(new Error(`内核自检进程提前退出：${code}`));
		const onError = (error) => finish(error);
		function finish(error, reply) {
			clearTimeout(timer);
			child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError);
			if (error) reject(error); else resolve(reply);
		}
		child.on("message", onMessage); child.once("exit", onExit); child.once("error", onError);
		child.send(message, (error) => { if (error) finish(error); });
	});
}

export async function probeKernel(entry, protocolVersion) {
	const directory = await mkdtemp(join(tmpdir(), "flowork-kernel-release-probe-"));
	const runtime = await backendRuntime();
	try {
		for (const role of ["service", "session"]) {
			const cwd = join(directory, role);
			const agent = join(cwd, "agent");
			await mkdir(agent, { recursive: true });
			const child = fork(entry, [], {
				execPath: runtime.command,
				env: { ...process.env, ...runtime.env, FLOWORK_DATA_DIR: cwd, FLOWORK_PI_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1" },
				cwd,
			});
			const exit = new Promise((resolve) => child.once("exit", resolve));
			try {
				const ready = await exchange(child, { kind: "init", init: { role, cwd } }, (r) => r.kind === "ready");
				if (role === "service") {
					const ping = await exchange(child, { kind: "command", id: "probe", command: { type: "ping" } }, (r) => r.kind === "response" && r.id === "probe");
					if (ping.data.protocolVersion !== protocolVersion) throw new Error("发行包的 Worker 协议版本不一致");
				} else {
					if (!ready.state?.sessionId) throw new Error("发行包不能创建会话");
					await exchange(child, { kind: "command", id: "probe", command: { type: "get_state" } }, (r) => r.kind === "response" && r.id === "probe");
				}
				console.log(`✓ 官方 Pi / 当前适配层 ${role} 自检通过（${runtime.label}）`);
			} finally {
				const timer = setTimeout(() => child.kill(), 5_000);
				try { if (child.connected) child.send({ kind: "shutdown" }, () => undefined); await exit; }
				finally { clearTimeout(timer); }
			}
		}
	} finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
}
