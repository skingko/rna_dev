import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectMemorySyncStatus } from '../memory-sync-status.mjs';

// Counting semantics formerly asserted on the legacy UI's projectMemoryDisplay;
// the workbench now renders these server-side counts (MemorySyncPanel).
const status = (project, sessions) => projectMemorySyncStatus({ projects: [project], sessions }, project);

test('completed project memory counts only this project, and pending writes stay pending', () => {
  const project = { id: 'a' }, sessions = [{ id: 's', projectId: 'a', turns: [{ id: 'one', status: 'completed', memoryWrite: { status: 'completed' } }] }, { id: 'other', projectId: 'b', turns: [{ id: 'other', status: 'completed', memoryWrite: { status: 'completed' } }] }];
  assert.equal(status(project, sessions).completedTurns, 1);
  sessions[0].turns.push({ id: 'two', status: 'completed', memoryWrite: { status: 'polling' } });
  const pending = status(project, sessions); assert.equal(pending.completedTurns, 1); assert.equal(pending.pending, 1); assert.equal(pending.status, 'syncing');
  sessions[0].turns[1].memoryWrite.status = 'completed';
  const settled = status(project, sessions); assert.equal(settled.completedTurns, 2); assert.equal(settled.pending, 0); assert.equal(settled.status, 'synced');
});

test('multiple checkpoints remain one completed turn and incremental syncs are counted separately', () => {
  const sessions = [{ id: 's', projectId: 'p', turns: [{ id: 't', status: 'running', memoryCheckpoints: [{ id: 'a', kind: 'incremental', status: 'completed', memoriesExtracted: 0 }, { id: 'b', kind: 'incremental', status: 'completed' }, { id: 'c', kind: 'final', status: 'polling' }] }] }];
  const running = status({ id: 'p' }, sessions);
  assert.deepEqual([running.completedTurns, running.incremental, running.pending], [0, 2, 1]);
  sessions[0].turns[0].status = 'completed'; Object.assign(sessions[0].turns[0].memoryCheckpoints[2], { status: 'completed', memoriesExtracted: 1 });
  const final = status({ id: 'p' }, sessions);
  assert.deepEqual([final.completedTurns, final.incremental, final.pending], [1, 2, 0]);
});

test('retained working memory is reported as synced-but-unsettled, not as new long-term content', () => {
  const session = { id: 's', projectId: 'p', turns: [{ id: 't', status: 'running', memoryCheckpoints: [{ id: 'c', kind: 'incremental', status: 'retained' }] }] };
  assert.equal(status({ id: 'p' }, [session]).retained, 1);
});

test('only a successful later final checkpoint settles retained tails and completes an archived turn', () => {
  const turn = { id: 't', status: 'completed', memoryCheckpoints: [{ id: 'r', kind: 'incremental', status: 'retained' }, { id: 'i', kind: 'incremental', status: 'completed', memoriesExtracted: 0 }] };
  const sessions = [{ id: 's', projectId: 'p', turns: [turn] }], current = () => status({ id: 'p' }, sessions);
  assert.equal(current().completedTurns, 0); assert.equal(current().retained, 1);
  const final = { id: 'f', kind: 'final', status: 'polling' }; turn.memoryCheckpoints.push(final);
  for (const value of ['polling', 'failed', 'retained']) { final.status = value; assert.equal(current().completedTurns, 0, value); assert.ok(current().retained >= 1, value); }
  for (const value of ['completed', 'skipped']) { final.status = value; assert.equal(current().completedTurns, 1, value); assert.equal(current().retained, 0, value); }
  assert.equal(turn.memoryCheckpoints[0].status, 'retained');
  turn.memoryCheckpoints.push({ id: 'new-tail', kind: 'incremental', status: 'retained' });
  // The legacy label counted only tails after the last settled final (1); the
  // server health count includes the earlier settled tail as well.
  assert.equal(current().completedTurns, 0); assert.ok(current().retained >= 1);
});

test('autonomous and answered evidence archives are separate from user turns and do not imply new memories', () => {
  const session = { id: 's', projectId: 'p', turns: [], memoryEvidenceOutbox: [{ id: 'e', sourceKind: 'autonomous_delivery', status: 'polling' }] }, project = { id: 'p' };
  const initial = status(project, [session]); assert.equal(initial.completedTurns, 0); assert.equal(initial.evidence.records, 1); assert.equal(initial.evidence.completed, 0); assert.equal(initial.pending, 1);
  Object.assign(session.memoryEvidenceOutbox[0], { status: 'completed', memoriesExtracted: 0 });
  const archived = status(project, [session]); assert.equal(archived.evidence.completed, 1); assert.equal(archived.evidence.extracted, 0);
  session.memoryEvidenceOutbox.push({ id: 'answer', sourceKind: 'interaction_answer', status: 'completed', memoriesExtracted: 1 });
  const extracted = status(project, [session]); assert.equal(extracted.completedTurns, 0); assert.equal(extracted.evidence.completed, 2); assert.equal(extracted.evidence.extracted, 1);
  session.memoryEvidenceOutbox.push({ id: 'uncertain', status: 'uncertain' }); assert.equal(status(project, [session]).status, 'attention');
  assert.equal(projectMemorySyncStatus({ projects: [project], sessions: [session] }, { id: 'unrelated' }).status, 'none');
  session.memoryEvidenceOutbox.pop();
  session.memoryEvidenceOutbox[0].resourceIndex = { status: 'completed', updatedAt: '2026-09-26T00:00:00Z' };
  assert.equal(status(project, [session]).evidence.indexed, 1);
  session.memoryEvidenceOutbox[0].resourceIndex.status = 'uncertain'; assert.equal(status(project, [session]).evidence.indexIssues, 1);
});

test('history says what happened by shape: index stage, abandoned upload, blocked segment; settled losses go straight to history and only re-extraction is offered (MEM-4/5/10, A2)', () => {
  const project = { id: 'p' }, session = { id: 's', projectId: 'p', turns: [
    { id: 'a', status: 'completed', memoryWrite: { status: 'abandoned', code: 'MEMORY_SOURCE_CHANGED' } },
    { id: 'b', status: 'completed', memoryCheckpoints: [{ id: 'c1', kind: 'incremental', status: 'failed', code: 'MEMORY_WRITE_REJECTED' }, { id: 'c2', kind: 'final', status: 'failed', code: 'MEMORY_WRITE_REJECTED', blockedBy: 'c1' }] },
    { id: 'c', status: 'completed', memoryWrite: { status: 'failed', code: 'MEMORY_EXTRACTION_FAILED', taskId: 'task' } },
  ], items: [{ id: 'c-user', turnId: 'c', kind: 'user', text: 'Keep focus outlines visible.' }, { id: 'c-answer', turnId: 'c', kind: 'assistant', text: 'Noted.' }],
  memoryEvidenceOutbox: [{ id: 'e', status: 'completed', resourceIndex: { status: 'failed', code: 'MEMORY_SOURCE_CHANGED' } }] };
  for (const language of ['zh', 'en']) {
    const row = projectMemorySyncStatus({ projects: [project], sessions: [session], settings: { interfaceLanguage: language } }, project).sessions[0];
    assert.equal(row.attention, 0); assert.equal(row.status, 'synced'); assert.equal(row.settledLoss, 5); assert.equal(row.unresolved, 0); assert.equal(row.issues.length, 0); assert.equal(row.history.length, 5);
    const by = key => row.history.find(issue => issue.checkpointId === key || !issue.checkpointId && (issue.turnId === key || issue.evidenceId === key));
    assert.match(by('a').message, language === 'zh' ? /上传途中被修改或撤回/ : /while it was uploading/);
    assert.match(by('c2').message, language === 'zh' ? /较早的一段没有同步成功/ : /An earlier part of this turn/);
    assert.match(by('e').message, language === 'zh' ? /已归档，但在编入项目资料索引之前发生了变化/ : /archived, but it changed before it was added/);
    assert.doesNotMatch(by('e').message, /没有上传|not uploaded/);
    assert.deepEqual(by('c').actions, ['reextract']); assert.deepEqual(by('c2').actions, []); assert.deepEqual(by('e').actions, []);
    assert.equal(by('c').reextractable, undefined, 'the predicate stays internal');
  }
});

test('re-extraction is offered only when it would upload something: a final with no messages of its own and nothing retained before it offers nothing (B2)', () => {
  const project = { id: 'p' }, final = { id: 'f', kind: 'final', schemaVersion: 1, status: 'failed', code: 'MEMORY_EXTRACTION_FAILED', taskId: 'task-2', sessionId: 'rna-1', sourceRefs: [] };
  const turn = { id: 't', status: 'completed', memoryCheckpoints: [{ id: 'i', kind: 'incremental', schemaVersion: 1, status: 'completed', sessionId: 'rna-1', sourceRefs: [] }, final] };
  const session = { id: 's', projectId: 'p', items: [], turns: [turn] }, issue = () => projectMemorySyncStatus({ projects: [project], sessions: [session] }, project).sessions[0].history.find(row => row.checkpointId === 'f');
  assert.deepEqual(issue().actions, []);
  // An archive confirmed never committed (B3) is offered like a failed extraction once it has something to upload.
  session.items.push({ id: 'late', turnId: 't', kind: 'assistant', text: 'Final answer.' });
  Object.assign(final, { code: 'MEMORY_COMMIT_NOT_FOUND', taskId: undefined, sourceRefs: [{ itemId: 'late', textHash: createHash('sha256').update(JSON.stringify(['assistant', 'Final answer.'])).digest('hex') }] });
  assert.deepEqual(issue().actions, ['reextract']);
  assert.match(issue().message, /never archived|没有完成归档/);
});
