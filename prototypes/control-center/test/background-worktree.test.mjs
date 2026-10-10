import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { IsolationEngine, HOST_CARDS, LIMITS, WORKTREE_DIR, FEEDBACK_SOURCES } from '../git-isolation/index.mjs';
import { sandboxAvailable } from '../../../packages/sdk/src/workspace-exec.mjs';

// Background worktrees (worktree design 0.63 §4.3, §8, §13 "后台"): background work with write access in a git project
// runs in its own worktree B and is applied to the project folder when it ends. Real temporary repositories, the real
// merge engine, worktree service and root resolver; no network, no model calls (scripted providers and runs only).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitVersionOk = (() => { try { const [, major, minor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })); return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38); } catch { return false; } })();
const skip = gitVersionOk ? false : 'git 2.38 or later is needed';
const put = (root, path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const read = (root, path) => readFileSync(join(root, path), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
async function until(check, label = 'condition') { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const decision = (input, action = 'wait', content = '') => ({ action, content, evidenceIds: [input.events.at(-1).id], reason: 'Observed a concrete project fact', nextReviewAfterMs: 600000 });
const decisions = fn => async function* (options) { const input = JSON.parse(options.messages[0].content[0].text); const output = await fn(input); yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; };
const FILES = { 'notes.md': 'one\ntwo\nthree\n', 'other.md': 'alpha\n', '.gitignore': 'dist/\n' };

/**
 * A project folder (a git repository unless `repo: false`) with a store, the merge engine (release gate forced open
 * unless `ready: false`), the root resolver, the worktree service, the card service and the controller wired with them.
 * `initiative: true` lets the controller decide and run work itself (scripted decision provider).
 */
async function fixture(t, { repo = true, ready = true, initiative = false, decisionProvider, runtimeFactory, tools = ['project_read', 'project_list'] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-bgwt-'))), P = join(dir, 'project');
  mkdirSync(P);
  for (const [path, content] of Object.entries(FILES)) put(P, path, content);
  if (repo) { git(P, 'init', '-q'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'first'); }
  const store = new Store(join(dir, 'state', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Background fixture', description: 'Keep the notes current', workspace: P, initiative: { cooldownMs: 0, enabled: initiative } });
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    Object.assign(target, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, overview: 'Notes', permissions: { workspace: 'execute', background: 'inherit', revision: 1 }, assignments: { skillIds: [], toolIds: tools, mcpServerIds: [] } });
    target.initiative.tokenBudget = 100000; state.settings.realTokenBudget = 200000;
    target.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] };
  });
  const service = new WorkspaceGitService(store);
  const engine = new IsolationEngine(store, { git: service, ready, sandbox: () => true, pollMs: 20, execWaitMs: 100 });
  service.engine = engine;
  const roots = new RootResolver(store, { git: service });
  const worktrees = new WorktreeService(store, { git: service, engine, roots });
  service.owners = path => worktrees.ownerOf(path);
  const interactions = new UserInteractionService(store);
  const evolutionService = new ProjectEvolutionService(store, { provider: decisionProvider ?? decisions(input => decision(input)) });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, interactionService: interactions, evolutionService, decisionProvider: decisionProvider ?? decisions(input => decision(input)), ...(runtimeFactory ? { runtimeFactory } : {}), engine, worktrees, roots });
  t.after(async () => { await controller.close(); interactions.close?.(); engine.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const rows = () => (current().backgroundChanges ?? []).filter(row => row.kind === 'git');
  const lines = () => store.state.sessions.find(row => row.id === session.id).items.filter(item => item.source === 'initiative');
  const records = () => current().git?.worktrees ?? [];
  const context = { projectId: project.id, coordinator: { model: { providerId: provider.id, modelId: 'fixture-model', name: 'Fixture' }, state: { actions: [] }, active: new Map(), _executionBlocked: () => false }, workRuns: new Map(), activeHandles: new Set() };
  // The startup pass (recoverWorktrees) runs once, before any run of the test.
  await until(() => controller.gitRecovered === true, 'startup pass');
  return { dir, P, store, project, session, service, engine, roots, worktrees, interactions, controller, current, rows, lines, records, context };
}

/** The SDK's finish loop for a scripted run: the host hook until it accepts, `onFeedback` between continuations. */
async function finishLoop(f, action, bg, onFeedback = async () => {}, { max = LIMITS.backgroundFinishContinuations, message = { role: 'assistant' } } = {}) {
  const seen = [];
  for (let continuations = 0; ; continuations++) {
    const answer = await f.controller.finishGitRun(f.context, action, bg, { message, continuations, remainingContinuations: max - continuations });
    if (!answer) return seen;
    seen.push(answer.feedback[0]);
    await onFeedback(answer.feedback[0]);
  }
}
/**
 * A stand-in for ProjectInitiativeController#work that does what a run does in B: `script(root, finish)` writes files
 * in the run's own worktree and may call the finish hook; it is registered as a live run meanwhile.
 */
function scriptedWork(f, script) {
  const calls = [];
  f.controller.work = async (context, action, input) => {
    calls.push({ action, bg: input.bg ?? null, recorder: input.recorder ?? null });
    const run = { writable: true, isolated: Boolean(input.bg) };
    context.workRuns.set(action.id, run);
    try { return await script(input.bg?.root.root ?? f.P, { bg: input.bg, finish: (onFeedback, options) => finishLoop(f, action, input.bg, onFeedback, options), action, recorder: input.recorder }); }
    finally { context.workRuns.delete(action.id); }
  };
  return calls;
}
const answerCard = (f, row, choice) => f.interactions.answer(row.card.sessionId, row.card.interactionId, { requestId: `answer-${choice}-${row.id}`.slice(0, 150), answers: [{ id: 'decision', selected: [choice] }] });
const startForegroundTurn = (f, sessionId = f.session.id) => f.store.message(sessionId, { text: 'Rewrite the summary in the conversation.' });
const finishForegroundTurn = (f, sessionId = f.session.id) => f.store.finishRuntimeTurn(sessionId, f.store.state.sessions.find(row => row.id === sessionId).activeTurnId);

test('a writing background run works in its own worktree: tools, sandboxed commands and cwd are there, and it is applied to the project folder as one apply record when it ends', { skip }, async t => {
  const options = [], requests = [];
  let released = false;
  const queue = [
    // The run reads notes.md before replacing it (a write without expectedHash replaces only the version it observed).
    { tools: [{ id: 'r1', name: 'project_read', arguments: { path: 'notes.md' } }, { id: 'w1', name: 'project_write', arguments: { path: 'notes.md', content: 'one\ntwo (background)\nthree\n' } }, { id: 'x1', name: 'project_exec', arguments: { command: 'printf escaped > "$P_FOLDER/escape.txt"; printf inside > inside.txt' } }] },
    { text: 'Updated the notes.\n交接：更新了 notes.md，新增 inside.txt，下一步无。' },
  ];
  const f = await fixture(t, { initiative: true, tools: ['project_read', 'project_list', 'project_write', 'project_edit', 'project_exec'],
    decisionProvider: decisions(input => (released ? decision(input) : (released = true, decision(input, 'work', 'Update the notes')))),
    runtimeFactory: value => { options.push(value); return createRnaRuntime({ ...value, provider: async function* (request) {
      requests.push(request);
      const next = queue.shift() ?? { text: 'Nothing else.\n交接：无。' };
      yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } };
      if (next.tools) { for (const call of next.tools) yield { type: 'tool_call', id: call.id, name: call.name, arguments: call.name === 'project_exec' ? { command: call.arguments.command.replaceAll('$P_FOLDER', f.P) } : call.arguments }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      yield { type: 'text_delta', delta: next.text }; yield { type: 'done', stopReason: 'stop' };
    } }); } });
  await until(() => f.rows().some(row => row.status === 'kept'), 'the change set is applied');
  const [opened] = options, [row] = f.rows();
  // cwd, tools and the sandbox root are B; AGENTS.md comes from the project folder; the finish hook may continue 3 times.
  assert.ok(opened.cwd.startsWith(join(f.P, ...WORKTREE_DIR.split('/'), 'b-')), opened.cwd);
  assert.equal(opened.isolated, true); assert.equal(opened.instructionsRoot, f.P); assert.equal(opened.maxFinishContinuations, LIMITS.backgroundFinishContinuations);
  assert.equal(typeof opened.hostFinish, 'function'); assert.equal(opened.readOnly, false);
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (background)\nthree\n');
  assert.equal(read(f.P, 'inside.txt'), 'inside');
  if (sandboxAvailable()) assert.equal(existsSync(join(f.P, 'escape.txt')), false, 'a command in B cannot write into the project folder');
  // One apply record, verified; the change set row points at it; B is gone once applied.
  const record = f.current().git.applies.find(item => item.id === row.applyId);
  assert.equal(record.kind, 'background'); assert.equal(record.target, 'project'); assert.equal(record.state, 'verified'); assert.equal(record.source.worktreeId, row.worktreeId);
  assert.deepEqual(row.files.map(item => item.path).sort(), ['inside.txt', 'notes.md']);
  assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'removed');
  assert.equal(row.model.modelId, 'fixture-model');
  const line = f.lines().find(item => item.initiative?.backgroundChange === row.id);
  assert.match(line.text, /^更新了 notes\.md，新增 inside\.txt，下一步无。\n\n改了 2 个文件/);
  // The user's own index and HEAD are untouched; the files show as ordinary uncommitted changes.
  assert.equal(git(f.P, 'diff', '--cached', '--name-only'), '');
  assert.match(git(f.P, 'status', '--porcelain'), / M notes\.md/);
});

test('a direct-mode foreground turn neither interrupts nor narrows a run in its worktree; its apply waits for that turn, a worktree session turn does not hold it', { skip }, async t => {
  const f = await fixture(t);
  const gate = hold(), started = hold();
  let narrowed = null, stopped = null;
  scriptedWork(f, async (root, { finish }) => {
    started.resolve(); await gate.promise;
    narrowed = f.controller.backgroundProject(f.current(), { isolated: true }).permissions.background;
    put(root, 'notes.md', 'one\ntwo\nthree\nfour (background)\n');
    await finish();
    return { summary: 'Added line four.', reported: '加了第四行。' };
  });
  const action = { id: 'act-defer-1', action: 'work', content: 'Add a fourth line' };
  const running = f.controller.recordedWork(f.context, action, { signal: new AbortController().signal });
  await started.promise;
  startForegroundTurn(f);
  // The foreground admission does not stop it (nothing to drain), and the store change does not abort it. (The
  // controller's own contexts are not used by these scripted runs: this one is lent for the admission only.)
  f.controller.contexts.set(f.project.id, f.context);
  const admission = f.controller.prepareForeground(f.project.id, { signal: new AbortController().signal });
  f.controller.contexts.delete(f.project.id);
  stopped = await admission;
  assert.deepEqual(stopped, []);
  gate.resolve(); await running;
  assert.equal(narrowed, 'inherit', 'not made read only by the foreground turn');
  const [row] = f.rows();
  assert.equal(row.status, 'deferred'); assert.equal(row.hold, 'deferred');
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo\nthree\n', 'nothing written while the turn holds the folder');
  assert.match(f.lines().find(item => item.initiative?.backgroundChange === row.id).text, /^加了第四行。\n\n改动先留在它自己的工作副本里，等这一轮对话结束后应用到项目文件夹。$/);
  assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'active', 'B waits, kept from the worktree panel');
  finishForegroundTurn(f);
  await until(() => f.rows()[0].status === 'kept', 'applied once the turn ended');
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo\nthree\nfour (background)\n');
  assert.ok(f.rows()[0].applyId); assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'removed');
  assert.match(f.lines().find(item => item.initiative?.backgroundChange === row.id).text, /^加了第四行。\n\n改了 1 个文件/);

  // A conversation running in its own worktree does not hold the project folder.
  const other = f.store.createSession({ projectId: f.project.id, title: 'Isolated conversation' });
  f.store.mutate(state => { state.sessions.find(item => item.id === other.id).worktree = { id: 'session-wt', state: 'active' }; });
  startForegroundTurn(f, other.id);
  assert.equal(f.controller.directTurnRunning(f.project.id), false);
  scriptedWork(f, async (root, { finish }) => { put(root, 'other.md', 'alpha\nbeta\n'); await finish(); return { summary: 'Added beta.' }; });
  await f.controller.recordedWork(f.context, { id: 'act-defer-2', action: 'work', content: 'Add beta' }, { signal: new AbortController().signal });
  assert.equal(f.rows().find(item => item.actionId === 'act-defer-2').status, 'kept');
  assert.equal(read(f.P, 'other.md'), 'alpha\nbeta\n');
});

test('a conflict at the end of the run is merged into B with markers and resolved inside the run; the project folder never sees a marker', { skip }, async t => {
  const f = await fixture(t);
  let feedback = null, marked = null;
  scriptedWork(f, async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n');
    put(f.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    const seen = await finish(async item => {
      feedback = item; marked = read(root, 'notes.md');
      assert.doesNotMatch(read(f.P, 'notes.md'), /<<<<<<<|>>>>>>>/);
      put(root, 'notes.md', 'one\ntwo (user, then background)\nthree\n');
    });
    assert.equal(seen.length, 1);
    return { summary: 'Merged.', reported: '合并好了第二行。' };
  });
  await f.controller.recordedWork(f.context, { id: 'act-conflict-1', action: 'work', content: 'Edit line two' }, { signal: new AbortController().signal });
  assert.equal(feedback.source, FEEDBACK_SOURCES.worktreeApply);
  const told = JSON.parse(feedback.text);
  assert.deepEqual(told.files, ['notes.md']); assert.deepEqual(told.nonText, []);
  const mid = /refs\/rna\/m\/([a-f0-9]+)\//.exec(told.observation)[1];
  assert.match(marked, new RegExp(`^<<<<<<< refs/rna/m/${mid}/this-background-work$`, 'm'));
  assert.match(marked, new RegExp(`^>>>>>>> refs/rna/m/${mid}/project-folder$`, 'm'));
  assert.match(marked, /two \(user\)/); assert.match(marked, /two \(background\)/);
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user, then background)\nthree\n');
  const [row] = f.rows();
  assert.equal(row.status, 'kept'); assert.equal(row.continuations, 1); assert.equal(row.conflicts, undefined);
});

test('a conflict left unresolved after the continuations becomes merge_conflicted: B holds no markers, nothing is blocked, and the card decides (background version, rolled back through the record)', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); put(root, 'other.md', 'alpha\nfrom background\n');
    put(f.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    const seen = await finish();
    assert.equal(seen.length, LIMITS.applyContinuations, 'two host continuations, then the card');
    return { summary: 'Done.' };
  });
  const action = { id: 'act-card-1', action: 'work', content: 'Edit line two' };
  await f.controller.recordedWork(f.context, action, { signal: new AbortController().signal });
  const [row] = f.rows();
  assert.equal(row.status, 'merge_conflicted'); assert.deepEqual(row.conflicts, [{ path: 'notes.md', kind: 'content' }]); assert.equal(row.applyId, null);
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user)\nthree\n', 'the project folder is untouched'); assert.equal(read(f.P, 'other.md'), 'alpha\n');
  const record = f.records().find(item => item.id === row.worktreeId);
  assert.equal(record.state, 'active');
  const B = await f.roots.rootOf({ projectId: f.project.id, actionId: action.id });
  assert.equal(read(B.root, 'notes.md'), 'one\ntwo (background)\nthree\n', 'unresolved markers were put back to the background version');
  // The card: initiative source, the contract's actionId and options.
  const card = f.store.state.sessions.find(item => item.id === row.card.sessionId).items.find(item => item.interaction?.id === row.card.interactionId).interaction;
  assert.equal(card.source, HOST_CARDS.backgroundConflict.source); assert.equal(card.actionId, HOST_CARDS.backgroundConflict.actionId(action.id));
  assert.deepEqual(card.questions[0].options.map(option => option.id), [...HOST_CARDS.backgroundConflict.options]);
  assert.match(card.questions[0].question, /notes\.md/);
  // merge_conflicted does not block: no blocking action, the foreground is admitted.
  assert.equal(f.current().initiativeRuntime?.sdkState?.actions?.some(item => item.blocksExecution) ?? false, false);
  assert.equal(await f.controller.prepareForeground(f.project.id), undefined);
  // 冲突文件用后台的版本: both files take the background version, as one apply record.
  answerCard(f, row, 'background');
  await until(() => f.rows()[0].status === 'kept', 'card answered');
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (background)\nthree\n'); assert.equal(read(f.P, 'other.md'), 'alpha\nfrom background\n');
  const kept = f.rows()[0];
  assert.ok(kept.applyId); assert.equal(kept.conflicts, undefined); assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'removed');
  // Rolled back through the same record (two steps), the row follows it; undone, it is kept again.
  const preview = await f.engine.rollback(f.project.id, kept.applyId, {});
  const rolled = await f.engine.rollback(f.project.id, kept.applyId, { confirm: preview.confirm });
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user)\nthree\n'); assert.equal(read(f.P, 'other.md'), 'alpha\n');
  await until(() => f.rows()[0].status === 'reverted', 'row follows the rollback');
  const undo = await f.engine.rollback(f.project.id, rolled.applyId, {});
  await f.engine.rollback(f.project.id, rolled.applyId, { confirm: undo.confirm });
  await until(() => f.rows()[0].status === 'kept', 'row follows the undo');
});

test('the card: only the files without conflicts, or discard; the worktree panel can still act on what is left', { skip }, async t => {
  const f = await fixture(t);
  const conflicting = id => scriptedWork(f, async (root, { finish }) => {
    put(root, 'notes.md', `one\ntwo (${id})\nthree\n`); put(root, `${id}.md`, `${id}\n`);
    put(f.P, 'notes.md', `one\ntwo (user before ${id})\nthree\n`);
    await finish(async () => {}, { max: 0 });
    return { summary: 'Done.' };
  });
  conflicting('clean');
  await f.controller.recordedWork(f.context, { id: 'act-clean', action: 'work', content: 'Edit' }, { signal: new AbortController().signal });
  let row = f.rows().find(item => item.actionId === 'act-clean');
  assert.equal(row.status, 'merge_conflicted');
  answerCard(f, row, 'clean_only');
  await until(() => f.rows().find(item => item.actionId === 'act-clean').status === 'kept', 'clean only');
  row = f.rows().find(item => item.actionId === 'act-clean');
  assert.equal(read(f.P, 'clean.md'), 'clean\n'); assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user before clean)\nthree\n');
  assert.deepEqual(row.conflicts, [{ path: 'notes.md', kind: 'content' }]);
  assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'conflicted', 'what conflicts stays in B for the worktree panel');
  const listed = await f.worktrees.list(f.project.id);
  assert.ok(listed.worktrees.some(item => item.id === row.worktreeId && item.state === 'conflicted'));

  conflicting('gone');
  await f.controller.recordedWork(f.context, { id: 'act-discard', action: 'work', content: 'Edit' }, { signal: new AbortController().signal });
  row = f.rows().find(item => item.actionId === 'act-discard');
  answerCard(f, row, 'discard');
  await until(() => f.rows().find(item => item.actionId === 'act-discard').status === 'reverted', 'discarded');
  assert.equal(existsSync(join(f.P, 'gone.md')), false); assert.equal(f.rows().find(item => item.actionId === 'act-discard').discarded, true);
  assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'removed');
});

test('a run that fails part way applies only what does not conflict; the rest waits on the card', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async root => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); put(root, 'new.md', 'new\n');
    put(f.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    throw Object.assign(new Error('provider failed'), { code: 'background_failed' });
  });
  await assert.rejects(f.controller.recordedWork(f.context, { id: 'act-fail', action: 'work', content: 'Edit' }, { signal: new AbortController().signal }), /provider failed/);
  const [row] = f.rows();
  assert.equal(row.status, 'merge_conflicted'); assert.equal(row.failed, true); assert.ok(row.applyId, 'the clean part has its own record');
  assert.equal(read(f.P, 'new.md'), 'new\n'); assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user)\nthree\n');
  assert.ok(row.card);
  const line = f.lines().find(item => item.initiative?.backgroundChange === row.id);
  assert.match(line.text, /它没有做完就停了。\n\n不冲突的 1 个文件已经应用到项目文件夹。有 1 个文件和项目文件夹里同时发生的改动冲突/);
  assert.equal(line.initiative.backgroundWork.status, 'failed');
});

test('a change set handed to the conversation is settled with agent_merge({ changeId }): merge, show, take refusal, resolved; markers never reach the project folder', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); put(root, 'added.md', 'added\n');
    put(f.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    await finish(async () => {}, { max: 0 });
    return { summary: 'Done.' };
  });
  await f.controller.recordedWork(f.context, { id: 'act-handoff', action: 'work', content: 'Edit line two' }, { signal: new AbortController().signal });
  let [row] = f.rows();
  answerCard(f, row, 'rna');
  await until(() => f.rows()[0].handedTo === f.session.id, 'handed to the conversation');
  assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'conflicted', 'should the conversation not settle it, the worktree panel can');
  const message = f.store.state.sessions.find(item => item.id === f.session.id).items.findLast(item => item.kind === 'user');
  assert.match(message.text, new RegExp(`agent_merge\\(\\{"changeId":"${row.id}"\\}\\)`));
  const call = input => f.controller.backgroundMerge({ projectId: f.project.id, sessionId: f.session.id, changeId: row.id, callId: 'c1', ...input }).then(result => ({ ...result, json: result.isError ? null : JSON.parse(result.content[0].text) }));
  // Another conversation, or nothing handed over: refused.
  const other = f.store.createSession({ projectId: f.project.id, title: 'Other' });
  const refused = await f.controller.backgroundMerge({ projectId: f.project.id, sessionId: other.id, changeId: row.id });
  assert.equal(refused.isError, true); assert.equal(refused.details.code, 'merge_unknown');
  const merged = await call({ action: 'merge' });
  assert.equal(merged.json.status, 'conflict'); assert.deepEqual(merged.json.applied, ['added.md']);
  const [conflict] = merged.json.conflicts;
  assert.equal(conflict.path, 'notes.md'); assert.equal(conflict.kind, 'content'); assert.equal(conflict.currentSha256, sha('one\ntwo (user)\nthree\n'));
  assert.match(conflict.preview, /refs\/rna\/m\/[a-f0-9]+\/incoming-background-/);
  assert.equal(read(f.P, 'added.md'), 'added\n'); assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user)\nthree\n', 'conflicts are listed, never written with markers');
  const shown = await call({ action: 'show', path: 'notes.md' });
  assert.equal(shown.json.page, 1); assert.match(shown.json.text, /two \(background\)/);
  const wrong = await call({ action: 'take', take: [{ path: 'other.md', side: 'incoming' }] });
  assert.equal(wrong.details.code, 'merge_path_not_conflicted');
  const early = await call({ action: 'resolved' });
  assert.equal(early.json.status, 'conflict'); assert.deepEqual(early.json.remaining, [{ path: 'notes.md', reason: 'unchanged' }]);
  put(f.P, 'notes.md', 'one\ntwo (user and background)\nthree\n');
  const done = await call({ action: 'resolved' });
  assert.deepEqual(done.json, { status: 'merged' });
  [row] = f.rows();
  assert.equal(row.status, 'kept'); assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'removed');
  const settled = await call({ action: 'merge' });
  assert.equal(settled.json.status, 'merged'); assert.match(settled.json.notes[0], /already settled/);
});

test('directHandle runs in its own worktree; the card\'s 回退 rolls back through the apply record and keeps later edits', { skip }, async t => {
  const f = await fixture(t);
  put(f.P, 'notes.md', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'); git(f.P, 'commit', '-qam', 'longer');
  f.controller.decisions = { directHandle: async () => true, enabled: () => false };
  f.controller.current = () => true;
  const calls = scriptedWork(f, async root => { put(root, 'notes.md', 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n'); return { summary: '改了第二行的大小写。' }; });
  const action = { id: 'act-direct', action: 'share', content: '第二行应为大写 TWO。' };
  const handled = await f.controller.directHandle(f.context, action, { signal: new AbortController().signal });
  assert.equal(handled.outcome, 'fixed');
  assert.equal(calls[0].bg.root.kind, 'background'); assert.equal(calls[0].recorder, null, 'no DirectFix snapshots');
  assert.equal(read(f.P, 'notes.md'), 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n');
  const fix = f.current().directFixes.at(-1);
  assert.equal(fix.kind, 'git'); assert.ok(fix.applyId); assert.equal(fix.status, 'pending');
  assert.equal(f.records().find(item => item.id === fix.worktreeId).state, 'removed');
  // The user edits another part of the file, then answers 回退: the fix goes, the later edit stays.
  put(f.P, 'notes.md', 'one\nTWO\nthree\nfour\nfive\nsix\nseven (user)\n');
  f.interactions.answer(fix.sessionId, fix.interactionId, { requestId: 'revert-direct', answers: [{ id: 'decision', selected: ['revert'] }] });
  f.controller.settleDirectFixes(f.current());
  await until(() => f.current().directFixes.at(-1).status === 'reverted', 'reverted');
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven (user)\n');
  assert.deepEqual(f.current().directFixes.at(-1).outcome.restored, ['notes.md']);
  assert.equal(f.current().git.applies.find(item => item.kind === 'rollback').initiator, 'user', 'the card\'s answer is the user\'s');
  assert.match(f.lines().at(-1).text, /^已回退 1 个文件：notes\.md。$/);
});

test('a non-git project, and a git project with isolation off, keep the DirectFix snapshots of 0.62', async t => {
  for (const options of [{ repo: false }, { ready: false }]) {
    const f = await fixture(t, options);
    const calls = scriptedWork(f, async (root, { recorder }) => { recorder.capture('notes.md'); put(root, 'notes.md', 'changed\n'); return { summary: 'Done.' }; });
    await f.controller.recordedWork(f.context, { id: `act-legacy-${options.repo === false ? 'plain' : 'off'}`, action: 'work', content: 'Edit' }, { signal: new AbortController().signal });
    assert.equal(calls[0].bg, null); assert.ok(calls[0].recorder, 'DirectFixRecorder');
    assert.equal(calls[0].action.id.startsWith('act-legacy'), true);
    const [row] = f.current().backgroundChanges;
    assert.equal(row.kind, undefined); assert.equal(row.status, 'kept');
    assert.equal(read(f.P, 'notes.md'), 'changed\n');
    assert.deepEqual(f.records(), []);
    assert.equal(f.controller.revertBackgroundChange(f.project.id, row.id).status, 'reverted');
    assert.equal(read(f.P, 'notes.md'), 'one\ntwo\nthree\n');
  }
});

test('a foreground turn still narrows and interrupts a run without a worktree, and a needs_review action still blocks the foreground', { skip }, async t => {
  const f = await fixture(t, { ready: false });
  startForegroundTurn(f);
  assert.equal(f.controller.backgroundProject(f.current()).permissions.background, 'read');
  assert.equal(f.controller.backgroundProject(f.current(), { isolated: true }).permissions.background, 'inherit');
  const aborted = [];
  const context = { ...f.context, workRuns: new Map([['legacy', { writable: true, isolated: false, abort: reason => aborted.push(reason.code) }], ['isolated', { writable: true, isolated: true, abort: reason => aborted.push(`isolated:${reason.code}`) }]]), coordinator: { ...f.context.coordinator, active: new Map() } };
  f.controller.interruptBackgroundWriters(context);
  assert.deepEqual(aborted, ['foreground_started']);
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.initiativeRuntime = { sdkState: { actions: [{ id: 'blocked', action: 'work', status: 'needs_review', blocksExecution: true, content: 'x', evidenceIds: [] }] } }; });
  await assert.rejects(f.controller.prepareForeground(f.project.id), error => error.code === 'background_recovery_required');
});

test('a paused run resumes in the same worktree, and a restart settles a worktree whose run was cut off', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async root => { put(root, 'first.md', 'first\n'); return { control: { kind: 'pause' } }; });
  const action = { id: 'act-pause', action: 'work', content: 'Two steps' };
  await f.controller.recordedWork(f.context, action, { signal: new AbortController().signal });
  const paused = f.records().find(item => item.owner.actionId === action.id);
  assert.equal(paused.state, 'active'); assert.equal(existsSync(join(f.P, 'first.md')), false);
  assert.equal(f.lines().find(item => item.initiativeActionId === `${action.id}-changes`).initiative.backgroundWork.status, 'paused');
  const calls = scriptedWork(f, async (root, { finish }) => { assert.equal(read(root, 'first.md'), 'first\n'); put(root, 'second.md', 'second\n'); await finish(); return { summary: 'Both.' }; });
  await f.controller.recordedWork(f.context, { ...action, checkpoint: { sessionId: action.id } }, { signal: new AbortController().signal });
  assert.equal(calls[0].bg.worktreeId, paused.id, 'the same B');
  assert.equal(read(f.P, 'first.md'), 'first\n'); assert.equal(read(f.P, 'second.md'), 'second\n');

  // A run cut off by a restart: its B is still active with no run; the next controller settles it like a failed run.
  scriptedWork(f, async root => { put(root, 'cut.md', 'cut\n'); return { control: { kind: 'pause' } }; });
  await f.controller.recordedWork(f.context, { id: 'act-cut', action: 'work', content: 'Cut off' }, { signal: new AbortController().signal });
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.initiativeRuntime = { sdkState: { actions: [{ id: 'act-cut', action: 'work', status: 'needs_review', blocksExecution: true, content: 'Cut off', evidenceIds: [] }] } }; });
  await f.controller.recoverWorktrees();
  const row = f.rows().find(item => item.actionId === 'act-cut');
  assert.equal(row.status, 'kept'); assert.equal(row.failed, true); assert.equal(read(f.P, 'cut.md'), 'cut\n');
});

test('a git change set reverts in two steps through its apply record; its detail points at the record', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async (root, { finish }) => { put(root, 'other.md', 'alpha\nbeta\n'); await finish(); return { summary: 'Added beta.' }; });
  await f.controller.recordedWork(f.context, { id: 'act-revert', action: 'work', content: 'Add beta' }, { signal: new AbortController().signal });
  const [row] = f.rows();
  assert.deepEqual(f.controller.backgroundChangeDetail(f.project.id, row.id), { id: row.id, actionId: 'act-revert', at: row.at, status: 'kept', kind: 'git', applyId: row.applyId, skipped: 0, files: [] });
  const preview = await f.controller.revertBackgroundChange(f.project.id, row.id);
  assert.ok(preview.confirm); assert.deepEqual(preview.files, [{ path: 'other.md', action: 'restore' }]);
  assert.equal(read(f.P, 'other.md'), 'alpha\nbeta\n', 'the first step changes nothing');
  const done = await f.controller.revertBackgroundChange(f.project.id, row.id, { confirm: preview.confirm });
  assert.equal(done.status, 'reverted'); assert.deepEqual(done.outcome.restored, ['other.md']);
  assert.equal(read(f.P, 'other.md'), 'alpha\n');
  assert.equal(f.rows()[0].status, 'reverted');
  // The user's revert: the record keeps the run as its owner (one record: before, its source was empty) and says who
  // asked; the row carries a note the foreground's collaborator finding repeats, while the line's text (frozen memory
  // evidence) stays as it was.
  const rollback = f.current().git.applies.find(item => item.id === done.applyId);
  assert.deepEqual([rollback.initiator, rollback.source.actionId, rollback.undoes], ['user', 'act-revert', row.applyId]);
  assert.equal(f.rows()[0].revertNote, 'The user reverted these changes; the project folder no longer has them.');
  assert.doesNotMatch(f.lines().find(item => item.initiative?.backgroundChange === row.id).text, /reverted|回退了|已被你回退/);
  assert.deepEqual(await f.controller.revertBackgroundChange(f.project.id, row.id), { status: 'reverted', outcome: done.outcome });
});

test('a git change set applied by two records (its clean part, then a take) reverts both in one step, and one undo brings both back', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); put(root, 'added.md', 'added\n');
    put(f.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    await finish(async () => {}, { max: 0 });
    return { summary: 'Done.' };
  });
  await f.controller.recordedWork(f.context, { id: 'act-two', action: 'work', content: 'Edit' }, { signal: new AbortController().signal });
  const [row] = f.rows();
  const call = input => f.controller.backgroundMerge({ projectId: f.project.id, sessionId: f.session.id, changeId: row.id, ...input }).then(result => JSON.parse(result.content[0].text));
  assert.equal((await call({ action: 'merge' })).status, 'conflict');
  assert.equal((await call({ action: 'take', take: [{ path: 'notes.md', side: 'incoming' }] })).status, 'merged');
  assert.deepEqual(await call({ action: 'resolved' }), { status: 'merged' });
  const kept = f.rows()[0];
  assert.equal(kept.status, 'kept'); assert.equal(kept.applyIds.length, 2, JSON.stringify(kept));
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (background)\nthree\n'); assert.equal(read(f.P, 'added.md'), 'added\n');
  const preview = await f.controller.revertBackgroundChange(f.project.id, row.id);
  assert.deepEqual(preview.files.map(file => file.path).sort(), ['added.md', 'notes.md'], 'both records\' files are listed');
  const done = await f.controller.revertBackgroundChange(f.project.id, row.id, { confirm: preview.confirm });
  assert.equal(done.status, 'reverted'); assert.deepEqual(done.outcome.restored.sort(), ['added.md', 'notes.md']);
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user)\nthree\n'); assert.equal(existsSync(join(f.P, 'added.md')), false);
  const applies = f.current().git.applies;
  assert.equal(applies.filter(item => item.kind === 'rollback').length, 1, 'one rollback record for the set');
  assert.deepEqual([applies.find(item => item.kind === 'rollback').initiator, applies.find(item => item.kind === 'rollback').source], ['user', { actionId: 'act-two' }]);
  for (const id of kept.applyIds) assert.equal(applies.find(item => item.id === id).state, 'rolled_back');
  // One undo restores both, and the row follows (kept again).
  const undo = await f.engine.rollback(f.project.id, done.applyId, {});
  await f.engine.rollback(f.project.id, done.applyId, { confirm: undo.confirm });
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (background)\nthree\n'); assert.equal(read(f.P, 'added.md'), 'added\n');
  f.controller.syncGitRows(f.project.id);
  assert.equal(f.rows()[0].status, 'kept');
  assert.equal(f.rows()[0].revertNote, undefined, 'the undo takes the note back out');
  // Rolling back only one of its records (from the apply history) leaves the set kept: the other still stands.
  const one = await f.engine.rollback(f.project.id, kept.applyIds[0], {});
  await f.engine.rollback(f.project.id, kept.applyIds[0], { confirm: one.confirm });
  f.controller.syncGitRows(f.project.id);
  assert.equal(f.rows()[0].status, 'kept');
});

test('agent_merge drop rolls back what a handed-over change set applied and discards the rest', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); put(root, 'added.md', 'added\n');
    put(f.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    await finish(async () => {}, { max: 0 });
    return { summary: 'Done.' };
  });
  await f.controller.recordedWork(f.context, { id: 'act-drop', action: 'work', content: 'Edit' }, { signal: new AbortController().signal });
  const [row] = f.rows();
  const call = input => f.controller.backgroundMerge({ projectId: f.project.id, sessionId: f.session.id, changeId: row.id, ...input }).then(result => JSON.parse(result.content[0].text));
  // The change set's own conversation (where its line and card are) may settle it too.
  assert.equal((await call({ action: 'merge' })).status, 'conflict');
  assert.equal(read(f.P, 'added.md'), 'added\n');
  const dropped = await call({ action: 'drop' });
  assert.equal(dropped.status, 'dropped'); assert.deepEqual(dropped.restored, ['added.md']);
  assert.equal(existsSync(join(f.P, 'added.md')), false); assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user)\nthree\n');
  const settled = f.rows()[0];
  assert.equal(settled.status, 'reverted'); assert.equal(settled.discarded, true);
  // agent_merge is the model's tool: its drop is recorded as the agent's.
  assert.ok(f.current().git.applies.filter(item => item.kind === 'rollback').every(item => item.initiator === 'agent'));
  assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'removed');
});

test('stopping a paused run in its worktree applies what it changed; a deferred set that may no longer be written goes to the card', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async root => { put(root, 'paused.md', 'paused\n'); return { control: { kind: 'pause' } }; });
  const action = { id: 'act-stop', action: 'work', title: '扩写第 7 章', content: '扩写第 7 章。' };
  await f.controller.recordedWork(f.context, action, { signal: new AbortController().signal });
  f.context.coordinator.state.actions = [{ ...action, status: 'cancelled', cancellationReason: 'action_control' }];
  f.controller.event(f.context, { type: 'initiative_action_control', actionId: action.id, kind: 'cancel', status: 'applied' });
  await until(() => f.rows().some(row => row.actionId === action.id), 'stopped run settled');
  const stopped = f.rows().find(row => row.actionId === action.id);
  assert.equal(stopped.status, 'kept'); assert.equal(stopped.cancelled, true); assert.equal(read(f.P, 'paused.md'), 'paused\n');
  const line = f.lines().find(item => item.initiativeActionId === `${action.id}-changes`);
  assert.match(line.text, /^这次后台在做：扩写第 7 章\n\n按你的要求停下了。停之前已经改了 1 个文件/); assert.equal(line.initiative.backgroundWork.status, 'cancelled');

  startForegroundTurn(f);
  scriptedWork(f, async (root, { finish }) => { put(root, 'held.md', 'held\n'); await finish(); return { summary: 'Done.' }; });
  await f.controller.recordedWork(f.context, { id: 'act-held', action: 'work', content: 'Write held.md' }, { signal: new AbortController().signal });
  assert.equal(f.rows().find(row => row.actionId === 'act-held').status, 'deferred');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).permissions = { workspace: 'execute', background: 'read', revision: 2 }; });
  finishForegroundTurn(f);
  await until(() => f.rows().find(row => row.actionId === 'act-held').status === 'merge_conflicted', 'held for the card');
  const held = f.rows().find(row => row.actionId === 'act-held');
  assert.equal(held.hold, 'read_only'); assert.equal(existsSync(join(f.P, 'held.md')), false);
  await until(() => f.rows().find(row => row.actionId === 'act-held').card, 'card posted');
  const card = f.store.state.sessions.find(item => item.id === f.session.id).items.find(item => item.interaction?.id === f.rows().find(row => row.actionId === 'act-held').card.interactionId).interaction;
  assert.match(card.questions[0].question, /没有写入项目文件夹的权限/);
  // The user answers: writing is their action, which their foreground write access allows.
  answerCard(f, f.rows().find(row => row.actionId === 'act-held'), 'clean_only');
  await until(() => f.rows().find(row => row.actionId === 'act-held').status === 'kept', 'applied on the answer');
  assert.equal(read(f.P, 'held.md'), 'held\n');
});

test('the decision contract: with worktrees a foreground turn leaves background work its write access and says its writes are applied afterwards', { skip }, async t => {
  const f = await fixture(t);
  startForegroundTurn(f);
  const plain = f.controller.snapshot(f.current());
  assert.equal(plain.actionContracts.work.permissions.effective.background, 'read', 'until isolation is known the old contract stands');
  await f.controller.background.enabled(f.project.id);
  const isolated = f.controller.snapshot(f.current());
  assert.equal(isolated.actionContracts.work.foregroundBusy, true);
  assert.equal(isolated.actionContracts.work.effects, 'A foreground turn is running. Your writes go to your own working copy and are applied after it; do not duplicate the foreground task.');
  assert.equal(isolated.actionContracts.work.permissions.effective.background, 'execute');
  // The level in force rides at the request tail (backgroundLevel); the authorization names it there (PDL-5 phase 2).
  assert.equal(isolated.actionContracts.work.backgroundLevel, 'execute');
  assert.match(isolated.actionContracts.work.authorization, /permission in force \(hostConditions\.work\.backgroundLevel\)/);
  // Plan mode still makes it read only.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).mode = 'plan'; });
  assert.equal(f.controller.snapshot(f.current()).actionContracts.work.permissions.effective.background, 'read');
});

test('a marker line of the run\'s reverse merge left in any file is never applied: another continuation, then the card, and only the clean files on its answer', { skip }, async t => {
  const f = await fixture(t);
  const told = [];
  scriptedWork(f, async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n');
    put(f.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    await finish(async item => {
      told.push(JSON.parse(item.text).files);
      if (told.length > 1) return;
      // The marked file is settled, but its marker block is pasted into another file.
      const marked = read(root, 'notes.md');
      put(root, 'copy.md', marked);
      put(root, 'notes.md', 'one\ntwo (user and background)\nthree\n');
    });
    return { summary: 'Done.' };
  });
  await f.controller.recordedWork(f.context, { id: 'act-stray', action: 'work', content: 'Edit' }, { signal: new AbortController().signal });
  assert.deepEqual(told, [['notes.md'], ['copy.md']], 'the second continuation names the file that still holds a marker line');
  const [row] = f.rows();
  assert.equal(row.status, 'merge_conflicted'); assert.deepEqual(row.conflicts, [{ path: 'copy.md', kind: 'content' }]);
  assert.equal(existsSync(join(f.P, 'copy.md')), false); assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user)\nthree\n');
  // Once the run is over, B itself no longer holds the marker line: no later apply (the worktree panel's too) can carry it.
  const B = await f.roots.rootOf({ projectId: f.project.id, actionId: 'act-stray' });
  assert.equal(existsSync(join(B.root, 'copy.md')), false);
  answerCard(f, row, 'clean_only');
  await until(() => f.rows()[0].status === 'kept', 'clean only');
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user and background)\nthree\n');
  assert.equal(existsSync(join(f.P, 'copy.md')), false, 'the file with a marker line stays out of the project folder');
});

test('a run that ends on the host\'s step-limit conclusion applies only what does not conflict, without a continuation', { skip }, async t => {
  const f = await fixture(t);
  let seen;
  scriptedWork(f, async (root, { finish }) => {
    put(root, 'notes.md', 'one\ntwo (background)\nthree\n'); put(root, 'summary.md', 'summary\n');
    put(f.P, 'notes.md', 'one\ntwo (user)\nthree\n');
    seen = await finish(async () => {}, { message: { role: 'assistant', source: 'step-limit-summary' } });
    return { summary: 'Stopped at the step limit.' };
  });
  await f.controller.recordedWork(f.context, { id: 'act-limit', action: 'work', content: 'Edit' }, { signal: new AbortController().signal });
  assert.deepEqual(seen, [], 'no continuation after the step-limit conclusion');
  const [row] = f.rows();
  assert.equal(row.status, 'merge_conflicted'); assert.ok(row.applyId);
  assert.equal(read(f.P, 'summary.md'), 'summary\n'); assert.equal(read(f.P, 'notes.md'), 'one\ntwo (user)\nthree\n');
  assert.deepEqual(row.conflicts, [{ path: 'notes.md', kind: 'content' }]);
});

test('the background worktree code names no git subcommand that talks to another repository', async () => {
  const network = /(['"`])(?:push|fetch|pull|clone|remote|ls-remote|send-pack|fetch-pack|archive)\1|\bgit\s+(?:push|fetch|pull|clone|remote)\b/;
  for (const file of ['../background-worktree.mjs', '../project-initiative-controller.mjs']) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), network, file);
});
