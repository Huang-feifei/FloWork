/** 结构化跳过协议：子脚本重新选择 Node / Electron 运行时后仍沿用同一报告文件。 */
import { appendFileSync } from "node:fs";

export function reportSkip(reason, name) {
	const record = { status: "SKIP", reason, ...(name ? { name } : {}) };
	console.log(`SKIP ${name ? `${name}：` : ""}${reason}`);
	if (process.env.FLOWORK_TEST_REPORT_FILE) appendFileSync(process.env.FLOWORK_TEST_REPORT_FILE, `${JSON.stringify(record)}\n`);
}

export function classifyResult(label, code, records = [], ms = 0) {
	const suiteSkip = records.find(r => r.status === "SKIP" && !r.name);
	return [
		{ label, status: code === 0 ? (suiteSkip ? "SKIP" : "PASS") : "FAIL", ms, reason: code === 0 ? suiteSkip?.reason : `退出码 ${code ?? "null"}` },
		...records.filter(r => r.status === "SKIP" && r.name).map(r => ({ label: `${label} / ${r.name}`, status: "SKIP", ms: 0, reason: r.reason })),
	];
}
