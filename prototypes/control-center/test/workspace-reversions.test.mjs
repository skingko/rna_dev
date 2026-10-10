import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { turnFixture, read, skip } from './helpers/turn-fixture.mjs';
import { createApplyRoutes } from '../apply-routes.mjs';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { projectRhythmEvidenceKey } from '../project-rhythm.mjs';
import { REVERSIONS_SOURCE, deriveWorkspaceEvents } from '../workspace-events.mjs';
import { projectConversationContext } from '../project-conversation-context.mjs';
import { DirectFixRecorder, saveDirectFix } from '../direct-fix-store.mjs';

// Rollback awareness end to end: a user's undo reaches the next foreground request once, at the tail, and the
// initiative snapshot (which background work embeds) without becoming evidence that wakes the loop. Real temporary
// repositories and stores, a scripted model; no network, no paid model.

/** How many messages of a provider request carry host context from `source`. */
const carried = (request, source) => (request?.messages ?? []).filter(message => JSON.stringify(message).includes(source)).length;

test('a turn rolled back through the route reaches the next turn\'s requests once, after the earlier history, as the user\'s undo', { skip }, async t => {
  const f = turnFixture(t);
  f.model.steps.push({ write: ['a.txt', 'one\nTWO\nthree\n'] }, { text: 'Changed the second line of a.txt.' });
  const first = await f.send(f.session.id, 'change a');
  assert.equal(first.checkpoint?.state, 'taken');
  const routes = createApplyRoutes({ store: f.store, body: async req => req.body ?? {}, engine: f.engine });
  const call = async (path, body) => { let answer = null; const url = new URL(`http://localhost${path}`); await routes({ method: 'POST', body }, { pathname: url.pathname, url, send: (status, payload) => { answer = { status, body: payload }; } }); return answer; };
  const path = `/api/v2/projects/${f.project.id}/turns/${first.id}/rollback`;
  // Who asked is the route's to say, never the body's.
  assert.equal((await call(path, { initiator: 'agent' })).body.code, 'rollback_request_invalid');
  const preview = await call(path, {});
  const done = await call(path, { confirm: preview.body.confirm });
  assert.equal(done.status, 200); assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n');
  const record = f.applies().find(row => row.id === done.body.applyId);
  assert.deepEqual([record.kind, record.undoesTurn, record.initiator], ['rollback', first.id, 'user']);

  const before = f.model.requests.length;
  f.model.steps.push({ write: ['b.txt', 'b\n'] }, { text: 'Added b.txt.' });
  await f.send(f.session.id, 'add b');
  const requests = f.model.requests.slice(before);
  // The write, the reply, then the host's final-response review: three requests in one turn.
  assert.ok(requests.length >= 2, String(requests.length));
  for (const request of requests) assert.equal(carried(request, REVERSIONS_SOURCE), 1, 'one context message, not repeated by the second request');
  const messages = requests[0].messages, index = messages.findIndex(message => JSON.stringify(message).includes(REVERSIONS_SOURCE));
  assert.ok(index > messages.findIndex(message => JSON.stringify(message).includes('Changed the second line of a.txt.')), 'appended after the earlier turn, at the tail');
  const text = JSON.stringify(messages[index]);
  assert.match(text, /turn_rolled_back/); assert.match(text, /this_conversation/); assert.match(text, /a\.txt/); assert.match(text, /do not re-apply/);
  // The system prompt and tools of the turn are what they were: the undo rides only the tail.
  assert.equal(requests[0].systemPrompt, f.model.requests[before - 1].systemPrompt);
  assert.equal(JSON.stringify(requests[0].tools), JSON.stringify(f.model.requests[before - 1].tools));

  // The turn after: nothing new, so nothing is added (the one message stays in the history).
  const third = f.model.requests.length;
  f.model.steps.push({ text: 'Nothing else.' });
  await f.send(f.session.id, 'anything else?');
  assert.equal(carried(f.model.requests[third], REVERSIONS_SOURCE), 1);
});

test('an undo made after the previous turn\'s last request, while it was finishing, reaches the next turn once; then the key settles', { skip }, async t => {
  const f = turnFixture(t);
  f.model.steps.push({ text: 'First.' });
  await f.send(f.session.id, 'first');
  f.model.steps.push({ text: 'Second.' });
  // The user discards a file in the changes panel after the second turn's last request, before it completes (its
  // final reply streaming, its review, its hand-back): no request of that turn can carry it.
  const finish = f.store.finishRuntimeTurn.bind(f.store);
  let injected = 0;
  f.store.finishRuntimeTurn = (sessionId, turnId, options) => {
    if (!injected++) f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] }; project.git.applies ??= []; project.git.applies.push({ id: 'agap', kind: 'user_discard', target: 'project', source: {}, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: ['notes.md'], at: new Date().toISOString() }); });
    return finish(sessionId, turnId, options);
  };
  const before = f.model.requests.length;
  const second = await f.send(f.session.id, 'second');
  assert.equal(injected, 1); assert.ok(Date.parse(f.applies().find(row => row.id === 'agap').at) <= Date.parse(second.completedAt));
  assert.equal(f.model.requests.slice(before).some(request => carried(request, REVERSIONS_SOURCE)), false, 'the second turn never carried it');
  const third = f.model.requests.length;
  f.model.steps.push({ text: 'Third.' });
  await f.send(f.session.id, 'third');
  assert.equal(carried(f.model.requests[third], REVERSIONS_SOURCE), 1, 'the third turn\'s first request carries it');
  assert.match(JSON.stringify(f.model.requests[third].messages), /discarded/);
  // The fourth turn's window (since the second ended, after the discard) is empty: the settled value, once.
  const fourth = f.model.requests.length;
  f.model.steps.push({ text: 'Fourth.' });
  await f.send(f.session.id, 'fourth');
  assert.equal(carried(f.model.requests[fourth], REVERSIONS_SOURCE), 2, 'the notice in history, then the settled value at the tail');
  assert.match(JSON.stringify(f.model.requests[fourth].messages.at(-2)) + JSON.stringify(f.model.requests[fourth].messages.at(-1)), /describe past undos, not new ones/);
  const fifth = f.model.requests.length;
  f.model.steps.push({ text: 'Fifth.' });
  await f.send(f.session.id, 'fifth');
  assert.equal(carried(f.model.requests[fifth], REVERSIONS_SOURCE), 2, 'nothing appended again');
});

const until = async (check, what) => { const deadline = Date.now() + 10000; while (!check()) { if (Date.now() > deadline) throw new Error(`${what} did not settle`); await delay(5); } };
async function initiativeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-reversions-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Local fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Undo awareness', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.decisionMode = 'rna-model'; p.initialization = { status: 'ready' }; p.simulated = false; p.assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }; state.settings.realTokenBudget = null; });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 999999, tickIntervalMs: 0, decisionProvider: async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'fixture', evidenceIds: [], nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done', stopReason: 'stop' }; } });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  await until(() => controller.contexts.get(project.id)?.initialized, 'the initiative context');
  return { store, controller, projectId: project.id, sessionId: session.id, project: () => store.state.projects.find(row => row.id === project.id), session: () => store.state.sessions.find(row => row.id === session.id) };
}

test('the initiative snapshot carries the user\'s undos at its volatile tail and marks the turn and the run, without a new evidence source', async t => {
  const f = await initiativeFixture(t);
  f.store.message(f.sessionId, { text: 'Add a type check to calc.js' });
  const turnId = f.session().activeTurnId;
  f.store.mutate(state => state.sessions.find(row => row.id === f.sessionId).items.push({ id: 'answer', turnId, kind: 'assistant', simulated: false, text: 'Added the type check to src/calc.js.' }));
  f.store.finishRuntimeTurn(f.sessionId, turnId);
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.projectId); p.initiativeRuntime.sdkState.actions.push({ id: 'act-round2', action: 'work', status: 'completed', evidenceIds: [], content: 'Round 2', handoff: 'Done: round2 written to notes.md.' }); });
  const scope = f.controller.scope(f.project(), f.controller.model(f.project()));
  const sourcesBefore = f.controller.sources(f.project(), scope).map(row => row.id).sort(), rhythmBefore = projectRhythmEvidenceKey(f.store.state, f.project());
  assert.equal(f.controller.snapshot(f.project()).workspaceEvents, undefined, 'nothing undone, no key');
  const now = Date.now(), iso = offset => new Date(now + offset).toISOString();
  f.store.mutate(state => {
    const p = state.projects.find(row => row.id === f.projectId);
    p.git = { sessionWorktreeDefault: false, worktrees: [], applies: [
      { id: 'aturn', kind: 'turn', target: 'project', source: { sessionId: f.sessionId, turnId }, state: 'rolled_back', rolledBackBy: 'kturn', files: 1, sample: ['src/calc.js'], at: iso(-60000) },
      { id: 'kturn', kind: 'rollback', target: 'project', source: { sessionId: f.sessionId, turnId }, undoesTurn: turnId, initiator: 'user', state: 'verified', files: 1, sample: ['src/calc.js'], at: iso(-30000) },
      { id: 'kself', kind: 'rollback', target: 'project', source: { sessionId: f.sessionId, turnId, agentId: 'agent-x' }, undoes: 'aw', initiator: 'agent', state: 'verified', files: 1, sample: ['w.js'], at: iso(-20000) }] };
    p.backgroundChanges = [{ id: 'c-old', actionId: 'act-round2', at: iso(-50000), status: 'reverted', revertedAt: iso(-10000), files: [{ path: 'notes.md' }], outcome: { restored: ['notes.md'], conflicts: [], failed: [] } }];
  });
  const snapshot = f.controller.snapshot(f.project());
  assert.deepEqual(snapshot.workspaceEvents.events.map(row => [row.id, row.kind]), [['change:c-old', 'background_reverted'], ['kturn', 'turn_rolled_back']], 'newest first; the model\'s own drop is not there');
  assert.match(snapshot.workspaceEvents.meaning, /do not re-apply, sync back or propose re-adding/);
  assert.deepEqual(snapshot.continuity.recentTurns.at(-1).undone, { at: iso(-30000), kind: 'turn_rolled_back' });
  assert.deepEqual(snapshot.continuity.actionReceipts.find(row => row.actionId === 'act-round2').changesReverted, { at: iso(-10000) });
  // At the volatile tail of the project, before the conversation (it changes less often).
  const keys = Object.keys(snapshot);
  assert.ok(keys.indexOf('workspaceEvents') > keys.indexOf('actionContracts')); assert.ok(keys.indexOf('workspaceEvents') < keys.indexOf('recentConversation'));
  // Not evidence: the sources (what wakes a review) and the rhythm's evidence key are what they were.
  assert.deepEqual(f.controller.sources(f.project(), scope).map(row => row.id).sort(), sourcesBefore);
  assert.equal(projectRhythmEvidenceKey(f.store.state, f.project()), rhythmBefore);
  // Background work reads the same snapshot as its project evidence.
  assert.match(JSON.stringify({ project: snapshot }), /turn_rolled_back/);
});

test('a reverted git change set\'s line says so (and an undo takes it back out); revert notices follow the interface language', async t => {
  const f = await initiativeFixture(t);
  const now = new Date().toISOString();
  f.store.mutate(state => {
    const p = state.projects.find(row => row.id === f.projectId);
    p.git = { sessionWorktreeDefault: false, worktrees: [], applies: [{ id: 'abg', kind: 'background', target: 'project', source: { actionId: 'act-g', worktreeId: 'bg-1' }, state: 'rolled_back', rolledBackBy: 'kbg', files: 1, sample: ['notes.md'], at: now },
      { id: 'kbg', kind: 'rollback', target: 'project', source: { actionId: 'act-g', worktreeId: 'bg-1' }, undoes: 'abg', initiator: 'user', state: 'verified', files: 1, sample: ['notes.md'], at: now }] };
    p.backgroundChanges = [{ id: 'cg', kind: 'git', actionId: 'act-g', at: now, worktreeId: 'bg-1', applyId: 'abg', applyIds: ['abg'], files: [{ path: 'notes.md' }], status: 'kept' },
      { id: 'cl', actionId: 'act-l', at: now, files: [{ path: 'legacy.md', existed: true, afterSha: 'x' }], status: 'kept' }];
    state.sessions.find(row => row.id === f.sessionId).items.push(
      { id: 'line-g', turnId: null, kind: 'assistant', text: 'This background task: notes\n\nChanged 1 file.', createdAt: now, simulated: false, source: 'initiative', projectId: f.projectId, initiativeActionId: 'act-g-changes', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'act-g', status: 'done' }, backgroundChange: 'cg' } },
      { id: 'line-l', turnId: null, kind: 'assistant', text: 'Legacy change.', createdAt: now, simulated: false, source: 'initiative', projectId: f.projectId, initiativeActionId: 'act-l-changes', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'act-l', status: 'done' }, backgroundChange: 'cl' } });
  });
  const line = id => f.session().items.find(row => row.id === id).text, note = () => f.project().backgroundChanges[0].revertNote;
  const finding = () => projectConversationContext(f.session(), f.project()).messages.find(row => row.id === 'line-g');
  // Rolled back from the apply history: the row follows its records and carries the note. The line's text is never
  // rewritten (it is frozen memory evidence); the foreground's collaborator_finding carries the note instead.
  f.controller.syncGitRows(f.projectId);
  assert.equal(f.project().backgroundChanges[0].status, 'reverted');
  assert.equal(line('line-g'), 'This background task: notes\n\nChanged 1 file.');
  assert.equal(note(), 'The user reverted these changes; the project folder no longer has them.');
  assert.equal(finding().revertedByUser, note());
  f.controller.syncGitRows(f.projectId);
  f.controller.revertedLine(f.projectId, 'cg', true);
  assert.equal(note(), 'The user reverted these changes; the project folder no longer has them.', 'idempotent');
  // The rollback undone: the set is kept again and the note goes.
  f.store.mutate(state => { const rows = state.projects.find(row => row.id === f.projectId).git.applies; Object.assign(rows[0], { state: 'verified' }); delete rows[0].rolledBackBy; rows[1].state = 'rolled_back'; });
  f.controller.syncGitRows(f.projectId);
  assert.equal(f.project().backgroundChanges[0].status, 'kept');
  assert.equal(note(), undefined);
  assert.equal(finding().revertedByUser, undefined);
  assert.equal(line('line-g'), 'This background task: notes\n\nChanged 1 file.');
  // With the files a revert had to leave alone (the note is model-facing English; the notices follow the interface language).
  f.controller.revertedLine(f.projectId, 'cg', true, { conflicts: ['notes.md'] });
  assert.equal(note(), 'The user reverted these changes; notes.md changed afterwards and kept its current content.');
  assert.equal(line('line-g'), 'This background task: notes\n\nChanged 1 file.');
  f.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  assert.equal(f.controller.revertNotice({ restored: ['a.md', 'b.md'], conflicts: ['c.md'], failed: ['d.md'] }, { fix: true }), 'Reverted 2 files: a.md, b.md.\nc.md changed after the fix, so it was not reverted, to keep the newer content.\nd.md could not be restored.');
  // The one-click revert of an older change set posts its notice in the interface language (no snapshot of the file here: it is left alone).
  assert.equal(f.controller.revertBackgroundChange(f.projectId, 'cl').status, 'reverted');
  assert.equal(f.session().items.at(-1).text, 'Reverted 0 files.\nlegacy.md changed afterwards, so it was not reverted, to keep the newer content.');
  assert.deepEqual(deriveWorkspaceEvents(f.store.state, f.project()).map(row => [row.id, row.kind, row.partial ?? false, row.undoneLater ?? false]), [['change:cl', 'background_reverted', true, false], ['kbg', 'background_reverted', false, true]]);
  f.store.mutate(state => { state.settings.interfaceLanguage = 'zh'; });
  assert.equal(f.controller.revertNotice({ restored: ['a.md'], conflicts: ['c.md'], failed: [] }), '已回退 1 个文件：a.md。\nc.md 之后又被改过，为免覆盖新内容没有回退。');
});

test('reverting a direct fix made in its own worktree annotates the finding\'s action receipt (its records carry `<actionId>-direct`)', async t => {
  const f = await initiativeFixture(t), now = Date.now(), iso = offset => new Date(now + offset).toISOString();
  f.store.mutate(state => {
    const p = state.projects.find(row => row.id === f.projectId);
    p.initiativeRuntime.sdkState.actions.push({ id: 'act-x', action: 'share', status: 'completed', evidenceIds: [], content: 'Chapter 3 calls the captain Li Wei; chapter 1 says Li Hua.', resultSummary: 'Handled directly: the fixes were applied to 1 file(s).' });
    p.git = { sessionWorktreeDefault: false, worktrees: [], applies: [
      { id: 'afix', kind: 'background', target: 'project', source: { actionId: 'act-x-direct', worktreeId: 'bg-fix' }, state: 'rolled_back', rolledBackBy: 'kfix', files: 1, sample: ['ch3.md'], at: iso(-60000) },
      { id: 'kfix', kind: 'rollback', target: 'project', source: { actionId: 'act-x-direct', worktreeId: 'bg-fix' }, undoes: 'afix', initiator: 'user', state: 'verified', files: 1, sample: ['ch3.md'], at: iso(-30000) }] };
    p.directFixes = [{ id: 'fix-1', kind: 'git', actionId: 'act-x', applyIds: ['afix'], at: iso(-60000), files: [{ path: 'ch3.md' }], status: 'reverted', settledAt: iso(-30000) }];
  });
  const snapshot = f.controller.snapshot(f.project());
  assert.deepEqual(snapshot.continuity.actionReceipts.find(row => row.actionId === 'act-x').changesReverted, { at: iso(-30000) });
  assert.deepEqual(snapshot.workspaceEvents.events.map(row => [row.id, row.kind, row.actionId]), [['kfix', 'background_reverted', 'act-x']]);
});

test('the one-click revert of an older change set hands the files it wrote to the folder\'s observation, as the engine\'s undos do', async t => {
  const f = await initiativeFixture(t);
  const workspace = f.project().workspace, recorder = new DirectFixRecorder(workspace);
  writeFileSync(join(workspace, 'notes.md'), 'before\n'); recorder.capture('notes.md'); writeFileSync(join(workspace, 'notes.md'), 'after background work\n');
  const files = saveDirectFix(f.controller.backgroundChangeDir(), 'c-one-click', recorder.changes());
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).backgroundChanges = [{ id: 'c-one-click', actionId: 'act-one', at: new Date().toISOString(), files, status: 'kept' }]; });
  const handed = [];
  f.controller.background.engine = { userUndoWrite: projectId => ({ end: async paths => { handed.push([projectId, paths]); } }) };
  assert.deepEqual(f.controller.revertBackgroundChange(f.projectId, 'c-one-click').outcome.restored, ['notes.md']);
  assert.equal(readFileSync(join(workspace, 'notes.md'), 'utf8'), 'before\n');
  assert.deepEqual(handed, [[f.projectId, ['notes.md']]]);
});
