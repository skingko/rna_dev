import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, git, put, read, skip } from './git-isolation-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { turnFixture, git as turnGit, put as turnPut, until, cardOf } from './helpers/turn-fixture.mjs';
import { HOST_CARDS, MERGE_LABELS, REFS, sameFolder } from '../git-isolation/index.mjs';

// Problems the adversarial review of the 0.63.0 close-out found (and fixed): the writer's folder re-check (sameFolder,
// close-out 4a) refused every write into a folder whose name on disk differs from git's spelling only in case or in
// Unicode normalization — a case-only rename on a case-insensitive volume, a Finder-made name in decomposed form — so
// such applies were blocked for good. Temporary repositories only (no global or system git configuration).

const NFD = 'café', NFC = 'café';
/** A file of P changed in a worker-like copy, merged into P (`all`). */
async function applyChange(f, path, content) {
  const head = git(f.repo, 'rev-parse', 'HEAD').trim();
  const W = f.worktree('worker', `w${Math.random().toString(16).slice(2, 8)}`, head);
  put(W.root, path, content);
  const snap = await f.engine.snapshot(f.project.id, W);
  return f.engine.apply(f.project.id, { target: f.root, base: head, incoming: snap.commit, kind: 'worker', source: { agentId: 'agent-case' }, mode: 'all', labels: MERGE_LABELS.worker('agent-case') });
}

test('sameFolder: a folder whose name on disk differs only in case or Unicode normalization is still the same folder; a link never is', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-samefolder-'))), root = join(dir, 'root');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'Docs', 'inner'), { recursive: true }); mkdirSync(join(root, NFD)); mkdirSync(join(dir, 'outside'));
  assert.equal(await sameFolder(root, root, join(root, 'Docs', 'inner')), true);
  const insensitive = existsSync(join(root, 'docs'));
  if (insensitive) {
    assert.equal(await sameFolder(root, root, join(root, 'docs', 'INNER')), true, 'case only (a case-insensitive volume)');
  }
  if (existsSync(join(root, NFC))) assert.equal(await sameFolder(root, root, join(root, NFC)), true, 'precomposed against decomposed on disk');
  // A link is never the folder, whatever it is called or where it leads.
  symlinkSync(join(dir, 'outside'), join(root, 'Linked'));
  assert.equal(await sameFolder(root, root, join(root, 'Linked')), false);
  if (insensitive) assert.equal(await sameFolder(root, root, join(root, 'linked')), false, 'nor through a case-folded name');
  symlinkSync(join(root, 'Docs'), join(root, 'docs-link'));
  assert.equal(await sameFolder(root, root, join(root, 'docs-link', 'inner')), false, 'a link back inside the root is still not the folder');
});

test('an apply into P lands in a folder renamed in case only (git keeps the old spelling on a case-insensitive volume)', { skip }, async t => {
  const f = fixture(t, { files: { 'docs/a.md': 'one\n' } });
  renameSync(join(f.workspace, 'docs'), join(f.workspace, 'docs-renaming')); renameSync(join(f.workspace, 'docs-renaming'), join(f.workspace, 'Docs'));
  if (!existsSync(join(f.workspace, 'docs'))) return t.skip('needs a case-insensitive volume');
  const outcome = await applyChange(f, 'docs/a.md', 'two\n');
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome.conflicts));
  assert.equal(read(f.workspace, 'Docs/a.md'), 'two\n');
  assert.ok(!f.applies().some(row => row.state === 'writing'));
});

test('an apply into P lands in a folder whose name is stored decomposed (a Finder-made name) while git spells it precomposed', { skip }, async t => {
  const f = fixture(t, { files: { 'x.txt': 'x\n' } });
  mkdirSync(join(f.workspace, NFD)); writeFileSync(join(f.workspace, NFD, 'a.md'), 'one\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-q', '-m', 'decomposed folder');
  if (!existsSync(join(f.workspace, NFC))) return t.skip('needs a normalization-insensitive volume');
  const tracked = git(f.repo, '-c', 'core.quotePath=false', 'ls-files').split('\n').find(path => path.endsWith('/a.md'));
  const outcome = await applyChange(f, tracked, 'two\n');
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome.conflicts));
  assert.equal(read(f.workspace, `${NFD}/a.md`), 'two\n');
});

test('a turn whose checkpoint ref this sweep deleted reads expired even when the turn itself finished later (paused, then finished)', { skip }, async t => {
  const f = turnFixture(t);
  const day = 86400000, now = Date.now();
  process.env.GIT_COMMITTER_DATE = new Date(now - 40 * day).toISOString();
  let old;
  try { old = turnGit(f.repo, 'commit-tree', 'HEAD^{tree}', '-m', 'old').trim(); } finally { delete process.env.GIT_COMMITTER_DATE; }
  turnGit(f.repo, 'update-ref', REFS.turn('turn-late-01'), old);
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id);
    session.turns.push({ id: 'turn-late-01', status: 'completed', startedAt: new Date(now - 41 * day).toISOString(), completedAt: new Date(now - 10 * day).toISOString(), checkpoint: { ref: REFS.turn('turn-late-01'), state: 'taken' } });
  });
  const result = await f.engine.sweep({ now });
  assert.equal(result.checkpointsExpired, 1);
  assert.equal(f.sessionOf(f.session.id).turns.find(row => row.id === 'turn-late-01').checkpoint.state, 'expired');
});

test('an answer a shutdown stopped is taken up at the next start without a second card for the same conflict', { skip, timeout: 60000 }, async t => {
  const BIN = { base: Buffer.from([0, 1, 2, 3, 0, 9]), conversation: Buffer.from([0, 7, 7, 7, 0, 1]), project: Buffer.from([0, 5, 5, 5, 0, 2]) };
  const f = turnFixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n', 'cover.bin': BIN.base } });
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = (await f.rootOf(s.id)).root;
  writeFileSync(join(S, 'cover.bin'), BIN.conversation); turnPut(S, 'b.txt', 'clean from the conversation\n');
  writeFileSync(join(f.P, 'cover.bin'), BIN.project);
  f.model.steps.push({ text: '看过了。' });
  const turn = await f.send(s.id, '看看');
  assert.equal(turn.apply.status, 'conflicted');
  writeFileSync(join(f.repo, '.git', 'MERGE_HEAD'), turnGit(f.repo, 'rev-parse', 'HEAD'));
  const card = cardOf(f.store, s.id, HOST_CARDS.sessionConflict.actionId(turn.id));
  f.interactions.answer(s.id, card.id, { requestId: `answer-${randomUUID().slice(0, 8)}`, answers: [{ id: 'decision', selected: ['conversation'] }] });
  await until(() => f.sessionOf(s.id).items.some(item => item.kind === 'notice' && /git merge/.test(item.text ?? '')), 'the timeline line');
  f.sessionWorktrees.close();
  await until(() => !f.sessionWorktrees.queues.has(s.id), 'the answer to stop', 5000);
  rmSync(join(f.repo, '.git', 'MERGE_HEAD'));
  await f.sessionWorktrees.recover();
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply.status === 'applied', 'the answer at the next start');
  await delay(200);
  assert.deepEqual([...readFileSync(join(f.P, 'cover.bin'))], [...BIN.conversation]);
  const waiting = f.sessionOf(s.id).items.filter(item => item.interaction?.source === HOST_CARDS.sessionConflict.source && ['pending', 'interrupted'].includes(item.interaction.status));
  assert.deepEqual(waiting.map(item => item.interaction.actionId), [], 'no card is left waiting for a conflict already settled');
});
