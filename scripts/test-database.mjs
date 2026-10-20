/** SQLite 离线真实回归；FLOWORK_TEST_DATABASES=1 时额外启动临时 Docker PostgreSQL/MySQL。 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { backendRuntime } from './web-build-options.mjs';
// Windows 会在 Electron 退出前保持 ASAR 文件句柄；由普通 Node 父进程负责最终清理。
if(process.env.FLOWORK_TEST_DATABASE_ASAR==='1' && !process.versions.electron){
 const {default:electron}=await import('electron');const base=await mkdtemp(resolve('out/test-database-asar-'));let code=1;
 try {const result=spawnSync(electron,[import.meta.filename],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',FLOWORK_DATABASE_TEST_ROOT:base}});code=result.status??1;}
 finally {await rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:200});await rm(`${base}.asar`,{force:true,maxRetries:5,retryDelay:200});}
 process.exit(code);
}
const runtime = await backendRuntime();
if (runtime.command !== process.execPath || (runtime.env.ELECTRON_RUN_AS_NODE && !process.env.ELECTRON_RUN_AS_NODE)) {
 const r=spawnSync(runtime.command,[import.meta.filename],{stdio:'inherit',env:{...process.env,...runtime.env}});process.exit(r.status??1);
}
const { DatabaseSync }=await import('node:sqlite');
const root=process.env.FLOWORK_DATABASE_TEST_ROOT??await mkdtemp(resolve('out/test-database-'));
await build({entryPoints:['src/core/database.ts','src/shared/database-sql.ts','src/core/hosts.ts'],outdir:root,bundle:true,platform:'node',format:'esm',packages:'external',alias:{'@shared':'./src/shared'},logLevel:'silent'});
let entryRoot=root;
const archive=`${root}.asar`;
if(process.env.FLOWORK_TEST_DATABASE_ASAR==='1'){
 assert.ok(process.versions.electron && process.env.FLOWORK_DATABASE_TEST_ROOT,'请从普通 Node 运行 FLOWORK_TEST_DATABASE_ASAR=1 node scripts/test-database.mjs，由父进程清理 ASAR');
 const visited=new Set();
 const copyDependency=async(name,from)=>{
  const req=createRequire(from);let directory=dirname(req.resolve(name)),file;
  while(true){try{file=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));if(file.name===name)break;}catch{}const parent=dirname(directory);assert.notEqual(parent,directory,`无法定位 ${name}`);directory=parent;}
  if(visited.has(directory))return;visited.add(directory);
  const destination=join(root,relative(resolve('.'),directory));assert.ok(destination.startsWith(root));await mkdir(dirname(destination),{recursive:true});await cp(directory,destination,{recursive:true});
  for(const child of Object.keys(file.dependencies??{})){try{await copyDependency(child,join(directory,'package.json'));}catch(e){if(!file.optionalDependencies?.[child])throw e;}}
 };
 for(const name of ['pg','pg-cursor','mysql2'])await copyDependency(name,import.meta.filename);
 await writeFile(join(root,'package.json'),'{"type":"module"}');
 const {createPackage}=await import('@electron/asar');await createPackage(root,archive);entryRoot=archive;
 console.log(`ASAR / Electron 实际执行验证（${visited.size} 个独立数据库生产依赖）`);
}
const {DatabaseManager}=await import(pathToFileURL(join(entryRoot,'core/database.js')).href);
const {HostStore}=await import(pathToFileURL(join(entryRoot,'core/hosts.js')).href);
const {inspectSql,databaseCsv}=await import(pathToFileURL(join(entryRoot,'shared/database-sql.js')).href);
const state=join(root,'state.json'), fixture=join(root,'fixture.db');
const hostStore=new HostStore(join(root,'hosts.json'));
const codec={available:()=>true,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString()};
const manager=new DatabaseManager(hostStore,codec,state);
const input={kind:'sqlite',file:fixture,name:'回归数据库',readOnly:true};
let n=0;
const test=async(name,fn)=>{await fn();console.log(`✓ ${name}`);n++;};
let c;
const containers=[];
const docker=(args,timeout=180000)=>execFileSync('docker',args,{encoding:'utf8',timeout,stdio:['ignore','pipe','pipe']}).trim();
try {
 const db=new DatabaseSync(fixture);
 try { db.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT, amount REAL, big INTEGER); INSERT INTO orders VALUES (1,'paid',12.5,9223372036854775807),(2,'pending',4,NULL); CREATE VIEW paid AS SELECT * FROM orders WHERE status='paid'; CREATE TABLE "odd""table"("a""b" TEXT); INSERT INTO "odd""table" VALUES ('你好');`); } finally { db.close(); }
 await test('SQL 单语句检查、引号/注释、CTE 和写语句保守分类',async()=>{
  for(const sql of ['SELECT 1','-- test\nWITH x AS (SELECT 1) SELECT * FROM x','SELECT \'a;b\';','SELECT $$a;b$$','EXPLAIN SELECT 1','SELECT "update" FROM "t"'])assert.equal(inspectSql(sql).readOnly,true,sql);
  for(const sql of ['UPDATE t SET x=1','WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x','SELECT * INTO t FROM s','EXPLAIN ANALYZE DELETE FROM t'])assert.equal(inspectSql(sql).readOnly,false,sql);
  for(const sql of ['SELECT 1;DELETE FROM t','SELECT 1;;','BEGIN','COMMIT','SET transaction_read_only=off','PRAGMA query_only=off','ATTACH DATABASE \'x\' AS x','COPY x TO \'y\'','SELECT 1 /*!; DELETE FROM t */',"SELECT 'a\\';DELETE FROM t",'SELECT /* unfinished'])assert.throws(()=>inspectSql(sql),undefined,sql);
 });
 await test('CSV 转义、NULL、大整数与表格公式防护',async()=>{assert.equal(databaseCsv(['x'],[['a"b'],['=HYPERLINK("x")'],[null],[-1]]),'"x"\r\n"a""b"\r\n"\'=HYPERLINK(""x"")"\r\n""\r\n"-1"');});
 await test('SQLite 保存/重载、返回配置无密码、绝不自动创建数据库',async()=>{
  c=await manager.save(undefined,input);assert.equal(c.name,input.name);assert.ok(!('password' in c));assert.equal((await new DatabaseManager(hostStore,codec,state).list()).length,1);
  await assert.rejects(manager.save(undefined,{...input,file:join(root,'missing.db')}));await assert.rejects(manager.save(undefined,{...input,file:'relative.db'}));await assert.rejects(manager.save(undefined,{...input,sshHostId:'x'}));
 });
 await test('测试连接、枚举表/视图、字段结构与真实只读查询',async()=>{
  assert.ok((await manager.test(c.id,input,'test')).durationMs>=0);const ts=await manager.tables(c.id,'test');assert.ok(ts.some(t=>t.name==='paid'&&t.type==='view'));
  const p=await manager.browse({connectionId:c.id,table:{schema:'main',name:'orders',type:'table'},filter:"status='paid'",orderBy:'amount',descending:true},'test');assert.equal(p.rows.length,1);assert.equal(p.rows[0][3],'9223372036854775807');assert.equal(p.tableColumns[0].primaryKey,true);assert.equal(p.readOnly,true);
  const odd=await manager.browse({connectionId:c.id,table:{schema:'main',name:'odd"table',type:'table'}},'test');assert.equal(odd.rows[0][0],'你好');
 });
 await test('排序/分页/筛选边界与路径、表名注入拒绝',async()=>{
  await assert.rejects(manager.browse({connectionId:c.id,table:{schema:'main',name:'orders',type:'table'},orderBy:'amount; DROP TABLE orders'},'test'),/排序/);
  await assert.rejects(manager.browse({connectionId:c.id,table:{schema:'main',name:'orders',type:'table'},filter:'1); DELETE FROM orders; --'},'test'));
  await assert.rejects(manager.browse({connectionId:c.id,table:{schema:'main',name:'orders',type:'table'},page:-1},'test'));
  await assert.rejects(manager.browse({connectionId:c.id,table:{schema:'main',name:'orders"; DROP TABLE orders;--',type:'table'}},'test'),/不存在/);
 });
 await test('只读连接即使提供伪造确认凭证也不能写入',async()=>{
  await assert.rejects(manager.prepareWrite({connectionId:c.id,sql:'DELETE FROM orders'},'test'),/只读/);
  await assert.rejects(manager.query({connectionId:c.id,sql:'DELETE FROM orders',confirmationToken:'fake'},'test'),/只读/);
  assert.equal((await manager.query({connectionId:c.id,sql:'SELECT count(*) FROM orders'},'test')).rows[0][0],'2');
 });
 await test('写操作确认绑定 SQL、客户端和连接版本，只可消费一次',async()=>{
  c=await manager.save(c.id,{...input,readOnly:false});const sql="UPDATE orders SET status='paid' WHERE id=2";
  await assert.rejects(manager.query({connectionId:c.id,sql},'test'),/确认/);
  let {token}=await manager.prepareWrite({connectionId:c.id,sql},'test');await assert.rejects(manager.query({connectionId:c.id,sql,confirmationToken:token},'other'),/确认/);
  ({token}=await manager.prepareWrite({connectionId:c.id,sql},'test'));await assert.rejects(manager.query({connectionId:c.id,sql:sql+' ',confirmationToken:token},'test'),/确认/);
  ({token}=await manager.prepareWrite({connectionId:c.id,sql},'test'));await manager.save(c.id,{...input,name:'changed',readOnly:false});await assert.rejects(manager.query({connectionId:c.id,sql,confirmationToken:token},'test'),/确认/);
  ({token}=await manager.prepareWrite({connectionId:c.id,sql},'test'));assert.equal((await manager.query({connectionId:c.id,sql,confirmationToken:token},'test')).affectedRows,1);
  await assert.rejects(manager.query({connectionId:c.id,sql,confirmationToken:token},'test'),/确认/);
 });
 await test('可写连接的读查询仍受只读限制，最多返回 5,000 行',async()=>{
  const r=await manager.query({connectionId:c.id,sql:'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<6000) SELECT x FROM n'},'test');assert.equal(r.rows.length,5000);assert.equal(r.truncated,true);assert.equal(r.readOnly,true);
 });
 await test('超过返回上限的 SQLite 写操作中止并回滚，不会部分提交',async()=>{
  const write=async sql=>{const {token}=await manager.prepareWrite({connectionId:c.id,sql},'rollback');return manager.query({connectionId:c.id,sql,confirmationToken:token},'rollback');};
  await write('CREATE TABLE bulk(id INTEGER PRIMARY KEY)');
  await assert.rejects(write('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<6000) INSERT INTO bulk SELECT x FROM n RETURNING id'),/事务已中止/);
  assert.equal((await manager.query({connectionId:c.id,sql:'SELECT count(*) FROM bulk'},'test')).rows[0][0],'0');
 });
 await test('历史含成功/失败记录；收藏持久化、隔离、删除与清空',async()=>{
  await assert.rejects(manager.query({connectionId:c.id,sql:'SELECT * FROM missing_table'},'test'));
  const h=await manager.history(c.id);assert.ok(h.some(h=>h.ok));assert.ok(h.some(h=>!h.ok));
  const q=await manager.saveQuery(c.id,'订单','SELECT * FROM orders');assert.equal((await manager.saved(c.id))[0].id,q.id);await manager.removeQuery(q.id);assert.deepEqual(await manager.saved(c.id),[]);
  await manager.clearHistory(c.id);assert.deepEqual(await manager.history(c.id),[]);
 });
 await test('取消/超时真正终止 SQLite 长查询、互斥且后端继续可用',async()=>{
  const sql='WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n';
  const op=manager.query({connectionId:c.id,sql},'long');await new Promise(r=>setTimeout(r,200));
  await assert.rejects(manager.query({connectionId:c.id,sql:'SELECT 1'},'long'),/正在执行/);manager.cancel('long');await assert.rejects(op,/取消/);
  const timed=new DatabaseManager(hostStore,codec,state,200);await assert.rejects(timed.query({connectionId:c.id,sql},'timeout'),/超时/);timed.dispose();
  assert.equal((await manager.query({connectionId:c.id,sql:'SELECT 1'},'test')).rows[0][0],'1');
 });
 await test('系统加密凭据不出现在 Renderer/明文文件；保留、修改、清除与无法解密',async()=>{
  const p={kind:'postgres',host:'127.0.0.1',database:'test',user:'test',name:'secret',password:'regression-secret',readOnly:true};
  let a=await manager.save(undefined,p);assert.equal(a.hasPassword,true);assert.ok(!JSON.stringify(a).includes('regression-secret'));assert.ok(!(await readFile(state,'utf8')).includes('regression-secret'));
  a=await manager.save(a.id,{...p,password:undefined});assert.equal(a.hasPassword,true);
  const locked=new DatabaseManager(hostStore,undefined,state);await assert.rejects(locked.tables(a.id,'locked'),/无法解密/);
  a=await manager.save(a.id,{...p,password:''});assert.equal(a.hasPassword,false);await manager.remove(a.id);
 });
 await test('配置损坏时明确报错，不静默覆盖配置',async()=>{
  const file=join(root,'broken.json');await writeFile(file,'broken');const m=new DatabaseManager(hostStore,undefined,file);await assert.rejects(m.list(),/无法读取/);await assert.rejects(m.save(undefined,input),/无法读取/);assert.equal(await readFile(file,'utf8'),'broken');
 });
 if(process.env.FLOWORK_TEST_DATABASES==='1'){
  for(const kind of ['postgres','mysql']){
   const name=`flowork-database-test-${kind}-${process.pid}`;containers.push(name);
   console.log('启动隔离容器',name);
   const args=['run','-d','--rm','--name',name,'-p',`127.0.0.1::${kind==='postgres'?5432:3306}`];
   if(kind==='postgres')args.push('-e','POSTGRES_PASSWORD=flowork-test-only','-e','POSTGRES_DB=flowork','postgres:17-alpine');
   else args.push('-e','MYSQL_ROOT_PASSWORD=flowork-test-only','-e','MYSQL_DATABASE=flowork','mysql:8.4');
   docker(args,300000);const port=Number(docker(['port',name,kind==='postgres'?'5432':'3306']).split(':').at(-1));
   const p={kind,host:'127.0.0.1',port,database:'flowork',user:kind==='postgres'?'postgres':'root',password:'flowork-test-only',name:kind,readOnly:false};
   let ready=false,last;
   for(let i=0;i<80;i++){try{await manager.test(undefined,p,'net');ready=true;break;}catch(e){last=e;await new Promise(r=>setTimeout(r,1000));}}
   assert.ok(ready,`${kind} failed to start: ${last}`);
   const a=await manager.save(undefined,p);
   const runWrite=async sql=>{console.log(`  ${kind}: ${sql.slice(0,120)}`);const {token}=await manager.prepareWrite({connectionId:a.id,sql},'net');return manager.query({connectionId:a.id,sql,confirmationToken:token},'net');};
   await test(`${kind} 真实连接、确认 DDL/写入、表/结构、过滤与结果`,async()=>{
    await runWrite('CREATE TABLE orders(id INTEGER PRIMARY KEY, status VARCHAR(50), amount DECIMAL(10,2))');
    const insert=await runWrite("INSERT INTO orders VALUES (1,'paid',12.50),(2,'pending',4.00)");assert.equal(insert.affectedRows,2);
    const ts=await manager.tables(a.id,'net');const t=ts.find(t=>t.name==='orders');assert.ok(t);
    const r=await manager.browse({connectionId:a.id,table:t,filter:"status='paid'",orderBy:'id'},'net');assert.equal(r.rows.length,1);assert.equal(r.tableColumns[0].primaryKey,true);
    assert.equal((await manager.query({connectionId:a.id,sql:'SELECT * FROM orders'},'net')).rows.length,2);
   });
   await test(`${kind} TLS 失败时不静默降级或跳过证书验证`,async()=>{await assert.rejects(manager.test(undefined,{...p,tls:true},'tls'),/SSL|TLS|certificate|self.signed|证书/i);});
   await test(`${kind} 只读事务阻止副作用、错误恢复、结果限量、取消与超时`,async()=>{
    if(kind==='postgres'){
     await runWrite("CREATE FUNCTION mutate() RETURNS INTEGER LANGUAGE SQL AS $$INSERT INTO orders VALUES (3,'bad',0) RETURNING id$$");
     await assert.rejects(manager.query({connectionId:a.id,sql:'SELECT mutate()'},'net'),/read.only|只读/i);
     const r=await manager.query({connectionId:a.id,sql:'SELECT generate_series(1,6000)'},'net');assert.equal(r.rows.length,5000);assert.equal(r.truncated,true);
    } else {
     const mysql = await import('mysql2/promise'); const fixtureClient = await mysql.createConnection({host:p.host,port:p.port,user:p.user,password:p.password,database:p.database});
     try { await fixtureClient.query("CREATE FUNCTION mutate() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO orders VALUES (3,'bad',0); RETURN 3; END"); } finally { await fixtureClient.end(); }
     await assert.rejects(manager.query({connectionId:a.id,sql:'SELECT mutate()'},'net'),/read.only|只读/i);
     const r=await manager.query({connectionId:a.id,sql:'SELECT a.n FROM (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) a CROSS JOIN (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) b CROSS JOIN (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) d CROSS JOIN (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) e'},'net');assert.equal(r.rows.length,5000);assert.equal(r.truncated,true);
    }
    await assert.rejects(manager.query({connectionId:a.id,sql:'SELECT * FROM nonexistent'},'net'));
    const timed=new DatabaseManager(hostStore,codec,state,500);await assert.rejects(timed.query({connectionId:a.id,sql:kind==='postgres'?'SELECT pg_sleep(10)':'SELECT SLEEP(10)'},'timeout'),/超时/);timed.dispose();
    assert.equal((await manager.query({connectionId:a.id,sql:'SELECT count(*) FROM orders'},'net')).rows[0][0],'2');
   });
   if(kind==='postgres' && process.env.FLOWORK_TEST_DATABASE_SSH_IMAGE){
    await test('复用 SSH 主机真实隧道查询、关闭清理与主机密钥变化拒绝',async()=>{
     const sshName=`flowork-database-test-ssh-${process.pid}`;containers.push(sshName);
     docker(['run','-d','--rm','--name',sshName,'-p','127.0.0.1::22',process.env.FLOWORK_TEST_DATABASE_SSH_IMAGE]);
     docker(['exec',sshName,'sh','-c',"echo 'root:flowork-ssh-test-only' | chpasswd; printf '\\nPermitRootLogin yes\\nPasswordAuthentication yes\\n' >> /etc/ssh/sshd_config; kill -HUP 1"]);
     const sshPort=Number(docker(['port',sshName,'22']).split(':').at(-1));
     const config=join(root,'ssh_config');await writeFile(join(root,'known_hosts'),'');
     await writeFile(config,`Host *\n  UserKnownHostsFile ${join(root,'known_hosts').replace(/\\/g,'/')}\n  GlobalKnownHostsFile ${process.platform==='win32'?'NUL':'/dev/null'}\n`);
     const before=process.env.FLOWORK_SSH_CONFIG;process.env.FLOWORK_SSH_CONFIG=config;
     const h=await hostStore.add({name:'数据库测试隧道',host:'127.0.0.1',port:sshPort,user:'root',auth:'password',password:'flowork-ssh-test-only'});
     const dbHost=docker(['inspect','--format','{{.NetworkSettings.Networks.bridge.IPAddress}}',name]);
     const tunnelInput={...p,host:dbHost,port:5432,sshHostId:h.id,readOnly:true};
     let t;
     try{
      await new Promise(r=>setTimeout(r,1200));await manager.test(undefined,tunnelInput,'tunnel');t=await manager.save(undefined,tunnelInput);
      assert.equal((await manager.query({connectionId:t.id,sql:'SELECT count(*) FROM orders'},'tunnel')).rows[0][0],'2');
      assert.ok((await readFile(join(root,'known_hosts'),'utf8')).includes('ssh-'));
      docker(['exec',sshName,'sh','-c','rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && kill -HUP 1']);await new Promise(r=>setTimeout(r,1200));
      await assert.rejects(manager.tables(t.id,'tunnel'),/FLOWORK_HOST_KEY_CHANGED/);
     }finally{if(before===undefined)delete process.env.FLOWORK_SSH_CONFIG;else process.env.FLOWORK_SSH_CONFIG=before;if(t)await manager.remove(t.id);}
    });
   }
   await manager.remove(a.id);
  }
 }else console.log('跳过网络数据库集成：设置 FLOWORK_TEST_DATABASES=1 可启动隔离 Docker PostgreSQL / MySQL');
 await test('删除连接同步移除历史/收藏，但保留真实数据库文件',async()=>{await manager.remove(c.id);assert.deepEqual(await manager.list(),[]);assert.ok((await readFile(fixture)).byteLength>0);});
 console.log(`\nDATABASE REGRESSION OK：${n} 项通过（未调用模型）`);
}finally{
 manager.dispose();for(const name of containers){try{docker(['rm','-f',name],30000);}catch{}}
 await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});if(process.env.FLOWORK_TEST_DATABASE_ASAR!=='1')await rm(archive,{force:true});
}
