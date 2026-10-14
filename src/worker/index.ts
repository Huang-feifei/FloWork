/**
 * pi worker 入口。
 *
 * - 桌面版：Electron utilityProcess 启动，经 process.parentPort 通信，运行在 Electron 自带的 Node 中
 * - 网页版：Node child_process.fork 启动，经 process.send / "message" 事件通信
 *
 * role = "service"：常驻一个，处理会话列表、供应商、登录与配置等无会话命令
 * role = "session"：每个打开的工作区一个，承载 pi AgentSessionRuntime
 *
 * pi 或扩展崩溃只会结束本进程，不影响界面与后端。
 */
import type { AnyCommand, MainToWorker, SessionCommand, ServiceCommand, WorkerToMain } from "@shared/protocol";
import { ServiceHost } from "./service-host";
import { errorText, SessionHost } from "./session-host";

interface Channel {
	send(message: WorkerToMain): void;
	onMessage(listener: (message: MainToWorker) => void): void;
}

function createChannel(): Channel | undefined {
	const parentPort = process.parentPort;
	if (parentPort) {
		return {
			send: (message) => parentPort.postMessage(message),
			onMessage: (listener) => parentPort.on("message", (e) => listener(e.data as MainToWorker)),
		};
	}
	const send = process.send?.bind(process);
	if (send) {
		return {
			send: (message) => {
				if (process.connected) send(message);
			},
			onMessage: (listener) => process.on("message", (message) => listener(message as MainToWorker)),
		};
	}
	return undefined;
}

const channel = createChannel();
if (!channel) {
	console.error("[pi-worker] 必须由 FloWork 后端以子进程方式启动");
	process.exit(1);
}

const send = (message: WorkerToMain) => channel.send(message);

let sessionHost: SessionHost | undefined;
let serviceHost: ServiceHost | undefined;

const SERVICE_COMMANDS = new Set<AnyCommand["type"]>([
	"ping",
	"list_sessions",
	"validate_session",
	"rename_session",
	"delete_session",
	"list_providers",
	"list_models",
	"auth_login",
	"logout",
	"test_model",
	"get_config_file",
	"save_config_file",
	"fetch_remote_models",
	"get_shell_info",
	"list_resources",
	"set_resource_enabled",
	"import_resource",
	"remove_resource",
	"install_package",
	"remove_package",
]);

function getServiceHost(): ServiceHost {
	serviceHost ??= new ServiceHost((event) => send({ kind: "auth", event }));
	return serviceHost;
}

async function handleCommand(id: string, command: AnyCommand): Promise<void> {
	try {
		let data: unknown;
		if (SERVICE_COMMANDS.has(command.type)) {
			data = await getServiceHost().handle(command as ServiceCommand);
		} else {
			if (!sessionHost) throw new Error("此 worker 没有承载会话");
			data = await sessionHost.handle(command as SessionCommand);
		}
		send({ kind: "response", id, ok: true, data: data ?? null });
	} catch (error) {
		send({ kind: "response", id, ok: false, error: errorText(error) });
	}
}

channel.onMessage((message) => {
	switch (message.kind) {
		case "init": {
			const { role, cwd, sessionPath, approvalMode } = message.init;
			if (role === "service") {
				getServiceHost();
				send({ kind: "ready" });
				return;
			}
			sessionHost = new SessionHost((event) => send({ kind: "event", event }), approvalMode);
			sessionHost.init(cwd, sessionPath).then(
				(state) => send({ kind: "ready", state }),
				(error: unknown) => send({ kind: "init_error", error: errorText(error) }),
			);
			return;
		}
		case "command":
			void handleCommand(message.id, message.command);
			return;
		case "auth_answer":
			getServiceHost().answer(message.flowId, message.promptId, message.value, message.cancel);
			return;
		case "auth_cancel":
			getServiceHost().cancelFlow(message.flowId);
			return;
		case "shutdown":
			void (sessionHost?.dispose() ?? Promise.resolve()).finally(() => process.exit(0));
			return;
	}
});

// 网页版：父进程退出时一并退出
process.on("disconnect", () => process.exit(0));

process.on("uncaughtException", (error) => {
	console.error("[pi-worker] uncaughtException", error);
	send({ kind: "event", event: { type: "notice", level: "error", text: `worker 异常：${errorText(error)}` } });
});
process.on("unhandledRejection", (reason) => {
	console.error("[pi-worker] unhandledRejection", reason);
});
