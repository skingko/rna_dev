import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, put, read, skip } from './git-isolation-fixture.mjs';
import { MERGE_LABELS, hasMergeMarkers, notMergedOf } from '../git-isolation/index.mjs';
import { parseMergeTree } from '../git-isolation/merge.mjs';

// Three-way merges (worktree design 0.63 §3.4, §13 "合并"): merge-tree over an explicit base, conflict kinds from
// its message types, conflicts found by code, and the unique labels that make leftover markers recognisable.

const labels = MERGE_LABELS.worker('agent-0011223344');
const reset = f => { git(f.repo, 'reset', '-q', '--hard'); git(f.repo, 'clean', '-fdq'); };
/** base = the committed folder; current and incoming = the folder after each change function (reset in between). */
async function three(f, current, incoming) {
  const id = f.project.id, base = (await f.engine.snapshot(id, f.root)).tree;
  await current(f.workspace); const ours = (await f.engine.snapshot(id, f.root)).tree; reset(f);
  await incoming(f.workspace); const theirs = (await f.engine.snapshot(id, f.root)).tree; reset(f);
  return { base, current: ours, incoming: theirs };
}
const byPath = rows => Object.fromEntries(rows.map(row => [row.path, row]));

test('merge-tree output is parsed into the result tree, staged entries and typed messages', () => {
  const out = ['1237034676ad5b07c87b59a58d23a91e3b2c1503', '100644 e899 1\tb.bin', '100644 9de1 2\tb.bin', '100644 70d7 3\tb.bin', '', '1', 'b.bin', 'CONFLICT (binary)', 'warning: Cannot merge binary files\n', '1', 'b.bin', 'Auto-merging', 'Auto-merging b.bin\n', '2', 'ft~x', 'ft', 'CONFLICT (file/directory)', 'directory in the way\n', ''].join('\0');
  const parsed = parseMergeTree(out);
  assert.equal(parsed.tree, '1237034676ad5b07c87b59a58d23a91e3b2c1503');
  assert.deepEqual(parsed.entries.map(row => [row.path, row.stage]), [['b.bin', 1], ['b.bin', 2], ['b.bin', 3]]);
  assert.deepEqual(parsed.messages.map(row => [row.paths, row.kind]), [[['b.bin'], 'CONFLICT (binary)'], [['b.bin'], 'Auto-merging'], [['ft~x', 'ft'], 'CONFLICT (file/directory)']]);
  assert.deepEqual(parseMergeTree('abc\0'), { tree: 'abc', entries: [], messages: [] });
});

test('different files and non-overlapping edits merge cleanly; only the incoming side is written', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\n', 'b.txt': 'b\n', 'c.txt': 'c\n' } });
  const trees = await three(f, root => { put(root, 'b.txt', 'b mine\n'); put(root, 'a.txt', 'ONE\ntwo\nthree\nfour\nfive\nsix\n'); }, root => { put(root, 'c.txt', 'c theirs\n'); put(root, 'a.txt', 'one\ntwo\nthree\nfour\nfive\nSIX\n'); put(root, 'd.txt', 'new\n'); rmSync(join(root, 'b.txt')); put(root, 'b.txt', 'b\n'); });
  const result = await f.engine.merge(f.project.id, trees, { labels });
  assert.equal(result.clean, true); assert.deepEqual(result.conflicts, []);
  const writes = byPath(result.writes);
  assert.deepEqual(Object.keys(writes).sort(), ['a.txt', 'c.txt', 'd.txt']);
  assert.equal(git(f.repo, 'cat-file', 'blob', writes['a.txt'].oid), 'ONE\ntwo\nthree\nfour\nfive\nSIX\n', 'both edits kept');
  assert.equal(writes['d.txt'].expect, null, 'a new file expects nothing there');
  assert.equal(result.bothChanged, 1, 'a.txt changed on both sides');
  assert.equal(git(f.repo, 'for-each-ref', 'refs/rna/m/'), '', 'merge labels are deleted when the merge ends');
});

test('overlapping edits conflict with stage entries and markers carrying this merge\'s labels', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\nb\nc\n' } });
  const trees = await three(f, root => put(root, 'a.txt', 'a\nB1\nc\n'), root => put(root, 'a.txt', 'a\nB2\nc\n'));
  const result = await f.engine.merge(f.project.id, trees, { labels });
  assert.equal(result.clean, false);
  const [conflict] = result.conflicts;
  assert.equal(conflict.path, 'a.txt'); assert.equal(conflict.kind, 'content');
  assert.equal(git(f.repo, 'cat-file', 'blob', conflict.base.oid), 'a\nb\nc\n');
  assert.equal(git(f.repo, 'cat-file', 'blob', conflict.current.oid), 'a\nB1\nc\n');
  assert.equal(git(f.repo, 'cat-file', 'blob', conflict.incoming.oid), 'a\nB2\nc\n');
  const text = git(f.repo, 'cat-file', 'blob', conflict.marked);
  assert.match(text, new RegExp(`^<<<<<<< refs/rna/m/${result.mid}/current$`, 'm'));
  assert.match(text, new RegExp(`^>>>>>>> refs/rna/m/${result.mid}/incoming-worker-00112233$`, 'm'));
  assert.match(text, /^\|\|\|\|\|\|\| [0-9a-f]{7}\nb\n=======/m, 'zdiff3: the common base is shown');
  assert.equal(hasMergeMarkers(text, result.mid), true);
  assert.deepEqual(result.writes, [], 'a conflicted path is never written');
  const preview = await f.engine.diff3(f.project.id, conflict);
  assert.equal(preview.text, text); assert.equal(preview.truncated, false);
  const page = await f.engine.diff3(f.project.id, conflict, { page: 1 });
  assert.deepEqual([page.page, page.pages, page.text], [1, 1, text]);
});

test('modify/delete, add/add, binary and file/directory conflicts get their kinds; a clean rename with an edit merges', { skip }, async t => {
  const f = fixture(t, { files: { 'del.txt': 'x\n', 'bin.dat': Buffer.from([0, 1, 2, 0]), 'ft': 'file\n', 'old.md': 'line 1\nline 2\nline 3\nline 4\nline 5\n', 'keep.txt': 'k\n' } });
  const trees = await three(f, root => {
    put(root, 'del.txt', 'y\n'); put(root, 'both.txt', 'mine\n'); put(root, 'bin.dat', Buffer.from([0, 1, 3, 0])); put(root, 'ft', 'file changed\n');
    put(root, 'old.md', 'line 1 edited\nline 2\nline 3\nline 4\nline 5\n');
  }, root => {
    rmSync(join(root, 'del.txt')); put(root, 'both.txt', 'theirs\n'); put(root, 'bin.dat', Buffer.from([0, 1, 4, 0]));
    rmSync(join(root, 'ft')); put(root, 'ft/inside.txt', 'now a folder\n');
    rmSync(join(root, 'old.md')); put(root, 'new.md', 'line 1\nline 2\nline 3\nline 4\nline 5\n');
  });
  const result = await f.engine.merge(f.project.id, trees, { labels });
  const kinds = Object.fromEntries(result.conflicts.map(row => [row.path, row.kind]));
  assert.equal(kinds['del.txt'], 'modify_delete');
  assert.equal(kinds['both.txt'], 'add_add');
  assert.equal(kinds['bin.dat'], 'binary');
  assert.equal(kinds.ft, 'type');
  assert.ok(!Object.keys(kinds).some(path => path.includes('~')), 'git\'s made-up name for a file/folder clash is not a conflict of its own');
  const writes = byPath(result.writes);
  assert.ok(!Object.keys(writes).some(path => path === 'ft' || path.startsWith('ft/') || path.includes('~')), 'nothing under or over a conflicted path is written');
  assert.equal(git(f.repo, 'cat-file', 'blob', writes['new.md'].oid), 'line 1 edited\nline 2\nline 3\nline 4\nline 5\n', 'the rename carries the edit');
  assert.equal(writes['old.md'].delete, true);
});

test('code finds submodule, unsafe link, hard link and case conflicts and never writes them', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'Readme.md': 'r\n' } });
  git(f.repo, 'config', 'core.ignorecase', 'true');
  const sub = git(f.repo, 'rev-parse', 'HEAD').trim();
  const trees = await three(f, root => put(root, 'mine.txt', 'm\n'), root => {
    symlinkSync('../../etc/passwd', join(root, 'escape'));
    symlinkSync('a.txt', join(root, 'fine'));
  });
  // A gitlink, and a second name differing only in case, can't come from a folder snapshot on this volume: add them
  // to the incoming tree directly.
  const shout = git(f.repo, 'hash-object', '-w', '--stdin', { input: 'shouting\n' }).trim();
  const incoming = await f.engine.compose(f.project.id, trees.incoming, [{ path: 'lib', mode: '160000', oid: sub }, { path: 'README.md', mode: '100644', oid: shout }]);
  const result = await f.engine.merge(f.project.id, { ...trees, incoming }, { labels });
  const kinds = Object.fromEntries(result.conflicts.map(row => [row.path, row.kind]));
  assert.equal(kinds.lib, 'submodule');
  assert.equal(kinds.escape, 'unsafe_symlink');
  assert.equal(kinds['README.md'], 'case_collision');
  assert.deepEqual(result.writes.map(row => row.path), ['fine'], 'a link that stays inside is written');

  // A file with a second link in an isolated root may be the same file as one in the project folder.
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', 'agent-55667788', seed.commit);
  mkdirSync(join(f.dir, 'elsewhere'), { recursive: true }); writeFileSync(join(f.dir, 'elsewhere', 'target.txt'), 'shared\n');
  linkSync(join(f.dir, 'elsewhere', 'target.txt'), join(w.root, 'linked.txt'));
  put(w.root, 'plain.txt', 'plain\n');
  const final = await f.engine.snapshot(f.project.id, w);
  const linked = await f.engine.merge(f.project.id, { base: seed.tree, current: seed.tree, incoming: final.tree }, { labels, root: w });
  assert.deepEqual(linked.conflicts.map(row => [row.path, row.kind]), [['linked.txt', 'unsafe_hardlink']]);
  assert.deepEqual(linked.writes.map(row => row.path), ['plain.txt']);
});

test('three syncs in a row keep the right base, a partly conflicted one included', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' } });
  const id = f.project.id, seed = await f.engine.snapshot(id, f.root);
  const s = f.worktree('session', 'sess0001', seed.commit, { owner: { sessionId: 'sess0001' } });
  let base = seed.tree;
  const sync = async () => {
    const p = await f.engine.snapshot(id, f.root);
    const outcome = await f.engine.apply(id, { target: s, base, incoming: p.commit, kind: 'turn', source: { sessionId: 'sess0001' }, mode: 'partial', labels: MERGE_LABELS.projectToSession() });
    base = await f.engine.syncBase(id, { current: p.tree, previous: base, paths: outcome.conflicts.map(row => row.path) });
    return outcome;
  };
  // 1: the project folder changed b; the session changed a. Clean: b comes in, a stays.
  put(f.workspace, 'b.txt', 'b from the folder\n'); put(s.root, 'a.txt', 'a from the session\n');
  let outcome = await sync();
  assert.equal(outcome.status, 'applied'); assert.deepEqual(outcome.written, ['b.txt']);
  assert.equal(read(s.root, 'b.txt'), 'b from the folder\n'); assert.equal(read(s.root, 'a.txt'), 'a from the session\n');
  // 2: both changed c: a conflict. The session keeps its version, the base keeps the old c.
  put(f.workspace, 'c.txt', 'c folder\n'); put(s.root, 'c.txt', 'c session\n');
  outcome = await sync();
  assert.equal(outcome.status, 'conflicted'); assert.deepEqual(outcome.conflicts.map(row => row.path), ['c.txt']);
  assert.equal(read(s.root, 'c.txt'), 'c session\n', 'the conflicted file keeps the session\'s version');
  assert.equal(git(f.repo, 'cat-file', 'blob', `${base}:c.txt`), 'c\n', 'base′ keeps the old entry of a conflicted path');
  assert.equal(git(f.repo, 'cat-file', 'blob', `${base}:b.txt`), 'b from the folder\n', 'and moves on everywhere else');
  // 3: nothing new in the folder: c still conflicts (never taken over silently), nothing else is written.
  outcome = await sync();
  assert.equal(outcome.status, 'conflicted'); assert.deepEqual(outcome.written, []);
  assert.equal(read(s.root, 'c.txt'), 'c session\n');
  // The session settles c to the folder's version: the next sync is clean and the base catches up.
  put(s.root, 'c.txt', 'c folder\n');
  outcome = await sync();
  assert.equal(outcome.conflicts.length, 0);
  assert.equal(git(f.repo, 'cat-file', 'blob', `${base}:c.txt`), 'c folder\n');
  assert.equal(read(f.workspace, 'a.txt'), 'a\n', 'syncs only ever write the session copy');
});

test('what a source snapshot skipped is reported back as not merged', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n' } });
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', 'agent-0011223344', seed.commit);
  put(w.root, 'a.txt', 'worker\n'); mkdirSync(join(w.root, 'clone')); git(join(w.root, 'clone'), 'init', '-q');
  const final = await f.engine.snapshot(f.project.id, w);
  assert.deepEqual(notMergedOf(final), [{ path: 'clone/', reason: 'nested' }]);
  const outcome = await f.engine.apply(f.project.id, { target: f.root, base: seed.commit, incoming: final.commit, kind: 'worker', source: {}, mode: 'all', labels, notMerged: notMergedOf(final) });
  assert.equal(outcome.status, 'applied'); assert.deepEqual(outcome.notMerged, [{ path: 'clone/', reason: 'nested' }]);
});
