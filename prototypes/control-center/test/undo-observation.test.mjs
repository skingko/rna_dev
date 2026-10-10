import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { fingerprintPaths, createWorkspaceObserver } from '../workspace-observer.mjs';

// A user's undo is not an unexplained directory change (review F2 / K1-2): the panel's discard and a rollback write into
// the project folder outside any running work, and the folder's observation used to report them as a workspace_change,
// new evidence that invalidated the initiative's decision and woke the loop, next to the workspaceEvents entry that
// already says "the user undid this". The engine now hands an undo's writes to the observation, which folds exactly
// those files (by fingerprint) into its baseline. Temporary repositories, a real server and a real intake coordinator;
// no model is called.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna', '-c', 'user.email=rna@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const until = async (check, what) => { const deadline = Date.now() + 15000; while (!check()) { if (Date.now() > deadline) throw new Error(`${what} did not settle`); await delay(5); } };

async function setup(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-undo-observation-'))), workspace = join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  git(workspace, 'init', '-q');
  writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(workspace, 'b.txt'), 'bee\n');
  git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '-m', 'first');
  let clock = Date.parse('2026-10-04T08:00:00Z');
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, runtime: false, initiative: false, observationSources: true, observationOptions: { autoStart: false, now: () => clock, intervalMs: 10, settleMs: 0 } });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const controllers = [];
  t.after(async () => { for (const controller of controllers) await controller.close(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  // A provider that can never answer (a closed local port, a synthetic key): the intake below must not call a model.
  const provider = app.store.configurationService.provider(null, { name: 'Unreachable fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'undo-observation-synthetic-key', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project } = app.store.createProject({ name: 'Undo observation', workspace });
  app.store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' }, rhythm: { control: 'manual' }, assignments: { skillIds: [], toolIds: [], mcpServerIds: [] } }); state.settings.realTokenBudget = 0; });
  const port = app.server.address().port;
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  /** Both steps of a two-step POST (preview, then the confirmation it answered). */
  const twoSteps = async (path, body = {}) => { const first = await call('POST', path, body); assert.equal(first.status, 200, JSON.stringify(first.body)); const second = await call('POST', path, { ...body, confirm: first.body.confirm }); assert.equal(second.status, 200, JSON.stringify(second.body)); return second.body; };
  const current = () => app.store.state.projects.find(row => row.id === project.id);
  const changes = () => (current().observations ?? []).filter(row => row.kind === 'workspace_change');
  // Two forced scans: a change is seen once (settling), then reported.
  const scan = async () => { for (let pass = 0; pass < 2; pass++) { clock += 100; await app.observationService.pump({ force: true }); } };
  return { app, workspace, project, call, twoSteps, current, changes, scan, controllers, now: () => clock };
}

test('the panel\'s discard and a rollback through the routes are folded into the observation baseline: no new evidence, no invalidated decision; a later edit still is', async t => {
  const f = await setup(t), id = f.project.id;
  assert.equal(f.app.engine.undoWrites, f.app.observationService, 'server.mjs hands the engine\'s undo writes to the observation');
  writeFileSync(join(f.workspace, 'a.txt'), 'one\ntwo\nmine\n');
  await f.scan();
  assert.deepEqual(f.changes(), [], 'the baseline is silent');
  // A real initiative intake (it would call no model: no token budget, and its provider throws): what it treats as new
  // evidence invalidates its decision.
  const controller = new ProjectInitiativeController(f.app.store, { now: f.now, initialDelayMs: 86400000, tickIntervalMs: 0, independentLearning: true, decisionProvider: async function* () { throw new Error('the intake must not call a model'); } });
  f.controllers.push(controller);
  await until(() => controller.contexts.get(id)?.initialized, 'the intake context');
  const coordinator = controller.contexts.get(id).coordinator, invalidated = [], invalidate = coordinator.invalidateDecision.bind(coordinator);
  coordinator.invalidateDecision = (...args) => { invalidated.push(args[0]); return invalidate(...args); };
  const evidence = () => controller.sources(f.current(), controller.contexts.get(id).scope).filter(row => row.type === 'workspace_change');

  // The changes panel's discard (a user_discard record), then its rollback (a rollback record the user asked for).
  const discarded = await f.twoSteps(`/api/v2/projects/${id}/git/discard`, { paths: ['a.txt'] });
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'one\ntwo\n');
  await f.scan();
  assert.deepEqual(f.changes(), [], 'the discard is not a directory change');
  const restored = await f.twoSteps(`/api/v2/projects/${id}/applies/${discarded.applyId}/rollback`);
  assert.deepEqual(restored.restored, ['a.txt']); assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'one\ntwo\nmine\n');
  assert.equal(f.current().git.applies.find(row => row.id === restored.applyId).initiator, 'user');
  await f.scan();
  assert.deepEqual(f.changes(), [], 'nor is its rollback');
  assert.deepEqual(evidence(), []); assert.deepEqual(invalidated, [], 'nothing woke the loop');
  assert.equal(f.current().observationSources[0].stats.suppressedDuringExecution, 0, 'not counted as a mixed-origin change');

  // An edit by anyone after the undo, before the next scan, is still a change: only the undo's own write is folded.
  await f.twoSteps(`/api/v2/projects/${id}/git/discard`, { paths: ['a.txt'] });
  writeFileSync(join(f.workspace, 'a.txt'), 'one\ntwo\nedited again after the discard\n');
  await f.scan();
  assert.deepEqual(f.changes().map(row => row.data.changes), [[{ path: 'a.txt', change: 'modified' }]]);
  assert.equal(evidence().length, 1);
  assert.ok(invalidated.length > 0 && invalidated.every(reason => reason === 'new_project_evidence'), JSON.stringify(invalidated));
  // And an unrelated external edit as before.
  writeFileSync(join(f.workspace, 'b.txt'), 'bee, edited outside\n');
  await f.scan();
  assert.deepEqual(f.changes().at(-1).data.changes, [{ path: 'b.txt', change: 'modified' }]);
});

test('a scan that ran while an undo was writing is dropped; the observer folds a known write only at its exact fingerprint', async t => {
  const f = await setup(t), id = f.project.id, service = f.app.observationService;
  await f.scan();
  // An undo begins writing: scans meanwhile see part of it and are dropped (nothing committed, nothing reported).
  const undo = service.undoWrite(id);
  writeFileSync(join(f.workspace, 'a.txt'), 'one\n');
  await f.scan();
  assert.deepEqual(f.changes(), []);
  writeFileSync(join(f.workspace, 'b.txt'), 'bee\nsecond line\n');
  await undo.end(['a.txt', 'b.txt']);
  await undo.end(['b.txt']);
  assert.equal(service.undos.get(id).writing, 0, 'end is idempotent');
  await f.scan();
  assert.deepEqual(f.changes(), [], 'both writes folded');
  assert.equal(service.undos.get(id).paths.size, 0, 'settled by the committed scan');

  // The observer on its own: a { path, fingerprint } entry folds only that content (a plain path, anything).
  const root = join(f.workspace, 'sub'); mkdirSync(root); writeFileSync(join(root, 'x.txt'), 'x\n'); writeFileSync(join(root, 'y.txt'), 'y\n');
  const observer = createWorkspaceObserver({ root, settleMs: 0 });
  t.after(() => observer.close());
  const poll = async options => { const result = await observer.poll(options); if (result.checkpoint) observer.commit(result.checkpoint); return result; };
  await poll();
  writeFileSync(join(root, 'x.txt'), 'x written by the undo\n'); writeFileSync(join(root, 'y.txt'), 'y written by the undo\n');
  const known = await fingerprintPaths({ root, paths: ['x.txt', 'y.txt', 'gone.txt', '../escape.txt', '.env'] });
  assert.deepEqual([...known.keys()].sort(), ['gone.txt', 'x.txt', 'y.txt'], 'unsafe and ignored paths are left out');
  assert.equal(known.get('gone.txt'), null);
  writeFileSync(join(root, 'y.txt'), 'y edited by someone after the undo\n');
  const first = await poll({ suppressPaths: [...known].map(([path, fingerprint]) => ({ path, fingerprint })) });
  assert.deepEqual({ status: first.status, ownWrites: first.ownWrites, suppressed: first.suppressed, pending: first.checkpoint.pending.paths }, { status: 'settling', ownWrites: 1, suppressed: 0, pending: ['y.txt'] });
  const second = await poll();
  assert.deepEqual(second.changes.map(change => change.path), ['y.txt']);
});
