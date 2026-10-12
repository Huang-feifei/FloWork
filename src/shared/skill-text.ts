/**
 * pi 执行 /skill:名称 时，会把 SKILL.md 全文展开进用户消息：
 *   <skill name="x" location="...">…</skill>\n\n用户附带的文字
 * 界面显示时折叠为 “/skill:x 用户附带的文字”。
 */
const SKILL_BLOCK = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*([\s\S]*)$/;

export function parseSkillInvocation(text: string): { skill: string; args: string; body: string } | null {
	const m = SKILL_BLOCK.exec(text);
	if (!m?.[1]) return null;
	const args = (m[2] ?? "").trim();
	return { skill: m[1], args, body: text.slice(0, text.length - (m[2] ?? "").length).trim() };
}

export function displayUserText(text: string): string {
	const p = parseSkillInvocation(text);
	return p ? `/skill:${p.skill}${p.args ? ` ${p.args}` : ""}` : text;
}
