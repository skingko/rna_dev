import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRhythmStatus, projectRhythmEvidenceKey, acceptProjectRhythmDecision, admitProjectRhythmLearning } from '../project-rhythm.mjs';
import { makeProject, updateProject, normalizeProjectSchedule } from '../project-proactivity.mjs';
import { createHash } from 'node:crypto';

const now = 1800000000000, DAY = 86400000;
const assessment = (lifecycle = 'recurring') => ({ lifecycle, reason: 'One daily research delivery; wait for actual results between duties.', evidenceIds: ['fact'], scheduleIds: [], initiative: { mode: 'event_only', reviewAfterMs: DAY }, evolution: { mode: 'daily', maxPerDay: 1, maxPerWeek: 3, minIntervalMs: DAY } });
function fixture() {
  const project = makeProject({ name: 'Any project title' });
  const state = { projects: [project], sessions: [{ id: 's', projectId: project.id, items: [], turns: [] }] };
  return { project, state };
}
function assess(state, project, lifecycle = 'recurring') {
  const key = projectRhythmEvidenceKey(state, project);
  acceptProjectRhythmDecision(project, { at: now, revision: 1, action: 'wait', rhythm: assessment(lifecycle) }, { evidenceKey: key, allowedEvidenceIds: ['fact'], now });
  return key;
}

test('new and migrated projects default to adaptive; only the control field is user writable', () => {
  const { project } = fixture(); assert.equal(project.rhythm.control, 'auto');
  assert.equal(normalizeProjectSchedule({}).rhythm.control, 'auto');
  updateProject(project, { rhythm: { control: 'manual' } }); assert.equal(project.rhythm.control, 'manual');
  assert.throws(() => updateProject(project, { rhythm: { control: 'auto', assessment: assessment() } }));
});
test('no paid observer before assessment; one existing initiative decision supplies it', () => {
  const { state, project } = fixture();
  const status = projectRhythmStatus(state, project, { now, hasPendingLearning: true });
  assert.equal(status.initiative.reason, 'assessment_required'); assert.equal(status.initiative.eligible, true);
  assert.equal(status.evolution.eligible, false);
  assess(state, project); assert.equal(projectRhythmStatus(state, project, { now }).initiative.reason, 'recurring_schedule_missing');
});
test('clock, model narration and advancing schedule cursor are not fresh evidence', () => {
  const { state, project } = fixture();
  project.schedules = [{ id: 'duty', revision: 1, enabled: true, nextRunAt: new Date(now + DAY).toISOString() }];
  const key = assess(state, project);
  state.sessions[0].items.push({ id: 'share', kind: 'assistant', source: 'initiative', text: 'I am waiting.' });
  project.decisions.push({ action: 'wait' }); project.rhythmRuntime.history.push({ reason: 'A thought' });
  project.schedules[0].nextRunAt = new Date(now + 2 * DAY).toISOString();
  assert.equal(projectRhythmEvidenceKey(state, project), key);
  assert.equal(projectRhythmStatus(state, project, { now: now + DAY }).initiative.eligible, false);
});
test('user input wakes a completed project; an accepted decision consumes only its dispatch watermark', () => {
  const { state, project } = fixture(); assess(state, project, 'complete');
  assert.equal(projectRhythmStatus(state, project, { now: now + DAY }).initiative.reason, 'project_complete');
  state.sessions[0].items.push({ id: 'new', kind: 'user', text: 'Continue with a new scope' });
  assert.equal(projectRhythmStatus(state, project, { now }).initiative.reason, 'new_evidence');
  const dispatched = projectRhythmEvidenceKey(state, project);
  state.sessions[0].items.push({ id: 'later', kind: 'user', text: 'Another adjustment during the request' });
  acceptProjectRhythmDecision(project, { at: now + 1, revision: 2, action: 'wait' }, { evidenceKey: dispatched, now: now + 1 });
  assert.equal(project.rhythmRuntime.evidenceKey, dispatched);
  assert.equal(projectRhythmStatus(state, project, { now: now + 1 }).initiative.reason, 'new_evidence');
});
test('a real tool result or task delivery wakes once; an empty work summary does not', () => {
  const { state, project } = fixture(); const key = assess(state, project);
  project.jobs.push({ id: 'empty', simulated: false, status: 'completed', output: 'Looks done.' });
  assert.equal(projectRhythmEvidenceKey(state, project), key);
  project.jobs.push({ id: 'verified', simulated: false, status: 'completed', toolReceipts: [{ id: 'r' }] });
  assert.notEqual(projectRhythmEvidenceKey(state, project), key);
  assess(state, project); const before = projectRhythmEvidenceKey(state, project);
  project.scheduleRuntime = { occurrences: [{ key: 'day', deliveredAt: new Date(now).toISOString() }] };
  assert.notEqual(projectRhythmEvidenceKey(state, project), before);
});
test('manual disable survives model assessment and repeated admission; hard off is authoritative', () => {
  const { state, project } = fixture(); assess(state, project);
  project.learningRuntime = { sdkState: { reviews: [{ id: 'batch', status: 'reviewing' }] } };
  admitProjectRhythmLearning(state, project, { reviewId: 'batch', now });
  project.initiative.enabled = false;
  assert.equal(projectRhythmStatus(state, project, { now }).evolution.eligible, false);
  assert.throws(() => admitProjectRhythmLearning(state, project, { reviewId: 'batch', now }), { code: 'project_rhythm_waiting' });
});
test('quota survives restart, review archive, failed work and new evidence; one batch is counted once', () => {
  const { state, project } = fixture(); assess(state, project);
  project.learningRuntime = { sdkState: { reviews: [{ id: 'one', status: 'reviewing' }] } };
  admitProjectRhythmLearning(state, project, { reviewId: 'one', now });
  admitProjectRhythmLearning(state, project, { reviewId: 'one', now: now + 1 });
  assert.equal(project.rhythmRuntime.learningAttempts.length, 1);
  project.learningRuntime.sdkState.reviews = [{ id: 'two', status: 'reviewing' }];
  const restarted = structuredClone(state), current = restarted.projects[0];
  assert.equal(projectRhythmStatus(restarted, current, { now: now + 1000, freshEvidence: true, hasPendingLearning: true }).evolution.eligible, false);
  assert.throws(() => admitProjectRhythmLearning(restarted, current, { reviewId: 'two', now: now + 1000 }), { code: 'project_rhythm_waiting' });
  admitProjectRhythmLearning(restarted, current, { reviewId: 'two', now: now + DAY });
  assert.equal(current.rhythmRuntime.learningAttempts.length, 2);
});
test('legacy real dispatch receipts count; a local request never sent does not', () => {
  const { state, project } = fixture(); assess(state, project);
  project.learningRuntime = { sdkState: { reviews: [
    { id: 'actual', startedAt: now - 100, status: 'failed', request: { phase: 'learning_reflection', requestStarted: true } },
    { id: 'unsent', startedAt: now - 50, status: 'failed', request: { phase: 'learning_reflection', requestStarted: false } },
  ] } };
  const status = projectRhythmStatus(state, project, { now, hasPendingLearning: true });
  assert.equal(status.evolution.quota.dayUsed, 1); assert.equal(status.evolution.eligible, false);
});
test('a schedule removed during a model request retains the accepted frozen receipt without consuming that later edit', () => {
  const { state, project } = fixture();
  project.schedules = [{ id: 'duty', revision: 1, enabled: true, nextRunAt: new Date(now + DAY).toISOString() }];
  const evidenceKey = projectRhythmEvidenceKey(state, project), schedules = structuredClone(project.schedules);
  const value = assessment(); value.scheduleIds = ['duty'];
  project.schedules = [];
  acceptProjectRhythmDecision(project, { at: now, revision: 1, action: 'wait', rhythm: value }, { evidenceKey, schedules, allowedEvidenceIds: ['fact'], now });
  assert.deepEqual(project.rhythmRuntime.assessment.scheduleIds, ['duty']);
  assert.equal(projectRhythmStatus(state, project, { now }).initiative.reason, 'new_evidence');
});
// B3 (A1's open question): a plan-mode toggle is runtime state, not evidence. Headlong records a runtime change as a fact
// line in the next wake prompt and never wakes on it (wake_prompt_cull.md, runtime section).
test('a conversation\'s mode is not evidence: toggling plan mode neither changes the key nor opens the lane; the startup migration moves consumed keys', async () => {
  const { migrateRhythmEvidenceKeys } = await import('../project-rhythm.mjs');
  const { state, project } = fixture(); state.sessions[0].mode = 'default';
  const key = assess(state, project, 'active');
  assert.equal(projectRhythmStatus(state, project, { now: now + 1000 }).initiative.reason, 'awaiting_evidence');
  state.sessions[0].mode = 'plan';
  assert.equal(projectRhythmEvidenceKey(state, project), key, 'plan mode on');
  assert.equal(projectRhythmStatus(state, project, { now: now + 1000 }).initiative.eligible, false);
  state.sessions[0].mode = 'default'; assert.equal(projectRhythmEvidenceKey(state, project), key, 'and off again');
  // What a plan brings is evidence as before: the user's message.
  state.sessions[0].items.push({ id: 'go', kind: 'user', text: 'Approved: carry out the plan.' });
  assert.notEqual(projectRhythmEvidenceKey(state, project), key);
  assert.equal(projectRhythmStatus(state, project, { now: now + 1000 }).initiative.reason, 'new_evidence');
  // Upgrade: a key stored in the earlier form (each conversation's mode hashed in) that the project had consumed moves to
  // the current form, so the upgrade alone is no new evidence; an unconsumed key (evidence since) stays unconsumed.
  const sha = text => createHash('sha256').update(text).digest('hex'), legacy = (state, project) => sha(evidenceShape(state, project, true));
  assert.equal(sha(evidenceShape(state, project, false)), projectRhythmEvidenceKey(state, project), 'the rebuilt input matches the module');
  project.rhythmRuntime.evidenceKey = legacy(state, project);
  assert.equal(projectRhythmStatus(state, project, { now: now + 1000 }).initiative.reason, 'new_evidence', 'before the migration the upgrade itself read as evidence');
  assert.deepEqual(migrateRhythmEvidenceKeys(state), { changed: 1 });
  assert.equal(project.rhythmRuntime.evidenceKey, projectRhythmEvidenceKey(state, project));
  assert.notEqual(projectRhythmStatus(state, project, { now: now + 1000 }).initiative.reason, 'new_evidence');
  assert.deepEqual(migrateRhythmEvidenceKeys(state), { changed: 0 }, 'idempotent');
  const consumedBefore = legacy(state, project);
  state.sessions[0].items.push({ id: 'later', kind: 'user', text: 'One more requirement.' });
  project.rhythmRuntime.evidenceKey = consumedBefore;
  assert.deepEqual(migrateRhythmEvidenceKeys(state), { changed: 0 }, 'evidence that arrived since stays unconsumed');
  assert.equal(projectRhythmStatus(state, project, { now: now + 1000 }).initiative.reason, 'new_evidence');
});
test('the store\'s startup flow migrates a consumed pre-B3 evidence key once', async t => {
  const [{ Store }, { mkdtempSync, rmSync }, { tmpdir }, { join }] = await Promise.all([import('../store.mjs'), import('node:fs'), import('node:os'), import('node:path')]);
  const directory = mkdtempSync(join(tmpdir(), 'rna-rhythm-key-')), file = join(directory, 'state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(file);
  const { project, session } = store.createProject({ name: 'Key migration', workspace: directory });
  store.mutate(state => { state.sessions.find(row => row.id === session.id).mode = 'plan'; const p = state.projects.find(row => row.id === project.id); p.rhythmRuntime = { ...(p.rhythmRuntime ?? {}), evidenceKey: createHash('sha256').update(evidenceShape(state, p, true)).digest('hex') }; });
  const legacyKey = store.state.projects.find(row => row.id === project.id).rhythmRuntime.evidenceKey;
  store = new Store(file);
  const migrated = store.state.projects.find(row => row.id === project.id);
  assert.notEqual(migrated.rhythmRuntime.evidenceKey, legacyKey);
  assert.equal(migrated.rhythmRuntime.evidenceKey, projectRhythmEvidenceKey(store.state, migrated));
  const revision = store.state.revision; store = new Store(file);
  assert.equal(store.state.revision, revision, 'nothing to migrate the second time');
});
/** The pre-B3 key input (each conversation's mode hashed in), rebuilt here independently of the module. */
function evidenceShape(state, project, withMode) {
  const sessions = (state.sessions ?? []).filter(row => row.projectId === project.id && !row.archivedAt);
  return JSON.stringify({
    project: [project.name, project.description, project.overview, project.focus, project.workspace, project.permissions, project.assignments, project.commitments, project.milestones, project.activeVersionId, project.trialVersionId],
    sessions: sessions.map(session => [session.id, ...(withMode ? [session.mode] : []),
      (session.items ?? []).filter(row => row.kind === 'user' && !row.sourceDeleted && !row.contextRevoked).slice(-16).map(row => [row.id, row.text]),
      (session.turns ?? []).filter(row => row.modelConfig?.execution === 'rna' && row.simulated !== true && ['completed', 'failed', 'stopped'].includes(row.status)).slice(-8).map(row => [row.id, row.status, row.completedAt])]),
    observations: (project.observations ?? []).filter(row => row.simulated !== true && !['withdrawn', 'superseded'].includes(row.status) && !row.data?.messageId && row.source !== 'initiative').slice(-12).map(row => [row.id, row.kind, row.text]),
    work: (project.jobs ?? []).filter(row => row.simulated !== true && ['completed', 'failed'].includes(row.status) && (row.toolReceipts?.length || Object.values(row.toolReceiptCounts ?? {}).some(value => typeof value === 'number' && value > 0))).slice(-8).map(row => [row.id, row.status, row.completedAt]),
    schedules: (project.schedules ?? []).map(row => [row.id, row.revision, row.enabled, row.lastEditedBy]),
    cancelled: (project.scheduleCreationReceipts ?? []).filter(row => row.deletedAt).slice(-32).map(row => [row.id, row.deletedAt]),
    deliveries: (project.scheduleRuntime?.occurrences ?? []).filter(row => row.deliveredAt).slice(-8).map(row => [row.key, row.deliveredAt]),
    failures: (project.initiativeRuntime?.sdkState?.actions ?? []).filter(row => ['failed', 'needs_review'].includes(row.status) && !row.contextRevoked).slice(-8).map(row => [row.id, row.status, row.errorCode, row.failure?.code]),
  });
}
