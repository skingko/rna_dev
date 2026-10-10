import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';

function fixture(t) { const dir=mkdtempSync(join(tmpdir(),'pi-forge-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'state.json'); }
test('任务转换、持久化和重启恢复保留进度',t=>{
  const file=fixture(t);const s=new Store(file);const a=s.create({title:'测试恢复'});s.tick();assert.equal(s.get().tasks[0].status,'running');assert.equal(s.get().tasks[0].progress,20);
  const recovered=new Store(file);assert.equal(recovered.get().tasks[0].status,'paused');assert.equal(recovered.get().tasks[0].progress,20);assert.ok(recovered.get().events.some(e=>e.type==='recovery'));
  recovered.task(a.id,{action:'resume'});for(let n=0;n<4;n++)recovered.tick();assert.equal(recovered.get().tasks[0].status,'succeeded');assert.equal(recovered.get().tasks[0].spend,.06);
  assert.throws(()=>recovered.task(a.id,{action:'resume'}),/不能/);recovered.deleteTask(a.id);assert.equal(new Store(file).get().tasks.length,0);
});
test('急停停止运行和队列，解除后不会自行恢复',t=>{
  const s=new Store(fixture(t));const a=s.create({title:'A'});s.create({title:'B'});s.tick();s.emergency(true);assert.ok(s.get().tasks.every(x=>x.status==='paused'));const before=s.get().usage.usd;s.tick();assert.equal(s.get().usage.usd,before);assert.throws(()=>s.task(a.id,{action:'resume'}),/急停/);s.emergency(false);s.tick();assert.ok(s.get().tasks.every(x=>x.status==='paused'));
});
test('模拟预算不足在扣费前停止，可提升额度并显式恢复',t=>{
  const s=new Store(fixture(t));const a=s.create({title:'预算',budget:.01});s.tick();assert.equal(s.get().tasks[0].status,'budget_exhausted');assert.equal(s.get().usage.usd,0);s.task(a.id,{budget:1});s.task(a.id,{action:'resume'});s.settings({tokenBudget:600});s.tick();assert.equal(s.get().usage.tokens,0);s.settings({tokenBudget:1000});s.task(a.id,{action:'resume'});s.tick();assert.equal(s.get().usage.tokens,620);s.tick();assert.equal(s.get().usage.tokens,620);
});
test('错误转换不写入状态；任意文本按数据保存',t=>{
  const s=new Store(fixture(t));const a=s.create({title:'<img src=x onerror=alert(1)>'});const before=s.get();assert.throws(()=>s.task(a.id,{action:'resume'}));assert.deepEqual(s.get(),before);assert.equal(s.get().tasks[0].title,'<img src=x onerror=alert(1)>');assert.throws(()=>s.settings({maxConcurrent:1.5}));assert.deepEqual(s.get(),before);
});

test('1000 demo ticks do not rewrite state or charge a foreground Rna session', t => {
  const store = new Store(fixture(t)), { session } = store.createProject({ name: 'Real session fixture' });
  store.mutate(state => {
    for (const project of state.projects) project.initiative.enabled = false;
    const target = state.sessions.find(row => row.id === session.id); target.status = 'running'; target.activeTurnId = 'real-turn';
    target.turns.push({ id: 'real-turn', source: 'user', status: 'running', modelConfig: { execution: 'rna' } });
  });
  const writes = store.persistence.writes, state = structuredClone(store.state);
  for (let tick = 0; tick < 1000; tick++) store.tick();
  assert.equal(store.persistence.writes, writes); assert.deepEqual(store.state, state);
  const task = store.create({ title: 'Actual demo work still progresses' }); store.tick();
  assert.equal(store.state.tasks.find(row => row.id === task.id).progress, 20); assert.equal(store.persistence.writes, writes + 2);
  assert.deepEqual(store.state.sessions.find(row => row.id === session.id), state.sessions.find(row => row.id === session.id));
});
test('损坏状态文件不会被静默重建',t=>{const file=fixture(t);writeFileSync(file,'{broken');assert.throws(()=>new Store(file),/避免覆盖/);});
test('技能配置与候选模拟晋升/回滚持久化，非法晋升不改变状态',t=>{
  const file=fixture(t);const s=new Store(file);s.toggle('skills','research',false);s.toggle('integrations','github',true);s.candidate('candidate-context-v2','promote');
  const reopened=new Store(file);assert.equal(reopened.get().skills.find(x=>x.id==='research').enabled,false);assert.equal(reopened.get().integrations.find(x=>x.id==='github').status,'not_connected');assert.equal(reopened.get().candidates[0].state,'promoted');
  const before=reopened.get();assert.throws(()=>reopened.candidate('candidate-context-v2','promote'));assert.deepEqual(reopened.get(),before);reopened.candidate('candidate-context-v2','rollback');assert.equal(new Store(file).get().candidates[0].state,'evaluated');
});
test('HTTP共享状态；Host/Origin/跨站写与JSON类型受校验',async t=>{
  const {server}=createServer({stateFile:fixture(t),ticks:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;
  const send=(path,options={})=>fetch(base+path,options);const post=(headers={})=>({method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({title:'API task'})});
  const created=await send('/api/tasks',post());assert.equal(created.status,201);const task=await created.json();assert.equal((await (await send('/api/state')).json()).tasks[0].id,task.id);
  assert.equal((await send('/api/tasks',post({origin:'https://evil.example'}))).status,403);
  assert.equal((await send('/api/tasks',post({'sec-fetch-site':'cross-site'}))).status,403);
  const badHost = await new Promise((resolve,reject) => {
    const req=request(`${base}/api/state`,{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
  });
  assert.equal(badHost,403);
  assert.equal((await send('/api/tasks',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await send('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:'[]'})).status,400);
  const html=await send('/');assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await html.text(),/Rna Agent/);
});
