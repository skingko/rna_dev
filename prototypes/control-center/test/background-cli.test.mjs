import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runBackgroundCommand, parseBackgroundArgs, backgroundStatus, backgroundTable } from '../cli-background.mjs';
import { completeCommand } from '../cli-interactive.mjs';

const fixture = () => ({ projectId: 'p', actions: [{ id: 'read-a', action: 'work', status: 'running', controlRevision: 3, content: '核对官方资料\n并整理引用', availableControls: ['pause', 'stop', 'steer'], controls: [] }, { id: 'read-b', action: 'work', status: 'paused', controlRevision: 7, content: '整理次要来源', availableControls: ['resume', 'stop', 'steer'], controls: [] }] });

test('background CLI uses exact project/action ID, host capability and revision; one GET and one explicit mutation', async () => {
  const calls = [], snapshot = fixture();
  const result = await runBackgroundCommand(['p', 'steer', 'read-a', '--text', '先核对引文', '--request-id', 'request-a', '--json'], async (...args) => {
    calls.push(args); return args[1] ? { action: snapshot.actions[0], receipt: { id: 'request-a', status: 'pending' } } : snapshot;
  });
  assert.deepEqual(calls, [['/projects/p/initiative/actions'], ['/projects/p/initiative/actions/read-a/control', 'POST', { action: 'steer', requestId: 'request-a', expectedRevision: 3, text: '先核对引文' }]]);
  assert.equal(result.json, true); assert.equal(result.result.receipt.status, 'pending'); assert.match(result.message, /回执为准/);
  assert.equal(snapshot.actions[1].status, 'paused');
});

test('background invalid syntax cannot reach network and action prefix cannot identify another action', async () => {
  let calls = 0;
  for (const args of [[], ['p', 'finish', 'read-a'], ['p', 'pause'], ['p', 'pause', 'read-a', '--text', 'text'], ['p', 'steer', 'read-a'], ['p', 'list', 'read-a'], ['p', 'list', '--revision', '0'], ['p', 'pause', '../read-a'], ['p', 'pause', 'read-a', '--revision', '-1'], ['p', 'pause', 'read-a', '--request-id', 'not valid'], ['p', 'steer', 'read-a', '--text', 'x'.repeat(4001)]]) {
    await assert.rejects(runBackgroundCommand(args, async () => { calls++; }));
  }
  assert.equal(calls, 0);
  await assert.rejects(runBackgroundCommand(['p', 'pause', 'read'], async () => { calls++; return fixture(); }), /不存在/);
  assert.equal(calls, 1);
});

test('background no-control state cannot dispatch and pause request never claims already paused', async () => {
  let mutations = 0;
  await assert.rejects(runBackgroundCommand(['p', 'resume', 'read-a'], async (path, method) => { if (method) mutations++; return fixture(); }), /不能 resume/);
  assert.equal(mutations, 0);
  assert.equal(backgroundStatus({ status: 'running', controls: [{ kind: 'pause', status: 'pending' }] }), '正在暂停');
  assert.equal(backgroundStatus({ status: 'running', controls: [{ kind: 'cancel', status: 'pending' }] }), '正在停止');
  assert.equal(backgroundStatus({ status: 'needs_review', controls: [{ kind: 'pause', status: 'rejected' }] }), '结果待核对');
  for (const [status, expected] of [['needs_review','结果待核对'], ['failed','未完成'], ['completed','已结束'], ['paused','已暂停']]) assert.equal(backgroundStatus({ status, controls: [{ kind: 'pause', status: 'pending' }] }), expected);
  assert.equal(backgroundTable(fixture().actions)[0].工作, '核对官方资料 并整理引用');
  assert.deepEqual(completeCommand('/back'), [['/background'], '/back']);
});

test('network failure retains explicit retry identity and revision; no automatic mutation replay', async () => {
  let mutations = 0;
  await assert.rejects(runBackgroundCommand(['p', 'pause', 'read-a', '--request-id', 'retry-same'], async (path, method) => {
    if (!method) return fixture(); mutations++; throw new Error('connection lost');
  }), error => /--request-id retry-same --revision 3/.test(error.message));
  assert.equal(mutations, 1);
  const snapshot = fixture(); snapshot.actions[0].status = 'paused'; snapshot.actions[0].controlRevision = 4; snapshot.actions[0].availableControls = ['resume'];
  const calls = [];
  await runBackgroundCommand(['p', 'pause', 'read-a', '--request-id', 'retry-same', '--revision', '3'], async (...args) => { calls.push(args); return args[1] ? { action: snapshot.actions[0], receipt: { id: 'retry-same', status: 'applied' } } : snapshot; });
  assert.deepEqual(calls[1][2], { action: 'pause', requestId: 'retry-same', expectedRevision: 3 });
  await assert.rejects(runBackgroundCommand(['p', 'pause', 'read-a'], async (_path, method) => { if (!method) return fixture(); throw Object.assign(new Error('stale'),{status:409}); }), error => !error.backgroundRetry && /查看最新状态/.test(error.message));
});

test('interactive background retry keeps original direction text, request ID and revision after a lost POST response', async t => {
  const controls = [], snapshot = fixture(), streams = new Set(), session = { id:'s',projectId:'p',title:'CLI retry',mode:'build',model:'fixture',modelConfig:{execution:'rna'},status:'idle',items:[],turns:[],inbox:[] };
  const server = createServer(async (req,res) => {
    // The v2 session stream and its tail window, as chat follows a conversation (B9).
    if (req.url.startsWith('/api/v2/stream?session=s')) { res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`event: hello\ndata: ${JSON.stringify({protocol:3,revision:1,seq:1,sessionId:session.id})}\n\n`);streams.add(res);res.on('close',()=>streams.delete(res));return; }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
    if(req.url.endsWith('/read-a/control')) { controls.push(data);if(controls.length===1){snapshot.actions[0].controlRevision=4;res.destroy();return;} }
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/api/v2/sessions/s?window=tail'?{...session,revision:1}:req.url.endsWith('/initiative/actions')?snapshot:req.url.endsWith('/read-a/control')?{action:snapshot.actions[0],receipt:{id:data.requestId,status:'pending'}}:{}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{for(const stream of streams)stream.end();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const child=promisify(execFile)(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'chat','s'],{env:{...process.env,RNA_AGENT_PORT:String(server.address().port)},timeout:15000});let errors='';child.child.stderr.on('data',chunk=>errors+=chunk);
  child.child.stdin.write('/background steer read-a 先核对官方来源，保留 引号 "example"\n');
  const deadline=Date.now()+8000;while(!errors.includes('/background retry read-a')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.match(errors,/\/background retry read-a/);assert.equal(controls.length,1);
  child.child.stdin.end('/background retry read-a\n/quit\n');const result=await child;
  assert.equal(controls.length,2);assert.deepEqual(controls[1],controls[0]);assert.equal(controls[0].expectedRevision,3);assert.equal(controls[0].text,'先核对官方来源，保留 引号 "example"');assert.match(result.stdout,/调整已提交/);
});

test('actual CLI sends typed background controls and offline help documents independent work', async t => {
  const requests = [], snapshot = fixture();
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    // The interface-language probe (GET /api/health) is not a command request; the count below is of what the command sent.
    if (req.url !== '/api/health') requests.push({ path: req.url, method: req.method, data });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.method === 'GET' ? snapshot : { action: { ...snapshot.actions[0], controls: [{ kind: 'pause', status: 'pending' }] }, receipt: { id: data.requestId, status: 'pending' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const invoke = (...args) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), ...args], { env: { ...process.env, RNA_AGENT_PORT: String(server.address().port) } });
  const list = await invoke('background', 'p'); assert.match(list.stdout, /read-a/); assert.doesNotMatch(list.stdout, /controlRevision|toolReceipts/);
  const paused = await invoke('background', 'p', 'pause', 'read-a', '--request-id', 'actual-cli', '--json');
  assert.equal(JSON.parse(paused.stdout).receipt.id, 'actual-cli');
  assert.deepEqual(requests.at(-1), { path: '/api/projects/p/initiative/actions/read-a/control', method: 'POST', data: { action: 'pause', requestId: 'actual-cli', expectedRevision: 3 } });
  const before = requests.length; await assert.rejects(invoke('background', 'p', 'pause', 'read-a', '--unknown')); assert.equal(requests.length, before);
  assert.match((await invoke('help', 'all')).stdout, /background.*pause\|resume\|stop/);
  assert.equal(parseBackgroundArgs(['p']).action, 'list');
});
