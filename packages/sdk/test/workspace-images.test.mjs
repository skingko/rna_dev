import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eZkAAAAASUVORK5CYII=', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-workspace-images-')), root = join(dir, 'project'); await mkdir(root);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root, { includeMutations: true, ...options });
  return { dir, root, ...Object.fromEntries(tools.map(tool => [tool.name.replace('project_', ''), tool])) };
}

test('a real PNG file returns exact original pixels and model-visible hash regardless of filename suffix', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'screenshot.data'), png);
  const result = await f.read.execute('read', { path: 'screenshot.data' });
  assert.equal(result.details.hash, hash(png)); assert.equal(result.details.bytes, png.length); assert.equal(result.details.truncated, false);
  assert.deepEqual(result.content[1], { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  assert.match(result.content[0].text, new RegExp(hash(png))); assert.match(result.content[0].text, /original pixels attached/);
  assert.deepEqual(Buffer.from(result.content[1].data, 'base64'), await readFile(join(f.root, 'screenshot.data')));
});

test('JPEG/GIF/WebP signatures select MIME without trusting extensions or decoding pixels as text', async t => {
  const f = await fixture(t);
  // These small buffers test the shared signature contract only, not a decoder
  // or visual correctness. The preceding test uses a complete one-pixel PNG.
  const samples = [['image/jpeg', Buffer.from([255, 216, 255, 224, 0, 2, 255, 217])], ['image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')], ['image/webp', Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')]];
  for (const [mimeType, bytes] of samples) {
    await writeFile(join(f.root, 'wrong.png'), bytes); const result = await f.read.execute('read', { path: 'wrong.png' });
    assert.equal(result.content[1].mimeType, mimeType); assert.deepEqual(Buffer.from(result.content[1].data, 'base64'), bytes); assert.equal(result.details.hash, hash(bytes));
  }
  await writeFile(join(f.root, 'ordinary.png'), 'An ordinary text file.'); assert.equal((await f.read.execute('read', { path: 'ordinary.png' })).content.length, 1);
});

test('image reads reject line ranges and retain the default and configured byte bounds', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'image.png'), png);
  for (const range of [{ offset: 1 }, { limit: 1 }, { offset: 2, limit: 20 }]) await assert.rejects(f.read.execute('read', { path: 'image.png', ...range }), { code: 'image_range_unsupported' });
  const oversized = Buffer.alloc(1024 * 1024 + 1); png.copy(oversized); await writeFile(join(f.root, 'large.png'), oversized);
  await assert.rejects(f.read.execute('read', { path: 'large.png' }), { code: 'invalid_file' });
  const small = (await createWorkspaceTools(f.root, { maxFileBytes: png.length - 1 }))[0]; await assert.rejects(small.execute('read', { path: 'image.png' }), { code: 'invalid_file' });
  await writeFile(join(f.root, 'unknown.png'), Buffer.from([0, 255, 1])); await assert.rejects(f.read.execute('read', { path: 'unknown.png' }), { code: 'invalid_file' });
  await assert.rejects(f.read.execute('read', { path: '.' }), { code: 'invalid_file' });
});

test('image pixels obey private paths, explicit denied paths and symlink escape checks', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'private-state')); await writeFile(join(f.root, 'private-state', 'image.png'), png);
  await writeFile(join(f.root, '.env'), png); await writeFile(join(f.dir, 'outside.png'), png); await symlink(join(f.dir, 'outside.png'), join(f.root, 'escape.png')); await symlink(join(f.root, 'private-state'), join(f.root, 'alias'));
  const reader = (await createWorkspaceTools(f.root, { deniedPaths: [join(f.root, 'private-state')] }))[0];
  for (const path of ['.env', '../outside.png', 'escape.png', 'private-state/image.png', 'alias/image.png']) await assert.rejects(reader.execute('read', { path }), { code: 'path_denied' });
});

test('write/edit remain text-only and grep skips images including ASCII-compatible signatures', async t => {
  const f = await fixture(t);
  for (const bytes of [png, Buffer.from('GIF89a plain-looking payload')]) {
    await writeFile(join(f.root, 'binary'), bytes);
    for (const [tool, args] of [[f.write, { content: 'replacement' }], [f.edit, { oldText: 'GIF89a', newText: 'changed' }]]) {
      const result = await tool.execute('mutate', { path: 'binary', expectedHash: hash(bytes), ...args }); assert.equal(result.isError, true); assert.equal(result.details.code, 'invalid_file');
      assert.deepEqual(await readFile(join(f.root, 'binary')), bytes);
    }
  }
  await writeFile(join(f.root, 'text.txt'), 'GIF89a occurs later in this line'.replace(/^GIF89a/, 'Text: GIF89a'));
  const search = (await f.grep.execute('grep', { query: 'GIF89a' })).details; assert.deepEqual(search.matches.map(row => row.path), ['text.txt']);
});
