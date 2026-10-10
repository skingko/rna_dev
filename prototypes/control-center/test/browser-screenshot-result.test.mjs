import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { checkBrowserOutput, screenshotResult } from '../browser-screenshot-result.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const result = { content: [{ type: 'text', text: '### Result\n- [Screenshot](./named.png)' }] };
async function fixture(t) { const root = await realpath(await mkdtemp(join(tmpdir(), 'rna-browser-image-'))); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('explicit PNG/JPEG filenames preserve original result and append bounded native pixels without duplicate images', async t => {
  const root = await fixture(t); await writeFile(join(root, 'named.png'), png);
  const response = await screenshotResult(result, { filename: 'named.png' }, root); assert.equal(response.isError, undefined); assert.deepEqual(response.content[0], result.content[0]); assert.equal(response.content.at(-1).data, png.toString('base64')); assert.equal(response.content.at(-1).mimeType, 'image/png');
  assert.equal(await screenshotResult(response, { filename: 'named.png' }, root), response);
  assert.equal(await screenshotResult(result, {}, root), result);
  const jpeg = Buffer.from([255,216,255,224,0,1,255,217]); await writeFile(join(root, 'named.jpg'), jpeg);
  const jpg = await screenshotResult(result, { filename: 'named.jpg' }, root); assert.equal(jpg.content.at(-1).mimeType, 'image/jpeg');
  const mismatch = await screenshotResult(result, { filename: 'named.jpg', type: 'png' }, root); assert.equal(mismatch.isError, true); assert.equal(mismatch.content.some(row => row.type === 'image'), false);
});
test('no arbitrary link/URL, cross-scope file, symlink, hardlink, special file or oversized screenshot can supply pixels', async t => {
  const root = await fixture(t), output = join(root, 'output'), other = join(root, 'other'); await mkdir(output); await mkdir(other); await writeFile(join(other, 'named.png'), png);
  for (const filename of ['../other/named.png', join(other, 'named.png'), 'https://example.invalid/image']) await assert.rejects(checkBrowserOutput(output, filename));
  const absent = await screenshotResult({ content: [{ type: 'text', text: `![Image](${join(other, 'named.png')})` }] }, { filename: 'named.png' }, output); assert.equal(absent.isError, true);
  await symlink(join(other, 'named.png'), join(output, 'link.png')); await assert.rejects(checkBrowserOutput(output, 'link.png'));
  await link(join(other, 'named.png'), join(output, 'hard.png')); await assert.rejects(checkBrowserOutput(output, 'hard.png'));
  await mkdir(join(output, 'directory.png')); await assert.rejects(checkBrowserOutput(output, 'directory.png'));
  await writeFile(join(output, 'large.png'), Buffer.alloc(3 * 1024 * 1024 + 1)); assert.equal((await screenshotResult(result, { filename: 'large.png' }, output)).isError, true);
  await symlink(output, join(root, 'alias')); await assert.rejects(checkBrowserOutput(join(root, 'alias'), 'named.png'));
  const signal = AbortSignal.abort(); await assert.rejects(screenshotResult(result, { filename: 'named.png' }, output, signal), { name: 'AbortError' });
});
