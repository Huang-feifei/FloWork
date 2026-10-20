/** 保守分类，不把文本分类当权限边界：读查询仍须在数据库强制只读事务里执行。 */
export function inspectSql(sql: string): { sql: string; readOnly: boolean } {
	if (typeof sql !== "string" || !sql.trim() || sql.length > 100_000 || sql.includes("\0")) throw new Error("SQL 不能为空，且最多 100,000 字符");
	const words: string[] = [];
	let i = 0, ended = false;
	while (i < sql.length) {
		const c = sql[i]!;
		if (/\s/.test(c)) { i++; continue; }
		if (sql.startsWith("--", i) || c === "#") { i = sql.indexOf("\n", i); if (i < 0) break; continue; }
		if (sql.startsWith("/*", i)) {
			if (/^\/\*[!+]/.test(sql.slice(i))) throw new Error("不支持可执行注释或 SQL 提示，请移除后重试");
			let depth = 1; i += 2;
			while (i < sql.length && depth) {
				if (sql.startsWith("/*", i)) { depth++; i += 2; }
				else if (sql.startsWith("*/", i)) { depth--; i += 2; }
				else i++;
			}
			if (depth) throw new Error("SQL 注释未闭合");
			continue;
		}
		if (c === ";") { if (ended) throw new Error("一次只能执行一条 SQL"); ended = true; i++; continue; }
		if (ended) throw new Error("一次只能执行一条 SQL");
		const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0];
		if (dollar) { const end = sql.indexOf(dollar, i + dollar.length); if (end < 0) throw new Error("SQL 字符串未闭合"); i = end + dollar.length; continue; }
		if (c === "'" || c === '"' || c === "`" || c === "[") {
			const end = c === "[" ? "]" : c; i++; let closed = false;
			while (i < sql.length) {
				// 不接受方言间含义不同的反斜杠转义，防止分类和服务器解释不一致。
				if (sql[i] === "\\") throw new Error("SQL 引号内请使用双写引号转义，不支持反斜杠转义");
				if (sql[i] === end) { if (sql[i + 1] === end) { i += 2; continue; } i++; closed = true; break; }
				i++;
			}
			if (!closed) throw new Error("SQL 引号未闭合");
			continue;
		}
		const word = sql.slice(i).match(/^[A-Za-z_][\w$]*/)?.[0];
		if (word) { words.push(word.toUpperCase()); i += word.length; } else i++;
	}
	const first = words[0];
	if (!first || !["SELECT", "WITH", "EXPLAIN", "INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP", "TRUNCATE"].includes(first)) {
		throw new Error("仅支持 SELECT / WITH / EXPLAIN 和需确认的数据或表结构语句；不支持事务控制、PRAGMA、ATTACH、COPY、CALL、SET 等命令");
	}
	const mutations = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP", "TRUNCATE", "INTO", "ANALYZE", "ATTACH", "DETACH", "LOAD_EXTENSION"]);
	const readOnly = ["SELECT", "WITH", "EXPLAIN"].includes(first) && !words.some((w) => mutations.has(w));
	return { sql: sql.trim().replace(/;\s*(?:(?:--[^\n]*)?\s*)?$/, ""), readOnly };
}

export function databaseCsv(columns: string[], rows: (string | number | boolean | null)[][]): string {
	const escape = (v: string | number | boolean | null) => {
		let text = v === null ? "" : String(v);
		// 避免导出后在 Excel 等表格软件中执行公式。
		if (typeof v === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
		return `"${text.replace(/"/g, '""')}"`;
	};
	return [columns, ...rows].map((r) => r.map(escape).join(",")).join("\r\n");
}
