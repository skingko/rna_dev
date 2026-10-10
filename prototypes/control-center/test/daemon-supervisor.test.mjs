import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { DaemonSupervisor } from '../daemon-supervisor.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { createEnduranceRun } from '../endurance-monitor.mjs';
import { processAlive, processBirth } from '../process-lease.mjs';

async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error(`Timed out: ${message}`);
}
async function bounded(promise, message, timeout = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function unusedPort() {
  const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const fixtureSource = `
import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const directory = process.env.FIXTURE_DIRECTORY;
const event = (type, data = {}) => appendFileSync(directory + '/events.jsonl', JSON.stringify({ type, pid: process.pid, at: Date.now(), ...data }) + '\\n');
const control = () => { try { return JSON.parse(readFileSync(directory + '/control.json', 'utf8')); } catch { return {}; } };
let spawned = false, sequence = 0;
process.on('SIGTERM', () => { event('sigterm'); if (!control().ignoreTerm) process.exit(0); });
const server = http.createServer((_request, response) => {
  if (control().hangAll || control().hangPid === process.pid) return;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, heartbeatAt: new Date().toISOString(), memory: { rss: control().rss ?? process.memoryUsage().rss }, process: { pid: process.pid, instanceId: process.env.RNA_AGENT_GENERATION, generation: process.env.RNA_AGENT_GENERATION, supervisorRunId: process.env.RNA_AGENT_SUPERVISOR_RUN } }));
});
server.listen(Number(process.env.RNA_AGENT_PORT), '127.0.0.1', () => event('started', { generation: process.env.RNA_AGENT_GENERATION }));
setInterval(() => {
  const input = control();
  if (process.connected && !input.stopLiveness) process.send({ type: 'rna-daemon-liveness', pid: process.pid,
    supervisorRunId: process.env.RNA_AGENT_SUPERVISOR_RUN, generation: input.wrongGeneration ? 'foreign' : process.env.RNA_AGENT_GENERATION,
    sequence: input.replayLiveness ? 1 : ++sequence, sentAtMonotonicMs: Number(process.hrtime.bigint()/1000000n) - (input.staleLiveness ? 10000 : 0), activeWork: input.activeWork === true, closing: false }, () => {});
  if (input.activeWork) event('work_progress');
  if (input.exitWithGrandchildPid === process.pid && !spawned) {
    spawned = true;
    const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'inherit' });
    event('grandchild', { grandchildPid: grandchild.pid });
    setTimeout(() => process.exit(17), 30);
  }
}, 20);
`;

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-supervisor-'));
  const stateFile = join(directory, 'state.json'), fixtureFile = join(directory, 'daemon-fixture.mjs');
  writeFileSync(fixtureFile, fixtureSource); writeFileSync(join(directory, 'control.json'), '{}');
  const supervisor = new DaemonSupervisor({ stateFile, port: await unusedPort(), command: process.execPath, args: [fixtureFile], cwd: directory, env: { FIXTURE_DIRECTORY: directory }, pollMs: 30, healthTimeoutMs: 80, startupGraceMs: 1500, unhealthyThreshold: 2, shutdownGraceMs: 150, restartBaseMs: 40, restartMaxMs: 80, maxCrashes: 20, ...overrides });
  atomicWrite(supervisor.paths.intent, JSON.stringify({ enabled: true }));
  const events = () => existsSync(join(directory, 'events.jsonl')) ? readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const logs = () => existsSync(join(supervisor.paths.directory, 'supervisor.jsonl')) ? readFileSync(join(supervisor.paths.directory, 'supervisor.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const control = value => atomicWrite(join(directory, 'control.json'), JSON.stringify(value));
  t.after(async () => {
    await supervisor.stop();
    try { await bounded(supervisor.exitPromise, 'supervisor teardown stalled'); }
    finally {
      for (const record of events()) for (const pid of [record.pid, record.grandchildPid]) if (pid && processAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await supervisor.start();
  await until(() => supervisor.status.phase === (overrides.initialPhase ?? 'running'), 'initial daemon reached expected health');
  return { directory, supervisor, events, logs, control };
}

test('a real daemon crash restarts with a different generation and returns to healthy HTTP', async t => {
  const app = await fixture(t), before = { pid: app.supervisor.child.pid, generation: app.supervisor.generation };
  app.supervisor.child.kill('SIGKILL');
  await until(() => app.supervisor.restarts === 1 && app.supervisor.status.phase === 'running', 'crashed daemon restarted');
  assert.notEqual(app.supervisor.child.pid, before.pid); assert.notEqual(app.supervisor.generation, before.generation);
  assert.equal(app.supervisor.lastHealth.process.pid, app.supervisor.child.pid);
  assert.ok(app.logs().some(event => event.event === 'daemon_exit' && event.signal === 'SIGKILL'));
});

test('actual child spawn receipts count replacements that crash before any successful health request', async t => {
  const app = await fixture(t), supervisor = app.supervisor;
  atomicWrite(supervisor.paths.endurance, JSON.stringify(createEnduranceRun({ id: 'failed-startup-generations', now: Date.now() })));
  await until(() => JSON.parse(readFileSync(supervisor.paths.endurance)).lastKnownDaemon?.generation === supervisor.generation, 'initial live generation observed');
  app.control({ hangAll: true }); const first = supervisor.child.pid; supervisor.child.kill('SIGKILL');
  await until(() => supervisor.child?.pid && supervisor.child.pid !== first && JSON.parse(readFileSync(supervisor.paths.endurance)).daemonRestarts === 1, 'replacement counted before HTTP readiness');
  const second = supervisor.child.pid; assert.equal(supervisor.lastHealth, null); supervisor.child.kill('SIGKILL');
  await until(() => supervisor.child?.pid && supervisor.child.pid !== second && JSON.parse(readFileSync(supervisor.paths.endurance)).daemonRestarts === 2, 'another unsuccessful generation counted');
  app.control({}); await until(() => supervisor.status.phase === 'running', 'third child finally becomes ready');
  const run = JSON.parse(readFileSync(supervisor.paths.endurance));
  assert.equal(run.daemonRestarts, 2); assert.ok(run.unhealthySamples >= 2); assert.equal(run.passed, null);
});

test('hung health HTTP is terminated, then killed when TERM is ignored, and recovered without overlapping generations', async t => {
  const app = await fixture(t), oldPid = app.supervisor.child.pid;
  // A hang in one generation must not poison the replacement fixture.
  app.control({ hangPid: oldPid, ignoreTerm: true }); app.supervisor.startedChildAt -= 2000;
  await until(() => app.events().some(event => event.type === 'sigterm' && event.pid === oldPid), 'TERM reached hung daemon');
  await until(() => app.supervisor.restarts === 1 && app.supervisor.status.phase === 'running', 'hung daemon killed and replaced');
  assert.notEqual(app.supervisor.child.pid, oldPid); assert.equal(processAlive(oldPid), false);
  const exit = app.logs().find(event => event.event === 'daemon_exit' && event.reason === 'HEALTH_UNREACHABLE');
  assert.equal(exit.signal, 'SIGKILL'); assert.ok(app.supervisor.lastHealth.ok);
  app.control({});
});

test('fresh authenticated main-loop work progress defers a health-route restart, preserves work, and permits repair once idle', async t => {
  const app = await fixture(t), pid = app.supervisor.child.pid;
  app.control({ activeWork: true });
  await until(() => app.supervisor.childLiveness?.activeWork, 'active work liveness received');
  app.supervisor.startedChildAt -= 2000; app.control({ activeWork: true, hangPid: pid });
  await until(() => app.supervisor.restartDeferred === 'ACTIVE_WORK_LIVENESS', 'HTTP outage is distinguished from a dead active daemon');
  const progress = app.events().filter(event => event.type === 'work_progress').length;
  await delay(300);
  assert.equal(app.supervisor.child.pid, pid); assert.equal(app.supervisor.restarts, 0); assert.equal(app.supervisor.status.phase, 'degraded');
  assert.equal(app.supervisor.lastHealth, null, 'Independent liveness must not disguise the health outage');
  assert.ok(app.events().filter(event => event.type === 'work_progress').length > progress);
  assert.ok(!app.events().some(event => event.type === 'sigterm' && event.pid === pid));
  assert.equal(app.logs().filter(event => event.event === 'daemon_restart_deferred').length, 1);
  app.control({ activeWork: false, hangPid: pid });
  await until(() => app.supervisor.restarts === 1 && app.supervisor.status.phase === 'running', 'idle unhealthy route is repaired normally');
  assert.notEqual(app.supervisor.child.pid, pid); assert.equal(processAlive(pid), false);
});

test('missing, replayed, delayed or foreign-generation IPC cannot indefinitely protect an unreachable daemon', async t => {
  for (const invalid of [{ stopLiveness: true }, { replayLiveness: true }, { staleLiveness: true }, { wrongGeneration: true }]) await t.test(Object.keys(invalid)[0], async t => {
    const app = await fixture(t), pid = app.supervisor.child.pid;
    app.control({ activeWork: true });
    await until(() => app.supervisor.childLiveness?.activeWork && app.supervisor.childLiveness.sequence > 1, 'authenticated work admitted');
    app.supervisor.startedChildAt -= 2000; app.control({ activeWork: true, hangPid: pid, ...invalid });
    await until(() => app.supervisor.restarts === 1 && app.supervisor.status.phase === 'running', 'unresponsive daemon without fresh valid progress restarts');
    assert.equal(processAlive(pid), false); assert.notEqual(app.supervisor.child.pid, pid);
    const termination = app.logs().find(row => row.event === 'daemon_terminate' && row.reason === 'HEALTH_UNREACHABLE');
    assert.equal(termination.evidence.pid, pid); assert.equal(termination.evidence.healthTimeoutMs, app.supervisor.config.healthTimeoutMs);
    assert.equal(termination.evidence.unhealthyThreshold, app.supervisor.config.unhealthyThreshold);
    assert.ok(termination.evidence.consecutiveUnhealthy >= termination.evidence.unhealthyThreshold);
    assert.ok(Number.isFinite(Date.parse(termination.evidence.probe.startedAt)));
    assert.ok(termination.evidence.liveness.sentAgeMs > termination.evidence.healthTimeoutMs);
    assert.ok(termination.evidence.liveness.receivedAgeMs > termination.evidence.healthTimeoutMs);
    assert.equal(app.supervisor.status.lastTermination.pid, pid, 'a replacement does not erase the prior shutdown evidence');
  });
});

for (const stillHung of [false, true]) test(`a failed probe that straddles work completion gets one fresh idle check (${stillHung ? 'still failed' : 'recovered HTTP'})`, async t => {
  const app = await fixture(t, { healthTimeoutMs: 1000 }), supervisor = app.supervisor, child = supervisor.child;
  app.control({ activeWork: true }); await until(() => supervisor.childLiveness?.activeWork, 'real child began work');
  clearInterval(supervisor.timer); await until(() => !supervisor.polling, 'existing poll settled');
  supervisor.startedChildAt -= 2000; supervisor.unhealthy = supervisor.config.unhealthyThreshold - 1;
  const original = supervisor.probe; let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  supervisor.probe = async () => { entered(); await held; throw new Error('Held request timed out'); };
  const poll = supervisor.poll(); await waiting;
  const activeSequence = supervisor.childLiveness.sequence;
  app.control({ activeWork: false, ...(stillHung ? { hangPid: child.pid } : {}) });
  await until(() => supervisor.childLiveness?.sequence > activeSequence && !supervisor.childLiveness.activeWork, 'work completed during the outstanding failed request');
  release(); await poll; supervisor.probe = original;
  assert.equal(supervisor.child, child); assert.equal(supervisor.restartDeferred, 'IDLE_HEALTH_RECHECK');
  assert.equal(supervisor.lastHealth, null); assert.equal(supervisor.unhealthy, supervisor.config.unhealthyThreshold);
  await supervisor.poll();
  if (stillHung) {
    await until(() => supervisor.restarts === 1, 'another fresh failed request retires idle generation');
    assert.equal(app.logs().filter(row => row.event === 'daemon_restart_deferred' && row.reason === 'IDLE_HEALTH_RECHECK').length, 1);
  } else { assert.equal(supervisor.child, child); assert.equal(supervisor.restarts, 0); assert.equal(supervisor.status.phase, 'running'); assert.equal(supervisor.restartDeferred, null); }
});

test('explicit supervisor stop persists stopped status and does not restart its intentionally terminated child', async t => {
  const app = await fixture(t), oldPid = app.supervisor.child.pid, started = app.events().filter(event => event.type === 'started').length;
  await app.supervisor.stop(); await bounded(app.supervisor.exitPromise, 'explicit stop timed out');
  await delay(180);
  assert.equal(app.supervisor.closed, true); assert.equal(app.supervisor.restarts, 0); assert.equal(processAlive(oldPid), false);
  assert.equal(app.events().filter(event => event.type === 'started').length, started);
  const status = JSON.parse(readFileSync(app.supervisor.paths.status, 'utf8')); assert.equal(status.phase, 'stopped'); assert.equal(status.childPid, null);
});

test('macOS observation owns idle and AC-system sleep assertions, releases them on observation stop and supervisor shutdown without keeping the display awake', { skip: process.platform !== 'darwin' }, async t => {
  const app = await fixture(t), daemonPid = app.supervisor.child.pid;
  assert.equal(app.supervisor.awake, null);
  const start = id => atomicWrite(app.supervisor.monitor.path, JSON.stringify(createEnduranceRun({ id, hours: 1, keepAwake: true })));
  start('keep-awake-lifecycle-one');
  await until(() => Boolean(app.supervisor.awake?.pid), 'observation starts its assertion process');
  const firstPid = app.supervisor.awake.pid;
  const args = execFileSync('/bin/ps', ['-p', String(firstPid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
  assert.match(args, new RegExp(`caffeinate -i -s -w ${process.pid}`));
  assert.doesNotMatch(args, /(?:^|\s)-(?:d|u)(?:\s|$)/);
  await until(() => {
    const lines = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8', timeout: 2000 }).split('\n').filter(line => line.includes(`pid ${firstPid}(caffeinate)`));
    return lines.some(line => line.includes('PreventUserIdleSystemSleep')) && lines.some(line => line.includes('PreventSystemSleep'));
  }, 'owned process publishes both requested IOKit assertions');
  const status = JSON.parse(readFileSync(app.supervisor.paths.status, 'utf8'));
  assert.equal(status.keepAwakePolicy.systemSleepOnAc, true); assert.equal(status.keepAwakePolicy.preventsDisplaySleep, false); assert.equal(status.keepAwakePolicy.guaranteesUninterruptedExecution, false);
  atomicWrite(app.supervisor.monitor.path, JSON.stringify({ ...JSON.parse(readFileSync(app.supervisor.monitor.path, 'utf8')), status: 'stopped' }));
  await until(() => !app.supervisor.awake && !processAlive(firstPid), 'stopping observation releases assertions');
  assert.equal(app.supervisor.child.pid, daemonPid); assert.equal(app.supervisor.restarts, 0);
  start('keep-awake-lifecycle-two');
  await until(() => Boolean(app.supervisor.awake?.pid), 'second observation owns a fresh assertion');
  const secondPid = app.supervisor.awake.pid;
  await app.supervisor.stop(); await bounded(app.supervisor.exitPromise, 'shutdown with keep-awake ends');
  await until(() => !processAlive(secondPid), 'supervisor shutdown releases the owned assertion');
});

test('parent exit while a grandchild retains inherited stdio cleans up its process group and restarts within a bound', { skip: process.platform === 'win32' }, async t => {
  const app = await fixture(t), oldPid = app.supervisor.child.pid;
  app.control({ exitWithGrandchildPid: oldPid });
  await until(() => app.events().some(event => event.type === 'grandchild'), 'grandchild created');
  const grandchildPid = app.events().find(event => event.type === 'grandchild').grandchildPid;
  await until(() => app.supervisor.restarts === 1 && app.supervisor.status.phase === 'running', 'inherited pipes do not stall restart', 5000);
  await until(() => !processAlive(grandchildPid), 'owned grandchild reaped', 5000);
  assert.equal(processAlive(oldPid), false); assert.notEqual(app.supervisor.child.pid, oldPid);
  assert.ok(app.logs().some(event => event.event === 'daemon_exit' && event.code === 17));
});

test('an unavailable managed dependency degrades the full chain without restarting a healthy daemon or adopting a foreign listener', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-helper-integration-'));
  const listener = createServer(socket => socket.destroy());
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise(done => listener.close(done)); rmSync(directory, { recursive: true, force: true }); });
  const descriptor = join(directory, 'helper.json');
  writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, id: 'occupied-relay', command: process.execPath, args: ['-e', 'throw new Error("must not start")'], cwd: directory, healthUrl: `http://127.0.0.1:${listener.address().port}/_rna/health`, healthIdentity: 'rna-helper-v1' }));
  const app = await fixture(t, { helperDescriptors: [descriptor], initialPhase: 'degraded' });
  const health = app.supervisor.lastHealth;
  assert.equal(health.ok, false);
  assert.equal(health.dependencies.managedHelpers.helpers[0].lastIssue.code, 'HELPER_FOREIGN_LISTENER');
  assert.equal(health.dependencies.managedHelpers.helpers[0].owned, false);
  assert.equal(app.supervisor.restarts, 0);
  assert.equal(listener.listening, true);
  await app.supervisor.stop(); await bounded(app.supervisor.exitPromise, 'supervisor with blocked dependency stops');
  assert.equal(listener.listening, true, 'User stop cannot terminate an unrelated listener');
});

test('a new helper birth lookup failure stays isolated while the real daemon and a peer keep serving', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-birth-isolation-')), helper = join(directory, 'helper.mjs');
  writeFileSync(helper, `import http from 'node:http';import{readFileSync}from'node:fs';
    const e=process.env;while(true){let o;try{o=JSON.parse(readFileSync(e.RNA_MANAGED_HELPER_OWNER_FILE,'utf8'))}catch{}if(o?.phase==='running'&&o.pid===process.pid&&o.token===e.RNA_MANAGED_HELPER_TOKEN)break;await new Promise(r=>setTimeout(r,10))}
    http.createServer((q,r)=>r.end(JSON.stringify({ok:true,managedHelper:{id:e.RNA_MANAGED_HELPER_ID,token:e.RNA_MANAGED_HELPER_TOKEN,fingerprint:e.RNA_MANAGED_HELPER_FINGERPRINT,pid:process.pid}}))).listen(Number(process.argv[2]),'127.0.0.1');`);
  const descriptors = [];
  for (const id of ['failing-identity', 'healthy-peer']) {
    const path = join(directory, `${id}.json`), port = await unusedPort(); descriptors.push(path);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, id, command: process.execPath, args: [helper, String(port)], cwd: directory, healthUrl: `http://127.0.0.1:${port}/health`, healthIdentity: 'rna-helper-v1', startupGraceMs: 5000 }));
  }
  const spawnReal = childProcess.spawn, execReal = childProcess.execFileSync, affectedPids = new Set(); let failIdentity = true;
  t.mock.method(childProcess, 'spawn', (...args) => { const child = spawnReal(...args); if (args[2]?.env?.RNA_MANAGED_HELPER_ID === 'failing-identity') affectedPids.add(child.pid); return child; });
  t.mock.method(childProcess, 'execFileSync', (program, args, options) => program === '/bin/ps' && affectedPids.has(Number(args[1])) && failIdentity ? '' : execReal(program, args, options));
  syncBuiltinESMExports();
  // This checks helper isolation, not health timeouts: a generous daemon health deadline keeps a busy
  // machine (the full suite runs files in parallel) from restarting the daemon and failing `restarts === 0`.
  const app = await fixture(t, { helperDescriptors: descriptors, initialPhase: 'degraded', healthTimeoutMs: 1000 });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); });
  const oldPid = [...affectedPids][0], daemonPid = app.supervisor.child.pid;
  await until(() => app.supervisor.helpers.status().helpers[1].healthy && !processAlive(oldPid), 'peer serves and failed fresh child exits');
  const peerPid = app.supervisor.helpers.status().helpers[1].pid;
  assert.equal(app.supervisor.stopping, false); assert.equal(app.supervisor.helpers.stopping, false);
  assert.equal(app.supervisor.restarts, 0, JSON.stringify({ status: app.supervisor.status, events: app.events(), supervisorEvents: app.logs() }));
  let daemonHealth; const probeStarted = performance.now();
  try { daemonHealth = await app.supervisor.probe(); }
  catch (error) {
    // Preserve a transient failure before teardown removes the fixture. This
    // is still one probe with the original deadline, and the same error fails
    // the test; no diagnostic retry may turn an unavailable sample into a pass.
    t.diagnostic(JSON.stringify({ label: 'helper_birth_isolation_probe_failed', elapsedMs: performance.now() - probeStarted,
      healthTimeoutMs: app.supervisor.config.healthTimeoutMs, error: { name: error.name, code: error.code, causeName: error.cause?.name, causeCode: error.cause?.code },
      expectedDaemonPid: daemonPid, status: { phase: app.supervisor.status.phase, stopping: app.supervisor.stopping, restarts: app.supervisor.restarts, lastIssue: app.supervisor.status.lastIssue, lastProbe: app.supervisor.lastProbe },
      lastHealth: app.supervisor.lastHealth ? { ok: app.supervisor.lastHealth.ok, process: app.supervisor.lastHealth.process } : null,
      helpers: app.supervisor.helpers.status().helpers.slice(0, 4).map(row => ({ id: row.id, phase: row.phase, healthy: row.healthy, pid: row.pid, owned: row.owned, cleanupUncertain: row.cleanupUncertain, restarts: row.restarts, lastIssue: row.lastIssue })),
      events: app.events().slice(-12), logs: app.logs().slice(-16).map(row => Object.fromEntries(['at', 'event', 'id', 'pid', 'generation', 'code', 'signal', 'reason', 'httpStatus'].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))) }));
    throw error;
  }
  assert.equal(daemonHealth.process.pid, daemonPid);
  failIdentity = false;
  await until(() => app.supervisor.status.phase === 'running', 'recovered identity restores the full chain');
  assert.equal(app.supervisor.child.pid, daemonPid); assert.equal(app.supervisor.helpers.status().helpers[1].pid, peerPid);
  assert.equal(app.logs().some(row => row.event === 'daemon_terminate'), false);
  await app.supervisor.stop(); await bounded(app.supervisor.exitPromise, 'isolated helper fixture cleanup');
});

for (const leaderDead of [false, true]) test(leaderDead ? 'recovery refuses to signal an orphan group after its leader identity is lost' : 'recovery reaps a verified orphan group even when its leader would exit on TERM before a stubborn grandchild', { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-orphan-recovery-')), stateFile = join(directory, 'state.json'), receipt = join(directory, 'child.json');
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync,renameSync}=require('node:fs');
    process.on('SIGTERM',()=>process.exit(0));
    const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>{const file=process.argv[1];writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,grandchildPid:child.pid}));renameSync(file+'.tmp',file);});setInterval(()=>{},1000);`;
  const leader = spawn(process.execPath, ['-e', source, receipt], { detached: true, stdio: 'ignore' });
  let grandchildPid;
  t.after(() => { if (processAlive(leader.pid)) { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} } if (grandchildPid && processAlive(grandchildPid)) { try { process.kill(grandchildPid, 'SIGKILL'); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  await until(() => existsSync(receipt), 'orphan descendant ready');
  grandchildPid = JSON.parse(readFileSync(receipt, 'utf8')).grandchildPid;
  atomicWrite(`${stateFile}.lock`, JSON.stringify({ pid: leader.pid, birth: processBirth(leader.pid), stateFile, supervisorRunId: 'dead-supervisor', generation: 'orphan-generation' }));
  if (leaderDead) { leader.kill('SIGKILL'); await until(() => !processAlive(leader.pid), 'old leader died'); }
  const recovery = new DaemonSupervisor({ stateFile, port: await unusedPort(), recoverOnStop: true, stopOnly: true });
  await recovery.start(); await bounded(recovery.exitPromise, 'orphan cleanup ends without spawning');
  if (leaderDead) { assert.equal(recovery.exitCode, 1); assert.equal(recovery.status.lastIssue.code, 'ORPHAN_GROUP_UNCERTAIN'); assert.equal(processAlive(grandchildPid), true, 'No guess-based signal after identity loss'); }
  else await until(() => !processAlive(leader.pid) && !processAlive(grandchildPid), 'entire verified old group reaped');
  assert.equal(recovery.child, null); assert.equal(recovery.restarts, 0);
});

test('a soft RSS limit preserves healthy ongoing work, records pressure and recycles only after work settles', async t => {
  const app = await fixture(t, { healthTimeoutMs: 500 }), supervisor = app.supervisor, pid = supervisor.child.pid;
  const rss = supervisor.config.maxRssBytes + 1024;
  app.control({ activeWork: true });
  await until(() => supervisor.childLiveness?.activeWork, 'busy liveness recorded');
  supervisor.startedChildAt -= 2000; app.control({ activeWork: true, rss });
  await until(() => supervisor.restartDeferred === 'ACTIVE_WORK_RSS_SOFT_LIMIT', 'soft pressure is deferred');
  await delay(180);
  assert.equal(supervisor.child.pid, pid); assert.equal(supervisor.restarts, 0);
  assert.equal(supervisor.lastHealth.memory.rss, rss); assert.equal(supervisor.lastHealth.ok, false);
  assert.equal(app.events().filter(event => event.type === 'sigterm' && event.pid === pid).length, 0);
  app.control({ activeWork: false, rss });
  await until(() => supervisor.restarts === 1, 'settled work permits recycling');
  app.control({});
  await until(() => supervisor.status.phase === 'running', 'replacement returns healthy');
  assert.equal(supervisor.status.lastTermination.reason, 'RSS_LIMIT');
  assert.equal(supervisor.status.lastTermination.rssBytes, rss);
});

test('memory pressure that subsides does not recycle, while the hard ceiling still bounds an active daemon', async t => {
  const app = await fixture(t, { healthTimeoutMs: 500 }), supervisor = app.supervisor, pid = supervisor.child.pid;
  app.control({ activeWork: true }); await until(() => supervisor.childLiveness?.activeWork, 'busy');
  supervisor.startedChildAt -= 2000;
  app.control({ activeWork: true, rss: supervisor.config.maxRssBytes + 1024 });
  await until(() => supervisor.restartDeferred === 'ACTIVE_WORK_RSS_SOFT_LIMIT', 'soft limit deferred');
  app.control({ activeWork: true }); await until(() => supervisor.status.phase === 'running', 'transient allocation released');
  assert.equal(supervisor.child.pid, pid); assert.equal(supervisor.restartDeferred, null);
  app.control({ activeWork: true, rss: supervisor.config.hardMaxRssBytes + 1024 });
  await until(() => supervisor.restarts === 1, 'hard ceiling retires bounded process'); app.control({});
  assert.equal(supervisor.status.lastTermination.reason, 'RSS_HARD_LIMIT');
});
