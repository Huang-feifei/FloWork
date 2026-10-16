/**
 * 测试用的最小 OpenAI 兼容服务（/v1/chat/completions，流式）：按脚本依次返回预设回复，不调用任何真实模型。
 *
 *   const mock = await startMockOpenAI([
 *     { toolCalls: [{ name: "bash", arguments: { command: "df -h" } }] },
 *     { text: "完成" },
 *   ]);
 *   // models.json: { providers: { mock: { baseUrl: mock.url, api: "openai-completions", apiKey: "x", models: [{ id: "mock-1" }] } } }
 *   mock.requests  // 收到的请求体，便于断言工具结果是否送回模型
 *   await mock.close();
 */
import { createServer } from "node:http";

export async function startMockOpenAI(script) {
	const queue = [...script];
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			if (!req.url?.includes("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const parsed = JSON.parse(body || "{}");
			requests.push(parsed);
			const step = queue.shift() ?? { text: "（mock：脚本已用完）" };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const id = `chatcmpl-${requests.length}`;
			const send = (delta, finish = null) =>
				res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			send({ role: "assistant" });
			if (step.text) send({ content: step.text });
			if (step.toolCalls) {
				step.toolCalls.forEach((call, index) => {
					send({ tool_calls: [{ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
				});
			}
			send({}, step.toolCalls ? "tool_calls" : "stop");
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
