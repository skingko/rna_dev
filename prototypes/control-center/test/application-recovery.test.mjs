import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { acquireProcessLease } from '../process-lease.mjs';
import { maintenancePaths, persistMaintenance, readMaintenance } from '../application-maintenance-state.mjs';
import { applicationRecoveryStatus, reconcileRestoredState } from '../application-recovery.mjs';
import { verifyStateCheckpoint } from '../state-checkpoint.mjs';
import { readStateFile } from '../state-shards.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-app-recovery-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'state.json'), store = new Store(stateFile);
  const { project, session } = store.createProject({ name: 'Recovery fixture', workspace: directory });
  const idle = store.createSession({ projectId: project.id });
  const operationId = randomUUID();
  store.mutate(state => {
    state.emergency = true; state.configuration.memory.autoStore = true;
    const s = state.sessions.find(row => row.id === session.id); s.status = 'running'; s.activeTurnId = 'old-turn';
    s.turns = [{ id: 'old-turn', status: 'running', memoryWrite: { status: 'polling', taskId: 'external-task', requestId: 'old-request' }, memoryCheckpoints: [{ id: 'checkpoint', status: 'pending' }] }];
    s.inbox = [{ id: 'old-message', text: 'private old instruction', delivery: 'steer', deliveryStatus: 'accepted' }];
    s.items.push({ id: 'tool', kind: 'tool', turnId: 'old-turn', streaming: true, tool: { status: 'running', name: 'project_exec', input: { command: 'old command' } } });
    s.memoryEvidenceOutbox = [{ id: 'outbox', status: 'completed', sourceRefs: [], resourceIndex: { status: 'completed', uri: 'viking://fixture/resource', receipt: { complete: true, contentVerified: true } } }, { id: 'pending-memory', status: 'creating', requestId: 'paid-request' }];
    const p = state.projects.find(row => row.id === project.id); p.initiative.enabled = true; p.evolution.enabled = true;
    p.schedules = [{ id: 'daily', enabled: true, userPaused: false, revision: 2, rule: { type: 'interval', intervalMs: 86400000 }, destinationSessionId: s.id }];
    p.scheduleRuntime = { occurrences: [{ key: 'pending-delivery', scheduleId: 'daily', status: 'delivery_pending', result: 'already-produced-delivery' }, { key: 'done', status: 'delivered', deliveryItemId: 'receipt' }] };
    p.initiativeRuntime = { sdkState: { schemaVersion: 1, revision: 2, events: [], seenEventIds: [], policy: { enabled: true }, actions: [{ id: 'work', action: 'work', status: 'running', checkpoint: { sessionId: 'work' }, controlRevision: 1, controls: [{ id: 'control', kind: 'steer', status: 'pending', revision: 1, expectedRevision: 0, createdAt: 0 }] }, { id: 'finished', action: 'work', status: 'completed', result: 'retained actual receipt' }] } };
    p.jobs = [{ id: 'work', status: 'running', output: 'partial real output' }, { id: 'finished', status: 'completed', output: 'finished output' }];
    p.learningRuntime = { sdkState: { schemaVersion: 1, episodes: [{ id: 'episode', status: 'pending', content: 'retained evidence' }], reviews: [{ id: 'review', status: 'queued_experiment', decision: { outcome: 'experiment' } }], seen: [] } };
    p.evolution.request = { id: 'evolution-request', status: 'running' };
    p.versions = [{ id: 'candidate', state: 'evaluating', evaluation: { realReceipt: 'keep' } }, { id: 'active', state: 'active', bundle: { hash: 'real-baseline' } }];
    p.memorySummary = { id: 'summary', status: 'polling', taskId: 'summary-paid-request' };
    state.goals = [{ id: 'goal', status: 'scheduled', sessionId: s.id, receipts: ['keep-receipt'] }];
    state.sessionDeletions = [{ sessionId: 'deleted', projectId: p.id, status: 'pending', localStatus: 'pending', remoteStatus: 'pending', bindings: [{ sessionId: 'remote-session' }] }, { sessionId: 'already-deleted', status: 'completed', bindings: [] }];
  });
  persistMaintenance(stateFile, { schemaVersion: 1, id: operationId, requestId: 'restored-state-request', kind: 'restore', phase: 'recovery_required', held: true, restoreCompleted: true, owner: null, startedAt: new Date().toISOString() });
  const before = readStateFile(stateFile).state;
  return { directory, stateFile, store, projectId: project.id, sessionId: session.id, idleId: idle.id, operationId, before };
}

test('explicit offline reconciliation preserves receipts while isolating every old automatic lane', async t => {
  const f = await fixture(t), report = await reconcileRestoredState(f), state = readStateFile(f.stateFile).state;
  assert.equal(report.reconciled, true); assert.equal(report.required, false); assert.equal(report.emergency, true);
  assert.equal(readMaintenance(f.stateFile).held, false); assert.equal(readMaintenance(f.stateFile).phase, 'completed');
  assert.deepEqual(state.applicationRecovery.barriers, { memory: true, background: true });
  assert.equal(state.configuration.memory.autoStore, false); assert.equal(state.emergency, true);
  const s = state.sessions.find(row => row.id === f.sessionId), p = state.projects.find(row => row.id === f.projectId);
  assert.equal(s.status, 'paused'); assert.equal(s.activeTurnId, 'old-turn'); assert.equal(s.appRecovery.required, true);
  assert.equal(state.sessions.find(row => row.id === f.idleId).appRecovery.required, true, 'old idle SDK contexts also require a fresh conversation');
  assert.equal(s.turns[0].status, 'paused'); assert.equal(s.inbox[0].text, 'private old instruction'); assert.equal(s.inbox[0].appRecovery.required, true);
  assert.equal(s.items.find(row => row.id === 'tool').tool.status, 'running', 'no invented failure receipt replaces an unknown tool outcome');
  assert.equal(s.items.find(row => row.id === 'tool').streaming, false);
  assert.equal(s.turns[0].memoryWrite.status, 'recovery_review'); assert.equal(s.turns[0].memoryWrite.taskId, 'external-task');
  assert.equal(s.memoryEvidenceOutbox[0].status, 'completed'); assert.deepEqual(s.memoryEvidenceOutbox[0].resourceIndex.receipt, { complete: true, contentVerified: true });
  assert.equal(s.memoryEvidenceOutbox[0].appRecovery.required, true); assert.equal(s.memoryEvidenceOutbox[1].status, 'recovery_review');
  assert.equal(p.initiative.enabled, false); assert.equal(p.evolution.enabled, false); assert.equal(p.appRecovery.background, true);
  assert.equal(p.schedules[0].enabled, false); assert.equal(p.schedules[0].userPaused, true); assert.equal(p.schedules[0].revision, 2);
  assert.equal(p.scheduleRuntime.occurrences[0].status, 'needs_review'); assert.equal(p.scheduleRuntime.occurrences[0].result, 'already-produced-delivery'); assert.equal(p.scheduleRuntime.occurrences[1].status, 'delivered');
  const action = p.initiativeRuntime.sdkState.actions[0]; assert.equal(action.status, 'needs_review'); assert.equal(action.blocksExecution, true); assert.equal(action.controls[0].status, 'rejected');
  assert.equal(p.initiativeRuntime.sdkState.actions[1].result, 'retained actual receipt'); assert.equal(p.jobs[0].status, 'paused'); assert.equal(p.jobs[0].output, 'partial real output');
  assert.equal(p.learningRuntime.sdkState.reviews[0].status, 'interrupted'); assert.ok(p.learningRuntime.sdkState.reviews[0].reconciledAt); assert.equal(p.learningRuntime.sdkState.episodes[0].content, 'retained evidence');
  assert.equal(p.versions[0].state, 'interrupted'); assert.equal(p.versions[0].evaluation.realReceipt, 'keep'); assert.equal(p.versions[1].state, 'active');
  assert.equal(p.memorySummary.status, 'recovery_review'); assert.equal(p.memorySummary.taskId, 'summary-paid-request');
  assert.equal(state.sessionDeletions[0].status, 'recovery_review'); assert.deepEqual(state.sessionDeletions[0].bindings, f.before.sessionDeletions[0].bindings); assert.equal(state.sessionDeletions[1].status, 'completed');
  assert.equal(state.goals[0].status, 'paused'); assert.deepEqual(state.goals[0].receipts, ['keep-receipt']);
  const checkpoint = await verifyStateCheckpoint({ directory: state.applicationRecovery.preReviewCheckpoint });
  assert.equal(checkpoint.id, state.applicationRecovery.preReviewCheckpointId);
  assert.deepEqual(readStateFile(join(checkpoint.directory, 'payload/state.json')).state, f.before);
  assert.equal(JSON.stringify(report).includes('private old instruction'), false); assert.match(report.warning, /没有回滚/);
});

test('reconciliation is idempotent and does not write another checkpoint or status revision', async t => {
  const f = await fixture(t); const first = await reconcileRestoredState(f), bytes = await readFile(f.stateFile);
  const again = await reconcileRestoredState(f); assert.deepEqual(again.review, first.review); assert.deepEqual(await readFile(f.stateFile), bytes);
});

test('a failure after state publication leaves maintenance held; retry completes from the exact saved review', async t => {
  const f = await fixture(t), record = join(maintenancePaths(f.stateFile).records, `${f.operationId}.json`);
  await rm(record); await mkdir(record);
  await assert.rejects(reconcileRestoredState(f));
  assert.equal(readMaintenance(f.stateFile).held, true);
  const state = readStateFile(f.stateFile).state; assert.equal(state.applicationRecovery.operationId, f.operationId);
  const bytes = await readFile(f.stateFile); await rm(record, { recursive: true });
  const result = await reconcileRestoredState(f); assert.equal(result.required, false); assert.deepEqual(await readFile(f.stateFile), bytes);
});

for (const lane of ['state', 'supervisor', 'worker']) test(`review refuses a live ${lane} owner and leaves all old receipts untouched`, async t => {
  const f = await fixture(t), paths = maintenancePaths(f.stateFile), lock = lane === 'state' ? `${f.stateFile}.lock` : lane === 'worker' ? paths.worker : join(paths.directory, 'supervisor.lock');
  const release = await acquireProcessLease(lock); t.after(release); const before = await readFile(f.stateFile);
  await assert.rejects(reconcileRestoredState(f)); assert.deepEqual(await readFile(f.stateFile), before); assert.equal(readMaintenance(f.stateFile).held, true);
});

for (const change of [{ id: randomUUID() }, { restoreCompleted: false }, { held: false }, { phase: 'verifying' }, { kind: 'backup' }]) test(`review requires the exact completed-and-held restore request ${Object.keys(change)[0]}`, async t => {
  const f = await fixture(t); persistMaintenance(f.stateFile, { ...readMaintenance(f.stateFile), ...change }); const bytes = await readFile(f.stateFile);
  await assert.rejects(reconcileRestoredState(f)); assert.deepEqual(await readFile(f.stateFile), bytes);
});

test('status is read-only and exposes review counts rather than old private messages', async t => {
  const f = await fixture(t), before = await readFile(f.stateFile), row = await applicationRecoveryStatus(f);
  assert.equal(row.required, true); assert.equal(row.reconciled, false); assert.deepEqual(await readFile(f.stateFile), before);
  assert.equal(JSON.stringify(row).includes('private old instruction'), false);
  await assert.rejects(applicationRecoveryStatus({ ...f, operationId: randomUUID() }), { code: 'application_recovery_identity' });
});

test('a corrupt restored state does not release maintenance or hide the corruption', async t => {
  const f = await fixture(t); atomicWrite(f.stateFile, '{corrupt'); await assert.rejects(reconcileRestoredState(f));
  assert.equal(await readFile(f.stateFile, 'utf8'), '{corrupt'); assert.equal(readMaintenance(f.stateFile).held, true);
});

test('maintenance worker/control paths cannot follow symlinks before acquiring offline ownership', async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside.sqlite'); await writeFile(outside, 'do not touch');
  await symlink(outside, `${maintenancePaths(f.stateFile).worker}.sqlite`);
  await assert.rejects(reconcileRestoredState(f), { code: 'maintenance_unsafe_path' });
  assert.equal(await readFile(outside, 'utf8'), 'do not touch'); assert.equal(readMaintenance(f.stateFile).held, true);
});

test('a linked maintenance root is rejected before creating any ownership files outside it', async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside'); await mkdir(outside);
  await rm(maintenancePaths(f.stateFile).directory, { recursive: true }); await symlink(outside, maintenancePaths(f.stateFile).directory);
  await assert.rejects(reconcileRestoredState(f), { code: 'maintenance_unsafe_path' });
  assert.deepEqual(await readdir(outside), []);
});

test('a restore taken during an emergency stop leaves projects off when the stop is lifted; the user switches each back on (C-h)', async t => {
  const f = await fixture(t);
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.projectId); p.initiative.enabled = false; p.initiative.pausedByEmergency = true; });
  await reconcileRestoredState(f);
  const p = readStateFile(f.stateFile).state.projects.find(row => row.id === f.projectId);
  assert.equal(p.initiative.enabled, false); assert.equal(p.initiative.pausedByEmergency, undefined);
  const store = new Store(f.stateFile); store.emergency(false);
  assert.equal(store.state.projects.find(row => row.id === f.projectId).initiative.enabled, false);
});
