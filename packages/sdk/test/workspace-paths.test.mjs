import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, symlink, writeFile, rm, stat, mkdir, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeMissingPath, missingPathCanonicalizer } from '../src/workspace-paths.mjs';

async function fixture(t) { const root = await realpath(await mkdtemp(join(tmpdir(), 'rna-missing-path-'))); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('missing protected leaves resolve through the nearest real existing ancestor without creating files', async t => {
  const root = await fixture(t), alias = join(root, 'alias'); await symlink(root, alias);
  assert.equal(await canonicalizeMissingPath(join(alias, 'future', 'nested', 'journal.jsonl')), join(root, 'future', 'nested', 'journal.jsonl'));
  await assert.rejects(stat(join(root, 'future')), { code: 'ENOENT' });
  await writeFile(join(root, 'existing.json'), '{}'); assert.equal(await canonicalizeMissingPath(join(alias, 'existing.json')), join(root, 'existing.json'));
});
test('non-directory ancestors and symlink loops fail closed rather than falling back to lexical paths', async t => {
  const root = await fixture(t); await writeFile(join(root, 'file'), 'ordinary'); await symlink('loop', join(root, 'loop'));
  await assert.rejects(canonicalizeMissingPath(join(root, 'file', 'journal')), { code: 'ENOTDIR' });
  await assert.rejects(canonicalizeMissingPath(join(root, 'loop', 'journal')), { code: 'ELOOP' });
});
test('dangling symlink ancestors cannot be mistaken for absent directories', async t => {
  const root = await fixture(t); await symlink(join(root, 'not-yet-created'), join(root, 'dangling'));
  await assert.rejects(canonicalizeMissingPath(join(root, 'dangling', 'journal')), { code: 'ENOENT' });
});
test('filesystem permission denial is propagated instead of being converted into a missing path', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, async t => {
  const root = await fixture(t), privateDir = join(root, 'private'); await mkdir(privateDir); await chmod(privateDir, 0);
  try { await assert.rejects(canonicalizeMissingPath(join(privateDir, 'future.json')), { code: 'EACCES' }); }
  finally { await chmod(privateDir, 0o700); }
});
// A host denies sidecars that may not exist yet (`<state>.usage-cache.jsonl`); its first append can land between
// realpath (ENOENT) and lstat (exists). That leaf was created, not dangling: the turn's tools must still be built.
test('a protected leaf created while it is being resolved resolves instead of failing as a dangling link', async t => {
  const root = await fixture(t), leaf = join(root, 'state.json.usage-cache.jsonl');
  let raced = false;
  const creating = { lstat, async realpath(path) { if (path === leaf && !raced) { raced = true; await writeFile(leaf, '{}\n'); throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' }); } return realpath(path); } };
  assert.equal(await missingPathCanonicalizer(creating)(leaf), leaf);
  assert.equal(raced, true);
  // A link whose target never appears is still dangling, however often it is resolved again.
  await symlink(join(root, 'never-created'), join(root, 'dangling-leaf'));
  await assert.rejects(canonicalizeMissingPath(join(root, 'dangling-leaf')), { code: 'ENOENT' });
});
