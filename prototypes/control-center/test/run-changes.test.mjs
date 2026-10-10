import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { turnFixture, put, read, there, skip } from './helpers/turn-fixture.mjs';
import { checkpointChanges, worktreeChanges, ranUnhookedTool, guardContinued, guardOpenText, GUARD_SOURCE } from '../run-changes.mjs';

// Plan 2026-10-05 §2.2 C1: where the guard pass at the end of a run gets "what this run changed", and what it tells the
// user when a hit could not be fixed. A real temporary repository for the worktree source; nothing else is faked.

test('ranUnhookedTool: only a command, a generated or MCP tool and the rest that are not named file tools can write without a hook', () => {
  const result = name => ({ role: 'toolResult', toolName: name });
  assert.equal(ranUnhookedTool([result('project_read'), result('project_write'), result('project_edit'), result('project_grep'), result('web_fetch'), result('skill_load'), result('ask_user')]), false, 'hooked, or no write at all');
  assert.equal(ranUnhookedTool([result('project_exec')]), true);
  assert.equal(ranUnhookedTool([result('agent_delegate')]), true, 'a worker\'s merge arrives through the delegation tool');
  assert.equal(ranUnhookedTool([result('mcp__files__write')]), true);
  assert.equal(ranUnhookedTool([{ role: 'assistant', content: [] }, { role: 'user', content: [] }]), false);
  assert.equal(ranUnhookedTool([result('project_exec'), result('project_read')], 1), false, 'only from the turn\'s own first message on');
  assert.equal(ranUnhookedTool(undefined), false); assert.equal(GUARD_SOURCE, 'host-guard-pass');
});

test('guardContinued: the one continuation is read from the journal: a finish-feedback of ours, nothing else counts', () => {
  const ours = { role: 'user', source: 'finish-feedback', context: [{ source: GUARD_SOURCE, text: 'x' }] };
  assert.equal(guardContinued([{ role: 'user', source: 'user', content: 'go' }, { role: 'assistant', content: [] }]), false, 'an offer the SDK dropped leaves nothing in the journal');
  assert.equal(guardContinued([{ role: 'user', source: 'user', content: 'go' }, ours]), true);
  assert.equal(guardContinued([{ role: 'user', source: 'finish-feedback', context: [{ source: 'host-turn-settled', text: 'x' }] }]), false, 'another source\'s feedback is another allowance');
  assert.equal(guardContinued([{ role: 'assistant', source: 'finish-feedback', context: [{ source: GUARD_SOURCE }] }, { role: 'user', source: 'finish-feedback' }]), false, 'a user message of ours, with its context');
  assert.equal(guardContinued([ours, { role: 'user', source: 'user', content: 'next' }], 1), false, 'only from the run\'s own first message on');
  assert.equal(guardContinued(undefined), false);
});

test('guardOpenText: what the user reads when hits could not be fixed, in the interface language', () => {
  const open = [{ path: 'notes/a.md', title: 'TODO check', hits: 2 }, { path: 'notes/b.md', title: 'TODO check', hits: 1 }];
  assert.equal(guardOpenText(open, { language: 'zh' }), '这一轮改动的文件里，「TODO check」还有 3 处命中没有处理：notes/a.md, notes/b.md。');
  assert.equal(guardOpenText(open, { language: 'en' }), '3 hits from “TODO check” were left unfixed in the files this turn changed: notes/a.md, notes/b.md.');
  assert.equal(guardOpenText([{ path: 'a.md', title: '「守夜」字样检查', hits: 1 }], { language: 'zh', scope: 'background' }), '这次后台工作改的文件里，「守夜」字样检查还有 1 处命中没有处理：a.md。', 'a title that opens with its own quoted term is shown as it is');
  assert.equal(guardOpenText([{ path: 'a.md', title: '「Night」', hits: 1 }], { language: 'en', scope: 'background' }), '1 hit from “Night” was left unfixed in the files this background work changed: a.md.', 'a wrapped title is quoted in the reader\'s style');
  const many = ['a', 'b', 'c', 'd', 'e'].map(name => ({ path: `n/${name}.md`, title: 'One', hits: 1 }));
  assert.match(guardOpenText(many, { language: 'zh' }), /n\/a\.md, n\/b\.md, n\/c\.md 等 5 个文件。$/); assert.match(guardOpenText(many, { language: 'en' }), /n\/a\.md, n\/b\.md, n\/c\.md and 2 more\.$/);
  assert.equal(guardOpenText([], { language: 'en' }), ''); assert.equal(guardOpenText(undefined), '');
  assert.match(guardOpenText([{ path: 'a.md', title: 'One', hits: 1 }, { path: 'a.md', title: 'Two', hits: 1 }], { language: 'en' }), /^2 hits from “One” and “Two” were left unfixed/);
});

test('worktreeChanges: a worktree\'s files against its base, and each file as the base held it', { skip }, async t => {
  const f = turnFixture(t);
  const session = f.worktreeSession('工作树对话');
  await f.send(session.id, '看看');
  const root = await f.rootOf(session.id), record = f.recordOf(session.id), base = record.base ?? record.seed;
  // What a command did in the worktree: a rewrite, a new file, a removed file.
  put(root.root, 'a.txt', 'one\nTWO\nthree\n'); put(root.root, 'notes/new.md', 'created by a command\n');
  const source = worktreeChanges({ engine: f.engine, projectId: f.project.id, root, base });
  const changes = await source({});
  assert.deepEqual([...changes.paths].sort(), ['a.txt', 'notes/new.md']);
  assert.equal(await changes.read('a.txt'), 'one\ntwo\nthree\n', 'the file as the base held it');
  assert.equal(await changes.read('notes/new.md'), null, 'a file the run created did not exist');
  assert.equal(await changes.read('src/app.js'), 'export const a = 1;\n');
  // A worktree with nothing changed has no paths; a source needs everything it reads from.
  put(root.root, 'a.txt', 'one\ntwo\nthree\n'); put(root.root, 'notes/new.md', '');
  assert.deepEqual((await source({})).paths, ['notes/new.md'], 'back to what the base holds, apart from the one file');
  // The folder as the base held it, for a guard that reads other files than its own.
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/rna-run-changes-`)); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await changes.materialize(dir), true); assert.equal(read(dir, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(there(dir, 'notes/new.md'), false, 'a file the run created is not in the base');
  assert.equal(worktreeChanges({ engine: f.engine, projectId: f.project.id, root, base: null }), null);
  assert.equal(worktreeChanges({ engine: null, projectId: f.project.id, root, base }), null);
  assert.equal(worktreeChanges({ engine: f.engine, projectId: '', root, base }), null);
});

test('checkpointChanges: a direct-mode turn\'s checkpoint, or nothing', () => {
  assert.equal(checkpointChanges(null, { projectId: 'p', turnId: 't' }), null);
  assert.equal(checkpointChanges({}, { projectId: 'p', turnId: 't' }), null);
  assert.equal(checkpointChanges({ progress: async () => null }, { projectId: 'p', turnId: '' }), null);
  assert.equal(typeof checkpointChanges({ progress: async () => null }, { projectId: 'p', turnId: 't' }), 'function');
});

test('checkpointChanges: answers the checkpoint\'s progress as paths and a reader; null when the turn has none', async () => {
  const calls = [], read = async () => 'start text';
  const checkpoints = { progress: async (projectId, turnId, options) => { calls.push([projectId, turnId, Boolean(options?.signal)]); return turnId === 'taken' ? { paths: ['a.md'], excluded: [{ path: 'b.md' }], read, start: 's', end: 'e' } : null; } };
  const signal = new AbortController().signal;
  assert.deepEqual(await checkpointChanges(checkpoints, { projectId: 'p', turnId: 'taken' })({ signal }), { paths: ['a.md'], read });
  assert.equal(await checkpointChanges(checkpoints, { projectId: 'p', turnId: 'skipped' })({ signal }), null);
  assert.deepEqual(calls, [['p', 'taken', true], ['p', 'skipped', true]]);
  // The folder as the turn found it comes along when the checkpoint can write it.
  const materialize = async () => true;
  assert.equal((await checkpointChanges({ progress: async () => ({ paths: [], read, materialize }) }, { projectId: 'p', turnId: 't' })({})).materialize, materialize);
});
