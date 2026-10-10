// D4 scenario (B8 review finding 1): a conversation that runs in its own worktree writes a file that holds secrets
// (deploy/prod.env) next to an ordinary one. Its turn applies the ordinary file to the project folder and never the
// secret one; the user is told in the timeline where it is, the model hears it with its next request through the
// provider path, and deleting the conversation asks first, counting it as a secret file that goes to the trash.
// No version of it ever enters the repository's object store. Crosses POST /api/sessions (worktree), the foreground
// turn in S, the turn-end apply, the timeline, the next turn's request hook, DELETE /api/sessions/:id and the worktree
// removal. Only the model, OpenViking, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, git, gitReady } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { TRASH_DIR } from '../../git-isolation/index.mjs';

const NOTES = 'one\ntwo by the conversation\n', ENV = 'TOKEN=scenario-synthetic-session\n';
const blobOf = (cwd, content) => execFileSync('git', ['hash-object', '--stdin'], { cwd, input: content, encoding: 'utf8' }).trim();
const allObjects = cwd => new Set(git(cwd, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').split('\n').filter(Boolean));

test('a worktree conversation\'s secret file is never applied: the user and the model are told, deleting counts it, and it is never hashed', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { files: { 'notes.md': 'one\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  const created = await world.post('/api/sessions', { projectId: world.projectId, title: 'In its own worktree', worktree: true });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  const sessionId = created.body.id;

  const wrote = await s.send('Extend the notes and add the production env file.', { sessionId, reply: [
    { toolCalls: [{ name: 'project_read', args: { path: 'notes.md' } }] },
    { toolCalls: [{ name: 'project_write', args: { path: 'notes.md', content: NOTES } }, { name: 'project_write', args: { path: 'deploy/prod.env', content: ENV } }] },
    'Extended the notes and wrote deploy/prod.env.',
  ] });
  const worktree = () => (world.project().git?.worktrees ?? []).find(row => row.kind === 'session' && row.owner?.sessionId === sessionId);
  const copy = join(world.P, worktree().dir);
  await wrote.expect({
    files: { 'notes.md': NOTES, 'deploy/prod.env': null },
    state: state => {
      const session = state.sessions.find(row => row.id === sessionId), turn = session.turns.find(row => row.id === wrote.outcome.turnId);
      assert.equal(turn.apply.status, 'applied', 'the ordinary file was applied');
      const lines = session.items.filter(item => item.kind === 'notice' && item.source === 'worktree' && item.text.includes('deploy/prod.env'));
      assert.equal(lines.length, 1, 'the user is told once, in the timeline');
      assert.match(lines[0].text, /存放密钥|hold secrets/); assert.ok(lines[0].text.includes(worktree().dir), 'with where the file is');
    },
  });
  assert.equal(readFileSync(join(copy, 'deploy/prod.env'), 'utf8'), ENV, 'the file stays in the worktree');

  // The next turn: the model hears it through the provider path, with its first request (a one-request turn: the note
  // never waits for the turn's start sync).
  const next = await s.send('Anything left to do?', { sessionId, reply: ['No, the notes are done.'] });
  await next.expect({
    requests: rows => { assert.equal(rows.length, 1); assert.ok(/never applies files that hold secrets/.test(rows[0].wire) && rows[0].wire.includes('deploy/prod.env'), 'the model is told the file is only in its copy'); },
    state: state => assert.equal(state.sessions.find(row => row.id === sessionId).items.filter(item => item.kind === 'notice' && item.text.includes('deploy/prod.env')).length, 1, 'not told again'),
  });

  // Deleting the conversation asks first and counts the secret file, saying where it goes.
  const refused = await s.step('delete without confirming', () => world.del(`/api/sessions/${sessionId}`, {}));
  assert.equal(refused.outcome.status, 409);
  assert.equal(refused.outcome.body.code, 'worktree_unapplied');
  assert.equal(refused.outcome.body.unapplied, 1); assert.equal(refused.outcome.body.secret, 1);
  assert.match(refused.outcome.body.error, /trash\.nosync/);
  assert.ok(world.session(sessionId), 'still there');

  const deleted = await s.delete(sessionId, { confirm: true });
  await deleted.expect({ files: { 'notes.md': NOTES, 'deploy/prod.env': null } });
  assert.equal(existsSync(copy), false, 'the worktree is gone');
  const trash = join(world.P, ...TRASH_DIR.split('/'));
  assert.ok(readdirSync(trash).some(name => existsSync(join(trash, name, 'deploy/prod.env')) && readFileSync(join(trash, name, 'deploy/prod.env'), 'utf8') === ENV), 'kept in the trash, as the confirmation said');

  // B8's acceptance check: the secret file is no object of the repository, reachable or not; the notes are.
  const objects = allObjects(world.P);
  assert.equal(objects.has(blobOf(world.P, ENV)), false);
  assert.equal(objects.has(blobOf(world.P, NOTES)), true);
});
