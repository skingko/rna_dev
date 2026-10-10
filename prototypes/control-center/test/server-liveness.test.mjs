import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DaemonSupervisor } from '../daemon-supervisor.mjs';
import { atomicWrite } from '../durable-files.mjs';

async function until(check, label, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result; }

test('real server IPC protects genuinely active runtime work during a held health route and returns to idle after completion', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-server-liveness-')), workspace = join(directory, 'project'); await mkdir(workspace);
  const stateFile = join(directory, 'state.json'), file = join(directory, 'fixture.mjs');
  await writeFile(file, `import {createServer} from ${JSON.stringify(new URL('../server.mjs', import.meta.url).href)};
import http from 'node:http';
const notify=(type,data={})=>process.send({type:'fixture',event:type,...data});
let response, holdHealth=false, requests=0;
const model=http.createServer(async(req,res)=>{for await(const chunk of req){};requests++;response=res;notify('request',{requests});});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const app=createServer({stateFile:process.env.RNA_AGENT_STATE,ticks:false});await app.initializer.close();
const provider=app.store.configurationService.provider(null,{name:'Loopback fixture',protocol:'openai',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',apiKey:'fixture-only',models:[{id:'fixture-model',contextWindow:32000,maxOutputTokens:500,reasoning:['off']}]});
app.store.configurationService.update({defaultModel:{providerId:provider.id,modelId:'fixture-model',reasoning:'off'},memory:{autoRecall:false,autoStore:false}});
const {session}=app.store.createProject({name:'IPC fixture',workspace:${JSON.stringify(workspace)},initiative:{enabled:false}});
const handler=app.server.listeners('request')[0];app.server.removeListener('request',handler);
app.server.on('request',(req,res)=>{if(holdHealth&&req.url==='/api/health')return;handler(req,res)});
await new Promise(resolve=>app.server.listen(Number(process.env.RNA_AGENT_PORT),'127.0.0.1',resolve));
process.on('message',message=>{if(message.command==='begin'){holdHealth=true;app.store.message(session.id,{text:'A controlled local fixture task',requestId:'liveness-work'});}
if(message.command==='release'){holdHealth=false;response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{delta:{content:'The local fixture finished.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\\n\\ndata: [DONE]\\n\\n');}
});
const check=setInterval(()=>{const current=app.store.state.sessions.find(s=>s.id===session.id);if(current.turns[0]?.status==='completed'&&!app.executor.running.size){clearInterval(check);notify('completed',{requests,status:current.turns[0].status,turns:current.turns.length});}},30);
process.on('SIGTERM',async()=>{clearInterval(check);model.closeAllConnections();model.close();await app.close();process.exit(0)});
notify('ready');
`);
  const supervisor = new DaemonSupervisor({ stateFile, port: await port(), command: process.execPath, args: [file], cwd: directory,
    pollMs: 150, healthTimeoutMs: 1600, startupGraceMs: 15000, unhealthyThreshold: 2, shutdownGraceMs: 3000, restartBaseMs: 100 });
  atomicWrite(supervisor.paths.intent, JSON.stringify({ enabled: true }));
  t.after(async () => { await supervisor.stop(); await supervisor.exitPromise; await rm(directory, { recursive: true, force: true }); });
  await supervisor.start();
  const events = [], heartbeats = []; const child = supervisor.child;
  child.on('message', message => { if (message.type === 'fixture') events.push(message); if (message.type === 'rna-daemon-liveness') heartbeats.push(message); });
  await until(() => supervisor.status.phase === 'running' && heartbeats.some(row => !row.activeWork), 'actual server reached idle heartbeat');
  // Startup grace is irrelevant to this experiment: expire it before holding
  // HTTP so only the authenticated real runtime heartbeat can protect work.
  supervisor.startedChildAt -= 16000; child.send({ command: 'begin' });
  await until(() => events.some(row => row.event === 'request') && heartbeats.some(row => row.activeWork), 'actual runtime sends its first provider request');
  await until(() => supervisor.restartDeferred === 'ACTIVE_WORK_LIVENESS', 'held HTTP is degraded while real execution remains protected');
  assert.equal(supervisor.child, child); assert.equal(supervisor.restarts, 0); assert.equal(supervisor.lastHealth, null);
  const log = (await readFile(join(supervisor.paths.directory, 'supervisor.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(log.some(row => row.event === 'daemon_restart_deferred')); assert.ok(!log.some(row => row.event === 'daemon_terminate'));
  const busySequence = heartbeats.findLast(row => row.activeWork).sequence; child.send({ command: 'release' });
  await until(() => events.some(row => row.event === 'completed') && heartbeats.some(row => row.sequence > busySequence && !row.activeWork) && supervisor.status.phase === 'running', 'completed task returns to healthy idle');
  assert.deepEqual(events.find(row => row.event === 'completed'), { type: 'fixture', event: 'completed', requests: 1, status: 'completed', turns: 1 });
  assert.equal(supervisor.child, child); assert.equal(supervisor.restarts, 0);
  assert.ok(heartbeats.every((row, i) => row.pid === child.pid && row.supervisorRunId === supervisor.runId && row.generation === supervisor.generation && Number.isSafeInteger(row.sentAtMonotonicMs) && (!i || row.sequence > heartbeats[i - 1].sequence)));
});
