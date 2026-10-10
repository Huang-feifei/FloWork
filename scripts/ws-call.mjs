/**
 * 开发辅助：向正在运行的本地后端发一个请求并打印结果。
 *   node scripts/ws-call.mjs <method> '<params JSON>'
 * 例：node scripts/ws-call.mjs service.send '{"type":"get_shell_info"}'
 */
import WebSocket from "ws";

const [method, params = "null"] = process.argv.slice(2);
const port = Number(process.env.FLOWORK_PORT ?? 17321);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
ws.on("open", () => ws.send(JSON.stringify({ id: "1", method, params: JSON.parse(params) })));
ws.on("message", (data) => {
	const frame = JSON.parse(String(data));
	if (frame.id !== "1") return;
	console.log(JSON.stringify(frame.ok ? frame.result : { error: frame.error }, null, 2));
	ws.close();
});
ws.on("error", (e) => {
	console.error(e.message);
	process.exit(1);
});
