import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { IsolationEngine, LIMITS, TRASH_DIR } from '../git-isolation/index.mjs';

// B8: files that hold secrets (SECRET_FILES) never take part in a merge, so a background run's change to one is never
// applied to the project folder. Its change set's line says so (they go to the trash with its working copy) instead of
// dropping them silently, also when they were its only change. Real temporary repositories, the real merge engine and
// worktree service; scripted runs only (no model, no network). Keys are synthetic.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitVersionOk = (() => { try { const [, major, minor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })); return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38); } catch { return false; } })();
const skip = gitVersionOk ? false : 'git 2.38 or later is needed';
const put = (root, path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const read = (root, path) => readFileSync(join(root, path), 'utf8');
const blobOf = (cwd, content) => execFileSync('git', ['hash-object', '--stdin'], { cwd, input: content, encoding: 'utf8' }).trim();
const allObjects = cwd => new Set(git(cwd, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').split('\n').filter(Boolean));
async function until(check, label = 'condition') { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
const decisions = async function* (options) { const input = JSON.parse(options.messages[0].content[0].text); yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', evidenceIds: [input.events.at(-1).id], reason: 'Observed a concrete project fact', nextReviewAfterMs: 600000 }) }; yield { type: 'done', stopReason: 'stop' }; };
const ENV_BEFORE = 'API_KEY=background-synthetic-1\n', ENV_AFTER = 'API_KEY=background-synthetic-2\n';
/** Every file under the project folder's trash, as `<path in its copy>` → content. */
function trashed(P) {
  const out = new Map(), base = join(P, ...TRASH_DIR.split('/'));
  const walk = (dir, rel) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const next = rel ? `${rel}/${entry.name}` : entry.name; if (entry.isDirectory()) walk(join(dir, entry.name), next); else out.set(next.split('/').slice(1).join('/'), readFileSync(join(dir, entry.name), 'utf8')); } };
  if (existsSync(base)) walk(base, '');
  return out;
}

/** A git project whose .env is neither committed nor ignored, with the controller wired to the merge engine. */
async function fixture(t, { language = 'zh' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-bgsecret-'))), P = join(dir, 'project');
  mkdirSync(P);
  put(P, 'notes.md', 'one\n'); put(P, '.gitignore', 'dist/\n');
  git(P, 'init', '-q'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'first');
  put(P, '.env', ENV_BEFORE);
  const store = new Store(join(dir, 'state', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Secret fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Secret fixture', description: 'Keep the notes current', workspace: P, initiative: { cooldownMs: 0, enabled: false } });
  store.mutate(state => {
    state.settings.interfaceLanguage = language;
    const target = state.projects.find(row => row.id === project.id);
    Object.assign(target, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, overview: 'Notes', permissions: { workspace: 'execute', background: 'inherit', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read', 'project_write'], mcpServerIds: [] } });
    target.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] };
  });
  const service = new WorkspaceGitService(store);
  const engine = new IsolationEngine(store, { git: service, ready: true, sandbox: () => true, pollMs: 20, execWaitMs: 100 });
  service.engine = engine;
  const roots = new RootResolver(store, { git: service });
  const worktrees = new WorktreeService(store, { git: service, engine, roots });
  service.owners = path => worktrees.ownerOf(path);
  const interactions = new UserInteractionService(store);
  const evolutionService = new ProjectEvolutionService(store, { provider: decisions });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, interactionService: interactions, evolutionService, decisionProvider: decisions, engine, worktrees, roots });
  t.after(async () => { await controller.close(); interactions.close?.(); engine.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const rows = () => (current().backgroundChanges ?? []).filter(row => row.kind === 'git');
  const lines = () => store.state.sessions.find(row => row.id === session.id).items.filter(item => item.source === 'initiative');
  const records = () => current().git?.worktrees ?? [];
  const context = { projectId: project.id, coordinator: { model: { providerId: provider.id, modelId: 'fixture-model', name: 'Fixture' }, state: { actions: [] }, active: new Map(), _executionBlocked: () => false }, workRuns: new Map(), activeHandles: new Set() };
  await until(() => controller.gitRecovered === true, 'startup pass');
  return { dir, P, store, project, session, controller, current, rows, lines, records, context };
}
/** A stand-in for the run: `script(root, finish)` writes in B and may call the finish hook. */
function scriptedWork(f, script) {
  f.controller.work = async (context, action, input) => {
    context.workRuns.set(action.id, { writable: true, isolated: true });
    const finish = async () => { for (let continuations = 0; ; continuations++) { const answer = await f.controller.finishGitRun(f.context, action, input.bg, { message: { role: 'assistant' }, continuations, remainingContinuations: LIMITS.backgroundFinishContinuations - continuations }); if (!answer) return; } };
    try { return await script(input.bg.root.root, finish); }
    finally { context.workRuns.delete(action.id); }
  };
}

test('a background run\'s change to a file that holds secrets is not applied: its change set names it on the row and in its line, it goes to the trash, and its content never enters the object store', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async (root, finish) => {
    assert.equal(read(root, '.env'), ENV_BEFORE, 'B got the project folder\'s .env as a copy');
    put(root, 'notes.md', 'one\ntwo\n'); put(root, '.env', ENV_AFTER);
    await finish();
    return { summary: 'Added line two and rotated the key.', reported: '加了第二行，换了密钥。' };
  });
  await f.controller.recordedWork(f.context, { id: 'act-secret-1', action: 'work', content: 'Add line two and rotate the key' }, { signal: new AbortController().signal });
  const [row] = f.rows();
  assert.equal(row.status, 'kept');
  assert.deepEqual(row.files.map(item => item.path), ['notes.md']);
  assert.deepEqual(row.secret, ['.env']);
  assert.equal(read(f.P, 'notes.md'), 'one\ntwo\n');
  assert.equal(read(f.P, '.env'), ENV_BEFORE, 'the project folder\'s .env is never written');
  assert.equal(f.records().find(item => item.id === row.worktreeId).state, 'removed');
  assert.deepEqual([...trashed(f.P).entries()].filter(([path]) => path === '.env'), [['.env', ENV_AFTER]], 'the changed .env is in the trash');
  const line = f.lines().find(item => item.initiative?.backgroundChange === row.id);
  assert.match(line.text, /^加了第二行，换了密钥。\n\n改了 1 个文件/);
  assert.match(line.text, /\n\n存放密钥的文件从不从工作副本应用到项目文件夹，所以它改的这 1 个文件没有应用：\.env。工作副本清理时它们会移到项目文件夹的 \.rna\/trash\.nosync，保留 7 天/);
  const objects = allObjects(f.P);
  assert.equal(objects.has(blobOf(f.P, ENV_BEFORE)), false); assert.equal(objects.has(blobOf(f.P, ENV_AFTER)), false);
});

test('a background run that changed only files that hold secrets keeps its line to say so (no change set), in English too', { skip }, async t => {
  const f = await fixture(t, { language: 'en' });
  scriptedWork(f, async (root, finish) => { put(root, 'deploy/prod.env', 'TOKEN=background-synthetic-3\n'); await finish(); return { summary: 'Added the deploy settings.' }; });
  await f.controller.recordedWork(f.context, { id: 'act-secret-2', action: 'work', title: 'Add deploy settings', content: 'Add the deploy settings' }, { signal: new AbortController().signal });
  assert.deepEqual(f.rows(), [], 'nothing to apply: no change set');
  assert.equal(existsSync(join(f.P, 'deploy', 'prod.env')), false);
  assert.equal(trashed(f.P).get('deploy/prod.env'), 'TOKEN=background-synthetic-3\n');
  const line = f.lines().find(item => item.initiativeActionId === 'act-secret-2-changes');
  assert.ok(line, 'the run\'s line stays');
  assert.equal(line.initiative.backgroundWork.status, 'done');
  assert.deepEqual(line.evidenceIds, ['action:act-secret-2:completed'], 'the completed run is reported by its line, as a change set\'s is');
  assert.match(line.text, /^This background task: Add deploy settings\n\nFiles that hold secrets are never applied from a working copy to the project folder, so this one it changed was not: deploy\/prod\.env\. When the working copy is cleaned up they move to the project folder’s \.rna\/trash\.nosync for 7 days/);
  assert.equal(allObjects(f.P).has(blobOf(f.P, 'TOKEN=background-synthetic-3\n')), false);

  // A run that stops without finishing (neither paused nor cancelled) after changing only one says so as well.
  scriptedWork(f, async root => { put(root, '.env', ENV_AFTER); return { control: { kind: 'supersede' } }; });
  await f.controller.recordedWork(f.context, { id: 'act-secret-3', action: 'work', title: 'Rotate the key', content: 'Rotate the key' }, { signal: new AbortController().signal });
  const stopped = f.lines().find(item => item.initiativeActionId === 'act-secret-3-changes');
  assert.ok(stopped, 'the stopped run\'s line stays');
  assert.equal(stopped.initiative.backgroundWork.status, 'stopped');
  assert.equal(stopped.evidenceIds, undefined, 'a stopped run is not reported by its line');
  assert.match(stopped.text, /^This background task was: Rotate the key\n\nThe project changed, so this background work did not go on\.\n\nFiles that hold secrets are never applied .*: \.env\./);
  assert.equal(read(f.P, '.env'), ENV_BEFORE);
  assert.equal(f.records().filter(item => item.owner?.actionId === 'act-secret-3').every(item => item.state === 'removed'), true);
});

test('a background run whose laid-down .env copy nobody touched reports no secret file, and its line is withdrawn as before', { skip }, async t => {
  const f = await fixture(t);
  scriptedWork(f, async (root, finish) => { assert.equal(read(root, '.env'), ENV_BEFORE); await finish(); return { summary: 'Nothing to change.' }; });
  await f.controller.recordedWork(f.context, { id: 'act-secret-4', action: 'work', content: 'Check the notes' }, { signal: new AbortController().signal });
  assert.deepEqual(f.rows(), []);
  assert.equal(f.lines().some(item => item.initiativeActionId === 'act-secret-4-changes'), false, 'the working line went, as for any run that changed nothing');
  assert.equal(trashed(f.P).has('.env'), false, 'an untouched copy is not moved to the trash');
});
