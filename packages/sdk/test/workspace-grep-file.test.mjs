import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';
import { prepareEvaluationWorkspace } from '../src/project-evaluation-workspace.mjs';

async function fixture(t, options = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'rna-grep-file-')), root = join(parent, 'workspace'); await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const tools = Object.fromEntries((await createWorkspaceTools(root, options)).map(tool => [tool.name, tool]));
  return { parent, root, ...tools, search: async args => (await tools.project_grep.execute('grep', args)).details };
}

test('grep accepts a regular file, reports project-relative lines and keeps literal and case-sensitive matching', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'reports')); await writeFile(join(f.root, 'reports', 'daily.md'), 'first\n来源 A.B\n来源 a.b\n');
  const result = await f.search({ path: 'reports/daily.md', query: 'A.B' });
  assert.deepEqual(result.matches.map(row => [row.path, row.line]), [['reports/daily.md', 2], ['reports/daily.md', 3]]); assert.equal(result.scanned, 1); assert.equal(result.truncated, false);
  assert.equal((await f.search({ path: 'reports/daily.md', query: 'A.B', caseSensitive: true })).matches.length, 1);
  assert.equal((await f.search({ path: 'reports/daily.md', query: 'A.*' })).matches.length, 0);
  assert.equal((await f.search({ path: 'reports', query: '来源' })).matches.length, 2);
  await assert.rejects(f.project_find.execute('find', { path: 'reports/daily.md', pattern: '*.md' }), { code: 'ENOTDIR' }, 'project_find is deliberately unchanged');
});

test('explicit file grep preserves private, denied, escaping and symlink boundaries while keeping directory traversal behavior', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'safe')); await mkdir(join(f.root, 'private-zone'));
  await writeFile(join(f.root, 'safe', 'file.txt'), 'needle'); await writeFile(join(f.root, '.env'), 'needle'); await writeFile(join(f.root, 'private-zone', 'secret.txt'), 'needle'); await writeFile(join(f.parent, 'outside.txt'), 'needle');
  await symlink(join(f.root, 'safe', 'file.txt'), join(f.root, 'file-link')); await symlink(join(f.root, 'safe'), join(f.root, 'dir-link')); await symlink(f.parent, join(f.root, 'outside-link'));
  const grep = (await createWorkspaceTools(f.root, { deniedPaths: [join(f.root, 'private-zone')] })).find(tool => tool.name === 'project_grep');
  for (const path of ['.env', 'private-zone/secret.txt', '../outside.txt', 'outside-link/outside.txt', 'file-link', 'dir-link/file.txt']) await assert.rejects(grep.execute('denied', { path, query: 'needle' }), { code: 'path_denied' });
  const directory = (await grep.execute('directory', { query: 'needle' })).details;
  assert.deepEqual(directory.matches.map(row => row.path), ['safe/file.txt']);
  const alias = (await grep.execute('existing-directory-semantics', { path: 'dir-link', query: 'needle' })).details;
  assert.deepEqual(alias.matches.map(row => row.path), ['safe/file.txt']);
});

test('file grep skips (and reports) binary and non-text files, and scans text files of any size', async t => {
  const f = await fixture(t, { maxFileBytes: 64 });
  for (const path of ['binary', 'invalid-utf8']) {
    await writeFile(join(f.root, path), path === 'binary' ? Buffer.from('needle\0text') : Buffer.from([110, 101, 101, 100, 108, 101, 255]));
    const result = await f.search({ path, query: 'needle' }); assert.equal(result.matches.length, 0); assert.equal(result.skipped, 1); assert.equal(result.skippedFiles[0].reason, 'binary');
  }
  await writeFile(join(f.root, 'large.txt'), 'needle'.repeat(20)); assert.equal((await f.search({ path: 'large.txt', query: 'needle' })).matches.length, 1, 'the edit size limit does not apply to search');
  await writeFile(join(f.root, 'empty.txt'), Buffer.alloc(0)); assert.equal((await f.search({ path: 'empty.txt', query: 'needle' })).matches.length, 0);
  await assert.rejects(f.project_grep.execute('absent', { path: 'missing.txt', query: 'needle' }), { code: 'ENOENT' });
});

test('single-file grep bounds matches and line length, and scans past the old 4 MiB cap', async t => {
  const f = await fixture(t, { maxFileBytes: 8 * 1024 * 1024 }); await writeFile(join(f.root, 'many.txt'), ('needle ' + 'x'.repeat(700) + '\n').repeat(120));
  const many = await f.search({ path: 'many.txt', query: 'needle' }); assert.equal(many.matches.length, 100); assert.equal(many.truncated, true); assert.equal(many.matches[0].text.length, 501); assert.ok(many.matches[0].text.endsWith('…'));
  assert.equal((await f.search({ path: 'many.txt', query: 'needle', limit: 500 })).matches.length, 120);
  await writeFile(join(f.root, 'big.txt'), 'x'.repeat(5 * 1024 * 1024) + '\n第3章 needle\n');
  const large = await f.search({ path: 'big.txt', query: '^第[0-9]+章', regex: true }); assert.deepEqual(large.matches.map(row => row.line), [2]); assert.ok(large.bytesScanned > 5 * 1024 * 1024);
});

test('file and directory grep respect cancellation before and during path traversal', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'file.txt'), 'needle');
  for (const path of ['file.txt', '.']) {
    const controller = new AbortController(); controller.abort(); await assert.rejects(f.project_grep.execute('aborted', { path, query: 'needle' }, controller.signal), { name: 'AbortError' });
    const midflight = new AbortController(), promise = f.project_grep.execute('cancel-during-io', { path, query: 'needle' }, midflight.signal); midflight.abort(); await assert.rejects(promise, { name: 'AbortError' });
  }
});

test('isolated evaluation uses the same single-file grep contract without adding shell or production tools', async t => {
  const f = await fixture(t);
  const tools = await prepareEvaluationWorkspace(f.root, { files: [{ path: 'reports/daily.md', content: '来源：fixture\n分析：fixture' }], checks: [{ id: 'report', kind: 'file_exists', path: 'reports/daily.md' }] });
  const grep = tools.find(tool => tool.name === 'project_grep'); assert.deepEqual(grep.parameters, f.project_grep.parameters); assert.equal(grep.description, f.project_grep.description);
  const result = (await grep.execute('eval', { path: 'reports/daily.md', query: '来源' })).details; assert.equal(result.matches.length, 1); assert.equal(result.matches[0].path, 'reports/daily.md');
  assert.ok(!tools.some(tool => tool.name === 'project_exec')); assert.equal(grep.effect, 'read');
});
