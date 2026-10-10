/**
 * 网页版外壳：本地 HTTP 服务（静态页面）+ WebSocket（Transport）。
 *
 * - 只监听 127.0.0.1，并校验 WebSocket 的 Origin，防止其他网站通过浏览器连接本服务。
 * - 后端逻辑与桌面版共用 src/core/backend.ts。
 *
 * 环境变量：
 *   FLOWORK_PORT          服务端口，默认 17321
 *   FLOWORK_STATIC_DIR    静态页面目录，默认 ../renderer（相对本文件）；开发模式不提供静态页面
 *   FLOWORK_DEV_ORIGIN    额外允许的 Origin，逗号分隔（开发模式下 Vite 的地址）
 * 参数：
 *   --smoke               运行冒烟检查后退出
 *   --open                启动后用默认浏览器打开
 */
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import type { BackendMethod, ClientFrame, ServerFrame } from "@shared/protocol";
import { Backend } from "../core/backend";
import { runCoreChecks } from "../core/smoke-checks";
import { spawnNodeWorker } from "./spawn";

declare const __FLOWORK_VERSION__: string;

const HOST = "127.0.0.1";
const PORT = Number(process.env.FLOWORK_PORT ?? 17321);
const STATIC_DIR = resolve(process.env.FLOWORK_STATIC_DIR ?? join(import.meta.dirname, "../renderer"));
const SERVE_STATIC = existsSync(join(STATIC_DIR, "index.html"));
const ALLOWED_ORIGINS = new Set(
	[`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, ...(process.env.FLOWORK_DEV_ORIGIN ?? "").split(",")]
		.map((o) => o.trim())
		.filter((o) => o.length > 0),
);

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

function checkNodeVersion(): void {
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 19)) {
		console.warn(
			`[flowork] 警告：当前 Node ${process.versions.node} 低于 pi 要求的 22.19，基础功能可能可用但不受支持，建议升级 Node。`,
		);
	}
}

const backend = new Backend({
	shell: "web",
	version: typeof __FLOWORK_VERSION__ === "string" ? __FLOWORK_VERSION__ : "dev",
	spawnWorker: spawnNodeWorker,
});

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!SERVE_STATIC) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("开发模式：请通过 Vite 开发服务器访问页面");
		return;
	}
	const url = new URL(req.url ?? "/", `http://${HOST}`);
	const requested = normalize(join(STATIC_DIR, decodeURIComponent(url.pathname)));
	// 防止路径穿越
	let file = requested.startsWith(STATIC_DIR + sep) || requested === STATIC_DIR ? requested : join(STATIC_DIR, "index.html");
	try {
		if ((await stat(file)).isDirectory()) file = join(file, "index.html");
	} catch {
		file = join(STATIC_DIR, "index.html"); // SPA 回退
	}
	try {
		const body = await readFile(file);
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
		});
		res.end(body);
	} catch {
		res.writeHead(404);
		res.end();
	}
}

const server = createServer((req, res) => {
	void serveStatic(req, res);
});

const wss = new WebSocketServer({
	server,
	path: "/ws",
	verifyClient: ({ origin }: { origin?: string }) => origin !== undefined && ALLOWED_ORIGINS.has(origin),
});

wss.on("connection", (socket) => {
	const clientId = randomUUID();
	const send = (frame: ServerFrame) => {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
	};
	const unsubscribe = backend.onPush((push) => send({ push }));

	socket.on("message", (data) => {
		let frame: ClientFrame;
		try {
			frame = JSON.parse(data.toString()) as ClientFrame;
		} catch {
			return;
		}
		backend.handle(frame.method as BackendMethod, frame.params as never, clientId).then(
			(result) => send({ id: frame.id, ok: true, result }),
			(error: unknown) => send({ id: frame.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
		);
	});

	socket.on("close", () => {
		unsubscribe();
		void backend.releaseClient(clientId);
	});
});

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	wss.close();
	server.close();
	await backend.shutdown();
	process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

checkNodeVersion();

if (process.argv.includes("--smoke")) {
	runCoreChecks(backend).then(
		(report) => {
			console.log(`SMOKE OK ${JSON.stringify(report, null, 2)}`);
			void shutdown(0);
		},
		(error: unknown) => {
			console.error(`SMOKE FAILED ${error instanceof Error ? error.stack : String(error)}`);
			void shutdown(1);
		},
	);
} else {
	server.listen(PORT, HOST, () => {
		const url = `http://${HOST}:${PORT}/`;
		console.log(`[flowork] 后端已启动：${SERVE_STATIC ? url : `ws://${HOST}:${PORT}/ws（开发模式，页面由 Vite 提供）`}`);
		if (SERVE_STATIC && process.argv.includes("--open")) {
			const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open ${url}` : `xdg-open ${url}`;
			exec(opener);
		}
	});
}
