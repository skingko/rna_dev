import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as tick } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectMindService, ensureMind, addCommitment, addAgenda, addLesson, mindSource, mindBackgroundView, mindContextText, commitmentOverdue, workChangeOutcome, workOutcomeChanges, applyWorkOutcomes, applyWaiting, COMMITMENT_OVERDUE_MS } from '../project-mind.mjs';
import { sourceScope, revokeMindSources } from '../source-revocation.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { DecisionService } from '../decision-service.mjs';

// MIND-1 (the sweep's own checks are not starved by catch-up) and X-5 (work settles what it resolves only by changes
// that reached the project folder; undoing them reopens it). Synthetic state, stub judges, no model, no repository.

const MINUTE = 60000, DAY = 24 * 60 * MINUTE;
const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const iso = at => new Date(at).toISOString();

function setup(t, { decisions = null, mind: seed = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-mind-outcomes-')), store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: 'Novel', workspace: dir, initiative: { enabled: false } });
  const clock = { now: NOW };
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id); target.simulated = false; target.initialization = { status: 'ready' };
    const mind = ensureMind(target, NOW - 3 * DAY); mind.migratedAt = iso(NOW - 3 * DAY);
    seed(mind, target, state, session);
  });
  const mind = new ProjectMindService(store, { decisions, provider: null, now: () => clock.now, sweepIntervalMs: 0, notesIntervalMs: 0 });
  store.mind = mind;
  t.after(async () => { await mind.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const row = (collection, id) => current().mind[collection].find(entry => entry.id === id);
  const change = fn => store.mutate(state => fn(state.projects.find(entry => entry.id === project.id), state));
  return { store, project, session, mind, clock, current, row, change };
}

// ------------------------------------------------------------------ MIND-1
test('MIND-1: with a request pending, one sweep still reaches commitment.due, lesson consolidation and reconcile', async t => {
  const calls = { due: [], judge: [], reconcile: [] };
  const decisions = { enabled: () => true, config: () => ({ modes: {} }),
    commitmentDue: async (_project, input) => { calls.due.push(input); return { due: [], wait: [0] }; },
    mindJudge: async (_project, input) => { calls.judge.push(input); return { resolved: [], same: [], refines: [], contradicts: [] }; },
    mindReconcile: async (_project, input) => { calls.reconcile.push(input); return null; } };
  let request;
  // The constructor runs the first sweep: catch-up is queued first (a request is pending), and the three checks after it.
  const app = setup(t, { decisions, mind: (mind, _project, state, session) => {
    state.sessions.find(row => row.id === session.id).items.push({ id: 'u-rule', kind: 'user', text: '章节标题统一用中文数字', createdAt: iso(NOW - 2 * DAY) });
    request = addCommitment(mind, { request: '整理人物表', trigger: 'user_request', source: mindSource('capture', { sessionId: session.id }) }, { now: NOW - 30 * MINUTE }).id;
    addLesson(mind, { kind: 'preference', text: '章节标题用中文数字' }, { now: NOW - 2 * DAY });
    addLesson(mind, { kind: 'preference', text: '章节标题一律用中文数字' }, { now: NOW - DAY });
  } });
  await app.mind.idle();
  assert.equal(calls.due.length, 1, 'commitment.due ran although catch-up held the queue');
  assert.equal(calls.due[0].commitments[0].id, request);
  assert.ok(calls.judge.some(input => input.candidate === '章节标题一律用中文数字'), 'the newer lesson met the older one (consolidation)');
  assert.equal(calls.reconcile.length, 1, 'reconcile ran');
  assert.ok(app.row('lessons', app.current().mind.lessons[1].id).consolidatedAt);
  assert.equal(app.row('commitments', request).dueCheckedAt, iso(NOW));

  // Nothing new: later sweeps queue no catch-up (and each check keeps its own throttle).
  let catchUps = 0; const catchUp = app.mind.catchUp.bind(app.mind); app.mind.catchUp = (...args) => { catchUps++; return catchUp(...args); };
  app.clock.now += MINUTE; app.mind.sweep(); await app.mind.idle(); app.mind.sweep(); await app.mind.idle();
  assert.equal(catchUps, 0); assert.equal(calls.due.length, 1);
  // A proactive message after the request is new evidence: one catch-up judges it.
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).items.push({ id: 'delivered-1', kind: 'assistant', source: 'initiative', text: '人物表整理好了。', createdAt: iso(app.clock.now) }); });
  const judged = calls.judge.length;
  app.mind.sweep(); await app.mind.idle(); app.mind.sweep(); await app.mind.idle();
  assert.equal(catchUps, 1); assert.equal(calls.judge.length, judged + 1);
  assert.match(calls.judge.at(-1).evidence[0], /人物表整理好了/);
});

// --------------------------------------------------------------------- X-5
const route = (app, action) => ProjectInitiativeController.prototype.resolveWork.call({ valid: () => true, project: id => app.store.state.projects.find(row => row.id === id), store: app.store }, { projectId: app.project.id }, action);
const gitRow = (id, actionId, status, extra = {}) => ({ id, kind: 'git', actionId, at: iso(NOW - MINUTE), worktreeId: `wt-${id}`, applyId: null, applyIds: [], files: [], skipped: 0, status, ...extra });
const record = (id, kind, source, extra = {}) => ({ id, kind, target: 'project', source, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: ['chapter-3.md'], at: iso(NOW), ...extra });

test('X-5: a run whose change set waits settles nothing until it is applied; an undo reopens, and undoing the undo settles again', async t => {
  let request, todo;
  const app = setup(t, { mind: mind => {
    request = addCommitment(mind, { request: '把第三章改短', trigger: 'user_request' }, { now: NOW - 5 * 3600000 }).id;
    todo = addAgenda(mind, { kind: 'todo', text: '第三章改短' }, { now: NOW - DAY }).id;
  } });
  app.change(project => { project.backgroundChanges = [gitRow('ch1', 'act-1', 'deferred', { hold: 'direct_turn' })]; });
  route(app, { id: 'act-1', action: 'work', resolves: [request, todo] });
  assert.equal(app.row('commitments', request).status, 'pending'); assert.equal(app.row('agenda', todo).status, 'open');
  assert.deepEqual(app.row('commitments', request).awaitingApply, { actionId: 'act-1', changeId: 'ch1', at: iso(NOW) });
  // Done on the agent's side: not overdue (its 4 h default passed), and the models read why it is still listed.
  assert.equal(commitmentOverdue(app.row('commitments', request), NOW), false);
  const view = mindBackgroundView(app.current(), { now: NOW });
  assert.equal(view.commitments[0].waitingForApply, true); assert.equal(view.agenda[0].waitingForApply, true); assert.match(view.states.waitingForApply, /Do not redo it/);
  const open = DecisionService.prototype.openWork.call({ now: () => NOW }, app.current());
  assert.deepEqual([open.commitments, open.overdue, open.agenda], [0, 0, 0], 'the review gate does not read them as open work');

  // Applied when the project folder is free (applyDeferred): settled at once (the store change, no sweep needed).
  app.change(project => Object.assign(project.backgroundChanges[0], { status: 'kept', applyId: 'abg1', applyIds: ['abg1'] }));
  await tick(); await tick();
  assert.equal(app.row('commitments', request).status, 'resolved');
  assert.deepEqual(app.row('commitments', request).resolvedBy, { kind: 'action', actionId: 'act-1', applyId: 'abg1', at: iso(NOW) });
  assert.equal(app.row('agenda', todo).status, 'done'); assert.equal(app.row('agenda', todo).resolvedBy.actionId, 'act-1');
  assert.equal(app.row('commitments', request).awaitingApply, undefined);

  // The user reverts the change set (its record rolled back): reopened with the rollback's apply id.
  app.clock.now = NOW + 10 * MINUTE;
  app.change(project => {
    Object.assign(project.backgroundChanges[0], { status: 'reverted', revertedAt: iso(app.clock.now) });
    project.git.applies = [record('abg1', 'background', { actionId: 'act-1', worktreeId: 'wt-ch1' }, { state: 'rolled_back', rolledBackBy: 'kundo' }), record('kundo', 'rollback', { actionId: 'act-1' }, { undoes: 'abg1', initiator: 'user', at: iso(app.clock.now) })];
  });
  app.mind.sweep();
  const reopened = app.row('commitments', request);
  assert.equal(reopened.status, 'pending'); assert.equal(reopened.resolvedBy, undefined);
  assert.equal(reopened.reopened.reason, 'change_undone'); assert.equal(reopened.reopened.applyId, 'kundo'); assert.equal(reopened.reopened.actionId, 'act-1'); assert.equal(reopened.reopened.changeId, 'ch1');
  assert.equal(reopened.overdueAt, undefined, 'owed again from now, not overdue at once: the window restarts (D4); the evidence, or the fallback clock, sets the next due moment');
  assert.equal(commitmentOverdue(reopened, app.clock.now), false);
  assert.equal(app.row('agenda', todo).status, 'open'); assert.equal(app.row('agenda', todo).reopened.applyId, 'kundo');
  const text = JSON.parse(mindContextText({ commitments: [reopened], now: app.clock.now, background: true }));
  assert.equal(text.commitments[0].reopened, 'change_undone'); assert.match(text.states.reopened, /do not redo or re-apply it unless the user asks again/);
  app.mind.sweep(); assert.equal(app.row('commitments', request).status, 'pending', 'stable: a second pass changes nothing');

  // The user undoes the revert: the changes are back, so is the settlement.
  app.change(project => {
    project.backgroundChanges[0].status = 'kept';
    Object.assign(project.git.applies[1], { state: 'rolled_back', rolledBackBy: 'kredo' });
    project.git.applies.push(record('kredo', 'rollback', { actionId: 'act-1' }, { undoes: 'kundo', initiator: 'user' }));
  });
  app.mind.sweep();
  assert.equal(app.row('commitments', request).status, 'resolved'); assert.equal(app.row('commitments', request).resolvedBy.actionId, 'act-1');
  assert.equal(app.row('commitments', request).reopened, undefined); assert.equal(app.row('agenda', todo).status, 'done');
});

test('X-5: no change set or an applied one settles at completion; a discarded conflict reopens; an undone one settles nothing', async t => {
  let plain, applied, conflicted, undone;
  const app = setup(t, { mind: mind => {
    [plain, applied, conflicted, undone] = ['看一下评论区', '补全大纲', '合并第二章', '改写结尾'].map(request => addCommitment(mind, { request, trigger: 'user_request' }, { now: NOW - 30 * MINUTE }).id);
  } });
  app.change(project => { project.backgroundChanges = [gitRow('ch-applied', 'act-applied', 'kept', { applyId: 'aok', applyIds: ['aok'] }), gitRow('ch-conflict', 'act-conflict', 'merge_conflicted'), gitRow('ch-undone', 'act-undone', 'reverted', { discarded: true })]; });
  assert.equal(workChangeOutcome(app.current(), 'act-plain').status, 'none');
  route(app, { id: 'act-plain', action: 'work', resolves: [plain] });
  route(app, { id: 'act-applied', action: 'work', resolves: [applied] });
  route(app, { id: 'act-conflict', action: 'work', resolves: [conflicted] });
  route(app, { id: 'act-undone', action: 'work', resolves: [undone] });
  assert.deepEqual(app.row('commitments', plain).resolvedBy, { kind: 'action', actionId: 'act-plain', at: iso(NOW) });
  assert.equal(app.row('commitments', applied).resolvedBy.applyId, 'aok');
  assert.equal(app.row('commitments', conflicted).status, 'pending'); assert.equal(app.row('commitments', conflicted).awaitingApply.changeId, 'ch-conflict');
  assert.equal(app.row('commitments', undone).status, 'pending'); assert.equal(app.row('commitments', undone).awaitingApply, undefined);
  // The user discards the conflict card (nothing was applied): owed again, now saying why.
  app.change(project => Object.assign(project.backgroundChanges.find(row => row.id === 'ch-conflict'), { status: 'reverted', discarded: true }));
  await tick(); await tick();
  const row = app.row('commitments', conflicted);
  assert.equal(row.status, 'pending'); assert.equal(row.awaitingApply, undefined); assert.equal(row.reopened.reason, 'change_undone'); assert.equal(row.reopened.changeId, 'ch-conflict');
  // A plain row's view (and the payload) is as before: no state fields, no meanings.
  const text = mindContextText({ commitments: [app.row('commitments', undone)], now: NOW, background: true });
  assert.doesNotMatch(text, /states|waitingForApply|reopened/);
});

test('X-5: a conversation turn whose changes wait to be applied settles nothing until they are; its rollback reopens what it settled', async t => {
  const calls = [];
  const decisions = { enabled: () => true, config: () => ({ modes: {} }), mindJudge: async (_project, input) => { calls.push(input); return { resolved: [0] }; } };
  let owed, captured;
  const app = setup(t, { decisions, mind: (mind, project, state, session) => {
    const live = state.sessions.find(row => row.id === session.id);
    const turn = (id, minutes, extra = {}) => ({ id, status: 'completed', createdAt: iso(NOW - minutes * MINUTE), completedAt: iso(NOW - (minutes - 1) * MINUTE), modelConfig: { execution: 'rna' }, userItemId: `${id}-user`, ...extra });
    live.turns.push(turn('t1', 20, { apply: { status: 'conflicted', applyIds: [] } }));
    live.items.push({ id: 't1-user', turnId: 't1', kind: 'user', text: '把第三章改短', createdAt: iso(NOW - 20 * MINUTE) }, { id: 't1-reply', turnId: 't1', kind: 'assistant', text: '第三章改短了，删掉了回忆段落。', createdAt: iso(NOW - 19 * MINUTE) });
    owed = addCommitment(mind, { request: '整理人物表', trigger: 'user_request' }, { now: NOW - 60 * MINUTE }).id;
    captured = addCommitment(mind, { request: '把第三章改短', trigger: 'user_request', source: mindSource('capture', { sessionId: session.id, turnId: 't1', itemId: 't1-user' }) }, { now: NOW - 20 * MINUTE }).id;
    // turn.settled judged the turn's instruction finished (the decision ledger the sweep reads back).
    state.decisionKernelRuntime = { recent: [{ id: 'ledger-1', point: 'turn.settled', scope: { turnId: 't1' }, source: 'judge', mode: 'active', backend: 'typesafe', answers: { instruction_complete: { type: 'boolean', probability: .99 }, deferred_without_cause: { type: 'boolean', probability: .01 } } }] };
  } });
  await app.mind.idle();
  await app.mind.afterTurn({ sessionId: app.session.id, turnId: 't1' });
  app.mind.sweep(); await app.mind.idle();
  const turn = () => app.store.state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === 't1');
  assert.equal(calls.length, 0, 'nothing judged while the conflict card is open');
  assert.equal(turn().mindSettledAt, undefined);
  assert.equal(app.row('commitments', captured).status, 'pending', 'turn.settled does not settle it either');
  assert.equal(app.row('commitments', owed).status, 'pending');

  // The user answers the card; the turn's changes are applied: the catch-up reads the turn now.
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === 't1').apply = { status: 'applied', applyIds: ['aturn1'] }; });
  app.mind.sweep(); await app.mind.idle();
  assert.ok(turn().mindSettledAt);
  assert.equal(app.row('commitments', captured).status, 'resolved'); assert.equal(app.row('commitments', captured).resolvedBy.turnId, 't1');
  assert.equal(app.row('commitments', owed).status, 'resolved'); assert.equal(app.row('commitments', owed).resolvedBy.kind, 'jev');

  // The user rolls the turn back (回退本轮): both reopen with the rollback's apply id; the sweep never re-settles them.
  app.clock.now = NOW + 5 * MINUTE;
  app.change(project => { project.git.applies = [record('aturn1', 'turn', { sessionId: app.session.id, turnId: 't1' }, { state: 'rolled_back', rolledBackBy: 'kturn' }), record('kturn', 'rollback', { sessionId: app.session.id, turnId: 't1' }, { undoesTurn: 't1', initiator: 'user', at: iso(app.clock.now) })]; });
  app.mind.sweep(); app.mind.sweep(); await app.mind.idle();
  for (const id of [captured, owed]) {
    const row = app.row('commitments', id);
    assert.equal(row.status, 'pending', id); assert.deepEqual([row.reopened.reason, row.reopened.applyId, row.reopened.turnId], ['change_undone', 'kturn', 't1']);
  }
  // The user undoes the rollback: settled again as before.
  app.change(project => { Object.assign(project.git.applies[1], { state: 'rolled_back', rolledBackBy: 'kback' }); project.git.applies.push(record('kback', 'rollback', { sessionId: app.session.id, turnId: 't1' }, { undoes: 'kturn', initiator: 'user' })); });
  app.mind.sweep();
  assert.equal(app.row('commitments', captured).status, 'resolved'); assert.equal(app.row('commitments', owed).status, 'resolved');
  assert.equal(app.row('commitments', owed).resolvedBy.kind, 'jev');
});

test('X-5: a finding handled directly settles by its fixes: reverting them on the card reopens what it resolved', async t => {
  let request, waiting;
  const app = setup(t, { mind: mind => {
    request = addCommitment(mind, { request: '人名前后不一致的地方改掉', trigger: 'user_request' }, { now: NOW - 30 * MINUTE }).id;
    waiting = addCommitment(mind, { request: '统一第三章的地名', trigger: 'user_request' }, { now: NOW - 30 * MINUTE }).id;
  } });
  app.change(project => { project.directFixes = [{ id: 'fix-1', actionId: 'share-1', status: 'pending', files: [] }]; project.backgroundChanges = [gitRow('ch-direct', 'share-2-direct', 'deferred')]; });
  assert.equal(workChangeOutcome(app.current(), 'share-1').status, 'applied', 'applied, until the user reverts it');
  assert.equal(workChangeOutcome(app.current(), 'share-2').status, 'waiting', "its run '<id>-direct' still waits");
  route(app, { id: 'share-2', action: 'share', resolves: [waiting] });
  assert.equal(app.row('commitments', waiting).awaitingApply.changeId, 'ch-direct');
  app.mind.resolve(app.project.id, [request], { kind: 'delivery', actionId: 'share-1' });
  app.mind.sweep(); assert.equal(app.row('commitments', request).status, 'resolved');
  app.clock.now = NOW + MINUTE;
  app.change(project => Object.assign(project.directFixes[0], { status: 'reverted', settledAt: iso(app.clock.now) }));
  app.mind.sweep();
  const row = app.row('commitments', request);
  assert.equal(row.status, 'pending'); assert.equal(row.reopened.reason, 'change_undone'); assert.equal(row.reopened.by.kind, 'delivery');
  // A share that changed nothing (no fixes) is never reopened by this.
  assert.equal(workChangeOutcome(app.current(), 'share-plain').status, 'none');
});

test('X5: a change set the conversation dropped with agent_merge reopens what depended on it as change_dropped, not as the user undoing it', async t => {
  let waiting, settled;
  const app = setup(t, { mind: mind => { [waiting, settled] = ['合并第二章', '补全大纲'].map(request => addCommitment(mind, { request, trigger: 'user_request' }, { now: NOW - 30 * MINUTE }).id); } });
  app.change(project => { project.backgroundChanges = [gitRow('ch-wait', 'act-wait', 'merge_conflicted'), gitRow('ch-done', 'act-done', 'kept', { applyId: 'aok', applyIds: ['aok'] })]; });
  route(app, { id: 'act-wait', action: 'work', resolves: [waiting] });
  route(app, { id: 'act-done', action: 'work', resolves: [settled] });
  assert.equal(app.row('commitments', waiting).awaitingApply.changeId, 'ch-wait'); assert.equal(app.row('commitments', settled).status, 'resolved');
  // backgroundMerge settles both as the conversation's own drop (droppedBy 'agent').
  app.change(project => { for (const row of project.backgroundChanges) Object.assign(row, { status: 'reverted', discarded: true, droppedBy: 'agent' }); });
  await tick(); await tick(); app.mind.sweep();
  for (const id of [waiting, settled]) {
    const row = app.row('commitments', id);
    assert.equal(row.status, 'pending', id); assert.equal(row.reopened.reason, 'change_dropped', id);
  }
  const text = JSON.parse(mindContextText({ commitments: [app.row('commitments', waiting)], now: NOW, background: true }));
  assert.equal(text.commitments[0].reopened, 'change_dropped'); assert.match(text.states.reopenedDropped, /dropped them instead of merging them/);
  assert.equal(text.states.reopened, undefined, 'the user-undo meaning is not claimed');
  app.mind.sweep(); assert.equal(app.row('commitments', waiting).reopened.reason, 'change_dropped', 'stable');
});

// The undo of one run (as the user reverts it on its card): the change set reverted, its apply rolled back.
const revert = (app, actionId, changeId, applyId) => app.change(project => {
  Object.assign(project.backgroundChanges.find(row => row.id === changeId), { status: 'reverted', revertedAt: iso(app.clock.now) });
  project.git.applies = [...(project.git.applies ?? []), record(applyId, 'background', { actionId, worktreeId: `wt-${changeId}` }, { state: 'rolled_back', rolledBackBy: `undo-${applyId}` }), record(`undo-${applyId}`, 'rollback', { actionId }, { undoes: applyId, initiator: 'user', at: iso(app.clock.now) })];
});

test('D1-1: a request reopened by an undo is not settled again by the report delivered before the undo; a later delivery can settle it', async t => {
  const judged = [];
  const decisions = { enabled: () => true, config: () => ({ modes: {} }), mindJudge: async (_project, input) => { judged.push(input); return { resolved: (input.commitments ?? []).map((_, index) => index), same: [], refines: [], contradicts: [] }; } };
  let request;
  const app = setup(t, { decisions, mind: mind => { request = addCommitment(mind, { request: '把第三章改短', trigger: 'user_request' }, { now: NOW - 5 * 3600000 }).id; } });
  await app.mind.idle();
  app.change(project => { project.backgroundChanges = [gitRow('ch1', 'act-1', 'kept', { applyId: 'abg1', applyIds: ['abg1'] })]; });
  route(app, { id: 'act-1', action: 'work', resolves: [request] });
  assert.equal(app.row('commitments', request).resolvedBy.kind, 'action');
  // The run reported its work to the user.
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).items.push({ id: 'delivered-1', kind: 'assistant', source: 'initiative', text: '第三章已经改短了，删掉了回忆段落。', createdAt: iso(NOW - MINUTE) }); });
  // The user reverts it: reopened; the report from before the undo settles nothing, however often the sweep runs.
  app.clock.now = NOW + 10 * MINUTE; revert(app, 'act-1', 'ch1', 'abg1');
  for (let i = 0; i < 3; i++) { app.mind.sweep(); await app.mind.idle(); }
  const row = app.row('commitments', request);
  assert.equal(row.status, 'pending'); assert.equal(row.reopened.reason, 'change_undone');
  assert.ok(judged.every(input => !(input.commitments ?? []).some(entry => entry.id === request)), 'the pre-undo report was never put to the judge for it');
  // A proactive message after the undo is new evidence and may settle it.
  app.store.mutate(state => { state.sessions.find(entry => entry.id === app.session.id).items.push({ id: 'delivered-2', kind: 'assistant', source: 'initiative', text: '按你的新要求重新改短了第三章。', createdAt: iso(app.clock.now + MINUTE) }); });
  app.clock.now += 2 * MINUTE; app.mind.sweep(); await app.mind.idle();
  assert.equal(app.row('commitments', request).status, 'resolved'); assert.equal(app.row('commitments', request).resolvedBy.itemId, 'delivered-2');
});

test('X2: an undo does not bring back a request or plan item whose source conversation was deleted, or whose message was rewound', async t => {
  let captured, planned, rewound;
  const app = setup(t, { mind: (mind, _project, state, session) => {
    state.sessions.find(row => row.id === session.id).items.push({ id: 'u-1', kind: 'user', text: '把第三章改短', createdAt: iso(NOW - 5 * 3600000) });
    captured = addCommitment(mind, { request: '把第三章改短', trigger: 'user_request', source: mindSource('capture', { sessionId: session.id, itemId: 'u-1' }) }, { now: NOW - 5 * 3600000 }).id;
    planned = addAgenda(mind, { kind: 'todo', text: '第三章改短', source: mindSource('turn', { sessionId: session.id, itemId: 'u-1' }) }, { now: NOW - DAY }).id;
    rewound = addCommitment(mind, { request: '统一地名', trigger: 'user_request', source: mindSource('capture', { sessionId: 'other-session', itemId: 'o-1' }) }, { now: NOW - 5 * 3600000 }).id;
  } });
  const other = app.store.createSession({ projectId: app.project.id });
  app.change(project => { project.backgroundChanges = [gitRow('ch1', 'act-1', 'kept', { applyId: 'abg1', applyIds: ['abg1'] }), gitRow('ch2', 'act-2', 'kept', { applyId: 'abg2', applyIds: ['abg2'] })]; });
  route(app, { id: 'act-1', action: 'work', resolves: [captured, planned] });
  route(app, { id: 'act-2', action: 'work', resolves: [rewound] });
  assert.equal(app.row('commitments', captured).status, 'resolved'); assert.equal(app.row('agenda', planned).status, 'done'); assert.equal(app.row('commitments', rewound).status, 'resolved');
  // The conversation the first two came from is deleted; the message the third came from is rewound.
  app.store.createSession({ projectId: app.project.id }); void other;
  app.store.deleteSession(app.session.id);
  app.store.mutate(state => revokeMindSources(state, state.projects.find(row => row.id === app.project.id), sourceScope({ sessionId: 'other-session', itemIds: ['o-1'], turnIds: [] }), { mode: 'rewound', now: NOW }));
  assert.equal(app.row('commitments', captured).sourceDeleted, true); assert.equal(app.row('commitments', rewound).sourceRemoved, 'message_rewound');
  // Both runs are undone: nothing is owed again.
  app.clock.now = NOW + 10 * MINUTE; revert(app, 'act-1', 'ch1', 'abg1'); revert(app, 'act-2', 'ch2', 'abg2');
  app.mind.sweep(); app.mind.sweep();
  assert.equal(app.row('commitments', captured).status, 'resolved'); assert.equal(app.row('agenda', planned).status, 'done'); assert.equal(app.row('commitments', rewound).status, 'resolved');
  assert.deepEqual(workOutcomeChanges(app.store.state, app.current(), { now: app.clock.now }), []);
  // A stale computed change cannot apply either.
  app.store.mutate(state => { const mind = state.projects.find(row => row.id === app.project.id).mind; assert.deepEqual(applyWorkOutcomes(mind, [{ collection: 'commitments', id: captured, change: 'reopen', reopened: { reason: 'change_undone', actionId: 'act-1' } }], { now: app.clock.now }), []); });
});

test('X3: a worktree turn whose held apply a later turn overtook is read by the mind, not left waiting forever', async t => {
  const decisions = { enabled: () => true, config: () => ({ modes: {} }), mindJudge: async () => ({ resolved: [] }) };
  let captured;
  const app = setup(t, { decisions, mind: (mind, _project, state, session) => {
    const live = state.sessions.find(row => row.id === session.id);
    const turn = (id, minutes, apply) => ({ id, status: 'completed', createdAt: iso(NOW - minutes * MINUTE), completedAt: iso(NOW - (minutes - 1) * MINUTE), modelConfig: { execution: 'rna' }, userItemId: `${id}-user`, apply });
    // t1's hand-back was held on the user's git merge; t2 started before it ended and applied the whole worktree.
    live.turns.push(turn('t1', 20, { status: 'pending', reason: 'git_operation', applyIds: [] }), turn('t2', 10, { status: 'applied', applyIds: ['aturn2'] }));
    live.items.push({ id: 't1-user', turnId: 't1', kind: 'user', text: '把第三章改短', createdAt: iso(NOW - 20 * MINUTE) }, { id: 't1-reply', turnId: 't1', kind: 'assistant', text: '第三章改短了。', createdAt: iso(NOW - 19 * MINUTE) });
    captured = addCommitment(mind, { request: '把第三章改短', trigger: 'user_request', source: mindSource('capture', { sessionId: session.id, turnId: 't1', itemId: 't1-user' }) }, { now: NOW - 20 * MINUTE }).id;
    state.decisionKernelRuntime = { recent: [{ id: 'ledger-1', point: 'turn.settled', scope: { turnId: 't1' }, source: 'judge', mode: 'active', backend: 'typesafe', answers: { instruction_complete: { type: 'boolean', probability: .99 }, deferred_without_cause: { type: 'boolean', probability: .01 } } }] };
  } });
  const session = app.store.state.sessions.find(row => row.id === app.session.id), [t1] = session.turns;
  assert.equal(applyWaiting(t1), true, 'on its own the turn still looks held');
  assert.equal(applyWaiting(t1, session), false, 'its conversation shows a later turn applied the worktree');
  app.mind.sweep(); await app.mind.idle(); app.mind.sweep(); await app.mind.idle();
  assert.ok(app.store.state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === 't1').mindSettledAt, 'the mind read it');
  assert.equal(app.row('commitments', captured).status, 'resolved'); assert.equal(app.row('commitments', captured).resolvedBy.turnId, 't1');
});
