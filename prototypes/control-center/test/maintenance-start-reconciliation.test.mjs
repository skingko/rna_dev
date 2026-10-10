import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runMaintenanceOperation } from '../application-maintenance-worker.mjs';
import { persistMaintenance, readMaintenance } from '../application-maintenance-state.mjs';
import { processAlive, processBirth } from '../process-lease.mjs';

const host = new URL('../', import.meta.url), supervisor = fileURLToPath(new URL('daemon-supervisor.mjs', host));
async function freePort() { const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await new Promise(done => server.close(done)); return port; }
async function until(check, message, ms = 7000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await check()) return; await delay(20); } throw Error(message); }
const json = file => JSON.parse(readFileSync(file, 'utf8'));

async function fixture(t, { startupDelay = 300, wrongIdentity = false, wrongOperation = false, realCli = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-start-reconcile-'))), stateFile = join(root, 'state.json'), directory = `${stateFile}.service`, port = await freePort();
  mkdirSync(directory); writeFileSync(stateFile, JSON.stringify({ version: 2, settings: {}, sessions: [], tasks: [], events: [] }));
  const id = randomUUID(), identity = 'a'.repeat(64), config = { stateFile, port, command: process.execPath, cwd: realCli ? fileURLToPath(host).replace(/\/$/, '') : root, manager: 'session', pollMs: 40, healthTimeoutMs: 200, startupGraceMs: 60000, shutdownGraceMs: 500 };
  const row = { schemaVersion: 1, id, requestId: randomUUID(), kind: 'backup', args: {}, held: true, phase: 'switching', startedAt: new Date().toISOString(), stopped: true, checkpointCompleted: true,
    expected: { hostVersion: 'fixture-host', sdkVersion: 'fixture-sdk', runtimeIdentity: identity, stateVersion: 2, config, process: { pid: 1, instanceId: 'original', generation: 'original', supervisorRunId: 'original' } } };
  persistMaintenance(stateFile, row);
  const daemon = join(root, 'fixture-daemon.mjs');
  writeFileSync(daemon, `import http from 'node:http';
import { readFileSync } from 'node:fs';
import { acquireProcessLease } from ${JSON.stringify(new URL('process-lease.mjs', host).href)};
const state=process.env.RNA_AGENT_STATE, run=process.env.RNA_AGENT_SUPERVISOR_RUN, generation=process.env.RNA_AGENT_GENERATION;
const unlock=await acquireProcessLease(state+'.lock',{stateFile:state,supervisorRunId:run,generation});
const server=http.createServer((q,r)=>{const maintenance=JSON.parse(readFileSync(state+'.service/maintenance.json'));r.setHeader('content-type','application/json');r.end(JSON.stringify({ok:true,version:'fixture-host',sdkVersion:'fixture-sdk',runtimeIdentity:${JSON.stringify(wrongIdentity ? 'b'.repeat(64) : identity)},heartbeatAt:new Date().toISOString(),persistence:{failed:false},memory:{rss:1000},maintenance:{protocolVersion:1,held:true,operationId:${wrongOperation ? JSON.stringify(randomUUID()) : 'maintenance.id'}},process:{pid:process.pid,instanceId:'fixture-'+generation,supervisorRunId:run,generation,closing:false},workload:{activeWork:false}}));});
let stopping=false;process.on('SIGTERM',()=>{if(stopping)return;stopping=true;unlock();if(server.listening)server.close(()=>process.exit(0));else process.exit(0);});
setTimeout(()=>{if(!stopping)server.listen(Number(process.env.RNA_AGENT_PORT),'127.0.0.1');},${startupDelay});`);
  config.args = [daemon]; writeFileSync(join(directory, 'config.json'), JSON.stringify(config)); writeFileSync(join(directory, 'intent.json'), JSON.stringify({ enabled: true }));
  let child, starts = 0;
  const start = () => { starts++; child = spawn(process.execPath, [supervisor, join(directory, 'config.json')], { stdio: 'ignore' }); };
  t.after(async () => {
    if (!child && existsSync(join(directory, 'supervisor.lock'))) { const owner = json(join(directory, 'supervisor.lock')); if (owner.birth && processBirth(owner.pid) === owner.birth) { process.kill(owner.pid, 'SIGTERM'); await until(() => !processAlive(owner.pid), 'CLI fixture supervisor stop', 4000); } }
    if (child && processAlive(child.pid)) child.kill('SIGTERM');
    if (child) await until(() => !processAlive(child.pid), 'fixture supervisor stop', 4000).catch(() => child.kill('SIGKILL'));
    if (existsSync(`${stateFile}.lock`)) { const owner = json(`${stateFile}.lock`); if (owner.supervisorRunId && owner.stateFile === stateFile && processAlive(owner.pid)) try { process.kill(-owner.pid, 'SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  });
  const ready = () => until(() => existsSync(join(directory, 'status.json')) && ['running', 'degraded'].includes(json(join(directory, 'status.json')).phase), 'fixture ready');
  const io = { runtimeIdentity: () => identity, reconcileMs: 2500, verifyMs: 2500, service: async (_config, action) => { assert.equal(action, 'start'); start(); throw Object.assign(Error('fixture stdout lost; private path is not a receipt'), { code: 1 }); } };
  if (realCli) { delete io.service; io.reconcileMs = 15000; }
  return { stateFile, directory, row, ready, io, run: () => runMaintenanceOperation({ stateFile, id, io }), starts: () => starts, child: () => child };
}

test('actual service CLI timeout at 35 seconds reconciles a 36.5 second startup without a second spawn', { timeout: 60000 }, async t => {
  const f = await fixture(t, { realCli: true, startupDelay: 36500 }), result = await f.run();
  assert.equal(result.phase, 'completed'); assert.equal(result.held, false);
  const stages = result.attempts[0].stages, start = stages.find(row => row.name === 'start'), verify = stages.find(row => row.name === 'verify_successor');
  assert.equal(start.status, 'unconfirmed'); assert.equal(start.serviceStartup.status, 'unconfirmed');
  const wait = start.serviceStartup.stages.find(row => row.name === 'wait_status');
  assert.equal(wait.failureType, 'maintenance_start_receipt_timeout'); assert.ok(wait.elapsedMs >= 35000 && wait.elapsedMs < 45000);
  assert.equal(verify.reconciled, true); assert.ok(verify.elapsedMs < 15000);
  const status = json(join(f.directory, 'status.json')); assert.equal(status.restarts, 0);
  const events = readFileSync(join(f.directory, 'supervisor.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(row => row.event === 'daemon_started').length, 1);
});

test('real delayed HTTP startup after a failed start receipt completes by observing one owned successor', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.phase, 'completed'); assert.equal(result.held, false); assert.equal(f.starts(), 1);
  assert.equal(result.attempts[0].stages.find(row => row.name === 'start').status, 'unconfirmed');
  assert.equal(result.attempts[0].stages.at(-1).reconciled, true); assert.ok(result.attempts[0].stages.at(-1).elapsedMs >= 300);
  const startup = json(join(f.directory, 'status.json')).startup;
  assert.equal(startup.status, 'completed'); assert.deepEqual(startup.stages.map(row => row.name), ['recover_orphan', 'helpers', 'daemon_spawn', 'health']);
});

test('real successor with lost stdout beyond the observation window remains held and later resumes without start replay', async t => {
  const f = await fixture(t, { startupDelay: 650 }); f.io.reconcileMs = 0;
  const first = await f.run(); assert.equal(first.errorCode, 'maintenance_start_unconfirmed'); assert.equal(first.held, true); assert.equal(f.starts(), 1);
  await f.ready(); f.io.reconcileMs = 1000;
  const second = await f.run(); assert.equal(second.phase, 'completed'); assert.equal(second.attemptCount, 2); assert.equal(f.starts(), 1);
  assert.equal(second.attempts[0].status, 'failed'); assert.equal(second.attempts[1].status, 'completed');
});

for (const mismatch of ['wrongIdentity', 'wrongOperation']) test(`real ${mismatch} successor cannot release maintenance or be stopped/taken over by reconciliation`, async t => {
  const f = await fixture(t, { [mismatch]: true }), result = await f.run();
  assert.equal(result.errorCode, 'maintenance_identity_changed'); assert.equal(result.held, true); assert.equal(f.starts(), 1);
  assert.equal(processAlive(f.child().pid), true); assert.equal(readMaintenance(f.stateFile).phase, 'recovery_required');
  const again = await f.run(); assert.equal(again.held, true); assert.equal(f.starts(), 1); assert.equal(processAlive(f.child().pid), true);
});
