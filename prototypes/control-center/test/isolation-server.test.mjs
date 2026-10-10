import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { changeMaintenance, initialMaintenance, persistMaintenance } from '../application-maintenance-state.mjs';
import { ISOLATION_READY } from '../git-isolation/index.mjs';

// 0.63 integration (worktree design §16 step 5): server.mjs builds one engine, resolver and worktree service around one
// WorkspaceGitService, hands them to every team's service, registers the apply / worktree routes behind the
// maintenance gate, and projects only the small part of project.git. Temporary repositories only.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna', '-c', 'user.email=rna@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function setup(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-isolation-server-'))), workspace = join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  git(workspace, 'init', '-q');
  writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(workspace, 'b.txt'), 'bee\n');
  git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '-m', 'first');
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, runtime: false, ...options });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = app.store.createProject({ name: 'Isolation', workspace, initiative: { enabled: false } }).project;
  const port = app.server.address().port;
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, directory, workspace, project, call };
}

test('one git service, engine, resolver and worktree service are shared by every team\'s service', async t => {
  const f = await setup(t, { runtime: true, initiative: false });
  const { app } = f;
  assert.equal(ISOLATION_READY, true, 'the release gate is open since the desktop walk-through passed (0.63.3)');
  assert.equal(app.engine.git, app.workspaceGit); assert.equal(app.roots.git, app.workspaceGit); assert.equal(app.worktrees.git, app.workspaceGit);
  assert.equal(app.workspaceGit.engine, app.engine, 'the panel\'s discard checkpoints through the engine');
  assert.equal(typeof app.workspaceGit.owners, 'function');
  assert.equal(app.worktrees.engine, app.engine); assert.equal(app.worktrees.roots, app.roots);
  assert.equal(app.sessionWorktrees.engine, app.engine); assert.equal(app.sessionWorktrees.worktrees, app.worktrees); assert.equal(app.sessionWorktrees.roots, app.roots); assert.equal(app.sessionWorktrees.interactions, app.interactions);
  assert.equal(app.checkpoints.engine, app.engine); assert.equal(app.checkpoints.roots, app.roots);
  assert.equal(app.executor.roots, app.roots); assert.equal(app.executor.sessionWorktrees, app.sessionWorktrees); assert.equal(app.executor.checkpoints, app.checkpoints);
  for (const key of ['engine', 'roots', 'worktrees', 'sessionWorktrees']) assert.equal(app.builtinAgentService[key], app[key], key);
  assert.equal(app.terminals.roots, app.roots); assert.equal(app.workspaceInspection.roots, app.roots);
  assert.equal(app.deletions.sessionWorktrees, app.sessionWorktrees); assert.equal(app.deletions.worktrees, app.worktrees);
  // execRunning reaches the runtime controller's count; attributable reaches the turn checkpoints.
  assert.equal(app.engine.execRunning(f.project.id), 0);
  app.executor.execCounts.set(f.project.id, 2);
  assert.equal(app.engine.execRunning(f.project.id), 2); assert.equal(app.roots.execRunning(f.project.id), 2);
  app.executor.execCounts.delete(f.project.id);
  await assert.rejects(app.engine.attributable(f.project.id, 'no-such-turn'), error => error.code === 'turn_checkpoint_missing');
  // Startup recovery ran (runtime on): engine writes wait for it.
  assert.ok(app.engine.recovering instanceof Promise);
  assert.deepEqual(await app.engine.recovering, { verified: [], completed: [], interrupted: [] });
});

test('the background controller and agent_merge({ changeId }) are wired when initiative runs', async t => {
  const f = await setup(t, { runtime: true, initiative: true, initiativeOptions: { initialDelayMs: 3600000, tickIntervalMs: 0, decisionProvider: null } });
  const { app } = f;
  for (const key of ['engine', 'worktrees', 'roots']) assert.equal(app.projectInitiative.background[key], app[key], key);
  let forwarded = null;
  app.projectInitiative.backgroundMerge = async (input, signal) => { forwarded = { input, signal }; return { content: [{ type: 'text', text: '{}' }] }; };
  const controller = new AbortController();
  await app.builtinAgentService.backgroundMerge({ projectId: f.project.id, changeId: 'c1' }, controller.signal);
  assert.deepEqual(forwarded.input, { projectId: f.project.id, changeId: 'c1' }); assert.equal(forwarded.signal, controller.signal);
});

test('with the release gate open, a git project reports isolation by this machine\'s conditions, not not_ready', async t => {
  const f = await setup(t), id = f.project.id;
  const list = await f.call('GET', `/api/v2/projects/${id}/worktrees`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.notEqual(list.body.isolation.reason, 'not_ready', JSON.stringify(list.body.isolation));
});

test('isolation routes answer through the server; a worktree conversation is refused while isolation is off', async t => {
  const f = await setup(t), id = f.project.id;
  // The gate held closed for this engine: what "isolation off" means stays covered now the release gate is open.
  f.app.engine.settings.ready = false;
  const list = await f.call('GET', `/api/v2/projects/${id}/worktrees`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.worktrees, []);
  assert.equal(list.body.isolation.enabled, false); assert.equal(list.body.isolation.reason, 'not_ready');
  assert.deepEqual((await f.call('GET', `/api/v2/projects/${id}/applies`)).body, { applies: [] });
  const invalid = await f.call('GET', `/api/v2/projects/${id}/applies?limit=0`);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.code, 'applies_request_invalid');
  const missing = await f.call('POST', `/api/v2/projects/${id}/applies/a0000000/rollback`, {});
  assert.equal(missing.status, 404); assert.equal(missing.body.code, 'apply_not_found');
  const turn = await f.call('POST', `/api/v2/projects/${id}/turns/t-none/rollback`, {});
  assert.equal(turn.status, 409); assert.equal(turn.body.code, 'turn_checkpoint_missing');
  // A turn's host-computed changes are a read next to its rollback.
  const changes = await f.call('GET', `/api/v2/projects/${id}/turns/t-none/changes`);
  assert.equal(changes.status, 404, JSON.stringify(changes.body)); assert.equal(changes.body.code, 'turn_not_found');
  const worktree = await f.call('POST', `/api/v2/projects/${id}/worktrees/w-none/apply`, {});
  assert.equal(worktree.status, 404, JSON.stringify(worktree.body)); assert.equal(worktree.body.code, 'worktree_not_found');
  // The git panel's own list is a different route and still answers.
  assert.equal((await f.call('GET', `/api/v2/projects/${id}/git/worktrees`)).status, 200);

  const refused = await f.call('POST', '/api/sessions', { projectId: id, title: 'Isolated', worktree: true });
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'worktree_unavailable'); assert.equal(refused.body.reason, 'not_ready');
  assert.equal(f.app.store.state.sessions.filter(session => session.projectId === id && session.title === 'Isolated').length, 0, 'nothing was created');
  const direct = await f.call('POST', '/api/sessions', { projectId: id, title: 'Direct' });
  assert.equal(direct.status, 201); assert.equal(direct.body.worktree, undefined, 'a direct-mode conversation');
});

test('a pilot project is isolated before the release gate opens; other projects stay as they are', async t => {
  const f = await setup(t), id = f.project.id;
  f.app.engine.settings.ready = false;
  const before = await f.call('GET', `/api/v2/projects/${id}/worktrees`);
  assert.equal(before.body.isolation.reason, 'not_ready');
  const patched = await f.call('PATCH', `/api/projects/${id}`, { git: { isolationPilot: true } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(f.app.store.state.projects.find(row => row.id === id).git.isolationPilot, true);
  const after = await f.call('GET', `/api/v2/projects/${id}/worktrees`);
  // The gate no longer stops it; the next condition on this machine decides (enabled, or sandbox/git/repository reasons).
  assert.notEqual(after.body.isolation.reason, 'not_ready', JSON.stringify(after.body.isolation));
  for (const bad of [{ isolationPilot: 'yes' }, {}, { isolationPilot: true, other: true }]) assert.equal((await f.call('PATCH', `/api/projects/${id}`, { git: bad })).status, 400, JSON.stringify(bad));
  await f.call('PATCH', `/api/projects/${id}`, { git: { isolationPilot: false } });
  assert.equal(f.app.store.state.projects.find(row => row.id === id).git.isolationPilot, undefined);
  assert.equal((await f.call('GET', `/api/v2/projects/${id}/worktrees`)).body.isolation.reason, 'not_ready');
});

test('the panel\'s discard checkpoints first through the server, and the record rolls back in two steps', async t => {
  const f = await setup(t), id = f.project.id;
  writeFileSync(join(f.workspace, 'a.txt'), 'one\ntwo\nmine\n');
  const preview = await f.call('POST', `/api/v2/projects/${id}/git/discard`, { paths: ['a.txt'] });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const discarded = await f.call('POST', `/api/v2/projects/${id}/git/discard`, { paths: ['a.txt'], confirm: preview.body.confirm });
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.ok(discarded.body.applyId, 'the discard answers its user_discard record');
  const applies = (await f.call('GET', `/api/v2/projects/${id}/applies`)).body.applies;
  assert.deepEqual(applies.map(row => [row.id, row.kind]), [[discarded.body.applyId, 'user_discard']]);
  const first = await f.call('POST', `/api/v2/projects/${id}/applies/${discarded.body.applyId}/rollback`, {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the first step changes nothing');
  const second = await f.call('POST', `/api/v2/projects/${id}/applies/${discarded.body.applyId}/rollback`, { confirm: first.body.confirm });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'one\ntwo\nmine\n', 'the discarded edit is back');
  assert.match(git(f.workspace, 'rev-parse', `refs/rna/apply/${second.body.applyId}`), /^[0-9a-f]{40}/, 'checkpoints are pinned under refs/rna');
  assert.equal(git(f.workspace, 'diff', '--cached', '--name-only'), '', 'the user\'s index is untouched');
});

test('isolation writes wait while maintenance holds; reads stay available', async t => {
  const f = await setup(t), id = f.project.id, stateFile = join(f.directory, '.state', 'state.json');
  const row = persistMaintenance(stateFile, initialMaintenance('backup', {}, randomUUID(), {})); f.app.maintenanceGate.refresh();
  assert.equal(f.app.maintenanceGate.held, true);
  assert.equal((await f.call('GET', `/api/v2/projects/${id}/worktrees`)).status, 200);
  assert.equal((await f.call('GET', `/api/v2/projects/${id}/applies`)).status, 200);
  for (const path of [`/api/v2/projects/${id}/applies/a1/rollback`, `/api/v2/projects/${id}/turns/t1/rollback`, `/api/v2/projects/${id}/worktrees/w1/apply`, `/api/v2/projects/${id}/worktrees/w1/discard`, `/api/v2/projects/${id}/git/init`]) {
    const held = await f.call('POST', path, {});
    assert.equal(held.status, 503, path); assert.equal(held.body.code, 'maintenance_held', path);
  }
  await changeMaintenance(stateFile, row.id, value => ({ ...value, held: false, phase: 'cancelled' })); f.app.maintenanceGate.refresh();
});

test('deleting a conversation whose worktree holds unapplied files needs confirm: true', async t => {
  const f = await setup(t), id = f.project.id;
  const created = await f.call('POST', '/api/sessions', { projectId: id, title: 'Kept work' });
  const sessionId = created.body.id;
  f.app.store.mutate(state => { state.sessions.find(row => row.id === sessionId).worktree = { id: randomUUID(), state: 'kept' }; });
  f.app.sessionWorktrees.unapplied = async asked => ({ unapplied: asked === sessionId ? 3 : 0 });
  const refused = await f.call('DELETE', `/api/sessions/${sessionId}`, {});
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'worktree_unapplied'); assert.equal(refused.body.unapplied, 3);
  assert.ok(f.app.store.state.sessions.some(row => row.id === sessionId), 'not deleted');
  const deleted = await f.call('DELETE', `/api/sessions/${sessionId}`, { confirm: true });
  assert.ok([200, 202].includes(deleted.status), JSON.stringify(deleted.body));
  assert.ok(!f.app.store.state.sessions.some(row => row.id === sessionId));
});

test('project summaries carry only the switch default and the init receipt; git change rows carry their apply record', async t => {
  const f = await setup(t), id = f.project.id;
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === id);
    project.git = { sessionWorktreeDefault: false, init: { at: '2026-10-04T00:00:00.000Z', by: 'rna', commit: 'c'.repeat(40), branch: 'main', largeFiles: ['big.bin'] },
      worktrees: [{ id: 'w1', kind: 'worker', state: 'removed' }], applies: Array.from({ length: 30 }, (_, index) => ({ id: `a${index}`, kind: 'turn', state: 'verified' })) };
    project.backgroundChanges = [{ id: 'c-git', actionId: 'act', at: '2026-10-04T00:00:00.000Z', status: 'merge_conflicted', kind: 'git', applyId: 'a1', applyIds: ['a1', 'a2'], worktreeId: 'b-act', files: [{ path: 'x.md' }], conflicts: [{ path: 'x.md', kind: 'content', currentSha256: 'f'.repeat(64) }], handoff: { secret: true }, hold: 'read_only', handedTo: 'session-2', card: { sessionId: 'session-2', interactionId: 'ix' }, retryAt: 1 },
      { id: 'c-old', actionId: 'act0', at: '2026-10-03T00:00:00.000Z', status: 'kept', files: [{ path: 'y.md' }] }];
  });
  const summary = (await f.call('GET', `/api/v2/projects/${id}`)).body;
  assert.deepEqual(summary.git, { sessionWorktreeDefault: false, init: { at: '2026-10-04T00:00:00.000Z', by: 'rna', commit: 'c'.repeat(40), branch: 'main' } }, 'no applies, no worktrees');
  const [gitRow, oldRow] = summary.backgroundChanges;
  assert.deepEqual(gitRow, { id: 'c-git', actionId: 'act', at: '2026-10-04T00:00:00.000Z', status: 'merge_conflicted', count: 1, paths: ['x.md'], kind: 'git', applyId: 'a1', applyIds: ['a1', 'a2'], worktreeId: 'b-act', conflicts: [{ path: 'x.md', kind: 'content' }], hold: 'read_only', handedTo: 'session-2' }, 'why it waits and who holds it ride along; handoff, card and retryAt stay on the host');
  assert.deepEqual(Object.keys(oldRow).sort(), ['actionId', 'at', 'count', 'id', 'paths', 'status'], 'older rows keep their shape');
  const patched = await f.call('PATCH', `/api/projects/${id}`, { git: { sessionWorktreeDefault: true } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal((await f.call('GET', `/api/v2/projects/${id}`)).body.git.sessionWorktreeDefault, true);
  const bootstrap = (await f.call('GET', '/api/v2/bootstrap')).body;
  assert.deepEqual(Object.keys(bootstrap.projects.find(row => row.id === id).git).sort(), ['init', 'sessionWorktreeDefault']);
});
