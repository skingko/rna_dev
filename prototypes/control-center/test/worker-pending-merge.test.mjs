import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { git, put, read, there, skip, scripted, feedbackOf } from './helpers/turn-fixture.mjs';
import { Store } from '../store.mjs';
import { BuiltinAgentService, CUT_OFF_REASON, HELD_REASONS, mergeLine } from '../builtin-agent-service.mjs';
import { createAgentRoutes } from '../agent-routes.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { IsolationEngine, MODEL_TEXT, REFS } from '../git-isolation/index.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { deriveWorkspaceEvents } from '../workspace-events.mjs';
import { SUBAGENT_RESULTS_SOURCE } from '../subagent-results.mjs';

// Pending workers (the user's decision of 2026-10-05, following mu: swarm-isolation.ts:279-370 only collects even a
// crashed worker's patch, which reaches the parent's files when the parent applies it). A worker that did not finish
// (failed, interrupted, out of steps) never writes into the project folder P by itself, nor does one that finished
// while its parent conversation was idle without continueAfter: its changes stay `pending` (`unfinished`,
// `parent_idle`) until the parent model's agent_merge or the user's card. A worker finishing normally while the parent
// turn runs is still merged. Real temporary git repositories and the real engine; the children are stand-ins that write
// in the root they were given, and the parent model is a scripted provider: no network, no paid model.

const gate = () => { let release; const held = new Promise(done => { release = done; }); return { held, release }; };
async function until(check, ms = 20000) { const deadline = Date.now() + ms; while (!(await check())) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await delay(10); } }
const body = result => JSON.parse(result.content[0].text);
const count = (text, needle) => text.split(needle).length - 1;

/**
 * A child stand-in for runDelegatedAgent: `work(options, task)` writes in `options.cwd` and answers `{ text, stepLimit }`
 * (stepLimit: its answer is the summary written at the step limit), or throws (the child failed); abort() stops it.
 */
function child(options, work) {
  const messages = [];
  let stop;
  const stopped = new Promise((_, reject) => { stop = reject; });
  stopped.catch(() => {});
  return {
    snapshot: () => ({ tools: options.readOnly ? [] : ['project_write', 'project_edit'], messages, recovery: { interrupted: false, pendingTools: 0, pendingFinish: false, uncertainTools: [] }, queue: { steering: [] }, usage: { totalTokens: 0 } }),
    async prompt(task) {
      messages.push({ role: 'user', source: 'user', content: task });
      const answer = (await Promise.race([work(options, task), stopped])) ?? {};
      messages.push({ role: 'assistant', content: [{ type: 'text', text: answer.text ?? 'Done; the files are written.' }], stopReason: 'stop', ...(answer.stepLimit ? { source: 'step-limit-summary' } : {}) });
    },
    async resume() {}, async steer() {}, async dispose() {},
    async abort() { stop(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
  };
}

/** A repository P with a.txt and b.txt committed, a project on it whose first turn runs (no runtime yet), and the 0.63 services. */
function setup(t, { work = async () => ({}) } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-pending-worker-'))), P = join(dir, 'repo');
  mkdirSync(P, { recursive: true }); put(P, 'a.txt', 'one\ntwo\nthree\n'); put(P, 'b.txt', 'bee\n');
  git(P, 'init', '-q'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'first');
  const store = new Store(join(dir, 'state', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'pending-worker-synthetic-key', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Pending workers', workspace: P, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const current = () => store.state.sessions.find(row => row.id === session.id), turnId = current().activeTurnId;
  const gitService = new WorkspaceGitService(store), engine = new IsolationEngine(store, { git: gitService, ready: true, sandbox: () => true, pollMs: 5 });
  gitService.engine = engine;
  const roots = new RootResolver(store, { git: gitService }), worktrees = new WorktreeService(store, { git: gitService, engine, roots });
  gitService.owners = path => worktrees.ownerOf(path);
  const children = [];
  const make = () => new BuiltinAgentService(store, { engine, roots, worktrees, factory: async options => { children.push(options); return child(options, work); } });
  const service = make(), tools = service.createTools({ sessionId: session.id, turnId });
  const tool = name => tools.find(row => row.name === name);
  const model = scripted();
  const f = {
    dir, P, store, session, project, turnId, current, engine, roots, worktrees, service, make, children, model, runtime: null,
    delegate: async (task, options = {}) => body(await tool('agent_delegate').execute(`call-${Math.random()}`, { task, ...options }, new AbortController().signal)),
    merge: async args => tool('agent_merge').execute(`merge-${Math.random()}`, args, new AbortController().signal),
    record: id => service.record(session.id, id),
    settled: async id => { await until(() => service.record(session.id, id)?.status !== 'running' && !service.running.has(id)); return service.record(session.id, id); },
    item: id => current().items.find(row => row.kind === 'subagent' && row.subagent?.agentId === id),
    worktree: id => store.state.projects.find(row => row.id === project.id).git?.worktrees?.find(row => row.id === id),
    applies: () => store.state.projects.find(row => row.id === project.id).git?.applies ?? [],
    /** The parent's first turn ends (its final reply streamed): the conversation is idle. */
    idle: () => store.finishRuntimeTurn(session.id, turnId),
    /** The parent conversation's runtime, with the scripted model. */
    start: () => { f.runtime ??= new RuntimeController(store, { factory: options => createRnaRuntime({ ...options, provider: model.provider }), builtinAgentService: service }); return f.runtime; },
    /** A user message, run to the end of its turn. */
    send: async text => { f.start(); const before = current().turns.length; store.message(session.id, { text, requestId: `send-${Math.random()}` }); await until(() => current().turns.length > before && current().turns.at(-1).status === 'completed' && !current().activeTurnId, 60000); return current().turns.at(-1); },
  };
  t.after(async () => { await f.runtime?.close(); await service.close(); engine.close(); try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  return f;
}
const pendingAs = reason => ({ status: 'pending', applyIds: [], reason });

test('a worker that fails writes nothing into the project folder, even while its parent turn runs: pending unfinished, its copy and tip kept, no apply record', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'a.txt', 'one\nhalf done\nthree\n'); put(cwd, 'c.txt', 'half\n'); throw Object.assign(new Error('The model stream broke.'), { code: 'provider_error' }); } });
  const handle = await f.delegate('Edit a.txt and add c.txt.');
  const row = await f.settled(handle.agentId);
  assert.equal(row.status, 'failed'); assert.equal(f.current().activeTurnId, f.turnId, 'the parent turn was running all along');
  assert.deepEqual(row.merge, pendingAs('unfinished'));
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(there(f.P, 'c.txt'), false);
  assert.deepEqual(f.applies(), [], 'no apply record until a real merge');
  const kept = f.worktree(row.worktree.id);
  assert.equal(kept.state, 'kept'); assert.equal(read(join(f.P, kept.dir), 'c.txt'), 'half\n', 'its work stays in its own copy');
  assert.ok(git(f.P, 'rev-parse', REFS.worktree(row.worktree.id, 'tip')).trim(), 'and pinned');
  // The running parent hears it at its next boundary; the user's line says the changes wait on the card.
  const notice = f.current().inbox.find(message => message.agentId === handle.agentId);
  assert.ok(notice.text.includes(`Its changes are pending: unfinished (the subtask did not finish, so the host kept its partial work out of your files). None of them are in your files; use agent_merge({"agentId":"${handle.agentId}"}) to apply them, or ask the user. action drop discards them.`));
  assert.match(notice.notice, /^子代理未完成：实现协作 · .* · 改动没有自动合并，可在卡片上合并或丢弃$/);
  // The card shows it pending with its worktree; the turn-end reminder lists it with its reason.
  assert.deepEqual(f.item(handle.agentId).subagent.merge, pendingAs('unfinished')); assert.equal(f.item(handle.agentId).subagent.worktreeId, row.worktree.id);
  assert.deepEqual(f.service.pendingMerges(f.session.id), [{ agentId: handle.agentId, role: 'worker', task: 'Edit a.txt and add c.txt.', turnId: f.turnId, status: 'pending', reason: 'unfinished', conflicts: [] }]);
  assert.deepEqual(JSON.parse(MODEL_TEXT.workerMergeReminder(f.service.pendingMerges(f.session.id))).workers, [{ agentId: handle.agentId, status: 'pending', reason: 'unfinished' }]);
  const status = body(await f.service.createTools({ sessionId: f.session.id, turnId: f.turnId }).find(row => row.name === 'agent_status').execute('s', { agentId: handle.agentId }, new AbortController().signal));
  assert.deepEqual(status.merge, { status: 'pending', reason: 'unfinished' }); assert.match(status.mergeNote, /^Its changes are pending: unfinished/);
});

test('a worker that ran out of steps, and one the service\'s stop interrupted, are left pending the same way (unfinished)', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }, task) => {
    if (/steps/.test(task)) { put(cwd, 'steps.txt', 'half written\n'); return { text: 'Summary at the step limit: steps.txt is half written.', stepLimit: true }; }
    put(cwd, 'stopped.txt', 'half written\n'); await held.held; return {};
  } });
  const limited = await f.delegate('Run out of steps.');
  const row = await f.settled(limited.agentId);
  assert.equal(row.status, 'completed'); assert.equal(row.stepLimit, true);
  assert.deepEqual(row.merge, pendingAs('unfinished')); assert.equal(there(f.P, 'steps.txt'), false);
  assert.equal(f.worktree(row.worktree.id).state, 'kept');
  // Stopped with the service: its end is settled at the next start, by the same rule.
  const stopped = await f.delegate('Stopped by the service.');
  await until(() => f.children.length === 2); await delay(50);
  await f.service.close();
  assert.equal(f.record(stopped.agentId).status, 'interrupted'); assert.equal(f.record(stopped.agentId).mergeAtStart, true);
  const next = f.make();
  t.after(() => next.close());
  next.recover(); await next.recovery;
  const after = next.record(f.session.id, stopped.agentId);
  assert.deepEqual(after.merge, pendingAs('unfinished')); assert.equal(after.mergeAtStart, undefined);
  assert.equal(there(f.P, 'stopped.txt'), false); assert.deepEqual(f.applies(), []);
  assert.equal(f.worktree(after.worktree.id).state, 'kept'); assert.ok(after.mergeWork.tip, 'pinned at the start');
  held.release();
});

test('a worker that finishes while its parent is idle and opens no turn (no continueAfter) writes nothing: pending parent_idle, reminded once per merge state', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'a.txt', 'one\nTWO by worker\nthree\n'); put(cwd, 'c.txt', 'new\n'); await held.held; return { text: 'Edited a.txt and added c.txt.' }; } });
  const handle = await f.delegate('Edit a.txt and add c.txt.');
  await until(() => f.children.length === 1); await delay(50);
  f.idle(); held.release();
  const row = await f.settled(handle.agentId);
  assert.equal(row.status, 'completed'); assert.deepEqual(row.merge, pendingAs('parent_idle'));
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(there(f.P, 'c.txt'), false); assert.deepEqual(f.applies(), []);
  assert.equal(f.worktree(row.worktree.id).state, 'kept');
  // Shown to the user only (no turn is started for it): its notice says the changes wait on the card.
  assert.equal(row.delivery.status, 'noticed'); assert.equal(f.current().activeTurnId, null);
  assert.match(f.current().items.find(item => item.kind === 'notice' && item.agentId === handle.agentId).text, /改动没有自动合并，可在卡片上合并或丢弃$/);
  // Worded as the host's decision (no turn of the parent was running when it settled the worker), which also holds for
  // a parent paused on a question card or a worker settled at a restart.
  assert.match(mergeLine(row), /^Its changes are pending: parent_idle \(no turn of yours was running when the host settled it \(this conversation was idle, paused, or restarting\), so the host did not merge it by itself\)\. None of them are in your files;/);
  // The turn-end reminder (ISO-4): listed with its reason, pointed out once in this merge state.
  assert.deepEqual(f.service.reminderRows(f.session.id).map(item => [item.agentId, item.status, item.reason]), [[handle.agentId, 'pending', 'parent_idle']]);
  f.service.markReminded(f.session.id, f.service.reminderRows(f.session.id));
  assert.deepEqual(f.service.reminderRows(f.session.id), []);
  assert.deepEqual(f.service.pendingMerges(f.session.id).map(item => item.reason), ['parent_idle'], 'still pending, only not pointed out again');
  assert.deepEqual(HELD_REASONS, ['unfinished', 'parent_idle']);
});

test('a worker that finishes normally while its parent turn runs is still merged by the host; so is one whose result opens a turn of its idle parent', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }, task) => { if (/later/.test(task)) { put(cwd, 'later.txt', 'later\n'); await held.held; } else put(cwd, 'c.txt', 'from the worker\n'); return {}; } });
  const running = await f.delegate('Add c.txt.');
  const row = await f.settled(running.agentId);
  assert.equal(row.merge.status, 'merged'); assert.equal(read(f.P, 'c.txt'), 'from the worker\n');
  assert.equal(f.applies().filter(item => item.kind === 'worker').length, 1); assert.equal(f.worktree(row.worktree.id).state, 'removed');
  const later = await f.delegate('Finish later.', { continueAfter: true });
  await until(() => f.children.length === 2); await delay(50);
  f.idle(); held.release();
  const woke = await f.settled(later.agentId);
  assert.equal(woke.merge.status, 'merged'); assert.equal(read(f.P, 'later.txt'), 'later\n');
  assert.equal(woke.delivery.status, 'woke', 'its follow-up turn hears of it');
});

test('agent_merge and the card\'s 合并 apply a pending worker all at once: every file, one apply record, its copy removed', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }, task) => { const name = task.split(' ')[0]; put(cwd, `${name}-1.txt`, `${task}\n`); put(cwd, `${name}-2.txt`, `${task}\n`); await held.held; return {}; } });
  const viaModel = await f.delegate('model work'), viaCard = await f.delegate('card work');
  await until(() => f.children.length === 2); await delay(50);
  f.idle(); held.release();
  for (const id of [viaModel.agentId, viaCard.agentId]) assert.deepEqual((await f.settled(id)).merge, pendingAs('parent_idle'));
  assert.deepEqual(f.applies(), []);
  // The parent model's agent_merge.
  const merged = body(await f.merge({ agentId: viaModel.agentId }));
  assert.equal(merged.status, 'merged'); assert.deepEqual(merged.applied.sort(), ['model-1.txt', 'model-2.txt']); assert.deepEqual(merged.conflicts, []);
  assert.equal(read(f.P, 'model-1.txt'), 'model work\n'); assert.equal(read(f.P, 'model-2.txt'), 'model work\n');
  const modelRow = f.record(viaModel.agentId), [modelApply] = f.applies().filter(item => item.source?.agentId === viaModel.agentId);
  assert.equal(modelRow.merge.applyIds.length, 1); assert.equal(modelApply.id, modelRow.merge.applyIds[0]); assert.equal(modelApply.files, 2); assert.equal(modelApply.kind, 'worker');
  assert.equal(f.worktree(modelRow.worktree.id).state, 'removed');
  // The user's card.
  const routes = createAgentRoutes({ store: f.store, agents: f.service, body: async req => req.body }), sent = [];
  await routes({ method: 'POST', body: { action: 'merge' } }, { pathname: `/api/v2/sessions/${f.session.id}/agents/${viaCard.agentId}/merge`, send: (status, payload) => sent.push([status, payload]) });
  const [code, answer] = sent.at(-1);
  assert.equal(code, 200); assert.deepEqual(answer.applied.sort(), ['card-1.txt', 'card-2.txt']); assert.equal(answer.subagent.merge.status, 'merged');
  const cardRow = f.record(viaCard.agentId);
  assert.equal(cardRow.merge.applyIds.length, 1); assert.equal(f.applies().filter(item => item.source?.agentId === viaCard.agentId).length, 1);
  assert.equal(f.item(viaCard.agentId).subagent.merge.status, 'merged'); assert.equal(f.worktree(cardRow.worktree.id).state, 'removed');
  assert.deepEqual(f.service.pendingMerges(f.session.id), []);
});

test('discarding a pending worker (the card\'s two steps, or agent_merge drop) removes its copy and writes nothing: no apply record, no workspace event', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }, task) => { put(cwd, `${task.split(' ')[0]}.txt`, 'never wanted\n'); throw Object.assign(new Error('Stopped half way.'), { code: 'provider_error' }); } });
  const viaCard = await f.delegate('card discard'), viaModel = await f.delegate('model discard');
  for (const id of [viaCard.agentId, viaModel.agentId]) assert.deepEqual((await f.settled(id)).merge, pendingAs('unfinished'));
  const preview = await f.service.userMerge(f.session.id, viaCard.agentId, { action: 'drop' });
  assert.deepEqual(preview.files, [], 'nothing was merged, so nothing is rolled back'); assert.ok(preview.confirm);
  const done = await f.service.userMerge(f.session.id, viaCard.agentId, { action: 'drop', confirm: preview.confirm });
  assert.equal(done.subagent.merge.status, 'dropped');
  const cardRow = f.record(viaCard.agentId);
  assert.equal(f.worktree(cardRow.worktree.id).state, 'removed'); assert.equal(cardRow.worktree.removed, true);
  assert.ok(git(f.P, 'rev-parse', REFS.worktree(cardRow.worktree.id, 'tip')).trim(), 'the tip ref stays for the retention period');
  assert.deepEqual(body(await f.merge({ agentId: viaModel.agentId, action: 'drop' })), { status: 'dropped', restored: [], skipped: [] });
  assert.equal(f.worktree(f.record(viaModel.agentId).worktree.id).state, 'removed');
  assert.equal(there(f.P, 'card.txt'), false); assert.equal(there(f.P, 'model.txt'), false);
  assert.deepEqual(f.applies(), []);
  assert.deepEqual(deriveWorkspaceEvents(f.store.state, f.store.state.projects.find(item => item.id === f.project.id)), []);
  assert.deepEqual(f.service.pendingMerges(f.session.id), []);
  assert.equal(mergeLine(f.record(viaModel.agentId)), 'Its changes were dropped.');
});

test('restart recovery leaves an interrupted worker pending (unfinished); the retention sweep never takes its copy; agent_merge brings it in later', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'survivor.txt', 'from before the restart\n'); await held.held; return {}; } });
  const handle = await f.delegate('Survive the restart.');
  await until(() => f.children.length === 1); await delay(50);
  // The old process is gone: its child never answers; a new service starts on the same state.
  f.service.running.clear();
  const next = f.make();
  t.after(() => next.close());
  assert.equal(next.recover(), 1); await next.recovery;
  const row = next.record(f.session.id, handle.agentId);
  assert.equal(row.status, 'interrupted'); assert.deepEqual(row.merge, pendingAs('unfinished'));
  assert.equal(there(f.P, 'survivor.txt'), false); assert.deepEqual(f.applies(), []);
  // Kept for as long as it is pending: the daily sweep removes only `removed` rows past the retention period.
  await f.worktrees.sweep({ now: Date.now() + 400 * 24 * 3600 * 1000 });
  const kept = f.worktree(row.worktree.id);
  assert.equal(kept.state, 'kept'); assert.ok(existsSync(join(f.P, kept.dir, 'survivor.txt')));
  assert.ok(git(f.P, 'rev-parse', REFS.worktree(row.worktree.id, 'tip')).trim());
  const tools = next.createTools({ sessionId: f.session.id, turnId: f.turnId });
  const merged = body(await tools.find(item => item.name === 'agent_merge').execute('m', { agentId: handle.agentId }, new AbortController().signal));
  assert.equal(merged.status, 'merged'); assert.deepEqual(merged.applied, ['survivor.txt']); assert.equal(read(f.P, 'survivor.txt'), 'from before the restart\n');
  held.release();
});

test('the parent model\'s next request carries the pending note exactly once; the turn-end reminder names the worker once; the project folder waits for agent_merge', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'c.txt', 'from the worker\n'); await held.held; return { text: 'Wrote c.txt.' }; } });
  const handle = await f.delegate('Add c.txt.');
  await until(() => f.children.length === 1); await delay(50);
  f.idle(); held.release();
  assert.equal((await f.settled(handle.agentId)).delivery.status, 'noticed');
  const NOTE = 'Its changes are pending: parent_idle';
  await f.send('What happened to c.txt?');
  const wire = () => f.model.requests.map(request => JSON.stringify(request.messages));
  assert.equal(count(wire()[0], NOTE), 1, 'the first request of the next turn carries it once');
  assert.equal(count(wire()[0], SUBAGENT_RESULTS_SOURCE), 1);
  assert.equal(f.record(handle.agentId).delivery.status, 'reported');
  // The model did not act on it: the turn end reminds it once (one continuation), with the reason.
  assert.equal(f.model.requests.length, 2);
  const reminder = feedbackOf(f.model.requests[1]).find(row => /These workers ended/.test(row.text));
  assert.deepEqual(JSON.parse(reminder.text).workers, [{ agentId: handle.agentId, status: 'pending', reason: 'parent_idle' }]);
  assert.equal(count(wire()[1], NOTE), 1, 'the history holds the one copy');
  assert.equal(there(f.P, 'c.txt'), false, 'still not in the project folder');
  await f.send('Anything else?');
  assert.equal(f.model.requests.length, 3, 'no second reminder in the same merge state');
  assert.equal(count(wire()[2], NOTE), 1, 'no second copy');
  assert.equal(count(wire()[2], SUBAGENT_RESULTS_SOURCE), 1);
  assert.equal(there(f.P, 'c.txt'), false);
});

// ---- Review fixes (A5 review, 2026-10-05) ----

/**
 * A worker that finishes while its parent turn runs, whose host merge the process dies in the middle of: the write of
 * its second file never returns (the record stays `running`, its apply record `writing`). Then a new process on the
 * same state: a fresh engine (its recovery settles the cut-off write) and a fresh agent service. `beforeRestart` runs
 * just before the new engine starts (a git operation the user opened meanwhile, say).
 */
async function crashMidMerge(t, f, { beforeRestart = () => {} } = {}) {
  const stuck = gate(); let writes = 0;
  f.engine.settings.hooks = { beforeWrite: async () => { if (writes++ >= 1) { await stuck.held; throw Object.assign(new Error('the process went away'), { code: 'test_crash' }); } } };
  const handle = await f.delegate('Write c.txt and d.txt.');
  await until(() => writes >= 2 && f.applies().some(row => row.kind === 'worker' && row.state === 'writing'));
  assert.equal(f.record(handle.agentId).status, 'running', 'settle has recorded nothing yet');
  assert.deepEqual(f.record(handle.agentId).merge, { status: 'pending', applyIds: [] });
  f.service.running.clear();
  beforeRestart();
  const gitService = new WorkspaceGitService(f.store), engine = new IsolationEngine(f.store, { git: gitService, ready: true, sandbox: () => true, pollMs: 5 });
  gitService.engine = engine;
  const roots = new RootResolver(f.store, { git: gitService }), worktrees = new WorktreeService(f.store, { git: gitService, engine, roots });
  gitService.owners = path => worktrees.ownerOf(path);
  const next = new BuiltinAgentService(f.store, { engine, roots, worktrees });
  // The dead process's write is let go (and fails) only once the test is done with the state.
  const finish = async () => { stuck.release(); await until(() => f.service.mergeQueues.size === 0); };
  t.after(async () => { await next.close(); engine.close(); });
  // As server.mjs: the engine's recovery starts first; the agents' recovery waits for it before it looks at records.
  void engine.recover();
  assert.equal(next.recover(), 1);
  await next.recovery;
  return { handle, next, engine, finish };
}

test('a crash in the middle of the host\'s own merge: recovery finishes that merge with its apply record instead of calling the worker unfinished, and the card\'s discard takes the files back out', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'c.txt', 'from the worker\n'); put(cwd, 'd.txt', 'also from the worker\n'); return { text: 'Wrote c.txt and d.txt.' }; } });
  const { handle, next, finish } = await crashMidMerge(t, f);
  const [apply] = f.applies().filter(item => item.source?.agentId === handle.agentId);
  assert.equal(apply.state, 'verified', 'the engine finished the cut-off write');
  assert.equal(read(f.P, 'c.txt'), 'from the worker\n'); assert.equal(read(f.P, 'd.txt'), 'also from the worker\n');
  const row = next.record(f.session.id, handle.agentId);
  assert.equal(row.status, 'interrupted');
  assert.equal(row.merge.status, 'merged', 'the host had decided to merge it; recovery does not decide again');
  assert.deepEqual(row.merge.applyIds, [apply.id], 'its apply record is adopted'); assert.equal(row.merge.files, 2);
  assert.equal(f.worktree(row.worktree.id).state, 'removed');
  assert.match(mergeLine(row), /^Its changes were merged into your files: /); assert.doesNotMatch(mergeLine(row), /None of them are in your files/);
  assert.doesNotMatch(f.current().items.find(item => item.kind === 'notice' && item.agentId === handle.agentId)?.text ?? '', /改动没有自动合并/);
  assert.deepEqual(next.pendingMerges(f.session.id), []);
  // The card's discard rolls the adopted record back.
  const preview = await next.userMerge(f.session.id, handle.agentId, { action: 'drop' });
  assert.deepEqual(preview.files.map(item => item.path).sort(), ['c.txt', 'd.txt']);
  await next.userMerge(f.session.id, handle.agentId, { action: 'drop', confirm: preview.confirm });
  assert.equal(there(f.P, 'c.txt'), false); assert.equal(there(f.P, 'd.txt'), false);
  assert.equal(next.record(f.session.id, handle.agentId).merge.status, 'dropped');
  await finish();
});

test('a crash in the middle of the host\'s merge that the engine leaves to the user\'s card (a git operation open at the restart): the record is adopted, nothing more is written, no reminder until the card is answered', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'c.txt', 'from the worker\n'); put(cwd, 'd.txt', 'also from the worker\n'); return { text: 'Wrote c.txt and d.txt.' }; } });
  const MERGE_HEAD = join(f.P, '.git', 'MERGE_HEAD');
  const { handle, next, engine, finish } = await crashMidMerge(t, f, { beforeRestart: () => writeFileSync(MERGE_HEAD, git(f.P, 'rev-parse', 'HEAD')) });
  const [apply] = f.applies().filter(item => item.source?.agentId === handle.agentId);
  assert.equal(apply.state, 'interrupted', 'the engine leaves it to its card');
  assert.equal(there(f.P, 'd.txt'), false, 'nothing more is written');
  const row = next.record(f.session.id, handle.agentId);
  assert.deepEqual([row.merge.status, row.merge.reason, row.merge.applyIds], ['pending', CUT_OFF_REASON, [apply.id]]);
  assert.equal(f.worktree(row.worktree.id).state, 'kept');
  assert.match(mergeLine(row), /cut off part way by a restart, so some of them may already be in your files\. The user decides on the card/);
  assert.deepEqual(next.pendingMerges(f.session.id), [], 'not pointed out while the card decides');
  // The user completes the write on the card once the operation is over: the worker is listed, and agent_merge closes it.
  rmSync(MERGE_HEAD);
  await engine.resolveInterrupted(f.project.id, apply.id, 'complete');
  assert.equal(read(f.P, 'd.txt'), 'also from the worker\n');
  assert.deepEqual(next.pendingMerges(f.session.id).map(item => [item.agentId, item.reason]), [[handle.agentId, CUT_OFF_REASON]]);
  const merged = body(await next.createTools({ sessionId: f.session.id, turnId: f.turnId }).find(item => item.name === 'agent_merge').execute('m', { agentId: handle.agentId }, new AbortController().signal));
  assert.equal(merged.status, 'merged');
  assert.deepEqual(next.record(f.session.id, handle.agentId).merge.applyIds, [apply.id], 'nothing was left to write');
  await finish();
});

test('a merge held on the user\'s git operation that ends after the parent\'s turn is not written by the host (parent_idle); agent_merge refused during an operation says to call again, not that the host merges it', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'c.txt', 'from the worker\n'); return { text: 'Wrote c.txt.' }; } });
  const MERGE_HEAD = join(f.P, '.git', 'MERGE_HEAD');
  writeFileSync(MERGE_HEAD, git(f.P, 'rev-parse', 'HEAD'));
  const handle = await f.delegate('Write c.txt.');
  const row = await f.settled(handle.agentId);
  assert.deepEqual([row.merge.status, row.merge.reason], ['pending', 'git_operation'], 'finished while the turn ran, held on the merge');
  assert.match(mergeLine(row), /If a turn of yours is running when that operation ends, the host merges them into your files then; otherwise they wait for agent_merge/);
  // The turn ends; the user's merge ends an hour later.
  f.idle();
  rmSync(MERGE_HEAD);
  await until(() => f.record(handle.agentId).merge.reason !== 'git_operation');
  const after = f.record(handle.agentId);
  assert.deepEqual(after.merge, pendingAs('parent_idle'));
  assert.equal(there(f.P, 'c.txt'), false, 'no turn is there to hear it: nothing written'); assert.deepEqual(f.applies(), []);
  assert.equal(f.worktree(after.worktree.id).state, 'kept');
  assert.deepEqual(f.service.pendingMerges(f.session.id).map(item => [item.agentId, item.reason]), [[handle.agentId, 'parent_idle']]);
  // The model acts on it while the user has another git operation open: told to call again, not promised a host merge.
  writeFileSync(MERGE_HEAD, git(f.P, 'rev-parse', 'HEAD'));
  const refused = await f.merge({ agentId: handle.agentId });
  assert.equal(refused.details.code, 'git_operation_in_progress');
  const text = JSON.parse(refused.content[0].text).error;
  assert.match(text, /Leave this for now and call agent_merge again once the user finishes or aborts that operation\.$/); assert.doesNotMatch(text, /merged by the host/);
  rmSync(MERGE_HEAD); await delay(1500);
  assert.equal(there(f.P, 'c.txt'), false); assert.equal(f.record(handle.agentId).merge.reason, 'parent_idle');
});

test('the worktree panel does not apply or discard a pending worker\'s copy behind its card; once the conversation no longer has the worker, it may', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'c.txt', 'half done\n'); throw Object.assign(new Error('The model stream broke.'), { code: 'provider_error' }); } });
  const handle = await f.delegate('Write c.txt.');
  const row = await f.settled(handle.agentId);
  assert.deepEqual(row.merge, pendingAs('unfinished'));
  for (const action of ['applyWorktree', 'discardWorktree']) await assert.rejects(f.worktrees[action](f.project.id, row.worktree.id, {}), error => error.code === 'worktree_worker_pending' && error.status === 409 && error.worktreeId === row.worktree.id && /卡片/.test(error.message), action);
  assert.equal(there(f.P, 'c.txt'), false); assert.equal(f.worktree(row.worktree.id).state, 'kept');
  assert.deepEqual(f.record(handle.agentId).merge, pendingAs('unfinished'));
  // Its conversation no longer has the worker (deleted): the panel is how its copy is settled.
  f.store.mutate(state => { for (const turn of state.sessions.find(item => item.id === f.session.id).turns) turn.delegations = []; });
  const preview = await f.worktrees.applyWorktree(f.project.id, row.worktree.id, {});
  assert.ok(preview.confirm); assert.deepEqual(preview.files.map(item => item.path), ['c.txt']);
});

test('startup recovery that cannot settle a worker keeps its copy for the card (kept); one a second stop cuts short is tried again at the next start (mergeAtStart)', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'c.txt', 'half done\n'); await held.held; return {}; } });
  const first = await f.delegate('first');
  await until(() => f.children.length === 1); await delay(50);
  f.service.running.clear();
  const refusing = f.make();
  t.after(() => refusing.close());
  refusing.finishWorker = async () => { throw Object.assign(new Error('The engine refused.'), { code: 'engine_failed' }); };
  refusing.recover(); await refusing.recovery;
  const failed = refusing.record(f.session.id, first.agentId);
  assert.deepEqual(failed.merge, pendingAs('engine_failed'));
  assert.equal(f.worktree(failed.worktree.id).state, 'kept', 'not left as if still in use');
  // A second worker, and a start that is stopped again while it settles it.
  const second = await f.delegate('second');
  await until(() => f.children.length === 2); await delay(50);
  f.service.running.clear();
  const stopping = f.make();
  t.after(() => stopping.close());
  stopping.finishWorker = async () => { stopping.closed = true; stopping.closing.abort(); throw Object.assign(new Error('The wait was aborted.'), { name: 'AbortError' }); };
  stopping.recover(); await stopping.recovery;
  const cut = stopping.record(f.session.id, second.agentId);
  assert.equal(cut.mergeAtStart, true, 'the next start settles it'); assert.deepEqual(cut.merge, pendingAs('interrupted'));
  held.release();
});

test('a continueAfter worker on an idle parent is merged by the host only when its notice would open that turn: not during an emergency stop, nor once the conversation is archived', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'later.txt', 'later\n'); await held.held; return {}; } });
  const handle = await f.delegate('Finish later.', { continueAfter: true });
  await until(() => f.children.length === 1); await delay(50);
  f.idle();
  const identity = { projectId: f.project.id, sessionId: f.session.id, agentId: handle.agentId };
  assert.equal(f.service.holdReason(identity, 'completed'), null, 'its result opens a follow-up turn: the host merges it');
  f.store.mutate(state => { state.emergency = { at: new Date().toISOString(), reason: 'test' }; });
  assert.equal(f.service.holdReason(identity, 'completed'), 'parent_idle', 'an emergency stop only shows the notice, so nothing is written');
  f.store.mutate(state => { state.emergency = false; state.sessions.find(row => row.id === f.session.id).archivedAt = new Date().toISOString(); });
  assert.equal(f.service.holdReason(identity, 'completed'), 'parent_idle');
  held.release();
});

test('the user\'s merge or discard on the card rewrites a notice still queued for the parent turn; the model cannot drop a merge the user made', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }, task) => { put(cwd, `${task.split(' ')[0]}.txt`, 'half done\n'); throw Object.assign(new Error('The model stream broke.'), { code: 'provider_error' }); } });
  const kept = await f.delegate('kept by the user'), thrown = await f.delegate('thrown away by the user');
  for (const id of [kept.agentId, thrown.agentId]) assert.deepEqual((await f.settled(id)).merge, pendingAs('unfinished'));
  const queued = id => f.current().inbox.filter(message => message.agentId === id);
  assert.match(queued(kept.agentId)[0].text, /None of them are in your files/);
  // The running turn has not read the notice yet when the user merges this worker from its card.
  const answer = await f.service.userMerge(f.session.id, kept.agentId, { action: 'merge' });
  assert.deepEqual(answer.applied, ['kept.txt']); assert.equal(read(f.P, 'kept.txt'), 'half done\n');
  assert.equal(queued(kept.agentId).length, 1, 'one notice, not two'); assert.equal(f.record(kept.agentId).delivery.status, 'steered');
  assert.doesNotMatch(queued(kept.agentId)[0].text, /None of them are in your files|action drop/);
  assert.match(queued(kept.agentId)[0].text, /The user merged its changes into your files from its card: kept\.txt\./);
  assert.doesNotMatch(queued(kept.agentId)[0].notice, /改动没有自动合并/);
  // … and discards the other.
  const preview = await f.service.userMerge(f.session.id, thrown.agentId, { action: 'drop' });
  await f.service.userMerge(f.session.id, thrown.agentId, { action: 'drop', confirm: preview.confirm });
  assert.equal(queued(thrown.agentId).length, 1);
  assert.match(queued(thrown.agentId)[0].text, /Its changes were dropped\./); assert.doesNotMatch(queued(thrown.agentId)[0].text, /use agent_merge/);
  // A model that read the worker as pending earlier tries to drop it: refused, the user's merge stays.
  const refused = await f.merge({ agentId: kept.agentId, action: 'drop' });
  assert.equal(refused.isError, true); assert.equal(refused.details.code, 'merge_user_merged');
  assert.match(JSON.parse(refused.content[0].text).error, /^The user merged this worker's changes into your files from its card \(1 file\(s\)\)/);
  assert.equal(read(f.P, 'kept.txt'), 'half done\n'); assert.equal(f.record(kept.agentId).merge.status, 'merged');
});

test('a joined worker (wait: true) that does not finish names itself in the error the model reads and says its changes are pending', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'c.txt', 'half done\n'); throw Object.assign(new Error('The model stream broke.'), { code: 'provider_error' }); } });
  const joined = await f.service.createTools({ sessionId: f.session.id, turnId: f.turnId }).find(item => item.name === 'agent_delegate').execute('joined', { task: 'Write c.txt.', wait: true }, new AbortController().signal);
  assert.equal(joined.isError, true);
  const [row] = f.service.records(f.session.id);
  assert.deepEqual(row.merge, pendingAs('unfinished'));
  assert.equal(joined.content[0].text, `The subtask did not finish; its record is kept and it was not retried. agentId=${row.id}. ${mergeLine(row)}`);
  assert.match(joined.content[0].text, /Its changes are pending: unfinished/);
});
