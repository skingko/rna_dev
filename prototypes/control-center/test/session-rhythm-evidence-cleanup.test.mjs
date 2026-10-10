import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';
import { captureSessionEvidence, scrubSessionEvidence, discoverSessionEvidence, purgeSessionEvidenceFiles } from '../session-evidence-cleanup.mjs';

const deletedText = 'Private conversation detail copied into a rhythm explanation.';
const assessment = (evidenceIds, reason = deletedText) => ({ lifecycle: 'complete', reason, evidenceIds, scheduleIds: [], initiative: { mode: 'event_only', reviewAfterMs: 86400000 }, evolution: { mode: 'weekly', maxPerDay: 1, maxPerWeek: 1, minIntervalMs: 86400000 } });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-rhythm-cleanup-')), stateFile = join(directory, 'state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = { id: 'deleted-session', projectId: 'project', items: [{ id: 'deleted-message', text: deletedText }], turns: [{ id: 'deleted-turn' }], inbox: [], submissions: [] };
  const project = { id: 'project', observations: [], jobs: [], decisions: [], facts: [], initiativeRuntime: { sdkState: { events: [], actions: [], usedTokens: 123, reservedTokens: 0 } } };
  const state = { projects: [project], sessions: [session], events: [] };
  const record = () => ({ sessionId: session.id, projectId: project.id, evidence: captureSessionEvidence(state, session) });
  const archive = (kind, value) => {
    const contents = JSON.stringify(value), digest = createHash('sha256').update(contents).digest('hex');
    const dir = join(`${stateFile}.archive`, 'initiative', project.id, kind); mkdirSync(dir, { recursive: true });
    const file = join(dir, `${digest}.json`); writeFileSync(file, contents); return file;
  };
  const journal = (actionId, rhythmStatus, { uncertain = false } = {}) => {
    const dir = join(`${stateFile}.rna`, 'initiative', project.id, actionId);
    const handle = openJournal({ stateDir: dir, sessionId: actionId, projectId: project.id });
    handle.append('inbox_added', { item: { context: [{ source: 'project-evidence', text: JSON.stringify({ project: { rhythmStatus, recentConversation: [] }, evidence: [] }) }] } });
    if (uncertain) { handle.append('tool_intent', { callKey: 'write', effect: 'write', idempotent: false }); handle.append('tool_uncertain', { callKey: 'write', code: 'uncertain_tool' }); }
    handle.close(); return { directory: dir, file: handle.file };
  };
  return { directory, stateFile, session, project, state, record, archive, journal };
}

test('deletion clears nested wait assessments and matching rhythm history while preserving real quota and accounting', t => {
  const f = fixture(t), source = 'message:deleted-message', own = assessment([source]);
  const unrelated = assessment(['message:other-message'], 'Preserve another session assessment.');
  f.project.initiativeRuntime.sdkState.lastDecision = { action: 'wait', content: '', reason: 'Idle', evidenceIds: [], rhythm: own };
  f.project.decisions = [{ id: 'decision-with-rhythm', action: 'wait', evidenceIds: [], rhythm: own }, { id: 'other-decision', action: 'wait', evidenceIds: [], rhythm: unrelated }];
  f.project.rhythmRuntime = { assessment: own, assessedAt: 10, decisionIdentity: 'receipt', evidenceKey: 'watermark', lastInitiativeAt: 10, lastLearningAt: 8, learningAttempts: [{ id: 'paid-review', at: 8, source: 'automatic', status: 'failed' }], history: [{ at: 1, evidenceIds: [source], reason: deletedText }, { at: 2, evidenceIds: ['message:other-message'], reason: 'Preserve unrelated history.' }] };
  const ledger = structuredClone(f.project.rhythmRuntime.learningAttempts), record = f.record();
  assert.equal(JSON.stringify(record).includes(deletedText), false);
  scrubSessionEvidence(f.state, record);
  assert.equal(f.project.rhythmRuntime.assessment, undefined); assert.equal(f.project.rhythmRuntime.evidenceKey, undefined); assert.equal(f.project.rhythmRuntime.decisionIdentity, undefined);
  assert.deepEqual(f.project.rhythmRuntime.learningAttempts, ledger); assert.equal(f.project.rhythmRuntime.lastLearningAt, 8); assert.equal(f.project.initiativeRuntime.sdkState.usedTokens, 123);
  assert.equal(f.project.rhythmRuntime.history.length, 1); assert.equal(f.project.rhythmRuntime.history[0].reason, 'Preserve unrelated history.');
  assert.equal(f.project.initiativeRuntime.sdkState.lastDecision.rhythm, undefined); assert.equal(f.project.decisions[0].rhythm, undefined); assert.equal(f.project.decisions[1].rhythm.reason, unrelated.reason);
  assert.equal(JSON.stringify(f.project).includes(deletedText), false);
  const once = structuredClone(f.project); scrubSessionEvidence(f.state, record); assert.deepEqual(f.project, once);
});

test('exact nested evidence identity supports turns, observations and transitive action results', t => {
  const f = fixture(t);
  f.project.observations.push({ id: 'linked-observation', text: deletedText, data: { messageId: 'deleted-message' } });
  f.project.initiativeRuntime.sdkState.actions = [
    { id: 'from-turn', action: 'work', status: 'completed', evidenceIds: [], rhythm: assessment(['turn:deleted-turn:completed@abcdef']) },
    { id: 'from-action', action: 'work', status: 'completed', evidenceIds: [], rhythm: assessment(['action:from-turn:completed']) },
  ];
  f.project.rhythmRuntime = { assessment: assessment(['observation:linked-observation']), learningAttempts: [{ id: 'review', source: 'automatic', at: 1 }] };
  const record = f.record(); assert.deepEqual(record.evidence.actionIds, ['from-turn', 'from-action']);
  scrubSessionEvidence(f.state, record);
  assert.equal(f.project.rhythmRuntime.assessment, undefined);
  for (const row of f.project.initiativeRuntime.sdkState.actions) { assert.equal(row.rhythm, undefined); assert.equal(row.contextRevoked, true); }
});

test('same text without a matching source is retained; deleting old history does not revoke an unrelated current assessment', t => {
  const f = fixture(t), retained = assessment(['message:other-message']);
  f.project.rhythmRuntime = { assessment: retained, decisionIdentity: 'current', evidenceKey: 'current-evidence', history: [{ evidenceIds: ['message:deleted-message'], reason: deletedText }, { evidenceIds: ['message:other-message'], reason: deletedText }] };
  scrubSessionEvidence(f.state, f.record());
  assert.deepEqual(f.project.rhythmRuntime.assessment, retained); assert.equal(f.project.rhythmRuntime.decisionIdentity, 'current');
  assert.equal(f.project.rhythmRuntime.history.length, 1); assert.deepEqual(f.project.rhythmRuntime.history[0].evidenceIds, ['message:other-message']);
});

test('archived nested wait decisions and background rhythm-only context are purged after hot session state disappears', async t => {
  const f = fixture(t), linked = assessment(['message:deleted-message']);
  const archived = f.archive('decisions', { id: 'historical-wait', action: 'wait', status: 'completed', evidenceIds: [], rhythm: linked, usage: { totalTokens: 11 } });
  const archivedOther = f.archive('decisions', { id: 'other-wait', action: 'wait', evidenceIds: [], rhythm: assessment(['message:other-message'], 'Keep independent assessment.') });
  const own = f.journal('rhythm-background', { assessment: linked, history: [] });
  const historical = f.journal('rhythm-history-background', { assessment: assessment(['message:other-message'], 'Other current state'), history: [{ evidenceIds: ['message:deleted-message'], reason: deletedText }] });
  const unrelated = f.journal('other-background', { assessment: assessment(['message:other-message'], 'Keep independent context'), history: [] });
  const workspace = join(f.directory, 'workspace'); mkdirSync(workspace); writeFileSync(join(workspace, 'index.html'), '<p>Keep project artifact</p>');
  const record = f.record(); f.state.sessions = []; f.state.projects = [];
  record.evidence = await discoverSessionEvidence(f.stateFile, record, { state: f.state });
  assert.deepEqual(record.evidence.journalActionIds.sort(), ['rhythm-background', 'rhythm-history-background']);
  const result = await purgeSessionEvidenceFiles(f.stateFile, record, { writersSettled: true });
  assert.equal(result.removedArchives, 1); assert.equal(result.removedJournals, 2);
  assert.equal(existsSync(archived), false); assert.equal(existsSync(archivedOther), true); assert.equal(existsSync(own.directory), false); assert.equal(existsSync(historical.directory), false); assert.equal(existsSync(unrelated.file), true);
  const dir = join(`${f.stateFile}.archive`, 'initiative', 'project', 'decisions');
  const receipts = readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const receipt = receipts.find(row => row.id === 'historical-wait'); assert.equal(receipt.usage.totalTokens, 11); assert.equal(receipt.rhythm, undefined);
  assert.equal(receipts.some(row => JSON.stringify(row).includes(deletedText)), false);
  assert.equal(readFileSync(join(workspace, 'index.html'), 'utf8'), '<p>Keep project artifact</p>');
});

test('rhythm context follows transitive action identities across journals without inventing textual matches', async t => {
  const f = fixture(t);
  const first = f.journal('z-first', { assessment: assessment(['message:deleted-message']), history: [] });
  const second = f.journal('a-second', { assessment: assessment(['action:z-first:completed']), history: [] });
  const record = f.record(); record.evidence = await discoverSessionEvidence(f.stateFile, record, { state: f.state });
  assert.deepEqual(record.evidence.actionIds.sort(), ['a-second', 'z-first']);
  await purgeSessionEvidenceFiles(f.stateFile, record, { writersSettled: true });
  assert.equal(existsSync(first.directory), false); assert.equal(existsSync(second.directory), false);
});

test('nested rhythm attribution cannot bypass an unknown external-execution cleanup barrier', async t => {
  const f = fixture(t), owned = f.journal('uncertain-write', { assessment: assessment(['message:deleted-message']), history: [] }, { uncertain: true });
  await assert.rejects(discoverSessionEvidence(f.stateFile, f.record(), { state: f.state }), { code: 'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED' });
  assert.equal(existsSync(owned.file), true);
});

test('host-recorded input provenance removes uncited conversation-derived assessment and decision text without resetting quota', t => {
  const f = fixture(t), implicit = assessment(['project-state']), sourceIds = ['session:deleted-session'];
  f.project.rhythmRuntime = { assessment: implicit, assessmentSourceIds: sourceIds, decisionIdentity: 'input-receipt', evidenceKey: 'input-key', learningAttempts: [{ id: 'paid-review', at: 3, source: 'automatic', status: 'unknown' }], history: [{ evidenceIds: ['project-state'], sourceIds, reason: deletedText }, { evidenceIds: ['other-state'], sourceIds: ['session:other-session'], reason: 'Keep independently sourced history.' }] };
  f.project.initiativeRuntime.lastDecisionSourceIds = sourceIds;
  f.project.initiativeRuntime.sdkState.lastDecision = { action: 'wait', content: '', reason: deletedText, evidenceIds: [], rhythm: implicit, usage: { totalTokens: 10 }, at: 4, revision: 1 };
  f.project.decisions = [{ id: 'uncited-decision', action: 'wait', reason: deletedText, evidenceIds: [], sourceIds, rhythm: implicit }];
  const ledger = structuredClone(f.project.rhythmRuntime.learningAttempts), record = f.record();
  scrubSessionEvidence(f.state, record);
  assert.equal(f.project.rhythmRuntime.assessment, undefined); assert.equal(f.project.rhythmRuntime.assessmentSourceIds, undefined); assert.equal(f.project.rhythmRuntime.evidenceKey, undefined);
  assert.equal(f.project.initiativeRuntime.lastDecisionSourceIds, undefined); assert.equal(f.project.initiativeRuntime.sdkState.lastDecision.rhythm, undefined);
  assert.equal(f.project.initiativeRuntime.sdkState.lastDecision.usage.totalTokens, 10); assert.equal(f.project.initiativeRuntime.sdkState.usedTokens, 123);
  assert.deepEqual(f.project.rhythmRuntime.learningAttempts, ledger); assert.equal(f.project.rhythmRuntime.history.length, 1); assert.equal(JSON.stringify(f.project).includes(deletedText), false);
  const once = structuredClone(f.project); scrubSessionEvidence(f.state, record); assert.deepEqual(f.project, once);
});

test('trusted rhythm provenance discovers uncited private context in archives and worker journals after source removal', async t => {
  const f = fixture(t), sourceIds = ['session:deleted-session'];
  const archived = f.archive('decisions', { id: 'uncited-archived', action: 'wait', sourceIds, evidenceIds: ['project-state'], reason: deletedText });
  const current = f.journal('uncited-current', { assessment: assessment(['project-state']), assessmentSourceIds: sourceIds });
  const history = f.journal('uncited-history', { history: [{ evidenceIds: ['project-state'], sourceIds, reason: deletedText }] });
  const dependent = f.journal('dependent', { assessment: assessment(['action:uncited-current:completed']) });
  const retained = f.journal('retained', { assessment: assessment(['project-state'], 'Other input session'), assessmentSourceIds: ['session:other-session'] });
  const record = f.record(); f.state.sessions = []; f.state.projects = [];
  record.evidence = await discoverSessionEvidence(f.stateFile, record, { state: f.state });
  assert.deepEqual(record.evidence.journalActionIds.sort(), ['dependent', 'uncited-current', 'uncited-history']);
  const result = await purgeSessionEvidenceFiles(f.stateFile, record, { writersSettled: true });
  assert.equal(result.removedArchives, 1); assert.equal(result.removedJournals, 3); assert.equal(existsSync(archived), false);
  for (const owned of [current, history, dependent]) assert.equal(existsSync(owned.directory), false);
  assert.equal(existsSync(retained.file), true);
});
