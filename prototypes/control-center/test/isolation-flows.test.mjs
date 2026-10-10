import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { turnFixture, scripted, read, put, there, skip, git, until } from './helpers/turn-fixture.mjs';
import { APPLY_TARGET, IsolationEngine, MERGE_LABELS } from '../git-isolation/index.mjs';
import { createServer } from '../server.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { Store } from '../store.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { BuiltinAgentService } from '../builtin-agent-service.mjs';
import { BackgroundWorktrees } from '../background-worktree.mjs';
import { fixture as engineFixture } from './git-isolation-fixture.mjs';

// Adversarial flow review of 0.63 isolation (design §4–§8, §10): whole flows across services, each on a real
// temporary repository with the real engine and a scripted model or a stand-in child. Git runs with no global or system
// configuration (the init flows name their own scratch global config). No network, no paid model, never the user's
// projects or production state.

/** A worker's change set as the engine sees one: P's files now plus `files`, as a commit-free tree. */
async function workerTree(f, files) {
  const P = (await f.roots.rootOf({ projectId: f.project.id }));
  const now = await f.engine.snapshot(f.project.id, P);
  const entries = Object.entries(files).map(([path, text]) => ({ path, mode: '100644', oid: execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, input: text, encoding: 'utf8' }).trim() }));
  return { P, base: now.commit, incoming: await f.engine.compose(f.project.id, now.commit, entries) };
}
/** Merge a worker's files into P as BuiltinAgentService.mergeOnce does (partial, kind worker, source = its turn). */
async function workerMerge(f, turnId, files, agentId = 'agent-flow') {
  const { P, base, incoming } = await workerTree(f, files);
  return f.engine.apply(f.project.id, { target: P, base, incoming, kind: 'worker', source: { sessionId: f.session.id, turnId, agentId, worktreeId: 'w-flow' }, mode: 'partial', labels: MERGE_LABELS.worker(agentId) });
}
const row = (f, id) => f.applies().find(item => item.id === id);

test('回退本轮 of a direct-mode turn takes back the worker merges made during it, not one that landed after it ended', { skip }, async t => {
  const f = turnFixture(t);
  let during = null;
  f.model.steps.push({ write: ['a.txt', 'one\nTWO\nthree\n'] }, async () => { during = await workerMerge(f, f.sessionOf(f.session.id).activeTurnId, { 'during.txt': 'merged while the turn ran\n' }, 'agent-during'); return { text: '好了。' }; });
  const turn = await f.send(f.session.id, '改 a');
  assert.equal(turn.checkpoint?.state, 'taken');
  assert.equal(during.status, 'applied');
  // A background worker of the same turn finishes after the turn ended and is merged then.
  const after = await workerMerge(f, turn.id, { 'after.txt': 'merged after the turn\n' }, 'agent-after');
  assert.equal(after.status, 'applied');
  const preview = await f.engine.rollbackTurn(f.project.id, turn.id, {});
  assert.deepEqual(preview.files.map(item => item.path).sort(), ['a.txt', 'during.txt']);
  const done = await f.engine.rollbackTurn(f.project.id, turn.id, { confirm: preview.confirm });
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(there(f.P, 'during.txt'), false);
  assert.equal(read(f.P, 'after.txt'), 'merged after the turn\n', 'the later merge is untouched');
  assert.equal(row(f, during.applyId).state, 'rolled_back', 'the merge made during the turn went with it');
  assert.equal(row(f, during.applyId).rolledBackBy, done.applyId);
  assert.equal(row(f, after.applyId).state, 'verified', 'a merge the rollback did not touch is not marked as rolled back');
  assert.equal(row(f, after.applyId).rolledBackBy, undefined);
  // It can still be rolled back on its own (agent_merge drop, the apply history).
  const own = await f.engine.rollback(f.project.id, after.applyId, {});
  assert.deepEqual(own.files.map(item => item.path), ['after.txt']);
  // 撤销回退 brings the turn and its worker merge back; the later merge stays as it was.
  const undo = await f.engine.rollback(f.project.id, done.applyId, {});
  await f.engine.rollback(f.project.id, done.applyId, { confirm: undo.confirm });
  assert.equal(read(f.P, 'a.txt'), 'one\nTWO\nthree\n'); assert.equal(read(f.P, 'during.txt'), 'merged while the turn ran\n');
  assert.equal(row(f, during.applyId).state, 'verified'); assert.equal(row(f, after.applyId).state, 'verified');
  assert.equal(row(f, done.applyId).target, APPLY_TARGET.project);
});

test('a host write into P still running when a direct-mode turn starts is never counted as the turn\'s own work', { skip }, async t => {
  let release = null; const held = new Promise(done => { release = done; });
  const f = turnFixture(t, { engine: { hooks: { beforeWrite: async path => { if (path === 'z2.txt') await held; } } } });
  // Another owner's apply (a background run, another conversation) writes z1, then z2 — slowly.
  const { P, base, incoming } = await workerTree(f, { 'z1.txt': 'first of another owner\n', 'z2.txt': 'second of another owner\n' });
  const other = f.engine.apply(f.project.id, { target: P, base, incoming, kind: 'background', source: { actionId: 'action-other', worktreeId: 'b-other' }, mode: 'all', labels: MERGE_LABELS.background('action-other') });
  await until(() => there(f.P, 'z1.txt'), 'the first file of the other write');
  // The direct-mode turn starts while that write is half done; its start checkpoint must not see half of it.
  f.model.steps.push(async () => { setTimeout(() => release(), 300); return { write: ['a.txt', 'turn\n'] }; }, { text: '好。' });
  const turn = await f.send(f.session.id, '写 a');
  assert.equal((await other).status, 'applied');
  assert.equal(turn.checkpoint?.state, 'taken');
  const own = await f.checkpoints.attributable(f.project.id, turn.id);
  assert.deepEqual(own.paths, ['a.txt'], 'z2.txt is the other owner\'s');
  const preview = await f.engine.rollbackTurn(f.project.id, turn.id, {});
  assert.deepEqual(preview.files.map(row => row.path), ['a.txt']);
  await f.engine.rollbackTurn(f.project.id, turn.id, { confirm: preview.confirm });
  assert.equal(read(f.P, 'z2.txt'), 'second of another owner\n', 'the other owner\'s file is not rolled back with the turn');
});

const markersIn = text => /^(<<<<<<<|>>>>>>>) refs\/rna\/m\//m.test(text);

test('a conversation left with conflict markers in its worktree (unanswered card, then archived) never brings them into P through the worktrees panel', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = (await f.rootOf(s.id)).root;
  f.model.steps.push(async () => { await f.runtime.running.get(s.id)?.startSync; put(f.P, 'a.txt', 'one\nuser-two\nthree\n'); return { writes: [['a.txt', 'one\nmodel-two\nthree\n'], ['clean.txt', 'clean\n']] }; },
    { text: '改好了。' }, { text: '还是没处理。' }, { text: '仍然没处理。' });
  const turn = await f.send(s.id, '改第二行');
  assert.equal(turn.apply.status, 'conflicted');
  assert.ok(markersIn(read(S, 'a.txt')), 'the reverse merge left its markers in S');
  // The card is never answered; the conversation is archived: S cannot apply cleanly, so it is kept.
  f.store.updateSession(s.id, { archived: true });
  await until(() => f.sessionOf(s.id).worktree.state === 'kept', 'kept');
  const record = f.recordOf(s.id);
  assert.equal(record.state, 'kept');
  // The worktrees panel offers it: the marked file is a conflict, never a write into P.
  const preview = await f.worktrees.applyWorktree(f.project.id, record.id, {});
  assert.ok(!preview.files.some(file => file.path === 'a.txt'), 'the marked file is not offered as a clean write');
  assert.ok(preview.conflicts.some(row => row.path === 'a.txt'));
  const done = await f.worktrees.applyWorktree(f.project.id, record.id, { confirm: preview.confirm });
  assert.equal(read(f.P, 'a.txt'), 'one\nuser-two\nthree\n', 'P keeps the user\'s version');
  assert.ok(!markersIn(read(f.P, 'a.txt')), 'no conflict marker in the project folder');
  assert.equal(read(f.P, 'clean.txt'), 'clean\n');
  assert.ok(done.conflicts?.some(row => row.path === 'a.txt'));
  assert.equal(f.recordOf(s.id).state, 'conflicted', 'what is left stays in the worktree');
});

test('a kept conversation worktree applied or discarded from the panel: the conversation, restored, starts again from the project folder instead of failing every turn', { skip }, async t => {
  const f = turnFixture(t);
  for (const action of ['discard', 'apply']) {
    const s = f.worktreeSession(action);
    await f.send(s.id, '开始');
    const S = (await f.rootOf(s.id)).root;
    put(S, 'a.txt', `one\n${action} S\nthree\n`); put(f.P, 'a.txt', `one\n${action} P\nthree\n`); put(S, `${action}.txt`, 'unapplied\n');
    f.store.updateSession(s.id, { archived: true });
    await until(() => f.sessionOf(s.id).worktree.state === 'kept', 'kept');
    const record = f.recordOf(s.id);
    if (action === 'discard') {
      const preview = await f.worktrees.discardWorktree(f.project.id, record.id, {});
      await f.worktrees.discardWorktree(f.project.id, record.id, { confirm: preview.confirm });
    } else {
      // The user settled the conflicting file in the project folder by hand, so the panel's apply takes the rest and removes it.
      put(S, 'a.txt', `one\n${action} P\nthree\n`);
      const preview = await f.worktrees.applyWorktree(f.project.id, record.id, {});
      await f.worktrees.applyWorktree(f.project.id, record.id, { confirm: preview.confirm });
    }
    assert.equal(f.projectRow().git.worktrees.find(row => row.id === record.id).state, 'removed');
    assert.equal(f.sessionOf(s.id).worktree.state, 'pending', 'its next turn makes a fresh copy of the project folder');
    f.store.updateSession(s.id, { archived: false });
    f.model.steps.push({ write: [`${action}-after.txt`, 'after restore\n'] }, { text: '好。' });
    const turn = await f.send(s.id, '继续');
    assert.equal(turn.status, 'completed', JSON.stringify(turn.errorCode ?? turn.failure ?? null));
    assert.equal(read(f.P, `${action}-after.txt`), 'after restore\n');
    assert.equal(f.sessionOf(s.id).worktree.state, 'active');
  }
});

test('回退 of a worktree conversation\'s turn waits while one of its applies is cut off: settled on its card first, like a single record', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  f.model.steps.push({ write: ['a.txt', 'from the conversation\n'] }, { text: '好。' });
  const turn = await f.send(s.id, '改 a');
  assert.equal(turn.apply.status, 'applied');
  const [applyId] = turn.apply.applyIds;
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).git.applies.find(row => row.id === applyId).state = 'interrupted'; });
  await assert.rejects(f.engine.rollbackTurn(f.project.id, turn.id, {}), error => error.code === 'apply_blocked');
  await assert.rejects(f.engine.rollback(f.project.id, applyId, {}), error => error.code === 'apply_blocked');
  assert.equal(read(f.P, 'a.txt'), 'from the conversation\n');
});

test('the panel\'s apply of a released background worktree merges over its own base: a project-folder change it took in and the user then undid is not brought back', { skip }, async t => {
  const f = turnFixture(t, { files: { 'f.txt': 'a\n' } });
  const P = await f.roots.rootOf({ projectId: f.project.id });
  const record = await f.worktrees.create(f.project.id, { kind: 'background', owner: { actionId: 'action-flow' }, parent: P, label: 'Rna background action-flow' });
  const B = await f.roots.rootOf({ projectId: f.project.id, actionId: 'action-flow' });
  // The user changes f.txt; the run's reverse merge takes that change into B, and its base moves to the folder's tree then.
  put(f.P, 'f.txt', 'X\n');
  put(B.root, 'f.txt', 'X\n'); put(B.root, 'g.txt', 'background work\n');
  const taken = await f.engine.snapshot(f.project.id, P);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).git.worktrees.find(row => row.id === record.id).base = taken.commit; });
  await f.engine.pin(f.project.id, [{ ref: `refs/rna/wt/${record.id}/base`, commit: taken.commit }]);
  f.worktrees.setState(f.project.id, record.id, 'conflicted'); // released to the panel
  // The user then undoes their change in the project folder.
  put(f.P, 'f.txt', 'a\n');
  const preview = await f.worktrees.applyWorktree(f.project.id, record.id, {});
  assert.deepEqual(preview.files.map(row => row.path), ['g.txt'], 'only what the background work itself changed');
  await f.worktrees.applyWorktree(f.project.id, record.id, { confirm: preview.confirm });
  assert.equal(read(f.P, 'f.txt'), 'a\n', 'the user\'s undo stands');
  assert.equal(read(f.P, 'g.txt'), 'background work\n');
});

/** A parent turn with workers (as worker-worktree.test.mjs): `work(options, task)` writes in the root the child got. */
function workerSetup(t, { work }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-flow-worker-'))), P = join(dir, 'repo');
  mkdirSync(P, { recursive: true }); writeFileSync(join(P, 'a.txt'), 'one\n');
  git(P, 'init', '-q'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'first');
  const store = new Store(join(dir, 'state', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'flow-worker-synthetic', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Flow workers', workspace: P, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const turnId = store.state.sessions.find(row => row.id === session.id).activeTurnId;
  const gitService = new WorkspaceGitService(store), engine = new IsolationEngine(store, { git: gitService, ready: true, sandbox: () => true, pollMs: 5 });
  gitService.engine = engine;
  const roots = new RootResolver(store, { git: gitService }), worktrees = new WorktreeService(store, { git: gitService, engine, roots });
  // A child that finishes with an answer (a worker that ends without one did not finish, and the host leaves it pending).
  const child = (options, messages = []) => ({ snapshot: () => ({ tools: options.readOnly ? [] : ['project_write', 'project_edit'], messages, recovery: { interrupted: false, pendingTools: 0, pendingFinish: false, uncertainTools: [] }, queue: { steering: [] }, usage: { totalTokens: 0 } }),
    async prompt(task) { messages.push({ role: 'user', source: 'user', content: task }); await work(options, task); messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' }); }, async resume() {}, async steer() {}, async dispose() {}, async abort() {} });
  const service = new BuiltinAgentService(store, { engine, roots, worktrees, factory: async options => child(options) });
  const tools = service.createTools({ sessionId: session.id, turnId });
  t.after(async () => { engine.close(); try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  const delegate = async task => JSON.parse((await tools.find(row => row.name === 'agent_delegate').execute(`call-${Math.random()}`, { task }, new AbortController().signal)).content[0].text);
  const merge = (args, signal = new AbortController().signal) => tools.find(row => row.name === 'agent_merge').execute(`merge-${Math.random()}`, args, signal);
  return { P, store, session, engine, service, delegate, merge, record: id => service.record(session.id, id) };
}

test('a worker that ends while the project folder has a git merge in progress leaves running at once (merge pending, git_operation) and is merged when the merge ends', { skip }, async t => {
  const f = workerSetup(t, { work: async ({ cwd }) => { writeFileSync(join(cwd, 'b.txt'), 'from the worker\n'); } });
  writeFileSync(join(f.P, '.git', 'MERGE_HEAD'), git(f.P, 'rev-parse', 'HEAD'));
  const handle = await f.delegate('Write b.txt.');
  await until(() => f.record(handle.agentId)?.status !== 'running' && !f.service.running.has(handle.agentId), 'the worker to settle', 10000);
  const row = f.record(handle.agentId);
  assert.notEqual(row.status, 'running', 'not left running while the user\'s merge is open');
  assert.equal(row.merge.status, 'pending'); assert.equal(row.merge.reason, 'git_operation'); assert.equal(row.merge.operation, 'merge');
  assert.equal(row.mergeAtStart, undefined);
  assert.equal(there(f.P, 'b.txt'), false, 'nothing is written into P while its merge is going on');
  assert.equal(f.service.running.size, 0); assert.equal(f.service.mergeQueues.size, 0, 'a hold keeps nothing in progress');
  // The turn-end reminder leaves it out (the host merges it itself), so no continuation is spent on a refusal.
  assert.deepEqual(f.service.pendingMerges(f.session.id), []);
  // agent_merge refuses at once instead of waiting (the turn's Stop is never stuck behind the user's merge).
  const started = Date.now();
  const refused = await f.merge({ agentId: handle.agentId });
  assert.ok(Date.now() - started < 5000);
  assert.equal(refused.isError, true); assert.equal(refused.details.code, 'git_operation_in_progress');
  assert.match(JSON.parse(refused.content[0].text).error, /A git merge is in progress in the project folder/);
  // The merge ends: the host merges the worker by itself.
  rmSync(join(f.P, '.git', 'MERGE_HEAD'));
  await until(() => f.record(handle.agentId).merge.status === 'merged', 'merged once the user\'s merge ended', 20000);
  assert.equal(read(f.P, 'b.txt'), 'from the worker\n');
  const closed = await Promise.race([f.service.close().then(() => 'closed'), new Promise(done => setTimeout(() => done('hung'), 5000))]);
  assert.equal(closed, 'closed');
});

test('C2: a held worker merge whose resume fails for another reason stops promising an automatic merge: pending with that reason, W kept, listed for the turn end, mergeable later', { skip }, async t => {
  const f = workerSetup(t, { work: async ({ cwd }) => { writeFileSync(join(cwd, 'b.txt'), 'from the worker\n'); } });
  writeFileSync(join(f.P, '.git', 'MERGE_HEAD'), git(f.P, 'rev-parse', 'HEAD'));
  const handle = await f.delegate('Write b.txt.');
  await until(() => f.record(handle.agentId)?.merge?.reason === 'git_operation' && !f.service.running.has(handle.agentId), 'the worker held on the merge', 10000);
  const worktreeId = f.record(handle.agentId).worktree.id;
  // The parent's root cannot be resolved when the merge ends (as when its conversation worktree is pending again).
  const rootOf = f.service.roots.rootOf.bind(f.service.roots);
  let broken = true;
  f.service.roots.rootOf = async input => { if (broken && !input.agentId) throw Object.assign(new Error('The conversation worktree is not ready.'), { code: 'worktree_pending' }); return rootOf(input); };
  rmSync(join(f.P, '.git', 'MERGE_HEAD'));
  await until(() => f.record(handle.agentId).merge.reason !== 'git_operation', 'the resumed merge settled', 20000);
  const row = f.record(handle.agentId);
  assert.equal(row.merge.status, 'pending'); assert.equal(row.merge.reason, 'worktree_pending'); assert.equal(row.merge.operation, undefined);
  assert.equal(f.store.state.projects[0].git.worktrees.find(item => item.id === worktreeId).state, 'kept', 'W stays for agent_merge');
  assert.equal(there(f.P, 'b.txt'), false);
  assert.equal(f.service.mergeQueues.size, 0);
  // The turn end lists it again, and the model's note no longer says the host merges it by itself.
  assert.deepEqual(f.service.pendingMerges(f.session.id).map(item => [item.agentId, item.status]), [[handle.agentId, 'pending']]);
  const view = JSON.parse((await f.service.createTools({ sessionId: f.session.id, turnId: row.turnId }).find(tool => tool.name === 'agent_status').execute('status', { agentId: handle.agentId }, new AbortController().signal)).content[0].text);
  assert.match(view.mergeNote, /The host has not merged its changes \(worktree_pending\)/);
  // Once the root is back, agent_merge merges it.
  broken = false;
  const merged = JSON.parse((await f.merge({ agentId: handle.agentId })).content[0].text);
  assert.equal(merged.status, 'merged'); assert.equal(read(f.P, 'b.txt'), 'from the worker\n');
});

test('C4: a held worker merge the host resumes after the git operation is awaited by close() while it writes into the parent\'s files', { skip }, async t => {
  const f = workerSetup(t, { work: async ({ cwd }) => { writeFileSync(join(cwd, 'b.txt'), 'from the worker\n'); } });
  writeFileSync(join(f.P, '.git', 'MERGE_HEAD'), git(f.P, 'rev-parse', 'HEAD'));
  const handle = await f.delegate('Write b.txt.');
  await until(() => f.record(handle.agentId)?.merge?.reason === 'git_operation' && !f.service.running.has(handle.agentId), 'the worker held on the merge', 10000);
  // The resumed merge's write into P is part way when the service is asked to stop.
  let entered, release; const writing = new Promise(done => { entered = done; }), gate = new Promise(done => { release = done; });
  f.engine.settings.hooks = { beforeWrite: async () => { entered(); await gate; } };
  rmSync(join(f.P, '.git', 'MERGE_HEAD'));
  await writing;
  assert.equal(f.service.running.size, 0, 'the worker itself left running when it was held');
  assert.equal(f.service.mergeQueues.size, 1, 'the resumed merge is a host merge action in progress');
  const closing = f.service.close();
  assert.equal(await Promise.race([closing.then(() => 'closed'), new Promise(done => setTimeout(() => done('waiting'), 300))]), 'waiting', 'close() waits for the write');
  release();
  await closing;
  f.engine.settings.hooks = null;
  assert.equal(f.service.mergeQueues.size, 0);
  assert.equal(f.record(handle.agentId).merge.status, 'merged'); assert.equal(read(f.P, 'b.txt'), 'from the worker\n');
});

test('C4: host merge actions in progress count as the daemon\'s active work (maintenance drain, supervisor liveness)', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-flow-merging-')));
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, runtime: true, initiative: false });
  let release; const gate = new Promise(done => { release = done; });
  t.after(async () => { release(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(app.health().workload.activeWork, false);
  const merging = app.builtinAgentService.serialAgent('agent-resumed', () => gate);
  assert.equal(app.health().workload.activeWork, true, 'a merge the host resumed after a git operation keeps the daemon busy');
  release(); await merging;
  assert.equal(app.health().workload.activeWork, false);
});

test('a background run settled while the project folder has a git rebase in progress is held at once (git_operation), and settles once the rebase ends', { skip }, async t => {
  const f = turnFixture(t);
  const background = new BackgroundWorktrees(f.store, { engine: f.engine, worktrees: f.worktrees, roots: f.roots });
  const bg = await background.open(f.project.id, 'action-rebase', { label: 'Rna background action-rebase' });
  put(bg.root.root, 'b.txt', 'from the background run\n');
  mkdirSync(join(f.repo, '.git', 'rebase-merge'), { recursive: true });
  const outcome = await Promise.race([background.settle(bg, { completed: false }), new Promise(done => setTimeout(() => done('hung'), 5000))]);
  assert.deepEqual(outcome, { status: 'held', reason: 'git_operation', operation: 'rebase', cleanOnly: true }, 'held, never waited for');
  assert.equal(there(f.P, 'b.txt'), false, 'nothing written while the rebase is open');
  assert.equal(f.projectRow().git.worktrees.find(row => row.id === bg.worktreeId).state, 'active', 'B stays for the retry');
  // Its finish hook holds the same way: the run finishes at once.
  assert.equal(await background.finish(bg, { message: { role: 'assistant' }, remainingContinuations: 2 }), undefined);
  assert.equal(bg.outcome.status, 'held'); assert.equal(bg.outcome.reason, 'git_operation');
  rmSync(join(f.repo, '.git', 'rebase-merge'), { recursive: true, force: true });
  assert.equal((await background.settle(bg, { completed: false })).status, 'applied');
  assert.equal(read(f.P, 'b.txt'), 'from the background run\n');
});

test('work a store listener starts while a repository write holds the lock (a card answer, a deferred background apply) still queues behind it', { skip }, async t => {
  let release = null; const held = new Promise(done => { release = done; });
  const f = engineFixture(t, { engine: { hooks: { beforeWrite: async () => { await held; } } } });
  const order = [];
  let armed = true;
  // As SessionWorktreeService.scan, the engine's card watcher and the initiative's git upkeep do: react to a state
  // change with work scheduled for later.
  const unsubscribe = f.store.subscribe(() => { if (!armed) return; armed = false; setImmediate(() => { void f.engine.lock(f.project.id, async () => { order.push(there(f.workspace, 'new.txt') ? 'listener work after the write' : 'listener work inside the write'); }); }); });
  t.after(unsubscribe);
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const incoming = await f.engine.compose(f.project.id, seed.commit, [{ path: 'new.txt', mode: '100644', oid: execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, input: 'new\n', encoding: 'utf8' }).trim() }]);
  const writing = f.engine.apply(f.project.id, { target: f.root, base: seed.commit, incoming, kind: 'worker', source: { agentId: 'agent-lock' }, mode: 'all', labels: MERGE_LABELS.worker('agent-lock') }).then(outcome => { order.push('apply done'); return outcome; });
  await until(() => !armed, 'the write to persist its record (a state change inside the lock)');
  await new Promise(done => setTimeout(done, 200));
  assert.deepEqual(order, [], 'the listener\'s work waits for the lock');
  release();
  assert.equal((await writing).status, 'applied');
  await until(() => order.includes('apply done') && order.length === 2, 'the listener\'s work');
  assert.ok(order.includes('listener work after the write'), JSON.stringify(order));
});

// ---- git init end to end on folders shaped like the user's three projects, then a direct-mode turn (gate closed) ----

const flowScratch = realpathSync(mkdtempSync(join(tmpdir(), 'rna-isolation-flows-')));
process.on('exit', () => { try { rmSync(flowScratch, { recursive: true, force: true }); } catch { /* best effort */ } });
const writeAt = (root, path, content = `${path}\n`) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const sparse = (root, path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), ''); truncateSync(join(root, path), bytes); };
const plainGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const MB = 1024 * 1024;
const plainGitSafe = folder => { try { return plainGit(folder, 'rev-parse', '--show-toplevel').trim(); } catch { return null; } };

/** A daemon on scratch state (gate closed as shipped), a scripted model, and the user's identity in a scratch global config. */
async function daemon(t) {
  const directory = realpathSync(mkdtempSync(join(flowScratch, 'daemon-'))), global = join(directory, 'gitconfig');
  writeFileSync(global, '[user]\n\tname = Flow User\n\temail = flow@example.com\n');
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: global, XDG_CONFIG_HOME: join(directory, 'xdg') });
  const model = scripted();
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, runtime: true, initiative: false, runtimeFactory: options => createRnaRuntime({ ...options, provider: model.provider }) });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); Object.assign(process.env, saved); });
  const provider = app.store.configurationService.provider(null, { name: 'Flow', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'flow-synthetic-key', models: [{ id: 'flow-model', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'flow-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const port = app.server.address().port;
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (promise, status = 200) => { const answer = await promise; assert.equal(answer.status, status, JSON.stringify(answer.body)); return answer.body; };
  const project = (name, build) => {
    const folder = join(directory, name); mkdirSync(folder, { recursive: true }); build(folder);
    const created = app.store.createProject({ name, workspace: folder, initiative: { enabled: false } });
    app.store.mutate(state => applyProjectPermissions(state, created.project.id, { workspace: 'execute', background: 'read' }));
    return { folder, ...created };
  };
  /** Preview then confirm, like GitInitDialog; answers both. */
  const init = async (projectId, extra = {}) => {
    const preview = await ok(call('POST', `/api/v2/projects/${projectId}/git/init`, {}));
    const result = await ok(call('POST', `/api/v2/projects/${projectId}/git/init`, { confirm: preview.confirm, ...(preview.needsAcknowledge ? { acknowledgeLarge: true } : {}), ...extra }));
    return { preview, result };
  };
  return { app, model, call, ok, project, init, directory };
}
const texts = preview => preview.gitignore.lines.map(line => line.text);
const tracked = folder => plainGit(folder, 'ls-files', '-z').split('\0').filter(Boolean).sort();

test('git init on a novel project with large .txt attachments: content folders named out/ and build/ stay, the big attachment is ignored by its exact path', { skip }, async t => {
  const d = await daemon(t);
  const novel = d.project('测试文本生成', root => {
    for (let chapter = 1; chapter <= 12; chapter++) writeAt(root, `正文/第${String(chapter).padStart(2, '0')}章.md`, `# 第${chapter}章\n${'夜色很深。'.repeat(200)}\n`);
    writeAt(root, '大纲.md', '# 大纲\n至少 30 章\n');
    writeAt(root, 'out/人物小传.md', '这是内容，不是构建产物\n'); writeAt(root, 'build/世界观.md', '同样是内容\n');
    writeAt(root, 'attachments/设定集.txt', '设定\n'.repeat(4096));
    sparse(root, 'attachments/参考资料 全集.txt', 60 * MB);
    writeAt(root, '.DS_Store', 'finder\n'); writeAt(root, '正文/.DS_Store', 'finder\n');
  });
  const before = plainGitSafe(novel.folder);
  assert.equal(before, null, 'not a repository yet');
  const { preview, result } = await d.init(novel.project.id);
  assert.deepEqual(texts(preview), ['.DS_Store', '.env*', 'node_modules/', '/attachments/参考资料 全集.txt']);
  assert.deepEqual(preview.largeFiles, [{ path: 'attachments/参考资料 全集.txt', bytes: 60 * MB }]);
  assert.equal(result.status, 'clean');
  const files = tracked(novel.folder);
  assert.ok(files.includes('out/人物小传.md') && files.includes('build/世界观.md'), 'no marker file: out/ and build/ are content');
  assert.ok(files.includes('attachments/设定集.txt'));
  assert.ok(!files.includes('attachments/参考资料 全集.txt') && !files.some(path => path.endsWith('.DS_Store')));
  assert.equal(files.length, preview.files.count, 'the first commit holds exactly what the preview listed');
  assert.equal(plainGit(novel.folder, 'status', '--porcelain'), '');
  assert.equal(d.app.store.state.projects.find(row => row.id === novel.project.id).git.init.commit, result.commit);
  assert.deepEqual(d.app.store.state.projects.find(row => row.id === novel.project.id).git.init.largeFiles, ['attachments/参考资料 全集.txt']);
});

test('git init on a JS game with node_modules, a build and a dev cache: the package.json lines keep them out; on a research project with data, media, a venv and a nested repository likewise', { skip }, async t => {
  const d = await daemon(t);
  const game = d.project('game_test', root => {
    writeAt(root, 'package.json', '{ "name": "game", "scripts": { "dev": "vite" } }\n'); writeAt(root, 'package-lock.json', '{}\n');
    writeAt(root, 'index.html', '<canvas></canvas>\n'); writeAt(root, 'src/main.js', 'console.log(1);\n'); writeAt(root, 'public/assets/sprite.png', 'PNG\0binary\n');
    for (let index = 0; index < 1500; index++) writeAt(root, `node_modules/pkg${index % 50}/file${index}.js`, 'module.exports = 1;\n');
    writeAt(root, 'dist/bundle.js', 'built\n'); writeAt(root, '.vite/deps/cache.json', '{}\n'); writeAt(root, '.env.local', 'SECRET=synthetic\n'); writeAt(root, 'debug.log', 'log\n');
  });
  const { preview: gamePreview, result: gameResult } = await d.init(game.project.id);
  for (const line of ['node_modules/', 'dist/', '.vite/', '*.log', '.env*']) assert.ok(texts(gamePreview).includes(line), line);
  assert.equal(gamePreview.gitignore.lines.find(line => line.text === 'node_modules/').count, 1500);
  assert.equal(gameResult.status, 'clean');
  assert.deepEqual(tracked(game.folder), ['.gitignore', 'index.html', 'package-lock.json', 'package.json', 'public/assets/sprite.png', 'src/main.js']);

  const research = d.project('Ai 应用调研项目', root => {
    writeAt(root, 'requirements.txt', 'pandas\n'); writeAt(root, 'notebooks/分析.ipynb', '{"cells": []}\n'); writeAt(root, 'data/调研.csv', 'a,b\n1,2\n');
    sparse(root, 'data/全部样本.parquet', 70 * MB); sparse(root, 'media/访谈录像.mp4', 120 * MB); writeAt(root, 'media/封面.jpg', 'JPEG\0\n');
    writeAt(root, '.venv/pyvenv.cfg', 'home = /usr/bin\n'); writeAt(root, '.venv/lib/site.py', 'x\n'); writeAt(root, 'src/__pycache__/m.cpython-312.pyc', 'pyc\n'); writeAt(root, 'src/m.py', 'x = 1\n');
    mkdirSync(join(root, 'vendor/tool'), { recursive: true }); plainGit(join(root, 'vendor/tool'), 'init', '-q'); writeAt(join(root, 'vendor/tool'), 'README', 'nested\n');
    plainGit(join(root, 'vendor/tool'), 'add', '-A'); plainGit(join(root, 'vendor/tool'), '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'nested');
  });
  const { preview, result } = await d.init(research.project.id);
  // requirements.txt brings .venv/ itself, so the venv needs no exact line of its own.
  for (const line of ['__pycache__/', '*.pyc', '.venv/', '/data/全部样本.parquet', '/media/访谈录像.mp4', '/vendor/tool/']) assert.ok(texts(preview).includes(line), line);
  assert.equal(result.status, 'clean');
  assert.deepEqual(tracked(research.folder), ['.gitignore', 'data/调研.csv', 'media/封面.jpg', 'notebooks/分析.ipynb', 'requirements.txt', 'src/m.py']);
  assert.equal(plainGit(research.folder, 'status', '--porcelain'), '');
  assert.equal(plainGit(research.folder, 'remote'), '', 'no remote is ever added');
});

test('after git init, a direct-mode turn on the shipped daemon (gate closed) has a checkpoint: 回退本轮 and 撤销回退 over HTTP, commands\' writes included, the user\'s index untouched', { skip }, async t => {
  const d = await daemon(t);
  const novel = d.project('测试文本生成', root => {
    writeAt(root, '正文/第01章.md', '# 第1章\n开头\n'); writeAt(root, '大纲.md', '# 大纲\n');
    sparse(root, 'attachments/参考资料 全集.txt', 60 * MB);
  });
  await d.init(novel.project.id);
  plainGit(novel.folder, 'add', '大纲.md'); // a staged entry of the user's own, which no Rna write may touch
  const staged = plainGit(novel.folder, 'diff', '--cached', '--name-only');
  d.model.steps.push({ write: ['正文/第01章.md', '# 第1章\n开头\n第二段。\n'] }, { exec: "printf '新章\\n' > '正文/第02章.md'" }, { text: '写好了。' });
  const sessionId = novel.session.id;
  d.app.store.message(sessionId, { text: '续写' });
  const turnId = d.app.store.state.sessions.find(row => row.id === sessionId).activeTurnId;
  const turnOf = () => d.app.store.state.sessions.find(row => row.id === sessionId).turns.find(row => row.id === turnId);
  await until(() => turnOf()?.status === 'completed' && turnOf()?.checkpoint && !d.app.executor.handBacks.has(sessionId), 'the turn and its end checkpoint');
  const { endedAt, ...checkpoint } = turnOf().checkpoint;
  assert.deepEqual(checkpoint, { ref: `refs/rna/turn/${turnId}`, state: 'taken' }, 'checkpoints ship with the gate closed');
  assert.ok(Number.isFinite(Date.parse(endedAt)), 'the attempt\'s end is recorded');
  assert.equal(read(novel.folder, '正文/第02章.md'), '新章\n');
  const preview = await d.ok(d.call('POST', `/api/v2/projects/${novel.project.id}/turns/${turnId}/rollback`, {}));
  assert.deepEqual(preview.files.map(row => [row.path, row.action]).sort(), [['正文/第01章.md', 'restore'], ['正文/第02章.md', 'delete']]);
  const done = await d.ok(d.call('POST', `/api/v2/projects/${novel.project.id}/turns/${turnId}/rollback`, { confirm: preview.confirm }));
  assert.equal(read(novel.folder, '正文/第01章.md'), '# 第1章\n开头\n'); assert.equal(there(novel.folder, '正文/第02章.md'), false);
  // 撤销回退: the web finds the rollback record by the turn and rolls it back.
  const { applies } = await d.ok(d.call('GET', `/api/v2/projects/${novel.project.id}/applies?turnId=${turnId}`));
  const rollback = applies.find(row => row.kind === 'rollback' && row.undoesTurn === turnId);
  assert.equal(rollback?.id, done.applyId); assert.equal(rollback.rollback.available, true);
  const undo = await d.ok(d.call('POST', `/api/v2/projects/${novel.project.id}/applies/${rollback.id}/rollback`, {}));
  await d.ok(d.call('POST', `/api/v2/projects/${novel.project.id}/applies/${rollback.id}/rollback`, { confirm: undo.confirm }));
  assert.equal(read(novel.folder, '正文/第01章.md'), '# 第1章\n开头\n第二段。\n'); assert.equal(read(novel.folder, '正文/第02章.md'), '新章\n');
  const after = (await d.ok(d.call('GET', `/api/v2/projects/${novel.project.id}/applies?turnId=${turnId}`))).applies;
  assert.equal(after.find(row => row.id === rollback.id).state, 'rolled_back', 'the rollback itself shows as undone');
  // 回退本轮 again after the undo works the same way.
  const again = await d.ok(d.call('POST', `/api/v2/projects/${novel.project.id}/turns/${turnId}/rollback`, {}));
  assert.deepEqual(again.files.map(row => row.path).sort(), ['正文/第01章.md', '正文/第02章.md']);
  assert.equal(plainGit(novel.folder, 'diff', '--cached', '--name-only'), staged, 'the user\'s staged entries are unchanged');
  assert.ok(plainGit(novel.folder, 'branch', '--list').includes('main'));
  assert.deepEqual(d.app.store.state.projects.find(row => row.id === novel.project.id).git.worktrees, [], 'no worktree with the gate closed');
});
