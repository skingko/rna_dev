import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runMaintenanceOperation, assertDrainReceipt, maintenanceProcessBound } from '../application-maintenance-worker.mjs';
import { maintenancePaths, persistMaintenance, readMaintenance, publicMaintenanceOperation } from '../application-maintenance-state.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { processBirth } from '../process-lease.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function fixture(t, changes = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-maintenance-worker-'))), stateFile = join(root, 'state.json'), paths = maintenancePaths(stateFile);
  mkdirSync(paths.directory); writeFileSync(stateFile, JSON.stringify({ version: 2, revision: 0, tasks: [], events: [], sessions: [] }));
  const id = randomUUID(), startedAt = new Date(Date.now() - 1000).toISOString(), digest = 'a'.repeat(64);
  const row = { schemaVersion: 1, id, requestId: randomUUID(), kind: 'backup', args: {}, held: true, phase: 'waiting_idle', startedAt, checkpointId: randomUUID(),
    expected: { process: { pid: 1234, instanceId: 'old-instance', generation: 'old-generation', supervisorRunId: 'old-supervisor' }, runtimeIdentity: digest, hostVersion: '0.15.0', sdkVersion: '0.9.0', nodeVersion: process.versions.node, stateVersion: 2,
      config: { command: process.execPath, cwd: root, port: 64538, manager: 'session' } }, ...changes };
  persistMaintenance(stateFile, row);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let phase = row.stopped ? 'none' : 'old', clock = 0;
  const calls = [], status = { active: false, newHealthy: true, binding: true, identity: digest };
  const health = which => ({ ok: which !== 'new' || status.newHealthy, version: '0.15.0', sdkVersion: '0.9.0', runtimeIdentity: digest, persistence: { failed: false }, workload: { activeWork: status.active },
    maintenance: { protocolVersion: 1, held: true, operationId: id }, process: which === 'old' ? { ...row.expected.process, closing: false } : { pid: 5678, instanceId: 'new-instance', generation: 'new-generation', supervisorRunId: 'new-supervisor', closing: false } });
  const drain = () => ({ schemaVersion: 1, drained: true, pid: row.expected.process.pid, instanceId: row.expected.process.instanceId, runtimeIdentity: digest, maintenanceOperationId: id, at: new Date().toISOString() });
  const stopped = () => ({ stoppedDaemon: { pid: row.expected.process.pid, generation: row.expected.process.generation }, lastDaemonExit: { pid: row.expected.process.pid, generation: row.expected.process.generation, code: 0, signal: null, at: new Date().toISOString() } });
  const saveStop = (result = stopped()) => {
    atomicWrite(`${paths.directory}/drain-receipt.json`, JSON.stringify(drain()));
    atomicWrite(`${paths.directory}/daemon-stop-receipt.json`, JSON.stringify({ schemaVersion: 1, maintenanceOperationId: id, supervisorRunId: row.expected.process.supervisorRunId, ...result, cleanupComplete: true, at: new Date().toISOString() }));
    // Real service CLI's cleanup supervisor intentionally replaces status.
    atomicWrite(`${paths.directory}/status.json`, JSON.stringify({ phase: 'stopped', childPid: null, runId: 'cleanup-supervisor' }));
    return result;
  };
  const checkpoint = (directory, checkpointId = row.checkpointId) => ({ id: checkpointId, directory, manifestHash: 'b'.repeat(64), files: 1, bytes: 64, manifest: { sourceStateFile: stateFile, createdAt: startedAt } });
  const io = { now: () => clock, sleep: async ms => { clock += ms; }, waitMs: 1000, verifyMs: 1000, runtimeIdentity: () => status.identity,
    health: async () => phase === 'none' ? null : health(phase), binding: () => status.binding,
    service: async (config, action) => { calls.push(action); if (action === 'stop') { phase = 'none'; return saveStop(); } phase = 'new'; return { childPid: 5678, supervisorPid: 5679 }; },
    createCheckpoint: async ({ destination }) => { calls.push('checkpoint'); return checkpoint(destination); },
    verifyCheckpoint: async ({ directory }) => checkpoint(directory),
    restoreCheckpoint: async () => { calls.push('restore'); return { emergency: true }; },
  };
  return { root, stateFile, paths, row, status, calls, io, health, drain, stopped, saveStop, checkpoint, phase(value) { phase = value; }, run: () => runMaintenanceOperation({ stateFile, id, io }), patch: changes => persistMaintenance(stateFile, { ...readMaintenance(stateFile), ...changes }) };
}

test('natural-idle maintenance stops once, checkpoints, starts held, verifies, and releases admission', async t => {
  const f = fixture(t), result = await f.run();
  assert.equal(result.phase, 'completed'); assert.equal(result.held, false); assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']);
  assert.equal(result.verifiedProcess.instanceId, 'new-instance'); assert.equal(result.stopResult.lastDaemonExit.code, 0);
});

test('worker refuses a linked lease before mutating its journal or controlling a service', async t => {
  const f = fixture(t), outside = join(f.root, 'outside.json'); writeFileSync(outside, '{}'); symlinkSync(outside, f.paths.worker);
  const before = readFileSync(f.paths.journal);
  await assert.rejects(f.run, error => error.code === 'maintenance_unsafe_path');
  assert.deepEqual(f.calls, []); assert.deepEqual(readFileSync(f.paths.journal), before); assert.equal(readFileSync(outside, 'utf8'), '{}'); assert.equal(existsSync(`${f.paths.worker}.sqlite`), false);
});

test('busy work is never stopped at the wait deadline', async t => {
  const f = fixture(t); f.status.active = true; const result = await f.run();
  assert.equal(result.errorCode, 'maintenance_wait_timeout'); assert.equal(result.held, false); assert.equal(result.phase, 'failed'); assert.deepEqual(f.calls, []);
});

test('waiting cancellation releases admission without service effects', async t => {
  const f = fixture(t, { cancelRequested: true }); const result = await f.run();
  assert.equal(result.phase, 'cancelled'); assert.equal(result.held, false); assert.deepEqual(f.calls, []);
});

test('filesystem code drift refuses to execute an old mutable control path', async t => {
  const f = fixture(t); f.status.identity = 'c'.repeat(64); const result = await f.run();
  assert.equal(result.errorCode, 'maintenance_runtime_changed'); assert.equal(result.held, false); assert.deepEqual(f.calls, []);
});

test('current listener without verified owned leases is not stopped', async t => {
  const f = fixture(t); f.status.binding = false; const result = await f.run();
  assert.equal(result.errorCode, 'maintenance_identity_changed'); assert.deepEqual(f.calls, []);
});

test('a lost stop stdout is recovered only from the durable transaction-bound receipt', async t => {
  const f = fixture(t); const real = f.io.service;
  f.io.service = async (...args) => { const result = await real(...args); if (args[1] === 'stop') throw Object.assign(new Error('lost stdout after exit'), { code: 'test_lost_stdout' }); return result; };
  const interrupted = await f.run(); assert.equal(interrupted.phase, 'recovery_required'); assert.equal(interrupted.stopped, undefined); assert.equal(interrupted.held, true);
  f.io.service = real; const resumed = await f.run();
  assert.equal(resumed.phase, 'completed'); assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']); assert.equal(resumed.stopResult.lastDaemonExit.code, 0);
});

for (const mutation of [r => { r.maintenanceOperationId = randomUUID(); }, r => { r.cleanupComplete = false; }, r => { r.supervisorRunId = 'different'; }, r => { r.at = 'invalid'; }, r => { r.lastDaemonExit.generation = 'different'; }]) test('incomplete or foreign stop receipts cannot turn HTTP silence into a completed stop', async t => {
  const f = fixture(t, { phase: 'stopping' }); f.phase('none'); f.saveStop();
  const path = `${f.paths.directory}/daemon-stop-receipt.json`, record = read(path); mutation(record); atomicWrite(path, JSON.stringify(record));
  const result = await f.run(); assert.equal(result.phase, 'recovery_required'); assert.equal(result.held, true); assert.deepEqual(f.calls, []);
});

test('forced daemon termination is never accepted as a clean migration boundary', async t => {
  const f = fixture(t); f.io.service = async (_config, action) => { f.calls.push(action); f.phase('none'); return f.saveStop({ ...f.stopped(), lastDaemonExit: { ...f.stopped().lastDaemonExit, code: null, signal: 'SIGKILL' } }); };
  const result = await f.run(); assert.equal(result.errorCode, 'maintenance_drain_unconfirmed'); assert.equal(result.held, true); assert.deepEqual(f.calls, ['stop']);
});

test('drain receipt rejects invalid schema, non-boolean acknowledgement, NaN/stale times, wrong instance, and missing stop generation', async t => {
  const f = fixture(t);
  for (const change of [r => { r.schemaVersion = 2; }, r => { r.drained = 'yes'; }, r => { r.at = 'bad'; }, r => { r.at = '2000-01-01T00:00:00Z'; }, r => { r.instanceId = 'foreign'; }]) { const receipt = f.drain(); change(receipt); assert.throws(() => assertDrainReceipt(f.row, receipt, f.stopped()), error => error.code === 'maintenance_drain_unconfirmed'); }
  assert.throws(() => assertDrainReceipt(f.row, f.drain(), { lastDaemonExit: f.stopped().lastDaemonExit }), error => error.code === 'maintenance_drain_unconfirmed');
});

test('checkpoint failure leaves the stopped service held and resumable, without starting it', async t => {
  const f = fixture(t); let attempts = 0; const create = f.io.createCheckpoint;
  f.io.createCheckpoint = async input => { if (++attempts === 1) throw Object.assign(new Error('disk issue'), { code: 'test_disk_full' }); return create(input); };
  assert.equal((await f.run()).phase, 'recovery_required'); assert.deepEqual(f.calls, ['stop']);
  assert.equal((await f.run()).phase, 'completed'); assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']);
});

test('a healthy unrelated listener cannot skip new service startup', async t => {
  const f = fixture(t, { stopped: true, checkpointCompleted: true, phase: 'switching' }); f.phase('new');
  const result = await f.run(); assert.equal(result.errorCode, 'maintenance_identity_changed'); assert.equal(result.held, true); assert.deepEqual(f.calls, []);
});

test('lost start stdout immediately checks only the held successor with matching content identity', async t => {
  const f = fixture(t); const service = f.io.service;
  f.io.service = async (...args) => { const result = await service(...args); if (args[1] === 'start') throw Object.assign(new Error('lost startup stdout'), { code: 'test_lost_start' }); return result; };
  const result = await f.run(); assert.equal(result.phase, 'completed'); assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']);
  assert.equal(result.attempts.at(-1).status, 'completed');
  assert.equal(result.attempts.at(-1).stages.find(row => row.name === 'start').status, 'unconfirmed');
  assert.equal(result.attempts.at(-1).stages.find(row => row.name === 'verify_successor').reconciled, true);
});

test('an unconfirmed start is never sent twice even when recovery still sees no listener', async t => {
  const f = fixture(t); f.io.reconcileMs = 500;
  const service = f.io.service; f.io.service = async (...args) => {
    if (args[1] !== 'start') return service(...args);
    f.calls.push('start'); throw Object.assign(new Error('private/path?api_key=never-persist'), { code: 1 });
  };
  const first = await f.run(); assert.equal(first.errorCode, 'maintenance_start_unconfirmed'); assert.equal(first.held, true);
  const second = await f.run(); assert.equal(second.errorCode, 'maintenance_start_unconfirmed'); assert.equal(second.held, true);
  assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']); assert.equal(second.attemptCount, 2);
  assert.equal(second.attempts[0].stages.find(row => row.name === 'start').failureType, 'command_exit_nonzero');
  assert.equal(JSON.stringify(publicMaintenanceOperation(second)).includes('api_key'), false);
  f.phase('new'); assert.equal((await f.run()).phase, 'completed'); assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']);
});

test('attempt history remains bounded and retains counts and prior failure evidence', async t => {
  const f = fixture(t, { stopped: true, checkpointCompleted: true, startAttempted: true, phase: 'recovery_required' }); f.io.reconcileMs = 0;
  for (let index = 0; index < 15; index++) await f.run();
  const result = readMaintenance(f.stateFile), publicRow = publicMaintenanceOperation(result);
  assert.equal(result.attemptCount, 15); assert.equal(result.attempts.length, 12); assert.equal(result.attempts[0].number, 4);
  assert.ok(result.attempts.every(row => row.status === 'failed' && row.stages.at(-1).failureType === 'maintenance_start_unconfirmed'));
  assert.equal(publicRow.attemptCount, 15); assert.equal(publicRow.attempts.length, 12); assert.deepEqual(f.calls, []);
});

test('checkpoint diagnostic is attached to the failed attempt without a private path or content', async t => {
  const f = fixture(t); f.io.createCheckpoint = async () => { throw Object.assign(new Error('/private/user/file: content'), { code: 'checkpoint_changed', checkpointDiagnostic: { schemaVersion: 1, phase: 'inventory_after', elapsedMs: 12, totalChanges: 1, truncated: false, changes: [{ pathIdentity: 'a'.repeat(32), rootKind: 'rna', fields: ['ctime'], path: '/private/user/file', content: 'private text' }] } }); };
  const result = await f.run(), publicRow = publicMaintenanceOperation(result), stage = publicRow.attempts[0].stages.at(-1);
  assert.equal(result.held, true); assert.equal(stage.checkpoint.phase, 'inventory_after'); assert.deepEqual(stage.checkpoint.changes[0].fields, ['ctime']);
  assert.equal(JSON.stringify(publicRow).includes('/private'), false); assert.equal(JSON.stringify(publicRow).includes('private text'), false);
});

test('a same-version successor with wrong runtime bytes never releases admission', async t => {
  const f = fixture(t); const get = f.io.health;
  f.io.health = async () => { const health = await get(); return health?.process.instanceId === 'new-instance' ? { ...health, runtimeIdentity: 'c'.repeat(64) } : health; };
  const result = await f.run(); assert.equal(result.errorCode, 'maintenance_identity_changed'); assert.equal(result.held, true); assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']);
});

test('failed successor readiness stays held and can finish after its dependency recovers', async t => {
  const f = fixture(t); f.status.newHealthy = false; const failed = await f.run();
  assert.equal(failed.errorCode, 'maintenance_verification_failed'); assert.equal(failed.held, true);
  f.status.newHealthy = true; assert.equal((await f.run()).phase, 'completed'); assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']);
});

test('a crash after original-state restoration still resumes to a held usable service', async t => {
  const f = fixture(t, { kind: 'restore', restoreCompleted: true, stopped: true, checkpointCompleted: true, phase: 'recovery_required' });
  const result = await f.run(); assert.equal(result.phase, 'recovery_required'); assert.equal(result.errorCode, 'restored_state_review'); assert.equal(result.held, true);
  assert.equal(result.verifiedProcess.instanceId, 'new-instance'); assert.deepEqual(f.calls, ['start']);
  await f.run(); assert.deepEqual(f.calls, ['start'], 'Completed restoration review is never released by another worker invocation');
});

test('restored state may expose repair UI with a failed remote dependency while remaining held', async t => {
  const f = fixture(t, { kind: 'restore', restoreCompleted: true, stopped: true, checkpointCompleted: true, phase: 'switching' }); f.status.newHealthy = false;
  const result = await f.run(); assert.equal(result.errorCode, 'restored_state_review'); assert.equal(result.held, true); assert.equal(result.verifiedProcess.instanceId, 'new-instance');
});

test('real local binding requires both live process births and both lease generations', t => {
  const f = fixture(t), health = f.health('new'), birth = processBirth(process.pid);
  Object.assign(health.process, { pid: process.pid, supervisorRunId: 'bound-supervisor', generation: 'bound-generation' });
  atomicWrite(`${f.paths.directory}/config.json`, JSON.stringify({ stateFile: f.stateFile, ...f.row.expected.config }));
  atomicWrite(`${f.paths.directory}/status.json`, JSON.stringify({ childPid: process.pid, supervisorPid: process.pid, runId: 'bound-supervisor', generation: 'bound-generation' }));
  atomicWrite(`${f.paths.directory}/supervisor.lock`, JSON.stringify({ pid: process.pid, birth, supervisorRunId: 'bound-supervisor' }));
  atomicWrite(`${f.stateFile}.lock`, JSON.stringify({ pid: process.pid, birth, stateFile: f.stateFile, supervisorRunId: 'bound-supervisor', generation: 'bound-generation' }));
  assert.equal(maintenanceProcessBound(f.stateFile, health, f.row.expected.config), true);
  atomicWrite(`${f.stateFile}.lock`, JSON.stringify({ pid: process.pid, birth: 'reused-pid', stateFile: f.stateFile, supervisorRunId: 'bound-supervisor', generation: 'bound-generation' }));
  assert.equal(maintenanceProcessBound(f.stateFile, health, f.row.expected.config), false);
});

test('legacy daemon without question negotiation keeps natural waiting and records unsupported capability', async t => {
  const f = fixture(t); f.status.active = true; let negotiation = 0; f.io.suspendQuestions = async () => { negotiation++; };
  const result = await f.run(); assert.equal(result.phase, 'failed'); assert.equal(result.errorCode, 'maintenance_wait_timeout'); assert.equal(result.questionHandoff.capability, 'unsupported'); assert.equal(result.questionHandoff.phase, 'waiting_legacy'); assert.equal(negotiation, 0); assert.deepEqual(f.calls, []);
});

test('question handoff is negotiated by operation identity but only a later idle health permits stop', async t => {
  const f = fixture(t); f.status.active = true; const health = f.io.health; let negotiation = 0;
  f.io.health = async () => { const current = await health(); if (current) current.maintenance.questionHandoff = 1; return current; };
  f.io.suspendQuestions = async (_port, input) => { negotiation++; assert.equal(input.operationId, f.row.id); assert.equal(input.requestId, readMaintenance(f.stateFile).questionHandoff.requestId); f.status.active = false; };
  const result = await f.run(); assert.equal(result.phase, 'completed'); assert.equal(negotiation, 1); assert.deepEqual(f.calls, ['stop', 'checkpoint', 'start']);
});

test('unsupported or unsuccessful question handoff cannot reinterpret active writes as idle', async t => {
  const f = fixture(t); f.status.active = true; const health = f.io.health;
  f.io.health = async () => { const current = await health(); if (current) current.maintenance.questionHandoff = 1; return current; };
  f.io.suspendQuestions = async () => ({ suspended: 999 }); // Untrusted HTTP success is never the drain proof.
  const result = await f.run(); assert.equal(result.phase, 'failed'); assert.equal(result.errorCode, 'maintenance_wait_timeout'); assert.deepEqual(f.calls, []);
});

test('cancel accepted during question negotiation wins before shutdown', async t => {
  const f = fixture(t); f.status.active = true; const health = f.io.health;
  f.io.health = async () => { const current = await health(); if (current) current.maintenance.questionHandoff = 1; return current; };
  f.io.suspendQuestions = async () => { persistMaintenance(f.stateFile, { ...readMaintenance(f.stateFile), cancelRequested: true }); f.status.active = false; };
  const result = await f.run(); assert.equal(result.phase, 'cancelled'); assert.equal(result.held, false); assert.deepEqual(f.calls, []);
});
