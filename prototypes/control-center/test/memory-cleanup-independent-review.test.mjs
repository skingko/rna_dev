import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';
import { planMemoryEvidence, recoverPreparedMemoryEvidence, freezeLegacyMemoryEvidence, memoryEvidenceMessages } from '../memory-evidence-outbox.mjs';
import { captureSessionEvidence, discoverSessionEvidence, purgeSessionEvidenceFiles } from '../session-evidence-cleanup.mjs';

function prepared() {
  const session = { id: 's', projectId: 'p', items: [{ id: 'delivered', kind: 'assistant', source: 'initiative', simulated: false, text: 'A delivered fixture report', createdAt: '2026-09-27T00:00:00Z', initiativeActionId: 'share', evidenceIds: ['action:work:completed'] }], memoryEvidenceState: { schemaVersion: 1, seen: [] } };
  const project = { id: 'p', initiativeRuntime: { sdkState: { actions: [{ id: 'share', action: 'share', status: 'completed' }] } }, jobs: [], memorySessions: [] };
  const state = { projects: [project], sessions: [session], configuration: { memory: { autoStore: true } } };
  const write = planMemoryEvidence(state, session, { connectionFingerprint: 'f' }).records[0];
  // A delivery record as a version before MEM-7 enrolled it (remote-session path).
  Object.assign(write, { schemaVersion: 1, status: 'uncertain', code: 'MEMORY_SOURCE_CHANGED', sessionId: 'remote', nextMessage: 0 }); delete write.sourceContext; delete write.extraction;
  const binding = { sessionId: 'remote', sourceSessionId: 's', connectionFingerprint: 'f', status: 'ready', pendingRequests: [], taskIds: [] };
  project.memorySessions.push(binding);
  project.jobs.push({ id: 'work', simulated: false, lane: 'background', status: 'completed', toolReceipts: [] });
  return { state, session, project, write, binding };
}

test('independent audit: prepared-only recovery preserves both source identities and is pure', () => {
  const f = prepared(), before = structuredClone(f), patch = recoverPreparedMemoryEvidence(f.state, f.session, f.write, 'f');
  assert.equal(patch.status, 'ready'); assert.deepEqual(patch.sourceContext.evidence, []);
  assert.deepEqual(f, before); Object.assign(f.write, patch);
  assert.doesNotThrow(() => memoryEvidenceMessages(f.state, f.session.id, f.write));
  assert.equal(f.write.sourceHash, before.write.sourceHash); assert.deepEqual(f.write.sourceRefs, before.write.sourceRefs);
});

for (const [name, mutate] of [
  ['uploaded cursor', f => { f.write.nextMessage = 1; }],
  ['admitted upload', f => { f.write.batchCount = 1; }],
  ['dispatched resource', f => { f.write.resourceIndex = { dispatchedAt: '2026-09-27T00:00:00Z' }; }],
  ['paid task', f => { f.write.taskId = 'task'; }],
  ['unknown transport', f => { f.write.code = 'MEMORY_WRITE_OUTCOME_UNKNOWN'; }],
  ['changed connection', f => { f.write.connectionFingerprint = 'other'; }],
  ['unsettled binding', f => { f.binding.status = 'creating'; }],
  ['cross-session binding', f => { f.binding.sourceSessionId = 'other'; }],
  ['binding connection changed', f => { f.binding.connectionFingerprint = 'other'; }],
  ['pending request', f => { f.binding.pendingRequests.push({ id: 'r', status: 'inflight' }); }],
  ['uncertain request', f => { f.binding.pendingRequests.push({ id: 'r', status: 'uncertain' }); }],
  ['missing pending ledger', f => { delete f.binding.pendingRequests; }],
  ['known extraction task', f => { f.binding.taskIds.push('task'); }],
  ['missing task ledger', f => { delete f.binding.taskIds; }],
  ['unknown cleanup', f => { f.binding.cleanupOutcomeUnknown = true; }],
  ['source hash mismatch', f => { f.write.sourceRefs[0].sourceHash = '0'.repeat(64); }],
  ['wire hash mismatch', f => { f.write.sourceHash = '0'.repeat(64); }],
  ['edited text', f => { f.session.items[0].text += ' changed'; }],
  ['revoked source item', f => { f.session.items[0].contextRevoked = true; }],
  ['revoked source action', f => { f.project.initiativeRuntime.sdkState.actions[0].sourceDeleted = true; }],
  ['deleted session', f => { f.session.deletedAt = 'now'; }],
  ['deleted project', f => { f.project.deletedAt = 'now'; }],
]) test(`independent audit: prepared recovery rejects ${name}`, () => {
  const f = prepared(); mutate(f); assert.equal(recoverPreparedMemoryEvidence(f.state, f.session, f.write, 'f'), null);
});

test('independent audit: completed legacy migration is metadata-only and repeated migration does no work', () => {
  const f = prepared(); Object.assign(f.write, { status: 'completed', code: null, nextMessage: 1, taskId: 'paid' });
  const before = structuredClone(f.write), patch = freezeLegacyMemoryEvidence(f.state, f.session, f.write);
  assert.deepEqual(Object.keys(patch).sort(), ['schemaVersion', 'sourceContext']); Object.assign(f.write, patch);
  assert.equal(f.write.nextMessage, before.nextMessage); assert.equal(f.write.taskId, 'paid'); assert.equal(f.write.status, 'completed');
  assert.equal(f.write.sourceHash, before.sourceHash); assert.equal(freezeLegacyMemoryEvidence(f.state, f.session, f.write), null);
});

function journalFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-cleanup-independent-')), file = join(directory, 'state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = { id: 'session', projectId: 'project', items: [{ id: 'message' }], turns: [] };
  const state = { sessions: [session], projects: [{ id: 'project', observations: [], facts: [], jobs: [], decisions: [], initiativeRuntime: { sdkState: { actions: [], events: [] } } }] };
  const root = join(`${file}.rna`, 'initiative', 'project', 'action');
  const journal = openJournal({ stateDir: root, sessionId: 'action', projectId: 'project' });
  journal.append('inbox_added', { item: { context: [{ source: 'project-evidence', text: JSON.stringify({ project: { recentConversation: [{ sessionId: 'session', id: 'message', text: '边界🙂'.repeat(60000) }] } }) }] } });
  journal.append('diagnostic', { text: 'tail-before' }); journal.close();
  const record = { sessionId: 'session', projectId: 'project', evidence: captureSessionEvidence(state, session) };
  return { file, state, root, journal: journal.file, record };
}

test('independent audit: UTF-8 across streaming blocks retains hash identity and permits exact linked journal removal', async t => {
  const f = journalFixture(t); f.record.evidence = await discoverSessionEvidence(f.file, f.record, { state: f.state });
  assert.deepEqual(f.record.evidence.journalActionIds, ['action']);
  const result = await purgeSessionEvidenceFiles(f.file, f.record, { writersSettled: true });
  assert.equal(result.removedJournals, 1); assert.equal(existsSync(f.root), false);
});

test('independent audit: corruption after streamed context never permits journal or execution capture deletion', async t => {
  const f = journalFixture(t), log = join(f.root, 'exec', 'rna-exec-Ab12_-', 'output.log');
  mkdirSync(join(log, '..'), { recursive: true }); writeFileSync(log, 'retained output');
  writeFileSync(f.journal, readFileSync(f.journal, 'utf8').replace('tail-before', 'tail-after!'));
  await assert.rejects(discoverSessionEvidence(f.file, f.record, { state: f.state }), { code: 'SESSION_EVIDENCE_JOURNAL_INVALID' });
  assert.equal(existsSync(f.journal), true); assert.equal(existsSync(log), true);
});
