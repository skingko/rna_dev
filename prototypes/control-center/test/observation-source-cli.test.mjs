import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
test('CLI source reads never change collection, explicit pause/resume send exact scoped control, failures stay visible', async t => {
  const source = { id: 'workspace', label: '项目目录变化', enabled: true, status: 'watching', summary: 'file\u009b metadata', stats: {received: 3} }, calls = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url === '/api/health') { response.setHeader('Content-Type','application/json'); response.end('{}'); return; }
    calls.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null }); response.setHeader('Content-Type','application/json');
    if (request.url.includes('missing')) { response.statusCode = 404; response.end('{"error":"项目不存在"}'); return; }
    if (request.method === 'PATCH') { source.enabled = JSON.parse(body).enabled; source.status = source.enabled ? 'initializing' : 'paused'; }
    response.end(JSON.stringify({projectId:'p-test',sources:[source]}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const run = (...args) => exec(process.execPath,[cli,...args],{env:{...process.env,RNA_AGENT_PORT:String(server.address().port)},timeout:10000});
  assert.match((await run('sources','p-test')).stdout,/正在关注/);
  const raw = (await run('sources','p-test','--json')).stdout; assert.equal(raw.includes('\u009b'),false); assert.deepEqual(JSON.parse(raw),{projectId:'p-test',sources:[source]});
  assert.ok(calls.every(row=>row.method==='GET')); assert.equal(source.enabled,true);
  assert.match((await run('source','p-test','workspace','pause')).stdout,/已暂停/); assert.deepEqual(calls.at(-1),{method:'PATCH',path:'/api/projects/p-test/sources/workspace',body:{enabled:false}});
  assert.equal(JSON.parse((await run('source','p-test','workspace','resume','--json')).stdout).sources[0].status,'initializing'); assert.deepEqual(calls.at(-1).body,{enabled:true});
  const previous=calls.length;
  for (const args of [['sources'],['sources','p-test','--unknown'],['source','p-test','workspace'],['source','p-test','outside','pause'],['source','p-test','workspace','stop'],['source','p-test','workspace','pause','extra']]) await assert.rejects(run(...args),error=>error.code===1&&/Rna Agent:/.test(error.stderr));
  assert.equal(calls.length,previous);
  await assert.rejects(run('sources','missing'),error=>error.code===1&&/项目不存在/.test(error.stderr));
  const help=(await run('help','all')).stdout; assert.match(help,/sources <项目ID>/); assert.match(help,/仅暂停\/恢复变化采集/);
});

test('chat sources commands stay in the same session, use explicit controls, and reject incomplete operations', async t => {
  let enabled = true; const calls = [], session = {id:'s-test',projectId:'p-test',title:'Source controls',mode:'build',model:'fixture',items:[],inbox:[]};
  const server = createServer(async (request,response) => {
    let body=''; for await (const chunk of request) body+=chunk;
    calls.push({method:request.method,path:request.url,body:body?JSON.parse(body):null});
    // The v2 session stream and its tail window, as chat follows a conversation (B9).
    if (request.url.startsWith('/api/v2/stream?session=s-test')) { response.writeHead(200,{'Content-Type':'text/event-stream'}); response.write(`event: hello\ndata: ${JSON.stringify({protocol:3,revision:1,seq:1,sessionId:session.id})}\n\n`); return; }
    response.setHeader('Content-Type','application/json');
    if (request.url==='/api/v2/sessions/s-test?window=tail') { response.end(JSON.stringify({...session,turns:[],revision:1})); return; }
    if (request.url==='/api/projects/p-test/sources/workspace'&&request.method==='PATCH') enabled=JSON.parse(body).enabled;
    response.end(JSON.stringify({projectId:'p-test',sources:[{id:'workspace',status:enabled?'watching':'paused',enabled}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const child=exec(process.execPath,[cli,'chat',session.id],{env:{...process.env,RNA_AGENT_PORT:String(server.address().port)},timeout:10000});
  child.child.stdin.end('/sources\n/source workspace pause\n/source workspace resume\n/source workspace stop\n/sources\n/quit\n');
  const result=await child; assert.match(result.stdout,/正在关注/); assert.match(result.stdout,/已暂停/); assert.match(result.stderr,/\/source workspace pause\|resume/);
  assert.deepEqual(calls.filter(row=>row.method==='PATCH').map(row=>row.body),[{enabled:false},{enabled:true}]);
  assert.equal(calls.some(row=>row.path.includes('/messages')||row.path.includes('/commands')),false); assert.equal(enabled,true);
});
