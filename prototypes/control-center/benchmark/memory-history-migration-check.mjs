#!/usr/bin/env node
// A2: run the settled-loss history migration (stampSettledMemoryHistory) on a copy of a real state file and check that it
// stamps only settled rows and never hides an unresolved one. Read-only: the state is read with readStateFile (never a
// Store), the migration runs on an in-memory copy, nothing is written back.
//   RNA_STATE=…/.state/state.json node benchmark/memory-history-migration-check.mjs [--strip-acknowledged]
// --strip-acknowledged removes the existing acknowledgedAt stamps from the copy first, to check the migration against the
// state as it was before anyone acknowledged anything.
import assert from 'node:assert/strict';
import { readStateFile } from '../state-shards.mjs';
import { memorySyncHealth, memoryWriteResolution, memoryIndexResolution, stampSettledMemoryHistory } from '../memory-sync.mjs';
import { memoryWriteRecords } from '../memory-checkpoints.mjs';
import { projectMemorySyncStatus } from '../memory-sync-status.mjs';

const file = process.env.RNA_STATE;
if (!file) { console.error('Set RNA_STATE to a state.json path.'); process.exit(2); }
const state = structuredClone(readStateFile(file)?.state ?? null);
if (!state) { console.error(`No state at ${file}`); process.exit(2); }
const rows = () => state.sessions.flatMap(session => [
  ...(session.turns ?? []).flatMap(turn => memoryWriteRecords(turn).map(({ id, write }) => ({ key: `${session.id}/${turn.id}/${id ?? 'write'}`, row: write, resolution: memoryWriteResolution(write) }))),
  ...(session.memoryEvidenceOutbox ?? []).flatMap(write => [{ key: `${session.id}/evidence/${write.id}`, row: write, resolution: memoryWriteResolution(write) },
    ...(write.resourceIndex ? [{ key: `${session.id}/evidence/${write.id}/index`, row: write.resourceIndex, resolution: memoryIndexResolution(write.resourceIndex) }] : [])]),
]).filter(entry => entry.row && typeof entry.row === 'object');
if (process.argv.includes('--strip-acknowledged')) for (const { row } of rows()) delete row.acknowledgedAt;
// --inject-unresolved: turn every seventh completed record into one of the unresolved shapes (and give the settled ones
// that carry a stamp a sibling that is unresolved), so the check is not vacuous on a state with nothing unresolved.
if (process.argv.includes('--inject-unresolved')) {
  const shapes = [{ status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN' }, { status: 'polling', code: 'MEMORY_TASK_LOOKUP_FAILED', pollFailures: 3 }, { status: 'pending', code: 'MEMORY_CONNECTION_UNAVAILABLE', pollFailures: 1 }];
  rows().filter(entry => entry.row.status === 'completed').forEach((entry, index) => {
    if (index % 7) return;
    if (entry.key.endsWith('/index')) Object.assign(entry.row, { status: 'uncertain', code: 'MEMORY_EVIDENCE_WRITE_UNCONFIRMED', acknowledgedAt: '2026-10-04T00:00:00.000Z' });
    else Object.assign(entry.row, shapes[index % shapes.length], index % 2 ? { acknowledgedAt: '2026-10-04T00:00:00.000Z' } : {});
  });
}
const snapshot = () => Object.fromEntries(state.projects.map(project => {
  const health = memorySyncHealth({ projects: [project], sessions: state.sessions.filter(row => row.projectId === project.id) });
  const status = projectMemorySyncStatus(state, project);
  return [project.id, { unresolved: health.unresolved, issues: JSON.stringify(health.issues), settledLoss: health.settledLoss, acknowledged: health.acknowledged, attention: status.attention,
    legacyAttention: health.unresolved + (health.settledLoss - health.acknowledged), sessionIssues: JSON.stringify(status.sessions.map(row => row.issues)) }];
}));
const unresolvedBefore = rows().filter(entry => entry.resolution === 'unresolved').map(entry => entry.key).sort();
const stampedBefore = new Set(rows().filter(entry => entry.row.acknowledgedAt).map(entry => entry.key));
const before = snapshot(), now = new Date().toISOString(), stamped = stampSettledMemoryHistory(state, { now }), after = snapshot();
const newly = rows().filter(entry => entry.row.acknowledgedAt === now && !stampedBefore.has(entry.key));
assert.equal(newly.length, stamped);
assert.ok(newly.every(entry => entry.resolution === 'settled'), 'only settled rows are stamped');
assert.deepEqual(rows().filter(entry => entry.resolution === 'unresolved').map(entry => entry.key).sort(), unresolvedBefore, 'no unresolved row changes');
assert.ok(rows().filter(entry => entry.resolution === 'unresolved').every(entry => !newly.includes(entry)), 'no unresolved row is stamped');
for (const id of Object.keys(before)) {
  for (const key of ['unresolved', 'issues', 'settledLoss', 'attention', 'sessionIssues']) assert.equal(after[id][key], before[id][key], `${id} ${key}`);
  assert.equal(after[id].attention, after[id].unresolved, `${id}: attention counts unresolved rows only`);
  assert.equal(after[id].legacyAttention, after[id].unresolved, `${id}: nothing settled is left waiting for the user`);
}
assert.equal(stampSettledMemoryHistory(state, { now }), 0, 'idempotent');
console.log(JSON.stringify({ file, stripped: process.argv.includes('--strip-acknowledged'), records: rows().length, unresolved: unresolvedBefore.length, stamped,
  projects: Object.fromEntries(Object.entries(after).map(([id, row]) => [id.slice(0, 8), { unresolved: row.unresolved, settledLoss: row.settledLoss, acknowledgedBefore: before[id].acknowledged, acknowledgedAfter: row.acknowledged, attentionBefore: before[id].legacyAttention, attentionAfter: row.attention }])) }, null, 1));
