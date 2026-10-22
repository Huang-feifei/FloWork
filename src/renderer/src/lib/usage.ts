import type { ChatMessage } from "@shared/protocol";

/** SDK 的 input 是未缓存输入；缓存读写都是输入的一部分，必须一并累计。 */
export function summarizeUsage(messages: readonly ChatMessage[]) {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let lastContext = 0;
	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		const usage = message.usage;
		input += usage.input + usage.cacheRead + usage.cacheWrite;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		cost += usage.cost.total;
		if (usage.totalTokens > 0) lastContext = usage.totalTokens;
	}
	return { input, output, cacheRead, cacheWrite, cost, lastContext };
}
