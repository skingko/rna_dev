import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedHelpers } from '../managed-helpers.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { processAlive, processBirth } from '../process-lease.mjs';

const moduleURL = new URL('../managed-helpers.mjs', import.meta.url).href;
const fixtureSource = `
import http from 'node:http'; import {readFileSync,appendFileSync} from 'node:fs'; import {spawn} from 'node:child_process';
const [directory,portText]=process.argv.slice(2); const port=Number(portText);
const record=(type,extra={})=>{try{appendFileSync(directory+'/events.jsonl',JSON.stringify({type,pid:process.pid,...extra})+'\\n')}catch{}};
const control=()=>{try{return JSON.parse(readFileSync(directory+'/control.json','utf8'))}catch{return{}}};
record('created');
if(process.env.RNA_MANAGED_HELPER_OWNER_FILE){const end=Date.now()+10000;let admitted=false;while(Date.now()<end){try{const owner=JSON.parse(readFileSync(process.env.RNA_MANAGED_HELPER_OWNER_FILE,'utf8'));if(owner.phase==='running'&&owner.pid===process.pid&&owner.token===process.env.RNA_MANAGED_HELPER_TOKEN&&owner.fingerprint===process.env.RNA_MANAGED_HELPER_FINGERPRINT&&owner.id===process.env.RNA_MANAGED_HELPER_ID){admitted=true;break}}catch{}await new Promise(r=>setTimeout(r,10))}if(!admitted){record('gate_expired');process.exit(75)}}
process.on('SIGTERM',()=>{record('term');if(!control().ignoreTerm)process.exit(0)});
let descendant;
const server=http.createServer((req,res)=>{
 const c=control(); if(c.hangPid===process.pid)return;
 if(c.grandchild&&!descendant){descendant=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});record('grandchild',{child:descendant.pid})}
 if(c.exitPid===process.pid){setTimeout(()=>process.exit(17),10);return}
 const body={ok:c.unready!==true,managedHelper:{id:process.env.RNA_MANAGED_HELPER_ID,token:c.wrongIdentity?'wrong':process.env.RNA_MANAGED_HELPER_TOKEN,fingerprint:process.env.RNA_MANAGED_HELPER_FINGERPRINT,pid:process.pid},...(c.embedding?{embedding:c.embedding}:{})};
 res.writeHead(c.unready?503:200,{'content-type':'application/json'});res.end(JSON.stringify(body));
});
const startup=control();
const firstStart=readFileSync(directory+'/events.jsonl','utf8').trim().split('\\n').filter(Boolean).length===1;
while(startup.holdFirstListen&&firstStart)await new Promise(r=>setTimeout(r,20));
if(startup.startupDelayMs)await new Promise(r=>setTimeout(r,startup.startupDelayMs));
server.listen(port,'127.0.0.1',()=>record('listening'));
if(control().noisy){process.stdout.write('x'.repeat(20000));const token=process.env.RNA_MANAGED_HELPER_TOKEN;process.stdout.write(token.slice(0,20));setTimeout(()=>process.stdout.write(token.slice(20)+'\\n'),10)}
`;
async function port() { const server = createNetServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function until(check, message, ms = 6000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await check()) return; await delay(20); } throw new Error(`Timed out: ${message}`); }
const policy = { unhealthyThreshold: 2, shutdownGraceMs: 120, killWaitMs: 1200, pipeCloseMs: 100, restartBaseMs: 40, restartMaxMs: 100, crashWindowMs: 6000, maxCrashes: 4, crashCooldownMs: 180, stableAfterMs: 60000 };
async function fixture(t, { initialControl = {}, overrides = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-managed-helper-')), helperPort = await port(), script = join(directory, 'helper.mjs'), descriptor = join(directory, 'helper.json');
  writeFileSync(script, fixtureSource); writeFileSync(join(directory, 'control.json'), JSON.stringify(initialControl));
  // Fault-specific tests override these. Ordinary process lifecycle tests must
  // not accidentally become 100 ms HTTP/200 ms cold-start performance tests.
  const config = { schemaVersion: 1, id: 'fixture-helper', command: process.execPath, args: [script, directory, String(helperPort)], cwd: directory, healthUrl: `http://127.0.0.1:${helperPort}/health`, healthIdentity: 'rna-helper-v1', healthTimeoutMs: 1000, startupGraceMs: 5000, ...overrides };
  atomicWrite(descriptor, JSON.stringify(config)); const pools = [], hosts = [];
  const create = (options = {}) => { const pool = new ManagedHelpers({ paths: { directory: join(directory, 'state-a.service') }, descriptors: [descriptor], policy, ...options,
    onFatal: error => { t.diagnostic(`helper-fatal ${JSON.stringify({ code: error.code, helperId: error.helperId, helpers: pool.status().helpers })}`); options.onFatal?.(error); } }); pools.push(pool); return pool; };
  const events = () => existsSync(join(directory, 'events.jsonl')) ? readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    for (const host of hosts) { try { host.kill('SIGKILL'); } catch {} }
    await Promise.allSettled(pools.map(pool => pool.stop()));
    for (const event of events()) for (const pid of [event.pid, event.child]) if (pid && processAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, helperPort, descriptor, config, create, hosts, events, control: value => atomicWrite(join(directory, 'control.json'), JSON.stringify(value)), owner: () => JSON.parse(readFileSync(`${descriptor}.managed/owner.json`, 'utf8')) };
}
async function healthy(pool) { await until(async () => { await pool.poll(); return pool.status().healthy; }, 'helper became healthy'); }

test('Darwin zombie-only group EPERM waits for its owned exit and does not stop a healthy peer', { skip: process.platform !== 'darwin' }, async t => {
  const a = await fixture(t, { overrides: { id: 'zombie-target' } }), b = await fixture(t, { overrides: { id: 'healthy-peer' } });
  const fatal = [], signalResults = [], signalReal = process.kill;
  const pool = a.create({ descriptors: [a.descriptor, b.descriptor], onFatal: error => fatal.push(error.code) });
  await pool.start(); await healthy(pool);
  const target = pool.helpers[0], child = target.child, peerPid = pool.status().helpers[1].pid;
  t.mock.method(process, 'kill', (pid, signal) => {
    try { return signalReal(pid, signal); }
    catch (error) { if (pid === -child.pid) signalResults.push({ signal, code: error.code }); throw error; }
  });
  target.terminate('HELPER_TEST_RETIRE');
  // Block this parent until the actual OS reports Z: SIGCHLD cannot yet be
  // reaped by Node, so its ChildProcess still appears live to the kill timer.
  let state = '', deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    state = childProcess.execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'state='], { encoding: 'utf8' }).trim();
    if (state.startsWith('Z')) break;
    childProcess.execFileSync('/bin/sleep', ['0.02']);
  }
  assert.match(state, /^Z/); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  target.signalChild('SIGKILL');
  assert.deepEqual(signalResults, [{ signal: 'SIGKILL', code: 'EPERM' }]);
  assert.equal(pool.stopping, false); assert.equal(processAlive(peerPid), true);
  await until(() => target.child === null, 'owned zombie reaped and failed signal reconciled');
  assert.deepEqual(fatal, []); assert.equal(pool.stopping, false);
  assert.match(readFileSync(`${a.descriptor}.managed/events.jsonl`, 'utf8'), /helper_signal_exit_reconciled/);
  await healthy(pool); assert.notEqual(pool.status().helpers[0].pid, child.pid); assert.equal(pool.status().helpers[1].pid, peerPid);
});

test('a real EPERM with no exit receipt remains bounded and fail-closed', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), fatal = [], signalReal = process.kill;
  const pool = f.create({ onFatal: error => fatal.push(error.code) }); await pool.start(); await healthy(pool);
  const helper = pool.helpers[0], child = helper.child;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -child.pid && signal !== 0) throw Object.assign(new Error('fixture: operation genuinely denied'), { code: 'EPERM' });
    return signalReal(pid, signal);
  });
  helper.terminate('HELPER_TEST_RETIRE');
  assert.equal(pool.stopping, false); assert.equal(processAlive(child.pid), true);
  await until(() => pool.stopping, 'unproven signal failure reaches its existing bounded deadline');
  assert.deepEqual(fatal, ['EPERM']); assert.equal(processAlive(child.pid), true); assert.equal(helper.restarts, 0);
  assert.ok(!readFileSync(`${f.descriptor}.managed/events.jsonl`, 'utf8').includes('helper_signal_exit_reconciled'));
  // This direct ChildProcess handle is only the test's own denied fixture.
  child.kill('SIGKILL'); await pool.stop();
});

test('an owned leader exit does not excuse EPERM while its descendant group remains alive', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { initialControl: { grandchild: true } }), fatal = [], signalReal = process.kill;
  const pool = f.create({ onFatal: error => fatal.push(error.code) }); await pool.start(); await healthy(pool);
  const child = pool.helpers[0].child, descendant = f.events().find(row => row.type === 'grandchild').child;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -child.pid && signal !== 0) throw Object.assign(new Error('fixture: remaining group cannot be signalled'), { code: 'EPERM' });
    return signalReal(pid, signal);
  });
  child.kill('SIGKILL'); await until(() => pool.stopping, 'remaining owned group keeps signal failure explicit');
  assert.deepEqual(fatal, ['EPERM']); assert.equal(processAlive(descendant), true);
  assert.ok(!readFileSync(`${f.descriptor}.managed/events.jsonl`, 'utf8').includes('helper_signal_exit_reconciled'));
  await pool.stop();
});

test('a missing new-spawn birth retires only that child, keeps a peer alive and recovers after confirmed group exit', async t => {
  const a = await fixture(t, { overrides: { id: 'identity-probe-target' } }), b = await fixture(t, { overrides: { id: 'unrelated-peer' } });
  const spawnReal = childProcess.spawn, execReal = childProcess.execFileSync, targetPids = new Set(), fatal = [];
  let failIdentity = true;
  t.mock.method(childProcess, 'spawn', (...args) => { const child = spawnReal(...args); if (args[2]?.env?.RNA_MANAGED_HELPER_ID === 'identity-probe-target') targetPids.add(child.pid); return child; });
  t.mock.method(childProcess, 'execFileSync', (program, args, options) => program === '/bin/ps' && targetPids.has(Number(args[1])) && failIdentity ? '' : execReal(program, args, options));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const pool = a.create({ descriptors: [a.descriptor, b.descriptor], onFatal: error => fatal.push(error.code) });
  await pool.start();
  const oldPid = [...targetPids][0];
  await until(async () => { await pool.poll(); return pool.status().helpers[1].healthy && !processAlive(oldPid); }, 'peer survives while unadmitted child is cleaned');
  const peerPid = pool.status().helpers[1].pid;
  assert.equal(pool.stopping, false); assert.deepEqual(fatal, []);
  assert.equal(a.events().some(row => row.type === 'listening' && row.pid === oldPid), false, 'Missing birth never publishes a running owner or starts business work');
  failIdentity = false; await healthy(pool);
  assert.notEqual(pool.status().helpers[0].pid, oldPid); assert.equal(pool.status().helpers[1].pid, peerPid); assert.equal(processAlive(oldPid), false);
  assert.ok(pool.status().helpers[0].restarts >= 1); assert.equal(pool.status().helpers[0].cleanupUncertain, false);
});

test('uncertain cleanup after birth failure is durably quarantined without delayed PID signals or another spawn', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), spawnReal = childProcess.spawn, execReal = childProcess.execFileSync, signalReal = process.kill, pids = new Set(), signals = [];
  t.mock.method(childProcess, 'spawn', (...args) => { const child = spawnReal(...args); if (args[2]?.env?.RNA_MANAGED_HELPER_ID === f.config.id) pids.add(child.pid); return child; });
  t.mock.method(childProcess, 'execFileSync', (program, args, options) => program === '/bin/ps' && pids.has(Number(args[1])) ? '' : execReal(program, args, options));
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < 0 && pids.has(-pid)) {
      signals.push({ pid, signal }); if (signal === 0) return true;
      // Force the previously load-dependent Darwin combination: the owned
      // leader exits on real TERM, its exit-time KILL returns EPERM, and the
      // group probe cannot confirm cleanup. This must retain local quarantine.
      if (signal === 'SIGKILL') throw Object.assign(new Error('fixture: group cleanup unconfirmed'), { code: 'EPERM' });
    }
    return signalReal(pid, signal);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const fatal = [], pool = f.create({ onFatal: error => fatal.push(error.code), policy: { ...policy, killWaitMs: 150 } }); await pool.start();
  await until(() => pool.status().helpers[0].cleanupUncertain, 'unconfirmed group is quarantined');
  assert.equal(pool.status().helpers[0].lastIssue.code, 'HELPER_START_CLEANUP_UNCERTAIN'); assert.equal(f.owner().phase, 'cleanup_uncertain');
  assert.equal(pool.stopping, false); assert.deepEqual(fatal, []); assert.equal(pool.status().healthy, false);
  assert.ok(signals.some(row => row.signal === 'SIGKILL')); assert.match(readFileSync(`${f.descriptor}.managed/events.jsonl`, 'utf8'), /helper_signal_cleanup_check/);
  const signalsAfterExit = signals.length;
  for (let i = 0; i < 20; i++) await pool.poll();
  assert.equal(pids.size, 1); assert.equal(signals.slice(signalsAfterExit).some(row => row.signal !== 0), false);
  await pool.stop(); const restarted = f.create(); await restarted.start(); await restarted.poll();
  assert.equal(restarted.status().helpers[0].cleanupUncertain, true); assert.equal(pids.size, 1, 'Restart cannot reinterpret unresolved PID as kill authority');
});

test('birth failure quarantine cannot excuse EPERM before the owned child has actually exited', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), spawnReal = childProcess.spawn, execReal = childProcess.execFileSync, signalReal = process.kill, pids = new Set(), fatal = [];
  t.mock.method(childProcess, 'spawn', (...args) => { const child = spawnReal(...args); if (args[2]?.env?.RNA_MANAGED_HELPER_ID === f.config.id) pids.add(child.pid); return child; });
  t.mock.method(childProcess, 'execFileSync', (program, args, options) => program === '/bin/ps' && pids.has(Number(args[1])) ? '' : execReal(program, args, options));
  t.mock.method(process, 'kill', (pid, signal) => { if (pid < 0 && pids.has(-pid) && signal !== 0) throw Object.assign(new Error('fixture: real permission failure'), { code: 'EPERM' }); return signalReal(pid, signal); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const pool = f.create({ onFatal: error => fatal.push(error.code), policy: { ...policy, killWaitMs: 150 } }); await pool.start();
  const child = pool.helpers[0].child;
  await until(() => pool.stopping, 'failed unadmitted child still needs a real exit receipt');
  assert.deepEqual(fatal, ['EPERM']); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert.equal(processAlive(child.pid), true);
  assert.ok(!readFileSync(`${f.descriptor}.managed/events.jsonl`, 'utf8').includes('helper_signal_cleanup_check'));
  child.kill('SIGKILL'); await pool.stop();
});

test('a temporary post-exec identity probe failure remains local and recovers with the same authenticated child', async t => {
  const f = await fixture(t), pool = f.create(); await pool.start();
  const pid = pool.status().helpers[0].pid, execReal = childProcess.execFileSync; let failIdentity = true;
  t.mock.method(childProcess, 'execFileSync', (program, args, options) => program === '/bin/ps' && Number(args[1]) === pid && failIdentity ? '' : execReal(program, args, options));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await until(() => f.events().some(row => row.type === 'listening'), 'helper listening'); await pool.poll();
  assert.equal(pool.stopping, false); assert.equal(pool.status().healthy, false); assert.equal(pool.status().helpers[0].lastIssue.code, 'HELPER_IDENTITY_UNAVAILABLE');
  failIdentity = false; await healthy(pool); assert.equal(pool.status().helpers[0].pid, pid); assert.equal(pool.status().helpers[0].restarts, 0);
});

test('authenticated 503 records bounded probe reasons; a transient failure recovers without restart while sustained failure still restarts', async t => {
  const f = await fixture(t), pool = f.create({ policy: { ...policy, unhealthyThreshold: 3 } }); await pool.start(); await healthy(pool);
  await delay(f.config.startupGraceMs); // Real elapsed startup grace, not a forced readiness bypass.
  const pid = pool.status().helpers[0].pid, token = f.owner().token;
  const embedding = { childAlive: true, cleanupUncertain: false, privateText: 'DO-NOT-LOG-CONTENT', readiness: { owner: { ok: true, code: 'EMBEDDING_PROBE_OK', backend: 'netstat', elapsedMs: 4 }, model: { ok: false, code: 'EMBEDDING_MODEL_TIMEOUT', elapsedMs: 1000, raw: token, message: 'DO-NOT-LOG-CONTENT' }, warmup: { ok: true, code: 'EMBEDDING_PROBE_OK', elapsedMs: 19437, dimensions: 1024, input: 'DO-NOT-LOG-CONTENT', embeddings: [1, 2, 3] }, resident: { ok: false, code: 'EMBEDDING_RESIDENT_MISSING', elapsedMs: 17, raw: token, model: 'DO-NOT-LOG-CONTENT' } } };
  f.control({ unready: true, embedding }); await pool.poll();
  let status = pool.status().helpers[0]; assert.equal(status.healthy, false); assert.equal(status.pid, pid); assert.equal(status.restarts, 0); assert.equal(status.lastIssue.httpStatus, 503); assert.deepEqual(status.lastIssue.healthDiagnostic.model, { code: 'EMBEDDING_MODEL_TIMEOUT', ok: false, elapsedMs: 1000 });
  assert.deepEqual(status.lastIssue.healthDiagnostic.warmup, { code: 'EMBEDDING_PROBE_OK', ok: true, elapsedMs: 19437, dimensions: 1024 });
  assert.deepEqual(status.lastIssue.healthDiagnostic.resident, { code: 'EMBEDDING_RESIDENT_MISSING', ok: false, elapsedMs: 17 });
  f.control({}); await healthy(pool); assert.equal(pool.status().helpers[0].pid, pid); assert.equal(pool.status().helpers[0].restarts, 0);
  f.control({ unready: true, embedding }); for (let index = 0; index < 3; index++) await pool.poll();
  await until(() => pool.status().helpers[0].restarts === 1, 'sustained failed readiness terminates owned helper');
  const events = readFileSync(`${f.descriptor}.managed/events.jsonl`, 'utf8'); assert.match(events, /EMBEDDING_MODEL_TIMEOUT/); assert.ok(!events.includes(token)); assert.ok(!events.includes('DO-NOT-LOG-CONTENT'));
  f.control({}); await healthy(pool); status = pool.status().helpers[0]; assert.notEqual(status.pid, pid); assert.equal(processAlive(pid), false);
});

test('503 diagnostics from the wrong identity are never accepted as authenticated failure evidence', async t => {
  const f = await fixture(t), pool = f.create(); await pool.start(); await healthy(pool);
  f.control({ unready: true, wrongIdentity: true, embedding: { readiness: { owner: { code: 'EMBEDDING_OWNER_PROBE_TIMEOUT', ok: false, elapsedMs: 1000 } } } }); await pool.poll();
  const issue = pool.status().helpers[0].lastIssue; assert.equal(issue.code, 'HELPER_IDENTITY_MISMATCH'); assert.equal(issue.healthDiagnostic, undefined); assert.equal(pool.status().healthy, false);
});
test('authenticated stale or pending readiness preserves the bounded aggregate reason without accepting arbitrary content', async t => {
  const f = await fixture(t), pool = f.create({ policy: { ...policy, unhealthyThreshold: 10 } }); await pool.start(); await healthy(pool);
  const pid = pool.status().helpers[0].pid, token = f.owner().token;
  const probes = Object.fromEntries(['owner', 'model', 'warmup', 'resident'].map(key => [key, { ok: true, code: 'EMBEDDING_PROBE_OK', elapsedMs: 10 }]));
  f.control({ unready: true, embedding: { readiness: { ...probes, code: 'EMBEDDING_PROBE_STALE', probing: true, ageMs: 2500, maxAgeMs: 2000, raw: token, message: 'DO-NOT-LOG-CONTENT' } } }); await pool.poll();
  let diagnostic = pool.status().helpers[0].lastIssue.healthDiagnostic;
  assert.deepEqual(diagnostic, { code: 'EMBEDDING_PROBE_STALE', probing: true, ageMs: 2500, maxAgeMs: 2000, ...probes });
  assert.equal(pool.status().helpers[0].healthy, false, 'Successful individual probes cannot override aggregate staleness');
  f.control({ unready: true, embedding: { readiness: { code: 'EMBEDDING_PROBE_PENDING', probing: true, ageMs: null, maxAgeMs: 2000 } } }); await pool.poll();
  assert.deepEqual(pool.status().helpers[0].lastIssue.healthDiagnostic, { code: 'EMBEDDING_PROBE_PENDING', probing: true, maxAgeMs: 2000 });
  f.control({ unready: true, embedding: { readiness: { owner: probes.owner, code: token, probing: 'true', ageMs: -1, maxAgeMs: 1e300, activeProbeStartedAt: 'DO-NOT-LOG-CONTENT' } } }); await pool.poll();
  diagnostic = pool.status().helpers[0].lastIssue.healthDiagnostic;
  assert.deepEqual(diagnostic, { owner: probes.owner });
  const events = readFileSync(`${f.descriptor}.managed/events.jsonl`, 'utf8'); assert.match(events, /EMBEDDING_PROBE_STALE/); assert.ok(!events.includes(token)); assert.ok(!events.includes('DO-NOT-LOG-CONTENT'));
  f.control({}); await healthy(pool); assert.equal(pool.status().helpers[0].pid, pid); assert.equal(pool.status().helpers[0].restarts, 0);
});
test('responsive authenticated pending readiness stays degraded without destroying loading progress; terminal failures require their own consecutive threshold', async t => {
  const f = await fixture(t), pool = f.create({ policy: { ...policy, unhealthyThreshold: 3 } }); await pool.start(); await healthy(pool);
  await delay(f.config.startupGraceMs);
  const pid = pool.status().helpers[0].pid;
  const success = { code: 'EMBEDDING_PROBE_OK', ok: true, elapsedMs: 10 };
  const embedding = readiness => ({ childAlive: true, cleanupUncertain: false, readiness });
  for (const readiness of [
    { code: 'EMBEDDING_PROBE_STALE', probing: true, ageMs: 3500, maxAgeMs: 2000, owner: success, model: success, warmup: success, resident: success },
    { code: 'EMBEDDING_PROBE_PENDING', probing: true, maxAgeMs: 2000 },
    { code: 'EMBEDDING_PROBE_FAILED', owner: success, model: success, warmup: { code: 'EMBEDDING_WARMUP_PENDING', ok: false, elapsedMs: 0 } }
  ]) {
    f.control({ unready: true, embedding: embedding(readiness) });
    for (let index = 0; index < 4; index++) await pool.poll();
    const status = pool.status().helpers[0];
    assert.equal(status.pid, pid); assert.equal(status.restarts, 0); assert.equal(status.healthy, false);
    assert.equal(status.phase, 'unhealthy'); assert.equal(status.restartDeferred, 'READINESS_PENDING'); assert.equal(status.restartableUnhealthy, 0);
  }
  f.control({ unready: true, embedding: embedding({ code: 'EMBEDDING_PROBE_FAILED', owner: success, model: success, warmup: { code: 'EMBEDDING_WARMUP_TIMEOUT', ok: false, elapsedMs: 60000 } }) });
  for (let index = 1; index <= 2; index++) { await pool.poll(); const status = pool.status().helpers[0]; assert.equal(status.pid, pid); assert.equal(status.restartableUnhealthy, index); assert.equal(status.restartDeferred, null); }
  await pool.poll(); await until(() => pool.status().helpers[0].restarts === 1, 'terminal cold-load failure still retires the owned process');
  f.control({}); await healthy(pool); assert.notEqual(pool.status().helpers[0].pid, pid); assert.equal(processAlive(pid), false);
});

test('unproven readiness or cleanup uncertainty cannot suppress normal helper failure recovery', async t => {
  const f = await fixture(t), pool = f.create({ policy: { ...policy, unhealthyThreshold: 3 } }); await pool.start(); await healthy(pool);
  await delay(f.config.startupGraceMs);
  const pid = pool.status().helpers[0].pid;
  for (const input of [
    { wrongIdentity: true, embedding: { childAlive: true, cleanupUncertain: false, readiness: { code: 'EMBEDDING_PROBE_STALE' } } },
    { embedding: { childAlive: false, cleanupUncertain: false, readiness: { code: 'EMBEDDING_PROBE_PENDING' } } },
    { embedding: { childAlive: true, cleanupUncertain: true, readiness: { code: 'EMBEDDING_PROBE_PENDING' } } }
  ]) {
    f.control({ unready: true, ...input }); await pool.poll();
    assert.equal(pool.status().helpers[0].restartDeferred, null);
  }
  await until(() => pool.status().helpers[0].restarts === 1, 'untrusted or unsafe failed readiness remains restartable');
  f.control({}); await healthy(pool); assert.notEqual(pool.status().helpers[0].pid, pid);
});
async function launchHost(f, { prepared = false, owner } = {}) {
  const source = prepared ? `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const owner=${JSON.stringify(owner)};writeFileSync(${JSON.stringify(`${f.descriptor}.managed/owner.json`)},JSON.stringify(owner));const child=spawn(${JSON.stringify(f.config.command)},${JSON.stringify(f.config.args)},{cwd:${JSON.stringify(f.directory)},detached:true,stdio:'ignore',env:{...process.env,RNA_MANAGED_HELPER_ID:owner.id,RNA_MANAGED_HELPER_TOKEN:owner.token,RNA_MANAGED_HELPER_FINGERPRINT:owner.fingerprint,RNA_MANAGED_HELPER_OWNER_FILE:${JSON.stringify(`${f.descriptor}.managed/owner.json`)}}});console.log(JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);`
    : `import {ManagedHelpers} from ${JSON.stringify(moduleURL)};const pool=new ManagedHelpers({descriptors:[${JSON.stringify(f.descriptor)}],policy:${JSON.stringify(policy)}});await pool.start();for(let i=0;i<50;i++){await pool.poll();if(pool.status().healthy)break;await new Promise(r=>setTimeout(r,20));}console.log(JSON.stringify(pool.status()));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] }); f.hosts.push(child); let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const value = await new Promise((resolve, reject) => { let raw = ''; const timer = setTimeout(() => reject(new Error(`host init timeout: ${stderr}`)), 6000); child.stdout.on('data', data => { raw += data; if (raw.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(raw.split('\n')[0])); } }); child.once('exit', () => { clearTimeout(timer); reject(new Error(`host exited: ${stderr}`)); }); });
  return { child, value };
}
async function killHost(child) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await done; }
function execWrapper(f) {
  const script = join(f.directory, 'exec-wrapper.sh');
  writeFileSync(script, `#!/bin/sh\nattempt=0\nwhile ! /usr/bin/grep -q '"phase": "running"' "$RNA_MANAGED_HELPER_OWNER_FILE" 2>/dev/null; do\n  attempt=$((attempt + 1))\n  [ "$attempt" -lt 200 ] || exit 75\n  /bin/sleep 0.02\ndone\nexec "$@"\n`);
  f.config.args = [script, process.execPath, ...f.config.args]; f.config.command = '/bin/sh'; atomicWrite(f.descriptor, JSON.stringify(f.config));
}

test('empty helper pools are healthy and strict descriptors reject unknown identity or remote endpoints', async t => {
  const empty = new ManagedHelpers(); assert.equal(empty.status().healthy, true); await empty.start(); await empty.stop();
  const f = await fixture(t); const invalid = join(f.directory, 'invalid.json');
  for (const extra of [{ healthIdentity: undefined }, { healthUrl: 'http://example.com/health' }, { command: 'python' }, { env: { TOKEN: 'not-allowed' } }]) {
    writeFileSync(invalid, JSON.stringify({ ...f.config, ...extra })); assert.throws(() => new ManagedHelpers({ descriptors: [invalid] }), { code: 'HELPER_INVALID_DESCRIPTOR' });
  }
});

test('owned helper start, nonce health, durable birth and idempotent stop do not expose the nonce', async t => {
  const f = await fixture(t), logs = [], pool = f.create({ log: (...args) => logs.push(args) }); await pool.start(); await healthy(pool);
  const state = pool.status(), owner = f.owner(); assert.equal(state.allReady, true); assert.equal(state.helpers[0].owned, true); assert.equal(state.helpers[0].pid, owner.pid); assert.ok(owner.birth); assert.ok(state.helpers[0].generation);
  assert.ok(!JSON.stringify({ state, logs }).includes(owner.token)); assert.ok(!readFileSync(`${f.descriptor}.managed/status.json`, 'utf8').includes(owner.token));
  const first = pool.stop(), second = pool.stop(); assert.equal(first, second); await first; assert.equal(processAlive(owner.pid), false); assert.equal(pool.status().helpers[0].phase, 'stopped');
});

test('two state directories cannot acquire the same helper lease and the loser cannot stop its owner', async t => {
  const f = await fixture(t), first = f.create(); await first.start(); await healthy(first); const pid = first.status().helpers[0].pid;
  const second = f.create({ paths: { directory: join(f.directory, 'state-b.service') } }); await assert.rejects(second.start(), { code: 'HELPER_LOCKED' }); await second.stop(); assert.equal(processAlive(pid), true); await healthy(first);
});

test('a healthy unknown listener is never adopted, signalled or considered an owned dependency', async t => {
  const f = await fixture(t), foreign = createServer((_req, res) => res.end(JSON.stringify({ ok: true, managedHelper: { id: 'fixture-helper' } })));
  await new Promise(resolve => foreign.listen(f.helperPort, '127.0.0.1', resolve));
  try { const pool = f.create(); await pool.start(); await pool.poll(); const status = pool.status(); assert.equal(status.healthy, false); assert.equal(status.helpers[0].owned, false); assert.equal(status.helpers[0].lastIssue.code, 'HELPER_FOREIGN_LISTENER'); assert.equal(f.events().length, 0); await pool.stop(); assert.equal((await fetch(f.config.healthUrl)).status, 200); }
  finally { foreign.closeAllConnections(); await new Promise(resolve => foreign.close(resolve)); }
});

test('wrong health identity is rejected even while the spawned process remains alive', async t => {
  const signalEvents = [], signalProcess = process.kill;
  t.mock.method(process, 'kill', function (pid, signal) {
    try { const result = signalProcess.call(process, pid, signal); signalEvents.push({ at: new Date().toISOString(), pid, signal, ok: true }); return result; }
    catch (error) { signalEvents.push({ at: new Date().toISOString(), pid, signal, code: error.code }); throw error; }
  });
  const f = await fixture(t, { initialControl: { wrongIdentity: true, startupDelayMs: 350 }, overrides: { startupGraceMs: 200 } }), pool = f.create(); await pool.start();
  try {
  const pid = pool.status().helpers[0].pid;
  // Identity requires a received response. Starting the health clock before
  // listen tests reachability instead and may kill the process before identity.
  await until(() => f.events().some(event => event.type === 'listening' && event.pid === pid), 'wrong-identity listener ready');
  await pool.poll(); assert.equal(processAlive(pid), true); assert.equal(pool.status().helpers[0].lastIssue.code, 'HELPER_IDENTITY_MISMATCH');
  await until(async () => { await pool.poll(); assert.equal(pool.stopping, false, `Recovery stopped: ${pool.lastError?.code ?? 'no fatal error reported'}`); return pool.status().helpers[0].restarts >= 1; }, 'wrong identity forced bounded owned-process recovery');
  assert.equal(pool.status().healthy, false); assert.match(pool.status().helpers[0].lastIssue.code, /IDENTITY/);
  } catch (error) {
    // Preserve the failure before fixture cleanup. These are public status and
    // nonce-free event records; owner.json and health response bodies stay private.
    const eventsPath = `${f.descriptor}.managed/events.jsonl`;
    const evidence = { at: new Date().toISOString(), error: { name: error.name, message: error.message }, status: pool.status(), started: pool.started, stopping: pool.stopping, pollInFlight: Boolean(pool.pollPromise), lastError: pool.lastError ?? null,
      child: pool.helpers.map(helper => ({ pid: helper.child?.pid ?? null, exitCode: helper.child?.exitCode ?? null, signalCode: helper.child?.signalCode ?? null, restartReason: helper.restartReason ?? null })),
      signalEvents: signalEvents.slice(-100), fixtureEvents: f.events(), helperEvents: existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
    const target = fileURLToPath(new URL(`../qa/managed-helper-failure-${process.pid}-${Date.now()}.json`, import.meta.url));
    t.diagnostic(JSON.stringify(evidence)); atomicWrite(target, JSON.stringify(evidence, null, 2)); throw error;
  }
});

test('hung health reaches TERM then KILL, restarts with a new generation and returns healthy', async t => {
  const f = await fixture(t, { overrides: { healthTimeoutMs: 100, startupGraceMs: 200 } }), pool = f.create(); await pool.start(); await healthy(pool); const old = pool.status().helpers[0];
  f.control({ hangPid: old.pid, ignoreTerm: true }); await delay(220);
  await until(async () => { await pool.poll(); return pool.status().helpers[0].restarts >= 1; }, 'hung helper recovered');
  await healthy(pool); const next = pool.status().helpers[0]; assert.notEqual(next.pid, old.pid); assert.notEqual(next.generation, old.generation); assert.equal(processAlive(old.pid), false); assert.ok(f.events().some(event => event.type === 'term' && event.pid === old.pid));
});

test('repeated crashes enter cooldown and stop does not launch another generation', async t => {
  const f = await fixture(t, { initialControl: { holdFirstListen: true }, overrides: { startupGraceMs: 200 } }), pool = f.create({ policy: { ...policy, maxCrashes: 2, crashCooldownMs: 500, crashWindowMs: 60000 } }); await pool.start();
  const first = pool.status().helpers[0].pid;
  await until(() => f.events().some(event => event.type === 'created' && event.pid === first), 'delayed first generation created');
  await until(async () => { await pool.poll(); return pool.status().helpers[0].restarts >= 1; }, 'cold-start failure recorded');
  const nextHealthy = async () => {
    await until(async () => {
      if (!pool.status().helpers[0].pid) await pool.poll();
      const pid = pool.status().helpers[0].pid;
      return pid && f.events().some(event => event.type === 'listening' && event.pid === pid);
    }, 'replacement listener ready');
    await healthy(pool);
  };
  await nextHealthy();
  // First cold start deliberately never listens within its grace. Counters are
  // cumulative; later controlled crashes must wait for a NEW exit receipt.
  assert.ok(pool.status().helpers[0].restarts >= 1);
  for (let index = 0; index < 2; index++) {
    const before = pool.status().helpers[0]; process.kill(before.pid, 'SIGKILL');
    await until(() => pool.status().helpers[0].restarts > before.restarts && pool.status().helpers[0].pid === null, 'new crash recorded');
    assert.equal(processAlive(before.pid), false); if (!index) await nextHealthy();
  }
  const state = pool.status().helpers[0]; assert.equal(state.phase, 'cooldown'); assert.ok(Number.isFinite(Date.parse(state.nextStartAt))); const count = f.events().filter(event => event.type === 'created').length; await pool.stop(); await delay(550); await pool.poll(); assert.equal(f.events().filter(event => event.type === 'created').length, count);
});

test('parent exit cannot leave descendants holding output pipes and blocking stop or restart', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { initialControl: { grandchild: true } }), pool = f.create(); await pool.start(); await healthy(pool); const old = pool.status().helpers[0].pid, descendant = f.events().find(event => event.type === 'grandchild').child;
  f.control({ exitPid: old }); await pool.poll(); await until(() => pool.status().helpers[0].restarts === 1, 'root exit closed held pipes'); await until(() => !processAlive(descendant), 'owned descendant exited'); await healthy(pool);
});

test('supervisor SIGKILL permits verified orphan recovery even when only a descendant would ignore TERM', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { initialControl: { grandchild: true } }), host = await launchHost(f); const old = host.value.helpers[0], descendant = f.events().find(event => event.type === 'grandchild').child;
  await killHost(host.child); assert.equal(processAlive(old.pid), true);
  const pool = f.create({ stopOnly: true }); await pool.start(); await pool.stop(); await until(() => !processAlive(descendant), 'orphan group reaped'); assert.equal(processAlive(old.pid), false); assert.equal(f.events().filter(event => event.type === 'listening').length, 1);
  const fresh = f.create(); await fresh.start(); await healthy(fresh); assert.notEqual(fresh.status().helpers[0].pid, old.pid);
});

test('authenticated readiness durably records the post-exec birth and permits orphan cleanup after supervisor SIGKILL', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { initialControl: { grandchild: true } }); execWrapper(f);
  const host = await launchHost(f), owner = f.owner(), descendant = f.events().find(event => event.type === 'grandchild').child;
  assert.equal(host.value.healthy, true); assert.ok(owner.authenticatedAt); assert.ok(owner.initialBirth); assert.notEqual(owner.birth, owner.initialBirth); assert.equal(owner.birth, processBirth(owner.pid));
  await killHost(host.child);
  const cleanup = f.create({ stopOnly: true }); await cleanup.start(); await cleanup.stop(); assert.equal(processAlive(owner.pid), false); assert.equal(processAlive(descendant), false);
});

test('an exec transition without an authenticated health response cannot refresh durable birth', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { initialControl: { wrongIdentity: true } }); execWrapper(f);
  const pool = f.create(); await pool.start(); const initial = f.owner(); await until(() => f.events().some(e => e.type === 'listening'), 'exec helper listening');
  assert.notEqual(processBirth(initial.pid), initial.birth); await pool.poll();
  assert.equal(pool.status().healthy, false); assert.equal(f.owner().birth, initial.birth); assert.equal(f.owner().authenticatedAt, undefined);
});

test('a late valid health response from an exited exec generation cannot refresh ownership or publish healthy', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); execWrapper(f); const pool = f.create(); await pool.start(); const initial = f.owner();
  await until(() => f.events().some(e => e.type === 'listening'), 'exec helper listening');
  const original = globalThis.fetch; let release, received;
  const responseReady = new Promise(resolve => { received = resolve; }), resume = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (...args) => { const response = await original(...args); received(); await resume; return response; });
  const polling = pool.poll(); await responseReady; process.kill(initial.pid, 'SIGKILL'); await until(() => pool.status().helpers[0].pid === null, 'helper exited before health admitted'); release(); await polling;
  assert.equal(pool.status().healthy, false); assert.equal(f.owner().birth, initial.birth); assert.equal(f.owner().authenticatedAt, undefined);
});

for (const committed of [false, true]) test(`post-exec identity persistence failure remains fail-closed (rename committed: ${committed})`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); execWrapper(f); const failures = [], pool = f.create({ onFatal: error => failures.push(error.code) });
  await pool.start(); const initial = f.owner(); await until(() => f.events().some(e => e.type === 'listening'), 'exec helper listening');
  const original = fs.fsyncSync; let injected = false;
  fs.fsyncSync = fd => { if (!injected && fs.fstatSync(fd).isDirectory() === committed) { injected = true; throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' }); } return original(fd); };
  syncBuiltinESMExports();
  try { await pool.poll(); } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  await pool.stop(); assert.ok(injected); assert.deepEqual(failures, ['HELPER_IDENTITY_PERSIST_FAILED']); assert.equal(pool.status().healthy, false); assert.equal(processAlive(initial.pid), false);
  const owner = f.owner(); assert.equal(owner.phase, 'exited');
  if (committed) { assert.equal(owner.initialBirth, initial.birth); assert.notEqual(owner.birth, initial.birth); assert.ok(owner.authenticatedAt); }
  else { assert.equal(owner.birth, initial.birth); assert.equal(owner.authenticatedAt, undefined); }
});

test('a stale birth identity cannot authorize killing a live helper PID', async t => {
  const f = await fixture(t), host = await launchHost(f); const old = f.owner(); await killHost(host.child);
  atomicWrite(`${f.descriptor}.managed/owner.json`, JSON.stringify({ ...old, birth: `${old.birth} different` }));
  const pool = f.create(); await assert.rejects(pool.start(), { code: 'HELPER_IDENTITY_MISMATCH' }); assert.equal(processAlive(old.pid), true);
  atomicWrite(`${f.descriptor}.managed/owner.json`, JSON.stringify(old)); const clean = f.create({ stopOnly: true }); await clean.start(); await clean.stop();
});

test('stop-only cleanup uses durable ownership after the descriptor and executable have been removed', async t => {
  const f = await fixture(t); f.config.command = join(f.directory, 'fixture-node'); symlinkSync(process.execPath, f.config.command); atomicWrite(f.descriptor, JSON.stringify(f.config));
  const host = await launchHost(f), pid = host.value.helpers[0].pid; await killHost(host.child);
  rmSync(f.descriptor); rmSync(f.config.command); rmSync(f.config.args[0]);
  const cleanup = f.create({ stopOnly: true }); await cleanup.start(); await cleanup.stop(); assert.equal(processAlive(pid), false);
  const missing = join(f.directory, 'never-installed.json'); const empty = new ManagedHelpers({ descriptors: [missing], stopOnly: true }); await empty.start(); await empty.stop(); assert.equal(empty.status().healthy, true);
});

test('a remaining group without its durable leader identity is left untouched and blocks automatic takeover', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { initialControl: { grandchild: true } }), host = await launchHost(f), pid = host.value.helpers[0].pid, descendant = f.events().find(event => event.type === 'grandchild').child;
  await killHost(host.child); process.kill(pid, 'SIGKILL'); await until(() => !processAlive(pid), 'orphan leader exited'); assert.equal(processAlive(descendant), true);
  const cleanup = f.create({ stopOnly: true }); await assert.rejects(cleanup.start(), { code: 'HELPER_GROUP_UNCERTAIN' }); assert.equal(processAlive(descendant), true); assert.equal(f.events().filter(event => event.type === 'created').length, 1);
});

test('stop-only cleanup ignores changed or corrupt current descriptor contents and never spawns them', async t => {
  for (const content of ['{broken JSON', JSON.stringify({ schemaVersion: 1, id: 'replacement' })]) {
    const f = await fixture(t), host = await launchHost(f), pid = host.value.helpers[0].pid; await killHost(host.child); atomicWrite(f.descriptor, content);
    const cleanup = f.create({ stopOnly: true }); await cleanup.start(); await cleanup.stop(); assert.equal(processAlive(pid), false); assert.equal(f.events().filter(event => event.type === 'created').length, 1);
    assert.throws(() => f.create(), { code: 'HELPER_INVALID_DESCRIPTOR' });
  }
});

test('startup gate prevents an uncommitted helper from binding after controller death', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), initial = f.create(); await initial.start(); await healthy(initial); const baseline = f.owner(); await initial.stop();
  const prepared = { ...baseline, phase: 'prepared', pid: null, birth: null, token: 'prepared-owner-'.repeat(6) };
  const host = await launchHost(f, { prepared: true, owner: prepared }); await killHost(host.child);
  const replacement = f.create(); await replacement.start(); await healthy(replacement); await until(() => !processAlive(host.value.pid), 'uncommitted helper exited its startup gate', 12000);
  assert.ok(!f.events().some(event => event.type === 'listening' && event.pid === host.value.pid));
});

test('stop racing start or a hung probe releases leases and cannot publish late healthy state', async t => {
  const f = await fixture(t), first = f.create(); const starting = first.start(); await first.stop(); await starting.catch(() => {}); assert.equal(first.status().healthy, false);
  const second = f.create(); await second.start(); await healthy(second); const pid = second.status().helpers[0].pid; f.control({ hangPid: pid, ignoreTerm: true }); const poll = second.poll(), stopping = second.stop(); await stopping; await poll; assert.equal(second.status().healthy, false); assert.equal(processAlive(pid), false);
  const third = f.create(); await third.start(); await healthy(third);
});

test('helper output logs rotate within bounds and redact identity tokens across chunk boundaries', async t => {
  const f = await fixture(t, { initialControl: { noisy: true } }), pool = f.create({ logPolicy: { maxBytes: 1024, copies: 2 } }); await pool.start(); await healthy(pool); const token = f.owner().token; await pool.stop();
  const logs = readdirSync(`${f.descriptor}.managed`).filter(name => name.startsWith('stdout.log')); assert.ok(logs.length > 0 && logs.length <= 3);
  for (const name of logs) { const path = join(`${f.descriptor}.managed`, name); assert.ok(statSync(path).size <= 1024); assert.ok(!readFileSync(path, 'utf8').includes(token)); }
});
