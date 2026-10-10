// D4 scenario (plan B8): a conversation hands work to a subagent worker in a project folder whose .env is neither
// committed nor ignored. The worker's copy gets the .env as P has it; the worker changes notes.md and the .env and
// finishes after its parent's turn ended, so its merge waits for the conversation. Deleting the conversation then asks
// first and names the worker's unmerged change; confirming discards the copy. No version of the .env ever enters the
// repository's object store. Crosses the foreground turn, the builtin agent service (its child on the real provider
// path to the faux model's HTTP endpoint), the worktree service, the merge engine's snapshots, session deletion and the
// DELETE route. Only the model, OpenViking, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, git, gitReady, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { REFS, TRASH_DIR } from '../../git-isolation/index.mjs';

const ENV_BEFORE = 'API_KEY=scenario-synthetic-1\n', ENV_AFTER = 'API_KEY=scenario-synthetic-2\n', NOTES_AFTER = 'one\ntwo by the worker\n';
const gate = () => { let release; const held = new Promise(done => { release = done; }); return { held, release }; };
const blobOf = (cwd, content) => execFileSync('git', ['hash-object', '--stdin'], { cwd, input: content, encoding: 'utf8' }).trim();
const allObjects = cwd => new Set(git(cwd, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').split('\n').filter(Boolean));

test('a worker\'s unmerged copy is named when its conversation is deleted, and the project\'s .env never enters refs/rna', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { files: { 'notes.md': 'one\n', '.gitignore': 'dist/\n' } });
  writeFileSync(join(world.P, '.env'), ENV_BEFORE); // neither committed nor ignored
  const s = scenario(world), child = gate();
  // The worker's requests take the real provider path to the faux model's endpoint; the first waits for the parent's turn to end.
  world.faux.script('http',
    { hold: child.held, then: { toolCalls: [{ name: 'project_read', args: { path: 'notes.md' } }] } },
    // The project tools refuse .env (a private path); a command run in the worker's copy can still change it.
    { toolCalls: [{ name: 'project_write', args: { path: 'notes.md', content: NOTES_AFTER } }, { name: 'project_exec', args: { command: `printf '${ENV_AFTER.trim()}\\n' > .env` } }] },
    'Added the line to notes.md and rotated the key in .env.');

  const started = await s.send('Have a worker extend the notes and rotate the key.', { reply: [{ toolCalls: [{ name: 'agent_delegate', args: { task: 'Add a second line to notes.md and rotate the key in .env.' } }] }, 'A worker is on it.'] });
  const [delegation] = started.outcome.turn.delegations ?? [];
  assert.ok(delegation, 'the turn delegated a worker');
  const record = () => world.app.builtinAgentService.record(world.sessionId, delegation.id);
  const worktree = () => (world.project().git?.worktrees ?? []).find(row => row.owner?.agentId === delegation.id);
  // The worker starts in its own copy and asks the model (its first request is held).
  await until(() => world.faux.of('http').length > 0 && worktree(), 'the worker\'s first request', 60000);
  assert.match(world.faux.of('http')[0].wire, /rotate the key/, 'the worker was asked through the provider path');
  const copy = join(world.P, worktree().dir);
  assert.equal(readFileSync(join(copy, '.env'), 'utf8'), ENV_BEFORE, 'the worker\'s copy has the project\'s .env, laid down from the folder');

  const finished = await s.step('the worker finishes after its parent\'s turn ended', async () => { child.release(); return until(() => (record()?.status !== 'running' && record()?.merge?.status === 'pending' ? record() : null), 'the worker to settle with its merge waiting', 60000); });
  assert.equal(readFileSync(join(copy, '.env'), 'utf8'), ENV_AFTER, 'the worker changed the .env in its copy');
  await finished.expect({
    files: { 'notes.md': 'one\n', '.env': ENV_BEFORE },
    state: () => assert.equal(finished.outcome.merge.reason, 'parent_idle', 'nothing is written while the conversation is idle'),
  });

  // Deleting the conversation without confirming: refused, naming the worker's unmerged changes. The .env never merges,
  // but it would leave with the copy too, so it is counted and named as a secret file (the trash, not Git).
  const refused = await s.step('delete without confirming', () => world.del(`/api/sessions/${world.sessionId}`, {}));
  assert.equal(refused.outcome.status, 409);
  assert.equal(refused.outcome.body.code, 'worktree_unapplied');
  assert.equal(refused.outcome.body.unapplied, 0);
  assert.deepEqual(refused.outcome.body.workers.map(row => [row.agentId, row.files, row.secret, row.task]), [[delegation.id, 2, 1, 'Add a second line to notes.md and rotate the key in .env.']]);
  assert.equal(refused.outcome.body.secret, 1);
  assert.match(refused.outcome.body.error, /trash\.nosync/);
  assert.ok(world.session(), 'still there');

  const deleted = await s.delete(world.sessionId, { confirm: true });
  await deleted.expect({
    files: { 'notes.md': 'one\n', '.env': ENV_BEFORE },
    state: state => assert.equal(state.projects.find(row => row.id === world.projectId).git.worktrees.find(row => row.owner?.agentId === delegation.id).state, 'removed'),
    gitRefs: refs => assert.ok(Object.keys(refs).some(ref => ref.startsWith('refs/rna/wt/') && ref.endsWith('/tip')), 'the discarded copy\'s last state stays pinned'),
  });
  assert.equal(existsSync(copy), false, 'the copy is gone');
  // The worker's changed .env went to the trash with the copy's other files that no snapshot holds.
  const trash = join(world.P, ...TRASH_DIR.split('/'));
  assert.ok(readdirSync(trash).some(name => existsSync(join(trash, name, '.env')) && readFileSync(join(trash, name, '.env'), 'utf8') === ENV_AFTER));

  // The acceptance check of B8: neither version of the .env is an object of the repository, reachable or not; the
  // worker's notes.md is (its tip snapshot).
  const objects = allObjects(world.P);
  assert.equal(objects.has(blobOf(world.P, ENV_BEFORE)), false);
  assert.equal(objects.has(blobOf(world.P, ENV_AFTER)), false);
  assert.equal(objects.has(blobOf(world.P, NOTES_AFTER)), true);
  assert.equal(git(world.P, 'show', `${REFS.worktree(worktree().id, 'tip')}:notes.md`), NOTES_AFTER);
});
