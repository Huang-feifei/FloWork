/**
 * 从批准的计划 Markdown（submit_plan）中提取结构化任务清单（Checklist）
 */

export interface PlanStepItem {
	id: number;
	title: string;
	completed?: boolean;
}

export interface ParsedPlan {
	raw: string;
	title: string;
	steps: PlanStepItem[];
	files: string[];
}

export function parsePlanMarkdown(raw: string): ParsedPlan | null {
	if (!raw || !raw.trim()) return null;

	const lines = raw.split("\n");
	const steps: PlanStepItem[] = [];
	const files: string[] = [];
	let planTitle = "已批准的实施计划";

	// 尝试寻找第一行标题作为计划标题
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) {
			planTitle = trimmed.slice(2).trim();
			break;
		}
	}

	let stepSeq = 0;
	let inStepSection = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;

		// 检测是否进入步骤章节
		if (/^(?:#{1,4}\s*(?:实施|执行)?步骤|步骤清单|Tasks|Steps)/i.test(line)) {
			inStepSection = true;
			continue;
		}

		// 检测是否进入其他章节（如涉及文件、风险、验证方法等）
		if (/^(?:#{1,4}\s*(?:涉及文件|文件清单|风险|验证方法|Files|Risks|Verification))/i.test(line)) {
			inStepSection = false;
		}

		// 提取步骤：数字标号 (1. 或 1、)
		const numberedMatch = /^(\d+)[\.、\)]\s*(?:\[([ xX])\]\s*)?(.*)$/.exec(line);
		if (numberedMatch) {
			const checkChar = numberedMatch[2];
			const isDone = checkChar ? checkChar.toLowerCase() === "x" : false;
			const text = (numberedMatch[3] ?? "").trim();
			if (text) {
				steps.push({
					id: ++stepSeq,
					title: text.replace(/\*\*/g, ""),
					completed: isDone,
				});
				continue;
			}
		}

		// 提取步骤：待办勾选框 (- [ ] 或 * [ ])
		const checkMatch = /^[-*]\s*\[([ xX])\]\s*(.*)$/.exec(line);
		if (checkMatch) {
			const checkChar = checkMatch[1];
			const isDone = checkChar ? checkChar.toLowerCase() === "x" : false;
			const text = (checkMatch[2] ?? "").trim();
			if (text) {
				steps.push({
					id: ++stepSeq,
					title: text.replace(/\*\*/g, ""),
					completed: isDone,
				});
				continue;
			}
		}

		// 如果在明确的步骤章节内，普通无序列表也作为步骤
		if (inStepSection) {
			const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
			if (bulletMatch) {
				const text = (bulletMatch[1] ?? "").trim();
				if (text && !text.startsWith("http") && text.length > 2) {
					steps.push({
						id: ++stepSeq,
						title: text.replace(/\*\*/g, ""),
						completed: false,
					});
					continue;
				}
			}
		}

		// 提取涉及文件 (如 `- src/xxx` 或 `* `path``)
		const fileMatch = /^[-*]\s+[`"']?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`"']?/.exec(line);
		if (fileMatch && fileMatch[1]) {
			files.push(fileMatch[1]);
		}
	}

	return {
		raw,
		title: planTitle,
		steps,
		files: [...new Set(files)],
	};
}
