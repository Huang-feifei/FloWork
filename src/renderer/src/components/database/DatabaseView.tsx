import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseConnection, DatabaseHistory, DatabasePage, DatabaseResult, DatabaseSavedQuery, DatabaseTable } from "@shared/database";
import { databaseCsv, inspectSql } from "@shared/database-sql";
import { api, errorText } from "../../api/client";
import { useApp } from "../../store";
import { askConfirm } from "../ConfirmDialog";
import { askText } from "../PromptDialog";
import { Icon } from "../Icon";
import { Badge, Button, Input, Segmented, Select } from "../ui";
import { ConnectionDialog } from "./ConnectionDialog";

const CodeEditor = lazy(() => import("../panels/CodeEditor"));
const kinds = { sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL" };
const tableKey = (t: DatabaseTable) => JSON.stringify([t.schema, t.name]);
const quote = (s: string, c: DatabaseConnection) => c.kind === "mysql" ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`;

function ResultGrid({ result }: { result: DatabaseResult }) {
	return <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border bg-surface-raised">
		<table className="w-full border-collapse text-left font-mono text-[12px]">
			<thead className="sticky top-0 z-10 bg-panel-2"><tr>{result.columns.map((c, i) => <th key={i} className="min-w-28 whitespace-nowrap border-b border-border px-4 py-2.5 font-normal text-faint">{c}</th>)}</tr></thead>
			<tbody>{result.rows.map((r, i) => <tr key={i} className="border-b border-border last:border-0 hover:bg-panel-2">{r.map((cell, j) => <td key={j} className={`max-w-96 truncate px-4 py-2.5 ${cell === null ? "italic text-faint" : "text-fg/85"}`} title={cell === null ? "NULL" : String(cell)}>{cell === null ? "NULL" : typeof cell === "boolean" ? String(cell) : cell}</td>)}</tr>)}</tbody>
		</table>
		{!result.rows.length && <div className="p-8 text-center text-xs text-muted">{result.columns.length ? "没有匹配的数据" : `执行完成 · 影响 ${result.affectedRows} 行`}</div>}
	</div>;
}
function exportCsv(result: DatabaseResult, name: string) {
	const url = URL.createObjectURL(new Blob(["\uFEFF", databaseCsv(result.columns, result.rows)], { type: "text/csv;charset=utf-8" }));
	const link = document.createElement("a"); link.href = url; link.download = `${name.replace(/[<>:"/\\|?*]/g, "_")}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DatabaseView() {
	const [connections, setConnections] = useState<DatabaseConnection[]>([]);
	const [selectedId, setSelectedId] = useState(() => localStorage.getItem("flowork.databaseConnection") ?? "");
	const [editor, setEditor] = useState<{ connection?: DatabaseConnection }>();
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	const [busy, setBusy] = useState(false);
	const sidebarOpen = useApp(s => s.sidebarOpen);
	const pushNotice = useApp(s => s.pushNotice);
	const load = useCallback(async () => { const cs = await api.database.list(); setConnections(cs); setSelectedId(id => cs.some(c => c.id === id) ? id : cs[0]?.id ?? ""); }, []);
	useEffect(() => { void load().catch(e => setError(errorText(e))); }, [load]);
	const selected = connections.find(c => c.id === selectedId);
	const select = (id: string) => { if (!busy) { setSelectedId(id); localStorage.setItem("flowork.databaseConnection", id); } };
	const remove = async () => {
		if (!selected || busy) return;
		if (!await askConfirm({ title: "移除数据库连接", message: `仅删除「${selected.name}」的连接配置、查询历史和收藏，不会删除数据库或数据。`, danger: true })) return;
		try { await api.database.remove(selected.id); localStorage.removeItem(`flowork.sql.${selected.id}`); await load(); } catch (e) { pushNotice("error", errorText(e)); }
	};
	return <div className="flex min-h-0 flex-1">
		{sidebarOpen && <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-sidebar">
			<div className="flex h-12 items-center gap-2 px-4"><span className="flex-1 text-xs font-semibold text-muted">数据库连接</span><Button size="sm" variant="ghost" disabled={busy} title="新建数据库连接" onClick={() => setEditor({})}>＋</Button></div>
			<div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">{connections.map(c => <button key={c.id} type="button" disabled={busy} onClick={() => select(c.id)} className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left ${c.id === selectedId ? "bg-primary-soft text-primary" : "text-muted hover:bg-panel-2"}`}><Icon name="database" className="size-4 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{c.name}</span><span className="block truncate text-[11px] opacity-70">{kinds[c.kind]}{c.sshHostId ? " · SSH" : ""}{c.readOnly ? " · 只读" : " · 可写"}</span></span></button>)}{!connections.length && <p className="px-3 py-4 text-xs leading-5 text-faint">添加 SQLite 文件，或连接 PostgreSQL / MySQL。</p>}</div>
			<div className="flex gap-2 border-t border-border p-3"><Button size="sm" disabled={!selected || busy} onClick={() => setEditor({ connection: selected })}>编辑…</Button><Button size="sm" variant="ghost" disabled={!selected || busy} onClick={() => void remove()}>移除</Button></div>
		</aside>}
		<div className="flex min-w-0 flex-1 flex-col">
			{error && <div role="alert" className="bg-err-soft p-3 text-xs text-err">{error}<Button size="sm" onClick={() => { setError(""); void load().catch(e => setError(errorText(e))); }}>重试</Button></div>}
			{selected ? <Workspace key={`${selected.id}:${revision}`} connection={selected} onBusy={setBusy} onEdit={() => setEditor({ connection: selected })} /> : <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted"><Icon name="database" className="size-10 text-faint" /><span className="text-base font-semibold">数据库工作台</span><span className="text-xs">浏览表数据、运行 SQL、管理查询历史和收藏</span><Button variant="primary" onClick={() => setEditor({})}>新建数据库连接</Button></div>}
		</div>
		{editor && <ConnectionDialog connection={editor.connection} onClose={() => setEditor(undefined)} onSaved={c => { setConnections(cs => [...cs.filter(v => v.id !== c.id), c]); select(c.id); setRevision(r => r + 1); setEditor(undefined); }} />}
	</div>;
}

function Workspace({ connection: c, onBusy, onEdit }: { connection: DatabaseConnection; onBusy: (busy: boolean) => void; onEdit: () => void }) {
	const [view, setView] = useState("data"), [tables, setTables] = useState<DatabaseTable[]>([]), [table, setTable] = useState<DatabaseTable>();
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const [filter, setFilter] = useState(""), [appliedFilter, setAppliedFilter] = useState("");
	const [orderBy, setOrderBy] = useState(""), [descending, setDescending] = useState(false), [pageSize, setPageSize] = useState(50);
	const [page, setPage] = useState<DatabasePage>();
	const [sql, setSql] = useState(() => localStorage.getItem(`flowork.sql.${c.id}`) || "SELECT 1;");
	const [sqlRevision, setSqlRevision] = useState(0), [result, setResult] = useState<DatabaseResult>();
	const [history, setHistory] = useState<DatabaseHistory[]>([]), [saved, setSaved] = useState<DatabaseSavedQuery[]>([]);
	const mounted = useRef(true), lock = useRef(false), activeWrite = useRef(false);
	const pushNotice = useApp(s => s.pushNotice);
	const setQuery = (text: string) => { setSql(text); setSqlRevision(n => n + 1); };
	useEffect(() => { try { localStorage.setItem(`flowork.sql.${c.id}`, sql); } catch { /* 不因配额耗尽阻止查询 */ } }, [sql, c.id]);
	useEffect(() => () => {
		mounted.current = false;
		if (lock.current) void api.database.cancel().catch(() => {});
		if (activeWrite.current) pushNotice("error", "数据库写操作在离开工作台时被取消，但可能已生效。请核对数据库，不要直接重复提交。");
		onBusy(false);
	}, [onBusy, pushNotice]);
	const refreshHistory = useCallback(async () => { const [h, s] = await Promise.all([api.database.history(c.id), api.database.saved(c.id)]); if (mounted.current) { setHistory(h); setSaved(s); } }, [c.id]);
	const operation = async (fn: () => Promise<void>) => {
		if (lock.current) return; lock.current = true; setBusy(true); onBusy(true); setError("");
		try { await fn(); } catch (e) { if (mounted.current) setError(errorText(e)); }
		finally { lock.current = false; if (mounted.current) { setBusy(false); onBusy(false); } }
	};
	const browse = async (t: DatabaseTable, n = 1, f = appliedFilter, order = orderBy, desc = descending, size = pageSize) => {
		const p = await api.database.browse({ connectionId: c.id, table: t, page: n, pageSize: size, filter: f, orderBy: order, descending: desc });
		if (mounted.current) { setPage(p); setAppliedFilter(f); setOrderBy(order); setDescending(desc); setPageSize(size); }
	};
	const loadTables = async () => {
		const ts = await api.database.tables(c.id); if (!mounted.current) return;
		setTables(ts); const t = ts.find(v => table && tableKey(v) === tableKey(table)) ?? ts[0]; setTable(t); setPage(undefined);
		if (t) await browse(t, 1, "", "", false);
	};
	useEffect(() => {
		mounted.current = true; let abandoned = false;
		// StrictMode 会重放挂载；延后一微任务，避免重复连接或误取消第一次查询。
		queueMicrotask(() => { if (abandoned) return; void operation(loadTables); void refreshHistory().catch(e => { if (mounted.current) setError(errorText(e)); }); });
		return () => { abandoned = true; };
	}, [c.id]);
	const run = () => operation(async () => {
		const selectedSql = sql, checked = inspectSql(selectedSql); let confirmationToken: string | undefined;
		if (!checked.readOnly) {
			if (c.readOnly) throw new Error("当前为只读连接。如确需写入，请编辑连接关闭只读，再逐次确认。");
			const { token } = await api.database.prepareWrite(c.id, selectedSql);
			if (!await askConfirm({ title: `确认写入 · ${c.name}`, message: `以下语句可能永久修改或删除数据：\n\n${selectedSql.slice(0, 1800)}\n\n请确认目标和条件。MySQL 的 DDL 可能自动提交；取消或超时不保证写入未生效。`, danger: true, confirmLabel: "确认执行" })) return;
			if (!mounted.current) return; confirmationToken = token;
		}
		setResult(undefined); activeWrite.current = !checked.readOnly;
		try { const r = await api.database.query({ connectionId: c.id, sql: selectedSql, confirmationToken }); if (mounted.current) setResult(r); }
		finally { activeWrite.current = false; await refreshHistory().catch(e => { if (mounted.current) pushNotice("error", `查询历史刷新失败（不代表 SQL 执行失败）：${errorText(e)}`); }); }
	});
	const saveQuery = async () => {
		const name = await askText({ title: "收藏查询", placeholder: "查询名称" }); if (!name) return;
		try { await api.database.saveQuery(c.id, name, sql); await refreshHistory(); } catch (e) { pushNotice("error", errorText(e)); }
	};
	const format = async () => {
		try { const { format } = await import("sql-formatter"); setQuery(format(sql, { language: c.kind === "postgres" ? "postgresql" : c.kind, keywordCase: "upper" })); } catch (e) { pushNotice("error", `格式化失败：${errorText(e)}`); }
	};
	const current = view === "data" ? page : result;
	return <div className="flex min-h-0 flex-1 flex-col">
		<header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5"><span className="text-[15px] font-semibold">数据库</span><Badge>{kinds[c.kind]}</Badge><span className="min-w-0 flex-1 truncate text-xs text-muted" title={c.file || `${c.user}@${c.host}:${c.port}/${c.database}`}>{c.name}</span><Badge tone={c.readOnly ? "muted" : "warn"}>{c.readOnly ? "只读连接" : "写操作需确认"}</Badge><Segmented items={[{ id: "data", label: "数据" }, { id: "query", label: "查询" }]} active={view} onChange={setView} /><Button size="sm" variant="ghost" disabled={busy} onClick={() => void operation(loadTables)}>刷新</Button><Button size="sm" disabled={!current?.columns.length || busy} onClick={() => { if (current) exportCsv(current, `${c.name}-${view === "data" ? table?.name ?? "table" : "query"}`); }}>导出 CSV</Button><Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>连接…</Button></header>
		{error && <div role="alert" className="mx-5 mt-3 whitespace-pre-wrap break-words rounded-xl bg-err-soft p-3 text-xs text-err">{error}</div>}
		{busy && <div role="status" className="flex shrink-0 items-center gap-3 px-5 py-2 text-xs text-muted"><span className="animate-pulse">正在执行数据库操作…</span><Button size="sm" onClick={() => void api.database.cancel().catch(e => setError(errorText(e)))}>取消</Button></div>}
		{view === "data" ? <>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
				<Select aria-label="选择数据表" className="w-52! shrink-0" value={table ? tableKey(table) : ""} disabled={busy || !tables.length} onChange={e => { const t = tables.find(t => tableKey(t) === e.target.value); if (t) { setTable(t); setPage(undefined); setFilter(""); void operation(() => browse(t, 1, "", "", false)); } }}>{!tables.length && <option value="">没有可见的表</option>}{tables.map(t => <option key={tableKey(t)} value={tableKey(t)}>{t.schema === "main" ? "" : `${t.schema}.`}{t.name}{t.type === "view" ? "（视图）" : ""}</option>)}</Select>
				<Input aria-label="WHERE 筛选" className="min-w-36 flex-1 font-mono text-xs" placeholder="WHERE 表达式（不含 WHERE）" value={filter} disabled={busy} onChange={e => setFilter(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && table) void operation(() => browse(table, 1, filter)); }} /><Button size="sm" disabled={busy || !table} onClick={() => { if (table) void operation(() => browse(table, 1, filter)); }}>筛选</Button>
				<Select aria-label="排序字段" className="w-36! shrink-0" value={orderBy} disabled={busy || !page} onChange={e => { if (table) void operation(() => browse(table, 1, appliedFilter, e.target.value)); }}><option value="">主键默认排序</option>{page?.tableColumns.map(col => <option key={col.name} value={col.name}>{col.name}</option>)}</Select><Button size="sm" disabled={busy || !table || !orderBy} onClick={() => { if (table) void operation(() => browse(table, 1, appliedFilter, orderBy, !descending)); }}>{descending ? "↓ 降序" : "↑ 升序"}</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">{page ? <>
				<ResultGrid result={page} />
				<div className="flex flex-wrap items-center gap-3 text-xs text-faint"><span>{page.rows.length} 行 · {page.tableColumns.length} 列 · {page.durationMs} ms · 只读事务</span><div className="flex-1" /><Select aria-label="每页行数" className="w-28! shrink-0" disabled={busy} value={pageSize} onChange={e => { if (table) void operation(() => browse(table, 1, appliedFilter, orderBy, descending, Number(e.target.value))); }}>{[25, 50, 100, 250].map(n => <option key={n} value={n}>{n} 行 / 页</option>)}</Select><Button size="sm" disabled={busy || page.page <= 1} onClick={() => { if (table) void operation(() => browse(table, page.page - 1)); }}>上一页</Button><span>第 {page.page} 页</span><Button size="sm" disabled={busy || !page.hasMore} onClick={() => { if (table) void operation(() => browse(table, page.page + 1)); }}>下一页</Button><Button size="sm" disabled={busy} onClick={() => { if (table) { setQuery(`SELECT * FROM ${quote(table.schema, c)}.${quote(table.name, c)} LIMIT 100;`); setView("query"); } }}>在查询中打开</Button></div>
				<details className="shrink-0 text-xs text-faint"><summary className="cursor-pointer">表结构 · 字段类型 / 主键 / 可空</summary><div className="mt-2 flex max-h-32 flex-wrap gap-2 overflow-y-auto">{page.tableColumns.map(col => <span key={col.name} className="rounded-lg bg-panel-2 px-2 py-1 font-mono">{col.name}: {col.type || "ANY"}{col.primaryKey ? " · PK" : ""}{!col.nullable ? " · NOT NULL" : ""}</span>)}</div></details>
			</> : !busy && <div className="m-auto text-sm text-muted">当前连接没有可浏览的数据表</div>}</div>
		</> : <div className="flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col gap-4 px-5 py-4">
				<div className="shrink-0 overflow-hidden rounded-xl border border-border bg-surface-raised" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!busy) void run(); } }}>
					<div className="flex items-center gap-2 border-b border-border px-3 py-1.5"><span className="flex-1 font-mono text-xs">SQL</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void format()}>格式化</Button><Button size="sm" variant="ghost" disabled={busy || !sql.trim()} onClick={() => void saveQuery()}>保存查询</Button></div>
					<div className="h-48"><Suspense fallback={<div className="p-4 text-muted">加载 SQL 编辑器…</div>}><CodeEditor path="query.sql" value={sql} editable={!busy} onChange={setSql} revision={sqlRevision} onSave={() => void saveQuery()} onRun={() => { if (!busy) void run(); }} /></Suspense></div>
					<div className="flex items-center gap-3 border-t border-border px-3 py-2"><Button size="sm" variant="primary" disabled={busy || !sql.trim()} onClick={() => void run()}>运行</Button><kbd className="text-xs text-faint">Ctrl / ⌘ + Enter</kbd><span className="ml-auto text-xs text-faint">单条 SQL · 30 秒超时 · 最多 5,000 行</span></div>
				</div>
				<div className="flex items-center gap-2"><span className="text-[13px] font-semibold">结果</span>{result && <><Badge tone="ok">{result.rows.length} 行</Badge><span className="text-xs text-faint">{result.durationMs} ms{!result.readOnly ? ` · 影响 ${result.affectedRows} 行` : ""}</span>{result.truncated && <Badge tone="warn">仅显示前 5,000 行</Badge>}</>}<div className="flex-1" /><Button size="sm" variant="ghost" disabled={!result?.columns.length} onClick={() => { if (result) void navigator.clipboard.writeText(databaseCsv(result.columns, result.rows)).then(() => pushNotice("info", "已复制 CSV")).catch(e => pushNotice("error", errorText(e))); }}>复制为 CSV</Button></div>
				{result ? <ResultGrid result={result} /> : <div className="flex flex-1 items-center justify-center rounded-xl border border-border text-xs text-faint">运行 SQL 后在这里查看结果</div>}
			</div>
			<aside className="w-64 shrink-0 overflow-y-auto border-l border-border p-4">
				<div className="flex items-center gap-2"><span className="flex-1 text-[13px] font-semibold">历史记录</span><Badge>{history.length}</Badge><Button size="sm" variant="link" disabled={busy || !history.length} onClick={() => void (async () => { if (await askConfirm({ title: "清空查询历史", message: "仅清除当前连接的历史记录，不影响数据库。" })) { await api.database.clearHistory(c.id); await refreshHistory(); } })().catch(e => pushNotice("error", errorText(e)))}>清空</Button></div>
				<div className="mt-2 max-h-72 divide-y divide-border overflow-y-auto">{history.map(h => <button key={h.id} type="button" disabled={busy} title={h.error || h.sql} className="block w-full py-3 text-left hover:bg-panel-2" onClick={() => setQuery(h.sql)}><span className={`mr-2 ${h.ok ? "text-accent-strong" : "text-err"}`}>{h.ok ? "✓" : "✕"}</span><span className="font-mono text-xs break-all text-muted">{h.sql.slice(0, 100)}</span><span className="mt-1 block text-[11px] text-faint">{new Date(h.createdAt).toLocaleString()} · {h.durationMs} ms</span></button>)}</div>
				<div className="mt-4 border-t border-border pt-4"><div className="text-[13px] font-semibold">收藏的查询</div>{saved.map(q => <div key={q.id} className="flex items-center gap-2 border-b border-border py-3"><button type="button" disabled={busy} className="min-w-0 flex-1 truncate text-left text-xs text-muted hover:text-primary" title={q.sql} onClick={() => setQuery(q.sql)}>★ {q.name}</button><button type="button" disabled={busy} aria-label={`删除收藏 ${q.name}`} className="text-faint hover:text-err" onClick={() => void api.database.removeQuery(q.id).then(refreshHistory).catch(e => pushNotice("error", errorText(e)))}>×</button></div>)}</div>
				<p className="mt-5 text-xs leading-5 text-faint">查询历史保存在本机，SQL 可能含敏感信息。只读分类只是辅助，权限由数据库事务强制限制；写操作必须单独确认。</p>
			</aside>
		</div>}
	</div>;
}
