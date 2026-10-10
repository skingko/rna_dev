import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { SessionWorktreeService } from '../session-worktree-service.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { IsolationEngine, HOST_CARDS, LIMITS, MERGE_LABELS } from '../git-isolation/index.mjs';
import { turnFixture, git as turnGit } from './helpers/turn-fixture.mjs';
import { applyWaiting } from '../project-mind.mjs';

// The user's git operation in a project folder (a merge, rebase, cherry-pick, revert or bisect left open) is held on,
// never waited for (review ISO-1 and its two missed findings): background change sets, card answers, a conversation's
// hand-back / idle / startup applies and interactive agent_merge calls do not stall, one project never holds another,
// and everything held goes on once the operation ends. ISO-2: agent_merge drop of a background change set merged into
// a conversation's own worktree takes it back out of that worktree. Real temporary repositories and the real merge
// engine; scripted runs and models only (no network, no paid model).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitVersionOk = (() => { try { const [, major, minor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })); return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38); } catch { return false; } })();
const skip = gitVersionOk ? false : 'git 2.38 or later is needed';
const put = (root, path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const read = (root, path) => readFileSync(join(root, path), 'utf8');
async function until(check, label = 'condition', ms = 30000) { const deadline = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(10); } }
const FILES = { 'notes.md': 'one\ntwo\nthree\n', 'other.md': 'alpha\n', '.gitignore': 'dist/\n' };
const decision = input => ({ action: 'wait', content: '', evidenceIds: [input.events.at(-1).id], reason: 'Observed a concrete project fact', nextReviewAfterMs: 600000 });
const decisions = async function* (options) { const input = JSON.parse(options.messages[0].content[0].text); yield { type: 'text_delta', delta: JSON.stringify(decision(input)) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; };
/** Leave a git operation open in a project folder, as an unfinished `git merge` or `git rebase` does. */
const begin = (P, operation = 'merge') => { if (operation === 'merge') writeFileSync(join(P, '.git', 'MERGE_HEAD'), git(P, 'rev-parse', 'HEAD')); else mkdirSync(join(P, '.git', 'rebase-merge'), { recursive: true }); };
const end = (P, operation = 'merge') => rmSync(join(P, '.git', operation === 'merge' ? 'MERGE_HEAD' : 'rebase-merge'), { recursive: true, force: true });

/**
 * Background work in several projects (one git repository each) sharing one store, merge engine, root resolver,
 * worktree service, card service, session worktree service and initiative controller, as the daemon wires them.
 */
async function fixture(t, { names = ['A', 'B'] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-gitop-')));
  const store = new Store(join(dir, 'state', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Held fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const projects = [];
  for (const name of names) {
    const P = join(dir, name);
    mkdirSync(P);
    for (const [path, content] of Object.entries(FILES)) put(P, path, content);
    git(P, 'init', '-q'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'first');
    const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: `Held ${name}`, description: 'Keep the notes current', workspace: P, initiative: { cooldownMs: 0, enabled: false } });
    store.mutate(state => {
      const target = state.projects.find(row => row.id === project.id);
      Object.assign(target, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, overview: 'Notes', permissions: { workspace: 'execute', background: 'inherit', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } });
      target.initiative.tokenBudget = 100000; state.settings.realTokenBudget = 200000;
      target.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] };
    });
    const context = { projectId: project.id, coordinator: { model: { providerId: provider.id, modelId: 'fixture-model', name: 'Fixture' }, state: { actions: [] }, active: new Map(), _executionBlocked: () => false }, workRuns: new Map(), activeHandles: new Set() };
    projects.push({ name, P, project, session, context });
  }
  const service = new WorkspaceGitService(store);
  const engine = new IsolationEngine(store, { git: service, ready: true, sandbox: () => true, pollMs: 20, execWaitMs: 100, freePollMs: 250 });
  service.engine = engine;
  const roots = new RootResolver(store, { git: service });
  const worktrees = new WorktreeService(store, { git: service, engine, roots });
  service.owners = path => worktrees.ownerOf(path);
  const interactions = new UserInteractionService(store);
  const sessionWorktrees = new SessionWorktreeService(store, { engine, worktrees, roots, interactions });
  const evolutionService = new ProjectEvolutionService(store, { provider: decisions });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, interactionService: interactions, evolutionService, decisionProvider: decisions, engine, worktrees, roots });
  t.after(async () => { await controller.close(); sessionWorktrees.close(); interactions.close?.(); engine.close(); rmSync(dir, { recursive: true, force: true }); });
  await until(() => controller.gitRecovered === true, 'startup pass');
  const current = p => store.state.projects.find(row => row.id === p.project.id);
  const rows = p => (current(p).backgroundChanges ?? []).filter(row => row.kind === 'git');
  const row = (p, actionId) => rows(p).find(item => item.actionId === actionId);
  const items = (p, sessionId = p.session.id) => store.state.sessions.find(item => item.id === sessionId).items;
  const lineOf = (p, changeId) => store.state.sessions.flatMap(session => session.items).find(item => item.initiative?.backgroundChange === changeId);
  return { dir, store, projects, service, engine, roots, worktrees, interactions, sessionWorktrees, controller, current, rows, row, items, lineOf };
}
/** The SDK's finish loop for a scripted run: the host hook until it accepts. */
async function finishLoop(f, p, action, bg, { max = LIMITS.backgroundFinishContinuations } = {}) {
  for (let continuations = 0; ; continuations++) {
    const answer = await f.controller.finishGitRun(p.context, action, bg, { message: { role: 'assistant' }, continuations, remainingContinuations: max - continuations });
    if (!answer) return;
  }
}
/** One writing background run of project `p` in its own worktree: `script(root, { finish })` stands in for the model. */
async function run(f, p, id, script) {
  f.controller.work = async (context, action, input) => {
    context.workRuns.set(action.id, { writable: true, isolated: Boolean(input.bg) });
    try { return await script(input.bg.root.root, { finish: options => finishLoop(f, p, action, input.bg, options) }); }
    finally { context.workRuns.delete(action.id); }
  };
  return f.controller.recordedWork(p.context, { id, action: 'work', content: 'Edit the notes' }, { signal: new AbortController().signal });
}
/** A run whose change to notes.md conflicts with the user's change to the same line: it ends on the card. */
const conflicting = (f, p, id) => run(f, p, id, async (root, { finish }) => {
  put(root, 'notes.md', `one\ntwo (${id})\nthree\n`); put(root, `${id}.md`, `${id}\n`);
  put(p.P, 'notes.md', `one\ntwo (user before ${id})\nthree\n`);
  await finish({ max: 0 });
  return { summary: 'Done.' };
});
const answerCard = (f, row, choice) => f.interactions.answer(row.card.sessionId, row.card.interactionId, { requestId: `answer-${choice}-${row.id}`.slice(0, 150), answers: [{ id: 'decision', selected: [choice] }] });

test('a background run that finishes during the user\'s git merge is held at once (git_operation), says why in the interface language, and is applied when the merge ends', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, { names: ['A'] });
  const [a] = f.projects;
  begin(a.P, 'merge');
  const started = Date.now();
  await run(f, a, 'act-held', async (root, { finish }) => { put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); await finish(); return { summary: 'Done.', reported: '改了第二行。' }; });
  assert.ok(Date.now() - started < 15000, 'the run finished without waiting for the merge');
  const held = f.row(a, 'act-held');
  assert.equal(held.status, 'deferred'); assert.equal(held.hold, 'git_operation'); assert.equal(held.operation, 'merge');
  assert.equal(held.retryAt, undefined, 'no timer: the git directory is watched');
  assert.equal(read(a.P, 'notes.md'), FILES['notes.md'], 'nothing written during the merge');
  assert.equal(a.context.workRuns.size, 0); assert.equal(a.context.activeHandles.size, 0);
  assert.match(f.lineOf(a, held.id).text, /^改了第二行。\n\n项目文件夹正在进行 git merge，改动先留在它自己的工作副本里，等这个操作结束后再应用到项目文件夹。$/);
  assert.equal(f.engine.waitingFree(a.project.id), true);
  // The line follows the interface language.
  f.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  assert.match(f.controller.gitChangeText(f.current(a), { id: held.actionId, title: held.task }, f.row(a, 'act-held')), /A git merge is in progress in the project folder, so its changes wait in its own working copy and are applied to the project folder once that operation ends\.$/);
  f.store.mutate(state => { state.settings.interfaceLanguage = 'zh'; });
  // Upkeep passes while the merge is open never write and never wait.
  const pass = Date.now(); await f.controller.gitUpkeep();
  assert.ok(Date.now() - pass < 5000); assert.equal(f.row(a, 'act-held').status, 'deferred');
  end(a.P, 'merge');
  await until(() => f.row(a, 'act-held').status === 'kept', 'applied once the merge ended');
  assert.equal(read(a.P, 'notes.md'), 'one\ntwo (background)\nthree\n');
  const kept = f.row(a, 'act-held');
  assert.equal(kept.hold, undefined); assert.equal(kept.operation, undefined); assert.ok(kept.applyId);
  assert.match(f.lineOf(a, kept.id).text, /^改了第二行。\n\n改了 1 个文件/);
});

test('one project\'s leftover git merge never holds another: B\'s deferred set and card answer go through, A\'s card answer and set wait for A\'s merge', { skip, timeout: 120000 }, async t => {
  const f = await fixture(t);
  const [a, b] = f.projects;
  // A: a set on its conflict card (made before the merge began), then a set finished during the merge.
  await conflicting(f, a, 'act-a-card');
  assert.equal(f.row(a, 'act-a-card').status, 'merge_conflicted');
  begin(a.P, 'merge');
  await run(f, a, 'act-a-held', async (root, { finish }) => { put(root, 'held.md', 'held in A\n'); await finish(); return { summary: 'Done.' }; });
  assert.equal(f.row(a, 'act-a-held').hold, 'git_operation');
  // A's card is answered during its merge: not carried out, the line says so, the answer stays on the card.
  answerCard(f, f.row(a, 'act-a-card'), 'clean_only');
  await until(() => /项目文件夹正在进行 git merge，等它结束后再按你的选择应用。$/.test(f.lineOf(a, f.row(a, 'act-a-card').id)?.text ?? ''), 'A\'s held answer');
  assert.equal(f.row(a, 'act-a-card').status, 'merge_conflicted'); assert.equal(f.row(a, 'act-a-card').answer, undefined);
  assert.equal(existsSync(join(a.P, 'act-a-card.md')), false);
  // B: a conflict whose card is answered, and a set deferred by a direct-mode turn that then ends.
  await conflicting(f, b, 'act-b-card');
  answerCard(f, f.row(b, 'act-b-card'), 'clean_only');
  await until(() => f.row(b, 'act-b-card').status === 'kept', 'B\'s answer carried out during A\'s merge');
  assert.equal(read(b.P, 'act-b-card.md'), 'act-b-card\n');
  f.store.message(b.session.id, { text: 'Rewrite the summary in the conversation.' });
  await run(f, b, 'act-b-deferred', async (root, { finish }) => { put(root, 'deferred.md', 'deferred in B\n'); await finish(); return { summary: 'Done.' }; });
  assert.equal(f.row(b, 'act-b-deferred').status, 'deferred'); assert.equal(f.row(b, 'act-b-deferred').hold, 'deferred');
  f.store.finishRuntimeTurn(b.session.id, f.store.state.sessions.find(row => row.id === b.session.id).activeTurnId);
  await until(() => f.row(b, 'act-b-deferred').status === 'kept', 'B\'s deferred set applied during A\'s merge');
  assert.equal(read(b.P, 'deferred.md'), 'deferred in B\n');
  // A full upkeep pass answers promptly although A's merge is still open.
  const pass = Date.now(); await f.controller.gitUpkeep();
  assert.ok(Date.now() - pass < 5000, 'the upkeep did not wait for A');
  assert.equal(existsSync(join(a.P, 'held.md')), false); assert.equal(f.row(a, 'act-a-card').status, 'merge_conflicted');
  // A's merge ends: both of A's go on.
  end(a.P, 'merge');
  await until(() => f.row(a, 'act-a-held').status === 'kept' && f.row(a, 'act-a-card').status === 'kept', 'A once its merge ended');
  assert.equal(read(a.P, 'held.md'), 'held in A\n'); assert.equal(read(a.P, 'act-a-card.md'), 'act-a-card\n');
  assert.equal(read(a.P, 'notes.md'), 'one\ntwo (user before act-a-card)\nthree\n', 'the conflicting file kept the user\'s version');
});

test('C1/X4: while a deferred set waits for a direct-mode turn or plan mode, store changes start no git process; the operation is checked only when something can change it', { skip, timeout: 120000 }, async t => {
  const f = await fixture(t, { names: ['A'] });
  const [a] = f.projects;
  // Every check of the user's git operation goes through the engine's projectBusy (git rev-parse plus the markers).
  let probes = 0;
  const projectBusy = f.engine.projectBusy.bind(f.engine);
  f.engine.projectBusy = async projectId => { probes++; return projectBusy(projectId); };
  const passes = async count => { for (let index = 0; index < count; index++) { f.store.mutate(state => { state.projects.find(row => row.id === a.project.id).overview = `Notes ${index}`; }); await f.controller.gitUpkeep(); } };
  // A direct-mode turn holds the folder: the finished run's set is deferred.
  f.store.message(a.session.id, { text: 'Rewrite the summary in the conversation.' });
  await run(f, a, 'act-direct', async (root, { finish }) => { put(root, 'direct.md', 'after the turn\n'); await finish(); return { summary: 'Done.' }; });
  assert.equal(f.row(a, 'act-direct').status, 'deferred'); assert.equal(f.row(a, 'act-direct').hold, 'deferred');
  probes = 0;
  await passes(30);
  assert.equal(probes, 0, 'no git process per store change while the turn holds the folder');
  // The turn ends during the user's merge: one check names the operation, the engine's watch waits from then on.
  begin(a.P, 'merge');
  f.store.finishRuntimeTurn(a.session.id, f.store.state.sessions.find(row => row.id === a.session.id).activeTurnId);
  await until(() => f.row(a, 'act-direct').hold === 'git_operation', 'held on the merge once the turn ended');
  assert.equal(f.row(a, 'act-direct').operation, 'merge');
  await passes(1);
  const named = probes;
  assert.ok(named >= 1 && named <= 2, `the operation was checked when the folder became free (${named})`);
  // Plan mode holds the folder too, the merge still open: passes ask nothing (the watch waits).
  f.store.mutate(state => { state.sessions.find(row => row.id === a.session.id).mode = 'plan'; });
  await passes(30);
  assert.equal(probes, named, 'the watch answers while it waits');
  // The merge ends while plan mode holds the folder: the watch's own pass checks once and the set says what holds it now.
  end(a.P, 'merge');
  await until(() => f.row(a, 'act-direct').hold === 'deferred', 'held by plan mode once the merge ended');
  assert.equal(f.row(a, 'act-direct').operation, undefined);
  assert.equal(f.row(a, 'act-direct').status, 'deferred'); assert.equal(existsSync(join(a.P, 'direct.md')), false);
  await passes(1);
  const reheld = probes;
  assert.ok(reheld - named >= 1 && reheld - named <= 2, `one check when the watch saw the merge end (${reheld - named})`);
  await passes(30);
  assert.equal(probes, reheld, 'no git process per store change while plan mode holds the folder');
  // Plan mode ends: the folder is free, one check before the write, and the set is applied.
  f.store.mutate(state => { state.sessions.find(row => row.id === a.session.id).mode = 'build'; });
  await until(() => f.row(a, 'act-direct').status === 'kept', 'applied once plan mode ended');
  assert.equal(read(a.P, 'direct.md'), 'after the turn\n');
  assert.ok(probes > reheld, 'the write was preceded by a check');
});

test('C1/X4: a deferred set whose apply fails is tried again at its retry time, not on every store change', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, { names: ['A'] });
  const [a] = f.projects;
  let probes = 0, settles = 0;
  const projectBusy = f.engine.projectBusy.bind(f.engine);
  f.engine.projectBusy = async projectId => { probes++; return projectBusy(projectId); };
  f.store.message(a.session.id, { text: 'Rewrite the summary in the conversation.' });
  await run(f, a, 'act-failing', async (root, { finish }) => { put(root, 'failing.md', 'applied at last\n'); await finish(); return { summary: 'Done.' }; });
  assert.equal(f.row(a, 'act-failing').hold, 'deferred');
  // The engine fails the apply (a lock timeout, a full disk): the set stays deferred with a retry time.
  const settle = f.controller.background.settle.bind(f.controller.background);
  f.controller.background.settle = async () => { settles++; throw Object.assign(new Error('engine failed'), { code: 'engine_failed' }); };
  f.store.finishRuntimeTurn(a.session.id, f.store.state.sessions.find(row => row.id === a.session.id).activeTurnId);
  await until(() => settles === 1 && f.row(a, 'act-failing').retryAt > Date.now(), 'the failed apply waits for its retry time');
  probes = 0;
  for (let index = 0; index < 30; index++) { f.store.mutate(state => { state.projects.find(row => row.id === a.project.id).overview = `Notes ${index}`; }); await f.controller.gitUpkeep(); }
  assert.equal(settles, 1, 'not retried on every store change'); assert.equal(probes, 0, 'no git process per store change');
  assert.equal(f.row(a, 'act-failing').status, 'deferred');
  // Its retry time comes: applied.
  f.controller.background.settle = settle;
  f.store.mutate(state => { state.projects.find(row => row.id === a.project.id).backgroundChanges.find(row => row.actionId === 'act-failing').retryAt = Date.now() - 1; });
  await until(() => f.row(a, 'act-failing').status === 'kept', 'applied at its retry time');
  assert.equal(read(a.P, 'failing.md'), 'applied at last\n');
});

test('agent_merge({ changeId }) refuses at once during the user\'s git operation instead of waiting, and works once it ends', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, { names: ['A'] });
  const [a] = f.projects;
  await conflicting(f, a, 'act-handoff');
  const row = f.row(a, 'act-handoff');
  answerCard(f, row, 'rna');
  await until(() => f.row(a, 'act-handoff').handedTo === a.session.id, 'handed to the conversation');
  begin(a.P, 'rebase');
  const call = input => f.controller.backgroundMerge({ projectId: a.project.id, sessionId: a.session.id, changeId: row.id, ...input }, new AbortController().signal);
  const started = Date.now();
  const refused = await call({ action: 'merge' });
  assert.ok(Date.now() - started < 5000, 'refused at once');
  assert.equal(refused.isError, true); assert.equal(refused.details.code, 'git_operation_in_progress');
  assert.match(refused.content[0].text, /A git rebase is in progress in the project folder/);
  assert.equal(existsSync(join(a.P, 'act-handoff.md')), false);
  end(a.P, 'rebase');
  const merged = JSON.parse((await call({ action: 'merge' })).content[0].text);
  assert.equal(merged.status, 'conflict'); assert.deepEqual(merged.applied, ['act-handoff.md']);
});

test('ISO-2: agent_merge drop of a change set merged into a worktree conversation takes it back out of that worktree, so its turn end does not bring it into the project folder', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, { names: ['A'] });
  const [a] = f.projects;
  // The user's change to line two, then a conversation with its own worktree made from the folder as it is now.
  const s = f.store.createSession({ projectId: a.project.id, title: '工作树对话', worktree: true });
  await run(f, a, 'act-drop-s', async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); put(root, 'added.md', 'added by the background\n');
    put(a.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    await finish({ max: 0 });
    return { summary: 'Done.' };
  });
  const S = (await f.sessionWorktrees.ensure(s.id, {})).root;
  assert.equal(read(S, 'notes.md'), 'one\ntwo (user)\nthree\n');
  // A finished turn of that conversation, and the set handed to it.
  f.store.message(s.id, { text: 'Take the background changes in.' });
  const turnId = f.store.state.sessions.find(row => row.id === s.id).activeTurnId;
  f.store.finishRuntimeTurn(s.id, turnId);
  const changeId = f.row(a, 'act-drop-s').id;
  f.store.mutate(state => { state.projects.find(row => row.id === a.project.id).backgroundChanges.find(row => row.id === changeId).handedTo = s.id; });
  const call = input => f.controller.backgroundMerge({ projectId: a.project.id, sessionId: s.id, changeId, ...input }).then(result => (result.isError ? result : JSON.parse(result.content[0].text)));
  const merged = await call({ action: 'merge' });
  assert.equal(merged.status, 'conflict'); assert.deepEqual(merged.applied, ['added.md']);
  assert.equal(read(S, 'added.md'), 'added by the background\n'); assert.equal(existsSync(join(a.P, 'added.md')), false, 'merged into the conversation\'s copy only');
  const sRow = f.current(a).git.applies.find(item => item.target === `session:${s.id}` && item.kind === 'background');
  assert.ok(sRow, 'the merge into S has its record');
  const dropped = await call({ action: 'drop' });
  assert.equal(dropped.status, 'dropped'); assert.deepEqual(dropped.restored, ['added.md']);
  assert.match(dropped.notes[0], /rolled back there/);
  assert.equal(existsSync(join(S, 'added.md')), false, 'the dropped file left the conversation\'s copy');
  assert.equal(f.current(a).git.applies.find(item => item.id === sRow.id).state, 'rolled_back');
  const rollback = f.current(a).git.applies.find(item => item.kind === 'rollback' && item.target === `session:${s.id}`);
  assert.equal(rollback.undoes, sRow.id); assert.equal(rollback.initiator, 'agent');
  const settled = f.row(a, 'act-drop-s');
  assert.equal(settled.status, 'reverted'); assert.equal(settled.discarded, true);
  // The conversation's next apply into the project folder carries nothing of the dropped set.
  await f.sessionWorktrees.applyIdle(s.id);
  assert.equal(existsSync(join(a.P, 'added.md')), false, 'the dropped file never reaches the project folder');
  assert.equal(read(a.P, 'notes.md'), 'one\ntwo (user)\nthree\n');
});

test('C5: agent_merge drop of a change set merged into a conversation worktree that is gone never writes the project folder through that record, and answers at once during the user\'s git merge', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, { names: ['A'] });
  const [a] = f.projects;
  const s = f.store.createSession({ projectId: a.project.id, title: '工作树对话', worktree: true });
  await run(f, a, 'act-gone', async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); put(root, 'added.md', 'added by the background\n');
    put(a.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    await finish({ max: 0 });
    return { summary: 'Done.' };
  });
  await f.sessionWorktrees.ensure(s.id, {});
  f.store.message(s.id, { text: 'Take the background changes in.' });
  f.store.finishRuntimeTurn(s.id, f.store.state.sessions.find(row => row.id === s.id).activeTurnId);
  const changeId = f.row(a, 'act-gone').id;
  f.store.mutate(state => { state.projects.find(row => row.id === a.project.id).backgroundChanges.find(row => row.id === changeId).handedTo = s.id; });
  const call = input => f.controller.backgroundMerge({ projectId: a.project.id, sessionId: s.id, changeId, ...input }).then(result => (result.isError ? result : JSON.parse(result.content[0].text)));
  assert.deepEqual((await call({ action: 'merge' })).applied, ['added.md']);
  const sRow = f.current(a).git.applies.find(item => item.target === `session:${s.id}` && item.kind === 'background');
  // The conversation's copy reached the project folder and went; it works in the project folder now, and the user has a
  // git merge open there.
  await f.sessionWorktrees.applyIdle(s.id);
  assert.equal(read(a.P, 'added.md'), 'added by the background\n');
  f.store.mutate(state => { state.sessions.find(row => row.id === s.id).worktree = null; });
  assert.equal((await f.roots.rootOf({ projectId: a.project.id, sessionId: s.id })).kind, 'project');
  begin(a.P, 'merge');
  const before = f.current(a).git.applies.length;
  const dropped = await Promise.race([call({ action: 'drop' }), delay(5000).then(() => 'waited')]);
  assert.notEqual(dropped, 'waited', 'never waits on the user\'s merge');
  assert.equal(dropped.status, 'dropped'); assert.deepEqual(dropped.restored, []);
  assert.deepEqual(dropped.skipped, [{ path: 'added.md', reason: 'failed' }], 'the record is not undone through the project folder');
  assert.equal(read(a.P, 'added.md'), 'added by the background\n');
  assert.equal(f.current(a).git.applies.length, before, 'no rollback record');
  assert.equal(f.current(a).git.applies.find(item => item.id === sRow.id).rolledBackBy, undefined);
});

// ---- Conversations (session worktrees) and the turn end ----

test('Stop ends a turn-end wait for the user\'s git merge; the hand-back then holds (git_operation) and the apply goes on when the merge ends', { skip, timeout: 120000 }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  begin(f.repo, 'merge');
  f.model.steps.push({ write: ['a.txt', 'one\nduring the merge\nthree\n'] }, { text: '写好了。' });
  f.store.message(s.id, { text: '改 a' });
  const turnId = f.sessionOf(s.id).activeTurnId;
  const line = item => item.kind === 'notice' && item.source === 'worktree' && /git merge/.test(item.text ?? '');
  await until(() => f.sessionOf(s.id).items.some(line), 'the turn end waits with its line');
  assert.equal(f.sessionOf(s.id).turns.find(row => row.id === turnId).status, 'running', 'the finish waits for the merge');
  const stopped = Date.now();
  f.store.controlSession(s.id, 'stop');
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === turnId).status !== 'running', 'Stop ends the turn', 10000);
  await f.quiet(s.id);
  assert.ok(Date.now() - stopped < 15000, 'the wait ended with the turn');
  const apply = f.sessionOf(s.id).turns.find(row => row.id === turnId).apply;
  assert.equal(apply.status, 'pending'); assert.equal(apply.reason, 'git_operation');
  assert.equal(f.sessionOf(s.id).items.filter(line).length, 1, 'one line for the wait and the hold');
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n');
  assert.equal(f.runtime.handBacks.size, 0); assert.equal(f.sessionWorktrees.idle.size, 0); assert.equal(f.sessionWorktrees.queues.size, 0);
  end(f.repo, 'merge');
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === turnId).apply.status === 'applied', 'applied once the merge ended');
  assert.equal(read(f.P, 'a.txt'), 'one\nduring the merge\nthree\n');
});

test('C3: a hand-back held on the user\'s merge is settled by the next turn\'s apply once the merge ends: no longer pending git_operation, and S at its base settles a held turn too', { skip, timeout: 120000 }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  begin(f.repo, 'merge');
  // T1: its finish waits for the merge, Stop ends it, the hand-back holds.
  f.model.steps.push({ write: ['a.txt', 'one\nby the first turn\nthree\n'] }, { text: '写好了。' });
  f.store.message(s.id, { text: '改 a' });
  const first = f.sessionOf(s.id).activeTurnId;
  const waitLine = item => item.kind === 'notice' && item.source === 'worktree' && /git merge/.test(item.text ?? '');
  await until(() => f.sessionOf(s.id).items.some(waitLine), 'the first turn waits for the merge');
  f.store.controlSession(s.id, 'stop');
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === first).status !== 'running', 'Stop ends the first turn', 10000);
  await f.quiet(s.id);
  assert.deepEqual(f.sessionOf(s.id).turns.find(row => row.id === first).apply, { status: 'pending', applyIds: [], reason: 'git_operation' });
  // T2 starts while the merge is still open; its finish waits, then applies all of S (T1's change too) once it ends.
  f.model.steps.push({ write: ['b.txt', 'by the second turn\n'] }, { text: '也好了。' });
  f.store.message(s.id, { text: '加 b' });
  const second = f.sessionOf(s.id).activeTurnId;
  await until(() => f.sessionOf(s.id).items.filter(waitLine).length >= 2, 'the second turn waits for the merge');
  end(f.repo, 'merge');
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === second).apply?.status === 'applied', 'the second turn applied once the merge ended');
  await f.quiet(s.id);
  assert.equal(read(f.P, 'a.txt'), 'one\nby the first turn\nthree\n'); assert.equal(read(f.P, 'b.txt'), 'by the second turn\n');
  const settled = f.sessionOf(s.id).turns.find(row => row.id === first).apply;
  assert.equal(settled.status, 'applied', 'the first turn no longer says it will apply on its own');
  assert.equal(settled.reason, undefined); assert.equal(settled.settledBy, second);
  assert.equal(applyWaiting(f.sessionOf(s.id).turns.find(row => row.id === first)), false, 'the project mind reads the first turn as settled');
  // A hand-back that finds S at its base (all of it applied elsewhere) settles its own held apply as well.
  f.store.mutate(state => { const turn = state.sessions.find(row => row.id === s.id).turns.find(row => row.id === second); turn.apply = { status: 'pending', applyIds: [...turn.apply.applyIds], reason: 'git_operation' }; });
  const again = await f.sessionWorktrees.applyOnHandBack(s.id, { turnId: second, reason: 'cancelled' });
  assert.equal(again.status, 'applied'); assert.equal(again.reason, undefined);
});

test('X3: a hand-back held on the user\'s git merge, overtaken by the next turn\'s apply, reads as applied by it (its changes went with it)', { skip, timeout: 120000 }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  begin(f.repo, 'merge');
  f.model.steps.push({ write: ['a.txt', 'one\nheld\nthree\n'] }, { text: '写好了。' });
  f.store.message(s.id, { text: '改 a' });
  const held = f.sessionOf(s.id).activeTurnId;
  const line = item => item.kind === 'notice' && item.source === 'worktree' && /git merge/.test(item.text ?? '');
  await until(() => f.sessionOf(s.id).items.some(line), 'the turn end waits with its line');
  f.store.controlSession(s.id, 'stop');
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === held).status !== 'running', 'Stop ends the turn', 10000);
  await f.quiet(s.id);
  assert.deepEqual([f.sessionOf(s.id).turns.find(row => row.id === held).apply.status, f.sessionOf(s.id).turns.find(row => row.id === held).apply.reason], ['pending', 'git_operation']);
  // The user sends the next turn before the merge ends; its own finish waits for the merge, then applies the whole worktree.
  f.model.steps.push({ write: ['b.txt', 'next turn\n'] }, { text: '也好了。' });
  f.store.message(s.id, { text: '再加 b' });
  const next = f.sessionOf(s.id).activeTurnId;
  await until(() => f.sessionOf(s.id).items.filter(line).length >= 2 || f.sessionOf(s.id).turns.find(row => row.id === next).status === 'running', 'the next turn runs');
  end(f.repo, 'merge');
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === next).apply?.status === 'applied', 'the next turn applies once the merge ended');
  await f.quiet(s.id);
  assert.equal(read(f.P, 'a.txt'), 'one\nheld\nthree\n'); assert.equal(read(f.P, 'b.txt'), 'next turn\n');
  const apply = f.sessionOf(s.id).turns.find(row => row.id === held).apply;
  assert.equal(apply.status, 'applied', 'not left pending (and so never read by the mind)'); assert.equal(apply.settledBy, next); assert.equal(apply.reason, undefined);
});

test('startup recovery of conversation worktrees runs projects independently: a held or slow project never holds another', { skip, timeout: 120000 }, async t => {
  const f = turnFixture(t);
  // A second project in the same store, with its own repository.
  const B = join(f.dir, 'second');
  mkdirSync(B, { recursive: true }); put(B, 'b.txt', 'bee\n');
  turnGit(B, 'init', '-q'); turnGit(B, 'add', '-A'); turnGit(B, 'commit', '-q', '-m', 'first');
  const { project: second } = f.store.createProject({ name: 'Second', workspace: B, initiative: { enabled: false } });
  f.store.mutate(state => applyProjectPermissions(state, second.id, { workspace: 'execute', background: 'read' }));
  const sa = f.worktreeSession(), sb = f.store.createSession({ projectId: second.id, title: '第二个项目的对话', worktree: true });
  await f.send(sa.id, '开始'); await f.send(sb.id, '开始');
  const SA = (await f.rootOf(sa.id)).root, SB = (await f.roots.rootOf({ projectId: second.id, sessionId: sb.id })).root;
  put(SA, 'from-a.txt', 'merged into A\'s conversation\n'); put(SB, 'from-b.txt', 'merged into B\'s conversation\n');
  // A's apply is slow (held here until released): B's goes on meanwhile.
  let release; const gate = new Promise(done => { release = done; });
  const applyIdle = f.sessionWorktrees.applyIdle.bind(f.sessionWorktrees);
  f.sessionWorktrees.applyIdle = async id => { if (id === sa.id) await gate; return applyIdle(id); };
  const recovering = f.sessionWorktrees.recover();
  await until(() => existsSync(join(B, 'from-b.txt')), 'B applied while A is still going', 20000);
  release(); await recovering;
  assert.equal(read(f.P, 'from-a.txt'), 'merged into A\'s conversation\n');
  f.sessionWorktrees.applyIdle = applyIdle;
  // A git merge left open in A: recovery holds A at once (pending git_operation, one line) and still applies B.
  put(SA, 'later-a.txt', 'later in A\n'); put(SB, 'later-b.txt', 'later in B\n');
  begin(f.repo, 'merge');
  const started = Date.now();
  const result = await f.sessionWorktrees.recover();
  assert.ok(Date.now() - started < 15000, 'recovery did not wait for A\'s merge');
  assert.deepEqual(result.applied.sort(), [sa.id, sb.id].sort(), 'A\'s hold is recorded on its turn, B is applied');
  assert.equal(read(B, 'later-b.txt'), 'later in B\n'); assert.equal(existsSync(join(f.P, 'later-a.txt')), false);
  const held = f.sessionOf(sa.id).turns.at(-1).apply;
  assert.equal(held.status, 'pending'); assert.equal(held.reason, 'git_operation');
  assert.equal(f.sessionOf(sa.id).items.filter(item => item.kind === 'notice' && /git merge/.test(item.text ?? '')).length, 1);
  assert.equal(f.sessionWorktrees.idle.size, 0); assert.equal(f.sessionWorktrees.queues.size, 0, 'a hold keeps nothing in progress');
  end(f.repo, 'merge');
  await until(() => existsSync(join(f.P, 'later-a.txt')) && f.sessionOf(sa.id).turns.at(-1).apply.status === 'applied', 'A applied once its merge ended');
  await f.quiet(sa.id);
});

test('the engine: hold refuses a write into the project folder at once, take refuses too, and whenProjectFree fires once the operation ends', { skip, timeout: 60000 }, async t => {
  const f = turnFixture(t);
  const P = await f.roots.rootOf({ projectId: f.project.id });
  begin(f.repo, 'rebase');
  assert.equal(await f.engine.projectBusy(f.project.id), 'rebase');
  const now = await f.engine.snapshot(f.project.id, P);
  await assert.rejects(f.engine.apply(f.project.id, { target: P, base: now.commit, incoming: now.commit, kind: 'worker', source: {}, mode: 'partial', labels: { current: 'current', incoming: 'incoming' }, hold: true }), error => error.code === 'git_operation_in_progress' && error.operation === 'rebase' && error.status === 409);
  await assert.rejects(f.engine.take(f.project.id, { target: P, items: [{ conflict: { path: 'a.txt', kind: 'content' }, side: 'current' }], source: {}, hold: true }), error => error.code === 'git_operation_in_progress');
  let fired = 0;
  f.engine.whenProjectFree(f.project.id, 'probe', () => { fired++; });
  f.engine.whenProjectFree(f.project.id, 'probe', () => { fired++; }); // the same key replaces, it does not add
  await delay(300);
  assert.equal(fired, 0); assert.equal(f.engine.waitingFree(f.project.id), true);
  end(f.repo, 'rebase');
  await until(() => fired === 1, 'fired once the rebase ended', 10000);
  await delay(300);
  assert.equal(fired, 1); assert.equal(f.engine.waitingFree(f.project.id), false);
  assert.equal(await f.engine.projectBusy(f.project.id), null);
});

test('an answered conflict card of a conversation is held during the user\'s git operation and carried out when it ends', { skip, timeout: 120000 }, async t => {
  const f = turnFixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n' } });
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  f.model.steps.push(async () => { await f.runtime.running.get(s.id)?.startSync; put(f.P, 'a.txt', 'one\nuser\nthree\n'); return { writes: [['a.txt', 'one\nmodel\nthree\n'], ['d.txt', 'clean\n']] }; }, { fail: 'fixture provider failure' });
  const turn = await f.send(s.id, '改');
  assert.equal(turn.apply.status, 'pending');
  begin(f.repo, 'merge');
  const card = f.sessionOf(s.id).items.findLast(item => item.interaction?.actionId?.startsWith(HOST_CARDS.sessionConflict.actionId(turn.id))).interaction;
  f.interactions.answer(s.id, card.id, { requestId: 'answer-conversation', answers: [{ id: 'decision', selected: ['conversation'] }] });
  await until(() => f.sessionOf(s.id).items.some(item => item.kind === 'notice' && /git merge/.test(item.text ?? '')), 'the held answer\'s line');
  await delay(300);
  assert.equal(f.sessionWorktrees.queues.size, 0, 'nothing waits for the merge');
  assert.equal(read(f.P, 'a.txt'), 'one\nuser\nthree\n');
  assert.equal(f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply.card.answered, undefined, 'the answer is not counted as carried out');
  end(f.repo, 'merge');
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply.status === 'applied', 'carried out once the merge ended');
  assert.equal(read(f.P, 'a.txt'), 'one\nmodel\nthree\n');
  assert.equal(f.sessionOf(s.id).items.filter(item => item.kind === 'notice' && /git merge/.test(item.text ?? '')).length, 1, 'one line for the held answer');
});

test('an answer to the "last apply was interrupted" card is held during the user\'s git operation and carried out when it ends', { skip, timeout: 90000 }, async t => {
  const f = turnFixture(t, { files: { 'f1.txt': '1\n', 'f2.txt': '2\n', 'f3.txt': '3\n' } });
  f.engine.interactions = f.interactions;
  const P = await f.roots.rootOf({ projectId: f.project.id });
  const seed = await f.engine.snapshot(f.project.id, P);
  const blob = text => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, env: gitEnv(), input: text, encoding: 'utf8' }).trim();
  const incoming = await f.engine.compose(f.project.id, seed.commit, ['f1.txt', 'f2.txt', 'f3.txt'].map(path => ({ path, mode: '100644', oid: blob(`${path} by the worker\n`) })));
  // A write cut off after its first file, as a crash leaves it.
  let count = 0;
  f.engine.settings.hooks = { beforeWrite: () => { if (count++ >= 1) throw Object.assign(new Error('the process went away'), { code: 'test_crash' }); } };
  await assert.rejects(f.engine.apply(f.project.id, { target: P, base: seed.commit, incoming, kind: 'worker', source: { sessionId: f.session.id }, mode: 'all', labels: MERGE_LABELS.worker('w-crash') }), { code: 'test_crash' });
  f.engine.settings.hooks = null;
  const row = () => f.applies().find(item => item.kind === 'worker');
  assert.equal(row().state, 'writing');
  begin(f.repo, 'rebase');
  const outcome = await f.engine.recover();
  assert.deepEqual(outcome.interrupted, [row().id]);
  assert.ok(row().card, 'its card is up');
  f.interactions.answer(row().card.sessionId, row().card.interactionId, { requestId: 'answer-complete', answers: [{ id: 'decision', selected: ['complete'] }] });
  const held = item => item.kind === 'notice' && /项目文件夹正在进行 git rebase，完成后再按你的选择处理。/.test(item.text ?? '');
  await until(() => f.sessionOf(f.session.id).items.some(held), 'the held answer\'s line');
  await delay(300);
  assert.equal(row().state, 'interrupted'); assert.equal(read(f.P, 'f2.txt'), '2\n', 'nothing written during the rebase');
  assert.equal(f.sessionOf(f.session.id).items.filter(held).length, 1);
  end(f.repo, 'rebase');
  await until(() => row().state === 'verified', 'carried out once the rebase ended');
  for (const name of ['f1.txt', 'f2.txt', 'f3.txt']) assert.equal(read(f.P, name), `${name} by the worker\n`);
});
