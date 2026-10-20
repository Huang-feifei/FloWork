/**
 * 独立 Node 子进程执行数据库操作。代码作为 -e 传入，不依赖额外发布的 Worker 文件。
 * 凭据仅经 stdin；主进程可强制结束 SQLite 长查询，不会阻塞 Electron 主线程。
 * require 的基准由应用传入，打包后同样能解析 app.asar 内的生产依赖。
 */
export const DATABASE_RUNNER = String.raw`
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; if (input.length > 256000) process.exit(1); });
process.stdin.on('end', async () => {
 let close = async () => {}, commit = async () => {};
 const started = performance.now();
 try {
  const p = JSON.parse(input), c = p.connection;
  const load = createRequire(p.moduleBase);
  const ro = p.readOnly || c.readOnly;
  const maxRows = 5000;
  let bytes = 0;
  const cell = v => {
   if (v === null || v === undefined) return null;
   if (typeof v === 'bigint') return v.toString();
   if (typeof v === 'number' || typeof v === 'boolean') return v;
   if (Buffer.isBuffer(v) || v instanceof Uint8Array) v = '[binary ' + v.byteLength + ' bytes] ' + Buffer.from(v).subarray(0, 64).toString('hex');
   else if (v instanceof Date) v = v.toISOString();
   else if (typeof v === 'object') v = JSON.stringify(v);
   else v = String(v);
   return v.length > 65536 ? v.slice(0, 65536) + '…[单元格已截断]' : v;
  };
  const row = r => { const values = r.map(cell); bytes += Buffer.byteLength(JSON.stringify(values)); if (bytes > 12 * 1024 * 1024) throw Error('查询结果超过 12 MiB，请缩小查询范围'); return values; };
  const quote = s => c.kind === 'mysql' ? '\x60' + s.replace(/\x60/g, '\x60\x60') + '\x60' : '"' + s.replace(/"/g, '""') + '"';
  let execute;
  if (c.kind === 'sqlite') {
   const { DatabaseSync } = require('node:sqlite');
   const db = new DatabaseSync(c.file, { readOnly: ro, enableForeignKeyConstraints: true, allowExtension: false, timeout: 5000 });
   close = async () => db.close();
   if (ro) db.exec('PRAGMA query_only=ON');
   db.exec(ro ? 'BEGIN' : 'BEGIN IMMEDIATE');
   commit = async () => db.exec('COMMIT');
   execute = async (sql, params = [], limit = maxRows) => {
    const stmt = db.prepare(sql); stmt.setReturnArrays(true); stmt.setReadBigInts(true);
    const columns = stmt.columns().map(x => x.name);
    if (!columns.length) { const r = stmt.run(...params); return { columns, rows: [], affectedRows: Number(r.changes), truncated: false }; }
    const rows = []; let truncated = false;
    for (const r of stmt.iterate(...params)) { if (rows.length === limit) { truncated = true; break; } rows.push(row(r)); }
    return { columns, rows, affectedRows: ro ? 0 : Number(db.prepare('SELECT changes()').get()[0]), truncated };
   };
  } else if (c.kind === 'postgres') {
   const { Client } = load('pg'); const Cursor = load('pg-cursor');
   const client = new Client({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    ssl: c.tls ? { rejectUnauthorized: true, servername: c.tlsServername || c.host } : false,
    connectionTimeoutMillis: 10000, statement_timeout: 30000, application_name: 'FloWork', query_timeout: 32000 });
   close = async () => { await client.end(); };
   client.on('error', () => {});
   await client.connect();
   await client.query(ro ? 'BEGIN READ ONLY' : 'BEGIN');
   await client.query("SET LOCAL statement_timeout = '30s'");
   await client.query("SET LOCAL lock_timeout = '5s'");
   commit = async () => { await client.query('COMMIT'); };
   execute = async (sql, params = [], limit = maxRows) => {
    const cursor = client.query(new Cursor(sql, params, { rowMode: 'array' }));
    try {
     const values = await cursor.read(limit + 1);
     const columns = cursor._result.fields.map(f => f.name);
     return { columns, rows: values.slice(0, limit).map(row), affectedRows: cursor._result.rowCount || 0, truncated: values.length > limit };
    } finally { await cursor.close(); }
   };
  } else {
   const mysql = load('mysql2');
   const db = mysql.createConnection({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    ssl: c.tls ? { rejectUnauthorized: true, servername: c.tlsServername || c.host } : undefined,
    connectTimeout: 10000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, enableKeepAlive: true,
    infileStreamFactory: () => { throw Error('禁止 LOCAL INFILE'); } });
   let destroyed = false;
   db.on('error', () => {});
   close = async () => { if (!destroyed) db.destroy(); destroyed = true; };
   const simple = sql => new Promise((resolve, reject) => db.query(sql, e => e ? reject(e) : resolve()));
   await new Promise((resolve, reject) => db.connect(e => e ? reject(e) : resolve()));
   await simple('SET SESSION MAX_EXECUTION_TIME=30000');
   await simple('SET SESSION innodb_lock_wait_timeout=5');
   await simple(ro ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
   commit = async () => { if (!destroyed) await simple('COMMIT'); };
   execute = (sql, params = [], limit = maxRows) => new Promise((resolve, reject) => {
    let columns = [], rows = [], affectedRows = 0, done = false;
    const query = db.query({ sql, values: params, rowsAsArray: true, timeout: 30000 });
    const finish = truncated => { if (done) return; done = true; resolve({ columns, rows, affectedRows, truncated }); };
    query.on('fields', fields => { columns = fields ? fields.map(f => f.name) : []; });
    query.on('result', r => {
     if (done) return;
     if (!Array.isArray(r)) { affectedRows = r.affectedRows || 0; return; }
     try {
      if (rows.length === limit) { destroyed = true; db.destroy(); finish(true); }
      else rows.push(row(r));
     } catch (e) { destroyed = true; db.destroy(); done = true; reject(e); }
    });
    query.on('error', e => { if (!done) { done = true; reject(e); } });
    query.on('end', () => finish(false));
   });
  }
  let result;
  if (p.action === 'test') { await execute('SELECT 1'); result = { durationMs: Math.round(performance.now() - started) }; }
  else if (p.action === 'tables') {
   let r;
   if (c.kind === 'sqlite') r = await execute("SELECT 'main', name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
   else if (c.kind === 'postgres') r = await execute("SELECT table_schema, table_name, CASE WHEN table_type='VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name");
   else r = await execute("SELECT TABLE_SCHEMA, TABLE_NAME, IF(TABLE_TYPE='VIEW','view','table') FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME");
   result = r.rows.map(r => ({ schema: r[0], name: r[1], type: r[2] }));
  } else if (p.action === 'browse') {
   const t = p.table;
   if (c.kind === 'sqlite' && t.schema !== 'main') throw Error('只支持主 SQLite 数据库');
   const qualified = quote(t.schema) + '.' + quote(t.name);
   let meta;
   if (c.kind === 'sqlite') {
    const r = await execute('PRAGMA main.table_info(' + quote(t.name) + ')');
    meta = r.rows.map(r => ({ name: r[1], type: r[2], nullable: !Number(r[3]), primaryKey: !!Number(r[5]) }));
   } else if (c.kind === 'postgres') {
    const r = await execute("SELECT c.column_name,c.data_type,c.is_nullable,EXISTS(SELECT 1 FROM information_schema.key_column_usage k JOIN information_schema.table_constraints tc ON tc.constraint_name=k.constraint_name AND tc.constraint_schema=k.constraint_schema AND tc.table_name=k.table_name WHERE tc.constraint_type='PRIMARY KEY' AND k.table_schema=c.table_schema AND k.table_name=c.table_name AND k.column_name=c.column_name) FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position", [t.schema,t.name]);
    meta = r.rows.map(r => ({ name: r[0], type: r[1], nullable: r[2] === 'YES', primaryKey: r[3] }));
   } else {
    const r = await execute("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_KEY FROM information_schema.columns WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [t.schema,t.name]);
    meta = r.rows.map(r => ({ name: r[0], type: r[1], nullable: r[2] === 'YES', primaryKey: r[3] === 'PRI' }));
   }
   if (!meta.length) throw Error('表不存在或没有权限');
   if (p.orderBy && !meta.some(m => m.name === p.orderBy)) throw Error('排序字段不存在');
   const order = p.orderBy ? ' ORDER BY ' + quote(p.orderBy) + (p.descending ? ' DESC' : ' ASC') : meta.filter(m => m.primaryKey).length ? ' ORDER BY ' + meta.filter(m => m.primaryKey).map(m => quote(m.name)).join(',') : '';
   const filter = p.filter ? ' WHERE (' + p.filter + '\n)' : '';
   const r = await execute('SELECT * FROM ' + qualified + filter + order + ' LIMIT ' + (p.pageSize + 1) + ' OFFSET ' + ((p.page - 1) * p.pageSize), [], p.pageSize + 1);
   result = { ...r, rows: r.rows.slice(0,p.pageSize), tableColumns: meta, page:p.page, pageSize:p.pageSize, hasMore:r.rows.length > p.pageSize, truncated:false, readOnly:true, durationMs:Math.round(performance.now()-started) };
  } else {
   result = { ...await execute(p.sql), readOnly:ro, durationMs:Math.round(performance.now()-started) };
   if (result.truncated && !ro) throw Error('写操作返回行数过多，事务已中止，请添加更严格的条件');
  }
  await commit(); await close();
  process.stdout.write(JSON.stringify({ result }), () => process.exit(0));
 } catch (e) {
  try { await close(); } catch {}
  process.stdout.write(JSON.stringify({ error: e.message || String(e) }), () => process.exit(1));
 }
});
`;
