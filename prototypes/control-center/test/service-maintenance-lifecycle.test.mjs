import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { processAlive, processBirth, acquireProcessLease } from '../process-lease.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { DaemonSupervisor } from '../daemon-supervisor.mjs';

const cli = fileURLToPath(new URL('../service-cli.mjs', import.meta.url));
const supervisor = fileURLToPath(new URL('../daemon-supervisor.mjs', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
async function until(check, message, timeout = 15000) {
  const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await delay(25); } throw new Error(message);
}
async function port() { const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rna-service-maintenance-')), stateFile = join(root, 'state.json'), service = `${stateFile}.service`;
  mkdirSync(service); writeFileSync(stateFile, JSON.stringify({ version: 2, tasks: [], events: [], sessions: [] }));
  const config = { schemaVersion: 1, stateFile, port: 64538, command: process.execPath, manager: 'session', helperDescriptors: [] };
  atomicWrite(join(service, 'config.json'), JSON.stringify(config));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invoke = async (args, env = {}) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, RNA_AGENT_STATE: stateFile, RNA_AGENT_PORT: String(config.port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(timeout);
    return { code, stderr, value: code === 0 && stdout.trim() ? JSON.parse(stdout) : null };
  };
  const maintenance = (changes = {}) => { const value = { schemaVersion: 1, id: randomUUID(), phase: 'draining', held: true, owner: { pid: process.pid, birth: processBirth(process.pid) }, ...changes }; atomicWrite(join(service, 'maintenance.json'), JSON.stringify(value)); return value; };
  return { root, stateFile, service, config, invoke, maintenance };
}

test('held maintenance blocks every service mutation but status stays readable', async t => {
  const f = fixture(t), held = f.maintenance();
  const before = readFileSync(join(f.service, 'config.json'));
  for (const action of ['start', 'stop', 'restart', 'install', 'uninstall', 'run']) {
    const result = await f.invoke(['service', action], { RNA_MAINTENANCE_OPERATION: '' });
    assert.notEqual(result.code, 0, action); assert.match(result.stderr, /维护期间/);
  }
  const status = await f.invoke(['service', 'status']); assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(readFileSync(join(f.service, 'config.json')), before); assert.equal(json(join(f.service, 'maintenance.json')).id, held.id);
});

test('the exact live maintenance owner authorizes its subordinate service stop', async t => {
  const f = fixture(t), held = f.maintenance();
  const wrong = await f.invoke(['service', 'stop'], { RNA_MAINTENANCE_OPERATION: randomUUID() }); assert.notEqual(wrong.code, 0);
  const result = await f.invoke(['service', 'stop'], { RNA_MAINTENANCE_OPERATION: held.id });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.value.phase, 'stopped'); assert.equal(result.value.lastDaemonExit, null);
  assert.equal(json(join(f.service, 'maintenance.json')).held, true, 'service stop cannot release the maintenance admission gate');
});

test('an operation id cannot authorize control after owner identity changes', async t => {
  const f = fixture(t), held = f.maintenance({ owner: { pid: process.pid, birth: 'a different OS process birth' } });
  const result = await f.invoke(['service', 'stop'], { RNA_MAINTENANCE_OPERATION: held.id });
  assert.notEqual(result.code, 0); assert.match(result.stderr, /维护期间/); assert.equal(existsSync(join(f.service, 'intent.json')), false);
});

test('mutation checks happen inside the existing operation lease', async t => {
  const f = fixture(t), held = f.maintenance(); const release = await acquireProcessLease(join(f.service, 'operation.lock'));
  try {
    const result = await f.invoke(['service', 'stop'], { RNA_MAINTENANCE_OPERATION: held.id });
    assert.notEqual(result.code, 0); assert.match(result.stderr, /排他锁|进程/); assert.equal(existsSync(join(f.service, 'intent.json')), false);
  } finally { release(); }
});

test('malformed maintenance refuses mutation and still permits operational status', async t => {
  const f = fixture(t); atomicWrite(join(f.service, 'maintenance.json'), JSON.stringify({ schemaVersion: 1, id: 'wrong', held: false }));
  assert.notEqual((await f.invoke(['service', 'stop'])).code, 0);
  assert.equal((await f.invoke(['service', 'status'])).code, 0);
});

test('held maintenance also excludes independent endurance control', async t => {
  const f = fixture(t); f.maintenance();
  for (const action of ['start', 'stop']) { const result = await f.invoke(['endurance', action], { RNA_MAINTENANCE_OPERATION: '' }); assert.notEqual(result.code, 0); assert.match(result.stderr, /维护期间/); }
  assert.equal((await f.invoke(['endurance', 'status'])).code, 0);
});

test('completed unheld maintenance does not block ordinary service operations', async t => {
  const f = fixture(t); f.maintenance({ held: false, phase: 'completed', owner: null });
  const result = await f.invoke(['service', 'stop'], { RNA_MAINTENANCE_OPERATION: '' }); assert.equal(result.code, 0, result.stderr);
});

test('service stop cannot report a stale exit as this operation’s clean daemon receipt', async t => {
  const f = fixture(t); atomicWrite(join(f.service, 'status.json'), JSON.stringify({ phase: 'stopped', updatedAt: new Date().toISOString(), childPid: null, runId: 'old', generation: 'old-generation', lastDaemonExit: { pid: 123, generation: 'old-generation', code: 0, signal: null, at: new Date().toISOString() } }));
  const result = await f.invoke(['service', 'stop']); assert.equal(result.code, 0, result.stderr);
  assert.equal(result.value.stoppedDaemon, null); assert.equal(result.value.lastDaemonExit, null);
});

const daemonSource = `import http from 'node:http';
const server=http.createServer((q,r)=>r.end(JSON.stringify({ok:true,heartbeatAt:new Date().toISOString(),memory:{rss:1000},process:{pid:process.pid,supervisorRunId:process.env.RNA_AGENT_SUPERVISOR_RUN,generation:process.env.RNA_AGENT_GENERATION}})));
process.on('SIGTERM',()=>{if(process.env.FIXTURE_IGNORE_TERM!=='1')server.close(()=>process.exit(0));});
server.listen(Number(process.env.RNA_AGENT_PORT),'127.0.0.1');`;

for (const force of [false, true]) test(`service stop preserves the actual ${force ? 'forced' : 'clean'} daemon exit across cleanup supervisor replacement`, async t => {
  const f = fixture(t), daemon = join(f.root, 'daemon.mjs'); writeFileSync(daemon, daemonSource);
  f.config.port = await port(); Object.assign(f.config, { args: [daemon], cwd: f.root, pollMs: 50, healthTimeoutMs: 1000, startupGraceMs: 10000, shutdownGraceMs: 200, env: { FIXTURE_IGNORE_TERM: force ? '1' : '0' } });
  atomicWrite(join(f.service, 'config.json'), JSON.stringify(f.config)); atomicWrite(join(f.service, 'intent.json'), JSON.stringify({ enabled: true }));
  const child = spawn(process.execPath, [supervisor, join(f.service, 'config.json')], { env: { ...process.env, RNA_MAINTENANCE_OPERATION: '' }, stdio: 'ignore' });
  let ownedPid;
  t.after(async () => { if (processAlive(child.pid)) child.kill('SIGTERM'); if (ownedPid && processAlive(ownedPid)) { try { process.kill(-ownedPid, 'SIGKILL'); } catch {} } await until(() => !processAlive(child.pid), 'fixture supervisor exit', 5000).catch(() => child.kill('SIGKILL')); });
  await until(() => existsSync(join(f.service, 'status.json')) && json(join(f.service, 'status.json')).phase === 'running', 'isolated daemon ready');
  const before = json(join(f.service, 'status.json')); ownedPid = before.childPid;
  const result = await f.invoke(['service', 'stop']); assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.value.stoppedDaemon, { pid: ownedPid, generation: before.generation });
  assert.equal(result.value.lastDaemonExit.pid, ownedPid); assert.equal(result.value.lastDaemonExit.generation, before.generation);
  assert.equal(result.value.lastDaemonExit.code, force ? null : 0); assert.equal(result.value.lastDaemonExit.signal, force ? 'SIGKILL' : null);
  assert.ok(Number.isFinite(Date.parse(result.value.lastDaemonExit.at))); assert.equal(processAlive(ownedPid), false);
  assert.notEqual(json(join(f.service, 'status.json')).runId, before.runId, 'cleanup writes its own supervisor identity');
});

test('service install/start/run cannot use a staged restoration as a runnable state binding', async t => {
  const f = fixture(t); atomicWrite(join(f.root, 'restoration.json'), JSON.stringify({ schemaVersion: 1, sourceStateFile: '/original/state.json', stagingOnly: true }));
  for (const action of ['install', 'start', 'run', 'restart']) { const result = await f.invoke(['service', action]); assert.notEqual(result.code, 0, action); assert.match(result.stderr, /stag|暂存|恢复|迁移/i); }
  assert.equal((await f.invoke(['service', 'status'])).code, 0);
  assert.equal((await f.invoke(['service', 'stop'])).code, 0, 'Stopping an existing service is still permitted');
});

test('direct supervisor startup also refuses a staged state and releases a supplied startup lease', async t => {
  const f = fixture(t); atomicWrite(join(f.root, 'restoration.json'), JSON.stringify({ schemaVersion: 1, sourceStateFile: '/original/state.json', stagingOnly: true }));
  const instance = new DaemonSupervisor(f.config); let released = 0;
  await assert.rejects(() => instance.start({ lease: () => { released++; } }), error => error.code === 'checkpoint_staging_only');
  assert.equal(released, 1); assert.equal(instance.child, null); assert.equal(existsSync(join(f.service, 'supervisor.lock')), false);
});

test('service status does not create service metadata for an unused state', async t => {
  const f = fixture(t); rmSync(f.service, { recursive: true });
  const result = await f.invoke(['service', 'status']);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.value.phase, 'not_installed'); assert.equal(existsSync(f.service), false);
});

test('service control refuses a linked service root before creating operation metadata', async t => {
  const f = fixture(t), outside = join(f.root, 'outside'); mkdirSync(outside); rmSync(f.service, { recursive: true }); symlinkSync(outside, f.service, 'dir');
  for (const action of ['status', 'stop']) { const result = await f.invoke(['service', action]); assert.notEqual(result.code, 0); assert.match(result.stderr, /链接/); }
  assert.deepEqual(readdirSync(outside), []);
});

test('direct supervisor refuses linked control files and releases supplied ownership before side effects', async t => {
  const f = fixture(t), outside = join(f.root, 'outside.json'); writeFileSync(outside, '{}'); symlinkSync(outside, join(f.service, 'supervisor.lock'));
  const instance = new DaemonSupervisor({ ...f.config, stopOnly: true }); let released = 0;
  await assert.rejects(() => instance.start({ lease: () => { released++; } }), error => error.code === 'maintenance_unsafe_path');
  assert.equal(released, 1); assert.equal(instance.child, null); assert.equal(readFileSync(outside, 'utf8'), '{}'); assert.equal(existsSync(join(f.service, 'status.json')), false);
});
