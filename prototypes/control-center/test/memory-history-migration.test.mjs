import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MemorySync, memorySyncHealth, stampSettledMemoryHistory } from '../memory-sync.mjs';
import { projectMemorySyncStatus } from '../memory-sync-status.mjs';

// A2: settled memory losses are history without a click (OpenViking's own client records a permanent loss and moves
// on: pi sync.ts droppedForever / captureGap). The one-time startup migration stamps the settled rows kept from before,
// and must never touch — or hide — an unresolved one.
const at = '2026-10-01T00:00:00.000Z';
function shapes() {
  // One of every recorded shape: settled, unresolved and nothing-to-report, on turn writes, checkpoints, evidence and indexes.
  return {
    projects: [{ id: 'p' }],
    sessions: [{ id: 's', projectId: 'p', items: [], turns: [
      { id: 'extraction-failed', status: 'completed', memoryWrite: { status: 'failed', code: 'MEMORY_EXTRACTION_FAILED', taskId: 'task', updatedAt: at } },
      { id: 'rejected', status: 'completed', memoryWrite: { status: 'failed', code: 'MEMORY_WRITE_REJECTED', updatedAt: at } },
      { id: 'undeterminable', status: 'completed', memoryWrite: { status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN', reconcile: { status: 'undeterminable' }, updatedAt: at } },
      { id: 'unknown', status: 'completed', memoryWrite: { status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN', updatedAt: at } },
      { id: 'retrying', status: 'completed', memoryWrite: { status: 'polling', code: 'MEMORY_TASK_LOOKUP_FAILED', pollFailures: 2, updatedAt: at } },
      { id: 'done', status: 'completed', memoryWrite: { status: 'completed', memoriesExtracted: 1, updatedAt: at } },
      { id: 'checkpoints', status: 'completed', memoryCheckpoints: [
        { id: 'abandoned', kind: 'incremental', status: 'abandoned', code: 'MEMORY_SOURCE_CHANGED', updatedAt: at },
        { id: 'pending', kind: 'final', status: 'pending', updatedAt: at }] },
    ], memoryEvidenceOutbox: [
      { id: 'index-failed', status: 'completed', resourceIndex: { status: 'failed', code: 'MEMORY_EVIDENCE_INDEX_FAILED', updatedAt: at } },
      { id: 'index-unconfirmed', status: 'completed', resourceIndex: { status: 'uncertain', code: 'MEMORY_EVIDENCE_WRITE_UNCONFIRMED', updatedAt: at } },
      { id: 'cleanup-unconfirmed', status: 'completed', resourceIndex: { status: 'failed', code: 'MEMORY_EVIDENCE_DELETE_UNCONFIRMED', cleanup: { status: 'unconfirmed' }, updatedAt: at } },
      { id: 'evidence-unknown', status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN', updatedAt: at },
    ] }],
  };
}
const unresolvedKeys = health => health.issues.map(row => [row.turnId ?? row.evidenceId, row.checkpointId ?? row.stage ?? null]);

test('the migration stamps only settled writes and indexes; every unresolved row keeps its place in attention', () => {
  const state = shapes(), before = memorySyncHealth(state), status = projectMemorySyncStatus(state, state.projects[0]);
  assert.equal(before.unresolved, 5); assert.equal(before.settledLoss, 5); assert.equal(before.acknowledged, 0);
  // Already history before any stamp: attention counts the unresolved rows alone.
  assert.equal(status.attention, 5); assert.equal(status.sessions[0].history.length, 5);
  assert.equal(stampSettledMemoryHistory(state, { now: '2026-10-05T00:00:00.000Z', dryRun: true }), 5);
  assert.equal(JSON.stringify(state), JSON.stringify(shapes()), 'a dry run changes nothing');
  assert.equal(stampSettledMemoryHistory(state, { now: '2026-10-05T00:00:00.000Z' }), 5);
  const [session] = state.sessions, write = id => session.turns.find(turn => turn.id === id).memoryWrite;
  for (const id of ['extraction-failed', 'rejected', 'undeterminable']) assert.equal(write(id).acknowledgedAt, '2026-10-05T00:00:00.000Z', id);
  for (const id of ['unknown', 'retrying', 'done']) assert.equal(write(id).acknowledgedAt, undefined, id);
  assert.deepEqual(session.turns.at(-1).memoryCheckpoints.map(row => row.acknowledgedAt ?? null), ['2026-10-05T00:00:00.000Z', null]);
  assert.deepEqual(session.memoryEvidenceOutbox.map(row => [row.acknowledgedAt ?? null, row.resourceIndex?.acknowledgedAt ?? null]),
    [[null, '2026-10-05T00:00:00.000Z'], [null, null], [null, null], [null, null]]);
  const after = memorySyncHealth(state);
  assert.deepEqual(unresolvedKeys(after), unresolvedKeys(before)); assert.equal(after.unresolved, 5); assert.equal(after.healthy, false);
  assert.equal(after.settledLoss, 5); assert.equal(after.acknowledged, 5);
  assert.equal(projectMemorySyncStatus(state, state.projects[0]).attention, 5);
  assert.equal(stampSettledMemoryHistory(state), 0, 'a second run changes nothing');
});

test('a stamp never hides a row that becomes unresolved again', () => {
  const state = shapes(); stampSettledMemoryHistory(state);
  // A settled index whose source is revoked later goes into cleanup: unresolved again, stamp and all.
  Object.assign(state.sessions[0].memoryEvidenceOutbox[0].resourceIndex, { status: 'uncertain', code: 'MEMORY_EVIDENCE_DELETE_UNCONFIRMED', cleanup: { status: 'deleting' } });
  const health = memorySyncHealth(state);
  assert.equal(health.unresolved, 6); assert.ok(health.issues.some(row => row.evidenceId === 'index-failed' && row.stage === 'project_resource_cleanup'));
  assert.equal(projectMemorySyncStatus(state, state.projects[0]).sessions[0].issues.length, 5, 'the session row lists five');
});

test('sessions held for application recovery are left for a later start', () => {
  const state = shapes(); state.sessions[0].appRecovery = { required: true };
  assert.equal(stampSettledMemoryHistory(state), 0);
  delete state.sessions[0].appRecovery; state.sessions[0].memoryEvidenceOutbox[0].resourceIndex.appRecovery = { required: true };
  assert.equal(stampSettledMemoryHistory(state), 4);
});

test('MemorySync runs the migration once per start, and waits for a maintenance hold to lift', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json'), store = new Store(file), { project, session } = store.createProject({ name: 'History migration' });
  const fixture = shapes().sessions[0];
  store.mutate(state => { const row = state.sessions.find(s => s.id === session.id); row.turns = fixture.turns; row.memoryEvidenceOutbox = fixture.memoryEvidenceOutbox; for (const turn of row.turns) turn.modelConfig = { execution: 'rna' }; });
  store.close?.();
  const restarted = new Store(file); restarted.maintenanceHeld = true;
  const revision = restarted.state.revision;
  const sync = new MemorySync(restarted, { now: () => Date.parse('2026-10-05T00:00:00Z'), pollMs: 1000 }); t.after(() => sync.close());
  assert.equal(restarted.state.revision, revision, 'nothing is written while maintenance holds the store');
  // The pump runs it first once the hold lifts.
  restarted.maintenanceHeld = false; sync.stampHistory();
  const health = () => memorySyncHealth({ projects: restarted.state.projects.filter(row => row.id === project.id), sessions: restarted.state.sessions });
  assert.equal(health().acknowledged, 5); assert.equal(health().unresolved, 5); assert.equal(health().settledLoss, 5);
  const stamped = restarted.state.revision; assert.ok(stamped > revision);
  sync.stampHistory(); assert.equal(restarted.state.revision, stamped, 'once per start');
  // Later settles are history by their resolution alone; the migration does not run again in this process.
  restarted.mutate(state => { Object.assign(state.sessions.find(s => s.id === session.id).turns.find(turn => turn.id === 'unknown').memoryWrite, { status: 'failed', code: 'MEMORY_WRITE_REJECTED' }); });
  sync.stampHistory();
  const write = restarted.state.sessions.find(s => s.id === session.id).turns.find(turn => turn.id === 'unknown').memoryWrite;
  assert.equal(write.acknowledgedAt, undefined);
  const status = projectMemorySyncStatus(restarted.state, restarted.state.projects.find(row => row.id === project.id));
  assert.equal(status.attention, 4); assert.ok(status.sessions[0].history.some(row => row.turnId === 'unknown'));
});
