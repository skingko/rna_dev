import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { turnFixture, put, read, there, skip, git, until, cardOf } from './helpers/turn-fixture.mjs';
import { fixture as engineFixture } from './git-isolation-fixture.mjs';
import { HOST_CARDS, LIMITS, MERGE_LABELS, REFS, sameFolder } from '../git-isolation/index.mjs';
import { WorkspaceInspectionService } from '../workspace-inspection-service.mjs';
import { isolatedPreview, previewSandboxProfile, startVitePreview } from '../workspace-dev-preview.mjs';
import { sandboxAvailable } from '../../../packages/sdk/src/workspace-exec.mjs';
import { projectDetail, projectSummary } from '../api-v2.mjs';
import { Store } from '../store.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { IsolationEngine } from '../git-isolation/index.mjs';
import { BuiltinAgentService } from '../builtin-agent-service.mjs';

// The host items left before the 0.63 isolation gate can open (reviews of the 0.63.0 build): a worktree turn's
// rollback takes its card's resolve records with it, a pending worktree conversation previews the project folder,
// the summary stays small, host writes into worktrees re-check their folders, a worktree's dev preview runs sandboxed,
// a card answer held on the user's git operation says so and lets shutdown go on, a deleted project releases its
// worktrees, a dropped worker merged into S settles its record, and old turn checkpoints read as expired.
// Real temporary repositories (no global or system git configuration), the real engine, scripted models: no network,
// no paid model, never the user's projects or production state.

const answer = (f, sessionId, interactionId, choice) => f.interactions.answer(sessionId, interactionId, { requestId: `answer-${randomUUID().slice(0, 8)}`, answers: [{ id: 'decision', selected: [choice] }] });
const bytesOf = (root, path) => [...readFileSync(join(root, path))];
const BINARY = { base: Buffer.from([0, 1, 2, 3, 0, 9]), conversation: Buffer.from([0, 7, 7, 7, 0, 1]), project: Buffer.from([0, 5, 5, 5, 0, 2]) };
/** Files under a folder whose name starts with `.rna-tmp-` (a write's temporary files), `.git` included when asked. */
const temporaries = (root, { git: withGit = false } = {}) => {
  const found = [];
  const walk = folder => { for (const entry of readdirSync(folder, { withFileTypes: true })) { if (entry.name === '.git' && !withGit) continue; const path = join(folder, entry.name); if (entry.name.startsWith('.rna-tmp-')) found.push(path); else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path); } };
  walk(root);
  return found;
};

/** A worktree conversation whose turn ends with a binary conflict (and a clean new file) waiting on the card. */
async function binaryConflict(f) {
  const s = f.worktreeSession();
  await f.send(s.id, '开始');
  const S = (await f.rootOf(s.id)).root;
  writeFileSync(join(S, 'cover.bin'), BINARY.conversation); put(S, 'b.txt', 'clean from the conversation\n');
  writeFileSync(join(f.P, 'cover.bin'), BINARY.project);
  f.model.steps.push({ text: '看过了。' });
  const turn = await f.send(s.id, '看看');
  assert.equal(turn.apply.status, 'conflicted', JSON.stringify(turn.apply));
  assert.equal(there(f.P, 'b.txt'), false, 'a finish conflict writes nothing');
  return { s, S, turn };
}

// ---- 1. A worktree turn's rollback includes the resolve records its card wrote ----

test('回退本轮 of a worktree turn also rolls back what its card\'s "this conversation\'s version" wrote, in one step that one undo restores', { skip }, async t => {
  const f = turnFixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n', 'cover.bin': BINARY.base } });
  const { s, turn } = await binaryConflict(f);
  await f.sessionWorktrees.answerConflict(s.id, turn.id, 'conversation');
  assert.deepEqual(bytesOf(f.P, 'cover.bin'), [...BINARY.conversation]); assert.equal(read(f.P, 'b.txt'), 'clean from the conversation\n');
  const mine = f.applies().filter(row => row.source?.turnId === turn.id && row.target === 'project');
  assert.deepEqual(mine.map(row => row.kind).sort(), ['resolve', 'turn'], 'the clean part as a turn record, the card\'s take as a resolve record');
  const preview = await f.engine.rollbackTurn(f.project.id, turn.id, {});
  assert.deepEqual(preview.files.map(row => row.path).sort(), ['b.txt', 'cover.bin'], 'the preview lists the resolve record\'s file too');
  const done = await f.engine.rollbackTurn(f.project.id, turn.id, { confirm: preview.confirm });
  assert.deepEqual(bytesOf(f.P, 'cover.bin'), [...BINARY.project], 'the project folder\'s version is back');
  assert.equal(there(f.P, 'b.txt'), false);
  const rollback = f.applies().find(row => row.id === done.applyId);
  assert.equal(rollback.kind, 'rollback'); assert.equal(rollback.undoesTurn, turn.id);
  assert.equal(f.applies().filter(row => row.kind === 'rollback').length, 1, 'one rollback record for the whole turn');
  for (const row of mine) assert.deepEqual([f.applies().find(item => item.id === row.id).state, f.applies().find(item => item.id === row.id).rolledBackBy], ['rolled_back', done.applyId], row.kind);
  // One undo brings both back.
  const undoPreview = await f.engine.rollback(f.project.id, done.applyId, {});
  await f.engine.rollback(f.project.id, done.applyId, { confirm: undoPreview.confirm });
  assert.deepEqual(bytesOf(f.P, 'cover.bin'), [...BINARY.conversation]); assert.equal(read(f.P, 'b.txt'), 'clean from the conversation\n');
  for (const row of mine) assert.equal(f.applies().find(item => item.id === row.id).state, 'verified', `${row.kind} is in effect again`);
  await assert.rejects(f.engine.rollbackTurn(f.project.id, 'turn-unknown', {}), { code: 'turn_checkpoint_missing' });
});

test('a resolve that undid an interrupted apply ("go back to before") stays out of its turn\'s rollback', { skip }, async t => {
  const f = turnFixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n', 'cover.bin': BINARY.base } });
  const { s, turn } = await binaryConflict(f);
  await f.sessionWorktrees.answerConflict(s.id, turn.id, 'conversation');
  const take = f.applies().find(row => row.kind === 'resolve' && row.source?.turnId === turn.id);
  // A resolve with `undoes` (as resolveInterrupted('restore') writes) for this turn: rolling it back would redo a write.
  f.store.mutate(state => { const rows = state.projects.find(row => row.id === f.project.id).git.applies; rows.push({ ...structuredClone(take), id: 'a-restore0001', undoes: take.id, at: new Date().toISOString() }); });
  const preview = await f.engine.rollbackTurn(f.project.id, turn.id, {});
  await f.engine.rollbackTurn(f.project.id, turn.id, { confirm: preview.confirm });
  assert.equal(f.applies().find(row => row.id === 'a-restore0001').state, 'verified', 'not part of the turn\'s rollback');
  assert.equal(f.applies().find(row => row.id === take.id).state, 'rolled_back');
});

// ---- 2. A pending worktree conversation reads and previews the project folder ----

test('a worktree conversation whose worktree is not made yet previews and reads the project folder; once its worktree exists the preview closes and restarts in it', { skip }, async t => {
  const f = turnFixture(t);
  const inspection = new WorkspaceInspectionService(f.store, { getDaemonOrigin: () => 'http://127.0.0.1:4317', roots: f.roots });
  t.after(() => inspection.close());
  put(f.P, 'index.html', '<p>project folder</p>\n');
  const s = f.worktreeSession();
  assert.equal(f.sessionOf(s.id).worktree.state, 'pending');
  await assert.rejects(f.rootOf(s.id), { code: 'worktree_pending' }, 'the resolver still refuses to name a folder');
  assert.equal((await inspection.read(f.project.id, { path: 'index.html', sessionId: s.id })).content, '<p>project folder</p>\n');
  assert.ok((await inspection.list(f.project.id, { sessionId: s.id })).entries.some(row => row.name === 'index.html'));
  const preview = await inspection.startPreview(f.project.id, { mode: 'static', path: 'index.html', sessionId: s.id }, { sessionId: s.id });
  assert.equal(preview.status, 'ready');
  assert.equal(await (await fetch(preview.url)).text(), '<p>project folder</p>\n');
  // The first turn makes the worktree: the scope opened on the project folder is stale now.
  f.model.steps.push({ text: '好了。' });
  await f.send(s.id, '开始');
  assert.equal(f.sessionOf(s.id).worktree.state, 'active');
  await until(() => inspection.previewStatus(f.project.id).status === 'stopped', 'the preview to close');
  const S = (await f.rootOf(s.id)).root;
  put(S, 'index.html', '<p>this conversation</p>\n');
  const again = await inspection.startPreview(f.project.id, { mode: 'static', path: 'index.html', sessionId: s.id }, { sessionId: s.id });
  assert.equal(await (await fetch(again.url)).text(), '<p>this conversation</p>\n', 'now its own worktree');
  assert.equal((await inspection.read(f.project.id, { path: 'index.html', sessionId: s.id })).content, '<p>this conversation</p>\n');
});

// ---- 3. Summaries stay small ----

test('a project summary carries only the switch default and the init receipt however many apply records and worktrees the project has', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-summary-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'p'));
  const store = new Store(join(dir, 'state', 'state.json'));
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const { project } = store.createProject({ name: 'Summary', workspace: join(dir, 'p'), initiative: { enabled: false } });
  const size = () => Buffer.byteLength(JSON.stringify(projectSummary(store, store.state.projects.find(row => row.id === project.id))));
  store.mutate(state => { state.projects.find(row => row.id === project.id).git = { sessionWorktreeDefault: false, worktrees: [], applies: [] }; });
  const bare = size();
  store.mutate(state => {
    const row = state.projects.find(item => item.id === project.id);
    row.git = { sessionWorktreeDefault: true, init: { at: '2026-10-04T00:00:00.000Z', by: 'rna', commit: 'c'.repeat(40), branch: 'main', largeFiles: Array.from({ length: 200 }, (_, index) => `assets/big-${index}.bin`) },
      worktrees: Array.from({ length: 60 }, (_, index) => ({ id: `wt-${index}`, kind: 'worker', name: `w-${index}`, dir: `.rna/worktrees.nosync/w-${index}`, prefix: '', owner: { agentId: `agent-${index}` }, seed: 'd'.repeat(40), state: 'removed', createdAt: '2026-10-01T00:00:00.000Z', laid: [{ path: '.env', kind: 'copy' }] })),
      applies: Array.from({ length: LIMITS.appliesPerProject }, (_, index) => ({ id: `a${String(index).padStart(16, '0')}`, kind: 'turn', target: 'project', source: { sessionId: 's', turnId: `t-${index}` }, state: 'verified', files: 20, added: 1, removed: 1, bothChanged: 0, sample: Array.from({ length: 20 }, (_, n) => `src/file-${n}.js`), at: '2026-10-01T00:00:00.000Z' })) };
  });
  const summary = projectSummary(store, store.state.projects.find(row => row.id === project.id)), json = JSON.stringify(summary);
  assert.deepEqual(summary.git, { sessionWorktreeDefault: true, init: { at: '2026-10-04T00:00:00.000Z', by: 'rna', commit: 'c'.repeat(40), branch: 'main' } });
  assert.ok(!json.includes('"applies"') && !json.includes('"worktrees"') && !json.includes('largeFiles') && !json.includes('src/file-'), 'no apply record, worktree row or init file list rides it');
  assert.ok(size() - bare < 200, `the git part stays a few bytes (${size() - bare} more than without records)`);
  // Asking for every heavy key does not bring them either.
  assert.ok(!JSON.stringify(projectDetail(store, store.state.projects.find(row => row.id === project.id), { include: ['versions', 'jobs', 'decisions', 'backgroundChanges', 'initiativeRuntime'] })).includes('"applies"'));
});

// ---- 4a. Host writes into a worktree re-check the folder they land in ----

test('sameFolder: a folder swapped for a link (even one leading back inside) no longer resolves to itself', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-same-folder-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'), elsewhere = join(dir, 'elsewhere');
  mkdirSync(join(root, 'a', 'b'), { recursive: true }); mkdirSync(elsewhere);
  assert.equal(await sameFolder(root, root, join(root, 'a', 'b')), true);
  assert.equal(await sameFolder(root, root, root), true);
  renameSync(join(root, 'a'), join(root, 'a-real')); symlinkSync(elsewhere, join(root, 'a'));
  assert.equal(await sameFolder(root, root, join(root, 'a')), false, 'a link out');
  rmSync(join(root, 'a')); symlinkSync(join(root, 'a-real'), join(root, 'a'));
  assert.equal(await sameFolder(root, root, join(root, 'a', 'b')), false, 'a link back inside is still not the folder checked');
  assert.equal(await sameFolder(root, root, join(dir, 'elsewhere')), false, 'outside the root');
  assert.equal(await sameFolder(root, root, join(root, 'missing')), false);
});

/** A conversation worktree S of the engine fixture whose `sub/` folder a hook swaps for a link to P's `secret/`. */
async function swapFixture(t, hook) {
  const f = engineFixture(t, { files: { 'a.txt': 'one\n', 'sub/keep.txt': 'keep\n', 'secret/keep.txt': 'the project folder\'s own file\n' } });
  const head = git(f.repo, 'rev-parse', 'HEAD').trim();
  const S = f.worktree('session', 'swt-swap', head, { owner: { sessionId: 'session-swap' } });
  const swap = () => { renameSync(join(S.root, 'sub'), join(S.root, 'sub-moved')); symlinkSync(join(f.workspace, 'secret'), join(S.root, 'sub')); };
  f.engine.settings.hooks = hook(swap);
  const seed = await f.engine.snapshot(f.project.id, S);
  const oid = text => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, input: text, encoding: 'utf8' }).trim();
  return { f, S, seed, oid };
}

test('a host write into a worktree whose folder is swapped for a link to the project folder right before the rename is refused, and its temporary file goes', { skip }, async t => {
  let armed = true;
  const { f, S, seed, oid } = await swapFixture(t, swap => ({ beforeRename: path => { if (armed && path === 'sub/new.txt') { armed = false; swap(); } } }));
  const incoming = await f.engine.compose(f.project.id, seed.commit, [{ path: 'sub/new.txt', mode: '100755', oid: oid('#!/bin/sh\necho planted\n') }, { path: 'top.txt', mode: '100644', oid: oid('fine\n') }]);
  const outcome = await f.engine.apply(f.project.id, { target: S, base: seed.commit, incoming, kind: 'turn', source: { sessionId: 'session-swap' }, mode: 'partial', labels: MERGE_LABELS.projectToSession() });
  assert.equal(existsSync(join(f.workspace, 'secret', 'new.txt')), false, 'nothing was planted in the project folder');
  assert.equal(read(f.workspace, 'secret/keep.txt'), 'the project folder\'s own file\n');
  assert.ok(outcome.conflicts.some(row => row.path === 'sub/new.txt' && row.kind === 'changed_during_merge'), JSON.stringify(outcome.conflicts));
  assert.equal(read(S.root, 'top.txt'), 'fine\n', 'the rest of a partial write still lands');
  assert.deepEqual(temporaries(f.workspace), [], 'no temporary file left in the project folder (or the worktree)');
  assert.deepEqual(temporaries(join(f.commonDir, 'rna')), [], 'nor in the repository\'s scratch folder');
  // `all` mode: refused and put back; the retry then finds the link in place and refuses the whole apply (git never
  // records a path beyond a symbolic link), so nothing reaches the project folder either way.
  rmSync(join(S.root, 'sub')); renameSync(join(S.root, 'sub-moved'), join(S.root, 'sub')); rmSync(join(S.root, 'top.txt'));
  const fresh = await f.engine.snapshot(f.project.id, S);
  const all = await f.engine.compose(f.project.id, fresh.commit, [{ path: 'sub/new.txt', mode: '100644', oid: oid('planted\n') }, { path: 'top.txt', mode: '100644', oid: oid('fine\n') }]);
  armed = true;
  await assert.rejects(f.engine.apply(f.project.id, { target: S, base: fresh.commit, incoming: all, kind: 'turn', source: { sessionId: 'session-swap' }, mode: 'all', labels: MERGE_LABELS.projectToSession() }), { code: 'snapshot_unreadable' });
  assert.equal(existsSync(join(f.workspace, 'secret', 'new.txt')), false); assert.equal(existsSync(join(S.root, 'top.txt')), false, 'all or nothing: the clean file was put back');
  assert.deepEqual(temporaries(f.workspace), []); assert.deepEqual(temporaries(join(f.commonDir, 'rna')), []);
  assert.ok(!f.applies().some(row => row.state === 'writing'), 'no record left writing');
});

test('a swap in the last instant (after the check, before the rename) is caught after it: the file is taken back out of the project folder', { skip }, async t => {
  const { f, S, seed, oid } = await swapFixture(t, swap => ({ beforePlace: path => { if (path === 'sub/new.txt') swap(); } }));
  const incoming = await f.engine.compose(f.project.id, seed.commit, [{ path: 'sub/new.txt', mode: '100644', oid: oid('planted\n') }]);
  const outcome = await f.engine.apply(f.project.id, { target: S, base: seed.commit, incoming, kind: 'turn', source: { sessionId: 'session-swap' }, mode: 'partial', labels: MERGE_LABELS.projectToSession() });
  assert.equal(existsSync(join(f.workspace, 'secret', 'new.txt')), false, 'taken back out');
  assert.ok(outcome.conflicts.some(row => row.path === 'sub/new.txt'));
  assert.deepEqual(temporaries(f.workspace), []);
});

test('a file that did not exist is placed without replacing one that appeared meanwhile', { skip }, async t => {
  const f = engineFixture(t, { files: { 'a.txt': 'one\n' } });
  f.engine.settings.hooks = { beforePlace: path => { if (path === 'new.txt') writeFileSync(join(f.workspace, 'new.txt'), 'the user just made this\n'); } };
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const incoming = await f.engine.compose(f.project.id, seed.commit, [{ path: 'new.txt', mode: '100644', oid: execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, input: 'from the merge\n', encoding: 'utf8' }).trim() }]);
  const outcome = await f.engine.apply(f.project.id, { target: f.root, base: seed.commit, incoming, kind: 'worker', source: { agentId: 'agent-x' }, mode: 'partial', labels: MERGE_LABELS.worker('agent-x') });
  assert.equal(read(f.workspace, 'new.txt'), 'the user just made this\n', 'the user\'s file stays');
  assert.ok(outcome.conflicts.some(row => row.path === 'new.txt'));
  assert.deepEqual(temporaries(f.workspace), []);
});

test('removing a worktree never carries a project-folder file off to the trash through a folder swapped for a link', { skip }, async t => {
  const f = turnFixture(t, { files: { 'a.txt': 'one\n', 'src/app.js': 'export const a = 1;\n' } });
  const parent = await f.roots.rootOf({ projectId: f.project.id });
  const record = await f.worktrees.create(f.project.id, { kind: 'worker', id: 'w-trash', owner: { agentId: 'agent-trash' }, parent, label: 'Rna worker' });
  const W = join(f.P, record.dir);
  // A process still running in W swapped `dist` (ignored) for a link to the project folder's src/ after git listed it.
  symlinkSync(join(f.P, 'src'), join(W, 'dist'));
  const gitIn = f.worktrees.gitIn.bind(f.worktrees);
  f.worktrees.gitIn = async (cwd, args, options) => (args[0] === 'ls-files' ? { code: 0, stdout: 'dist/app.js\0', stderr: '' } : gitIn(cwd, args, options));
  await f.worktrees.remove(f.project.id, record.id);
  assert.equal(read(f.P, 'src/app.js'), 'export const a = 1;\n', 'the project folder\'s file stays where it is');
  assert.equal(f.worktrees.record(f.project.id, record.id).state, 'removed');
});

test('an attachment is copied into a conversation\'s worktree only through real folders of it', { skip }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  f.model.steps.push({ text: '好了。' });
  const turn = await f.send(s.id, '开始');
  const S = (await f.rootOf(s.id)).root;
  put(f.P, 'attachments/photo.png', 'png bytes\n'); mkdirSync(join(f.P, 'elsewhere'));
  symlinkSync(join(f.P, 'elsewhere'), join(S, 'attachments'));
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === s.id);
    session.items.push({ id: 'item-attachment', kind: 'user', text: '看图', attachments: [{ workspacePath: 'attachments/photo.png' }], createdAt: new Date().toISOString() });
    session.turns.find(row => row.id === turn.id).userItemId = 'item-attachment';
  });
  const ctx = await f.sessionWorktrees.context(s.id);
  await f.sessionWorktrees.copyAttachments(ctx, turn.id);
  assert.equal(existsSync(join(f.P, 'elsewhere', 'photo.png')), false, 'nothing copied through the link into the project folder');
  rmSync(join(S, 'attachments'));
  await f.sessionWorktrees.copyAttachments(ctx, turn.id);
  assert.equal(read(S, 'attachments/photo.png'), 'png bytes\n', 'a real folder takes the copy');
});

// ---- 4b. A worktree's dev preview runs sandboxed ----

/** A project folder with a stand-in Vite (it records where it may write) and a worktree-like root inside it. */
function previewFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-preview-sandbox-'))), P = join(dir, 'project'), S = join(P, '.rna', 'worktrees.nosync', 's-preview1');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(P, 'node_modules', 'vite', 'dist', 'node'), { recursive: true }); mkdirSync(S, { recursive: true }); mkdirSync(join(dir, 'state'));
  writeFileSync(join(P, 'node_modules', 'vite', 'dist', 'node', 'index.js'), [
    "import { writeFileSync, readFileSync, existsSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const P = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');",
    'export async function createServer(options) {',
    '  const attempts = {};',
    "  const attempt = (name, path) => { try { writeFileSync(path, 'x'); attempts[name] = 'written'; } catch (error) { attempts[name] = error.code; } };",
    "  attempt('project', join(P, 'escaped-by-preview.txt'));",
    "  attempt('root', join(options.root, 'written-by-preview.txt'));",
    "  attempt('cache', join(options.cacheDir, 'cache.txt'));",
    // probe.json (review 2026-10-05, tool-safety): also try to read Rna's state and reach its API, as project_exec would.
    "  if (existsSync(join(P, 'probe.json'))) {",
    "    const { state, port } = JSON.parse(readFileSync(join(P, 'probe.json'), 'utf8'));",
    "    const read = (name, path) => { try { readFileSync(path); attempts[name] = 'read'; } catch (error) { attempts[name] = error.code; } };",
    "    read('secrets', state + '.secrets'); read('temporary', state + '.secrets.tmp-1'); read('cacheBack', join(options.cacheDir, 'cache.txt'));",
    "    try { await fetch('http://127.0.0.1:' + port + '/api/v2/bootstrap'); attempts.daemon = 'reached'; } catch (error) { attempts.daemon = error.cause?.code ?? error.code ?? 'failed'; }",
    '  }',
    "  const html = '<!doctype html><pre>' + JSON.stringify(attempts) + '</pre>';",
    "  return { middlewares: (request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); }, watcher: { on() {} }, close: async () => {} };",
    '}', ''].join('\n'));
  const manifest = { name: 'fixture', devDependencies: { vite: '0.0.0' } };
  for (const root of [P, S]) writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  const stateFile = join(dir, 'state', 'state.json');
  const scopeOf = (root, extra = {}) => ({ projectId: 'p', root, project: P, directory: root, info: lstatSync(root), privateState: stateFile, privateStateParent: join(dir, 'state'), privateStates: [stateFile], packageManifest: manifest, ...extra });
  const start = (scope, options = {}) => startVitePreview({ scope, token: randomUUID().replace(/-/g, ''), daemonOrigin: 'http://127.0.0.1:4317', stateFile, current: () => true, validateScope: async () => {}, ...options });
  return { dir, P, S, stateFile, scopeOf, start };
}
const attemptsOf = async dev => JSON.parse(/<pre>(.*)<\/pre>/s.exec(await (await fetch(dev.url)).text())[1]);

test('the dev preview of a worktree runs its config under the sandbox: nothing it runs can write to the project folder', { skip: skip || (sandboxAvailable() ? false : 'needs macOS sandbox-exec'), timeout: 60000 }, async t => {
  const f = previewFixture(t);
  const scope = f.scopeOf(f.S, { worktreeId: 'swt-preview', rootKind: 'session' });
  assert.equal(isolatedPreview(scope), true);
  const profile = previewSandboxProfile(scope, '/tmp/rna-cache-x');
  assert.match(profile, new RegExp(`\\(deny file-write\\* \\(subpath "${f.P.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\)\\)`)); assert.match(profile, /\(allow file-write\* \(subpath "\/tmp\/rna-cache-x"\)\)/);
  const dev = await f.start(scope);
  t.after(() => dev.stop().catch(() => {}));
  const attempts = await attemptsOf(dev);
  assert.equal(attempts.project, 'EPERM', 'a write to the project folder is refused by the sandbox');
  assert.equal(attempts.root, 'written'); assert.equal(attempts.cache, 'written');
  assert.equal(existsSync(join(f.P, 'escaped-by-preview.txt')), false);
  assert.equal(existsSync(join(f.S, 'written-by-preview.txt')), true);
  assert.equal(lstatSync(join(f.S, 'node_modules')).isDirectory(), true, 'an empty node_modules keeps Vite\'s bundled config inside the worktree');
  await dev.stop();
});

// Review 2026-10-05 (tool-safety): "the same rules as project_exec" includes A6's read denial of Rna's state (the
// preview's own cache in <state>.previews stays readable and writable) and no connection to Rna's own API port.
test('the dev preview of a worktree cannot read Rna\'s state or reach its API, and keeps its own cache', { skip: skip || (sandboxAvailable() ? false : 'needs macOS sandbox-exec'), timeout: 60000 }, async t => {
  const f = previewFixture(t);
  let hits = 0;
  const daemon = http.createServer((request, response) => { hits++; response.end('{"projects":[]}'); });
  await new Promise(done => daemon.listen(0, '127.0.0.1', done));
  t.after(() => daemon.close());
  writeFileSync(`${f.stateFile}.secrets`, '{"synthetic":"secret"}'); writeFileSync(`${f.stateFile}.secrets.tmp-1`, '{"synthetic":"temporary"}');
  writeFileSync(join(f.P, 'probe.json'), JSON.stringify({ state: f.stateFile, port: daemon.address().port }));
  const scope = f.scopeOf(f.S, { worktreeId: 'swt-preview', rootKind: 'session' });
  const dev = await f.start(scope, { daemonOrigin: `http://127.0.0.1:${daemon.address().port}` });
  t.after(() => dev.stop().catch(() => {}));
  const attempts = await attemptsOf(dev);
  assert.equal(attempts.secrets, 'EPERM'); assert.equal(attempts.temporary, 'EPERM');
  assert.equal(attempts.cache, 'written'); assert.equal(attempts.cacheBack, 'read', 'the preview\'s own cache inside <state>.previews');
  assert.equal(attempts.daemon, 'EPERM'); assert.equal(hits, 0);
  assert.equal(attempts.project, 'EPERM'); assert.equal(attempts.root, 'written');
  await dev.stop();
});

test('the project folder\'s own dev preview is unchanged (not sandboxed); without a sandbox a worktree\'s is refused', { skip, timeout: 60000 }, async t => {
  const f = previewFixture(t);
  await assert.rejects(f.start(f.scopeOf(f.S, { worktreeId: 'swt-preview' }), { sandbox: () => false }), { code: 'PREVIEW_SANDBOX_UNAVAILABLE', status: 409 });
  await assert.rejects(f.start(f.scopeOf(f.S, { worktreeId: 'swt-preview' }), { sandbox: () => false, say: variants => variants.en }), /static preview/);
  const scope = f.scopeOf(f.P);
  assert.equal(isolatedPreview(scope), false);
  const dev = await f.start(scope, { sandbox: () => false });
  t.after(() => dev.stop().catch(() => {}));
  assert.equal((await attemptsOf(dev)).project, 'written', 'the project\'s own preview writes where the project lets it');
  await dev.stop();
});

// ---- 4c. A card answer waiting for the user's git operation ----

test('answering the conflict card during a git merge in the project folder is held with a timeline line, and shutdown does not hang on it; the next start answers it', { skip, timeout: 60000 }, async t => {
  const f = turnFixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n', 'cover.bin': BINARY.base } });
  const { s, turn } = await binaryConflict(f);
  writeFileSync(join(f.repo, '.git', 'MERGE_HEAD'), git(f.repo, 'rev-parse', 'HEAD'));
  const card = cardOf(f.store, s.id, HOST_CARDS.sessionConflict.actionId(turn.id));
  answer(f, s.id, card.id, 'conversation');
  await until(() => f.sessionOf(s.id).items.some(item => item.kind === 'notice' && item.source === 'worktree' && /git merge/.test(item.text)), 'the timeline line');
  assert.equal(f.sessionOf(s.id).items.filter(item => item.kind === 'notice' && /git merge/.test(item.text)).length, 1, 'one line for the answer');
  assert.deepEqual(bytesOf(f.P, 'cover.bin'), [...BINARY.project], 'nothing written while the merge is open');
  const closed = await Promise.race([Promise.resolve(f.sessionWorktrees.close()).then(() => until(() => !f.sessionWorktrees.queues.has(s.id), 'the answer to stop', 5000)).then(() => 'closed'), delay(8000).then(() => 'hung')]);
  assert.equal(closed, 'closed');
  assert.equal(f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply.card.answered, undefined, 'the stopped answer is not counted as given');
  assert.deepEqual(bytesOf(f.P, 'cover.bin'), [...BINARY.project]);
  // The merge ends; the next start takes the answer up.
  rmSync(join(f.repo, '.git', 'MERGE_HEAD'));
  await f.sessionWorktrees.recover();
  await until(() => f.sessionOf(s.id).turns.find(row => row.id === turn.id).apply.status === 'applied', 'the answer at the next start');
  assert.deepEqual(bytesOf(f.P, 'cover.bin'), [...BINARY.conversation]);
});

test('answerConflict never waits for a git operation in the project folder: it refuses at once and writes nothing; a caller\'s signal still stops it', { skip, timeout: 60000 }, async t => {
  const f = turnFixture(t, { files: { 'a.txt': 'one\ntwo\nthree\n', 'cover.bin': BINARY.base } });
  const { s, turn } = await binaryConflict(f);
  mkdirSync(join(f.repo, '.git', 'rebase-merge'), { recursive: true });
  const started = Date.now();
  await assert.rejects(f.sessionWorktrees.answerConflict(s.id, turn.id, 'project'), error => error.code === 'git_operation_in_progress' && error.operation === 'rebase');
  assert.ok(Date.now() - started < 5000, 'refused at once');
  assert.equal(f.sessionWorktrees.queues.has(s.id), false, 'nothing waits in the conversation\'s queue');
  assert.deepEqual(bytesOf(f.P, 'cover.bin'), [...BINARY.project]); assert.equal(there(f.P, 'b.txt'), false);
  const S = (await f.rootOf(s.id)).root;
  assert.deepEqual(bytesOf(S, 'cover.bin'), [...BINARY.conversation], 'the conversation\'s copy is untouched too');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.sessionWorktrees.answerConflict(s.id, turn.id, 'project', { signal: controller.signal }), error => error.name === 'AbortError' || error.code === 'aborted');
  rmSync(join(f.repo, '.git', 'rebase-merge'), { recursive: true, force: true });
});

// ---- 4d. Deleting a project releases its worktrees ----

test('deleting a project removes its worktrees that hold nothing unapplied and unlocks the others, keeping their work', { skip, timeout: 90000 }, async t => {
  const f = turnFixture(t);
  const s = f.worktreeSession();
  f.model.steps.push({ write: ['a.txt', 'one\nTWO\nthree\n'] }, { text: '好了。' });
  await f.send(s.id, '改');
  const S = f.recordOf(s.id), sTop = join(f.P, S.dir);
  const parent = await f.roots.rootOf({ projectId: f.project.id });
  const W = await f.worktrees.create(f.project.id, { kind: 'worker', id: 'w-dirty', owner: { agentId: 'agent-dirty' }, parent, label: 'Rna worker' }), wTop = join(f.P, W.dir);
  put(wTop, 'unapplied.txt', 'work nobody applied\n');
  const listed = () => git(f.repo, 'worktree', 'list', '--porcelain');
  const locked = top => { const block = listed().split('\n\n').find(row => row.startsWith(`worktree ${top}\n`)); return block ? /\nlocked/.test(block) : null; };
  assert.equal(locked(sTop), true); assert.equal(locked(wTop), true);
  const seed = git(f.repo, 'rev-parse', REFS.worktree(W.id, 'seed')).trim();
  f.store.deleteProject(f.project.id);
  const released = await f.worktrees.releases.get(f.project.id);
  assert.deepEqual(released, { removed: [S.id], unlocked: [W.id], failed: [] });
  assert.equal(existsSync(sTop), false, 'the clean conversation worktree is gone'); assert.equal(locked(sTop), null);
  assert.equal(locked(wTop), false, 'the worker worktree is unlocked for the user\'s own git');
  assert.equal(read(wTop, 'unapplied.txt'), 'work nobody applied\n', 'its work stays on disk');
  assert.equal(git(f.repo, 'rev-parse', REFS.worktree(W.id, 'seed')).trim(), seed, 'its refs stay');
  assert.equal(read(f.P, 'a.txt'), 'one\nTWO\nthree\n', 'the project folder itself is untouched');
});

test('the store tells its deletion hooks about the project row as it was, after it left state', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-delete-hook-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'p'));
  const store = new Store(join(dir, 'state', 'state.json'));
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const { project } = store.createProject({ name: 'Hook', workspace: join(dir, 'p'), initiative: { enabled: false } });
  store.mutate(state => { state.projects.find(row => row.id === project.id).git = { sessionWorktreeDefault: false, worktrees: [{ id: 'w1', kind: 'worker', state: 'active' }], applies: [] }; });
  const seen = [];
  const off = store.onProjectDeleted(row => { seen.push({ row, inState: store.state.projects.some(item => item.id === row.id) }); throw new Error('a failing hook does not stop the deletion'); });
  store.onProjectDeleted(() => Promise.reject(new Error('nor does a rejected one')));
  const result = store.deleteProject(project.id);
  assert.equal(result.deleted, true);
  assert.equal(seen.length, 1); assert.equal(seen[0].inState, false); assert.equal(seen[0].row.id, project.id); assert.equal(seen[0].row.git.worktrees[0].id, 'w1');
  off();
});

// ---- 4e. Dropping a worker merged into a conversation's worktree ----

test('dropping a worker that was merged into a conversation\'s worktree marks that record rolled back, pointing at the rollback written there', { skip, timeout: 60000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-drop-s-'))), P = join(dir, 'repo');
  mkdirSync(P);
  put(P, 'a.txt', 'one\n'); git(P, 'init', '-q'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'first');
  const store = new Store(join(dir, 'state', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'drop-fixture-synthetic-key', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Drop', workspace: P, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const turnId = store.state.sessions.find(row => row.id === session.id).activeTurnId;
  const gitService = new WorkspaceGitService(store), engine = new IsolationEngine(store, { git: gitService, ready: true, sandbox: () => true, pollMs: 5 });
  gitService.engine = engine;
  const roots = new RootResolver(store, { git: gitService }), worktrees = new WorktreeService(store, { git: gitService, engine, roots });
  const child = (options, task) => {
    const messages = [];
    return { snapshot: () => ({ tools: options.readOnly ? [] : ['project_write', 'project_edit'], messages, recovery: { interrupted: false, pendingTools: 0, pendingFinish: false, uncertainTools: [] }, queue: { steering: [] }, usage: { totalTokens: 0 } }),
      async prompt(text) { messages.push({ role: 'user', source: 'user', content: text }); put(options.cwd, 'from-worker.txt', `${task}\n`); messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Wrote from-worker.txt.' }], stopReason: 'stop' }); },
      async resume() {}, async steer() {}, async dispose() {}, async abort() {} };
  };
  const idle = [];
  const service = new BuiltinAgentService(store, { engine, roots, worktrees, factory: async options => child(options, 'merged into S'), sessionWorktrees: { applyIdle: async id => { idle.push(id); return null; } } });
  t.after(async () => { await service.close(); engine.close(); try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  const record = await worktrees.create(project.id, { kind: 'session', id: 'swt-drop', owner: { sessionId: session.id }, parent: await roots.rootOf({ projectId: project.id }), label: 'Rna conversation' });
  store.mutate(state => { state.sessions.find(row => row.id === session.id).worktree = { id: record.id, state: 'active' }; });
  const S = join(P, record.dir);
  const tools = service.createTools({ sessionId: session.id, turnId }), tool = name => tools.find(row => row.name === name);
  const handle = JSON.parse((await tool('agent_delegate').execute('call-drop', { task: 'Write a file.', wait: true }, new AbortController().signal)).content[0].text);
  assert.equal(handle.merge.status, 'merged'); assert.equal(read(S, 'from-worker.txt'), 'merged into S\n');
  const applies = () => store.state.projects.find(row => row.id === project.id).git.applies;
  const merged = applies().find(row => row.source?.agentId === handle.agentId);
  assert.equal(merged.target, `session:${session.id}`); assert.equal(merged.state, 'verified');
  const dropped = JSON.parse((await tool('agent_merge').execute('merge-drop', { agentId: handle.agentId, action: 'drop' }, new AbortController().signal)).content[0].text);
  assert.equal(dropped.status, 'dropped'); assert.equal(existsSync(join(S, 'from-worker.txt')), false);
  const settled = applies().find(row => row.id === merged.id), rollback = applies().find(row => row.kind === 'rollback');
  assert.equal(settled.state, 'rolled_back'); assert.equal(settled.rolledBackBy, rollback.id);
  assert.equal(rollback.target, `session:${session.id}`); assert.equal(rollback.undoes, merged.id);
  // Dropping again does nothing more.
  const again = JSON.parse((await tool('agent_merge').execute('merge-drop-2', { agentId: handle.agentId, action: 'drop' }, new AbortController().signal)).content[0].text);
  assert.equal(applies().filter(row => row.kind === 'rollback').length, 1, JSON.stringify(again));
  // The engine leaves records of the project folder to rollback() itself.
  assert.equal(engine.markRolledBack(project.id, 'a-not-there'), null);
});

// ---- 4f. Old turn checkpoints read as expired ----

test('turn refs swept after 30 days mark their turns\' checkpoints expired, so the footer stops offering 回退本轮', { skip }, async t => {
  const f = turnFixture(t);
  const day = 86400000, now = Date.now();
  const commitAt = (when, message) => { process.env.GIT_COMMITTER_DATE = new Date(when).toISOString(); try { return git(f.repo, 'commit-tree', 'HEAD^{tree}', '-m', message).trim(); } finally { delete process.env.GIT_COMMITTER_DATE; } };
  const old = commitAt(now - 40 * day, 'old'), fresh = commitAt(now - 2 * day, 'fresh');
  const turns = { swept: 'turn-swept-01', fresh: 'turn-fresh-01', gone: 'turn-gone-01', young: 'turn-young-01', skipped: 'turn-skipped-01' };
  git(f.repo, 'update-ref', REFS.turn(turns.swept), old); git(f.repo, 'update-ref', REFS.turn(turns.fresh), fresh);
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id);
    const turn = (id, ageDays, checkpoint) => ({ id, status: 'completed', startedAt: new Date(now - ageDays * day - 60000).toISOString(), completedAt: new Date(now - ageDays * day).toISOString(), checkpoint });
    session.turns.push(turn(turns.swept, 40, { ref: REFS.turn(turns.swept), state: 'taken' }), turn(turns.fresh, 2, { ref: REFS.turn(turns.fresh), state: 'taken' }),
      turn(turns.gone, 45, { ref: REFS.turn(turns.gone), state: 'taken' }), turn(turns.young, 3, { ref: REFS.turn(turns.young), state: 'taken' }), turn(turns.skipped, 50, { state: 'skipped', reason: 'timeout' }));
  });
  const result = await f.engine.sweep({ now });
  assert.equal(result.checkpointsExpired, 2);
  const checkpoint = id => f.sessionOf(f.session.id).turns.find(row => row.id === id).checkpoint;
  assert.equal(checkpoint(turns.swept).state, 'expired'); assert.equal(checkpoint(turns.swept).reason, 'expired'); assert.equal(checkpoint(turns.swept).ref, undefined);
  assert.equal(checkpoint(turns.gone).state, 'expired', 'a ref swept earlier (an older host) is reconciled too');
  assert.equal(checkpoint(turns.fresh).state, 'taken'); assert.equal(checkpoint(turns.young).state, 'taken', 'a younger turn whose ref is missing is left alone');
  assert.deepEqual(checkpoint(turns.skipped), { state: 'skipped', reason: 'timeout' });
  assert.equal(git(f.repo, 'for-each-ref', REFS.turn(turns.swept)).trim(), '');
  await assert.rejects(f.engine.rollbackTurn(f.project.id, turns.swept, {}), { code: 'turn_checkpoint_missing' });
  assert.equal((await f.engine.sweep({ now })).checkpointsExpired, 0, 'once is enough');
});

test('the writer\'s scratch folder loses temporary files a crash left behind, after a day', { skip }, async t => {
  const f = engineFixture(t);
  const scratch = join(f.commonDir, 'rna', 'tmp');
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, '.rna-tmp-old'), 'left by a crash');
  writeFileSync(join(scratch, '.rna-tmp-new'), 'being written');
  const old = new Date(Date.now() - 2 * 86400000);
  utimesSync(join(scratch, '.rna-tmp-old'), old, old);
  await f.engine.sweep({ now: Date.now() });
  assert.equal(existsSync(join(scratch, '.rna-tmp-old')), false); assert.equal(existsSync(join(scratch, '.rna-tmp-new')), true);
});
