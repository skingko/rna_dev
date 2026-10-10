import test from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, newerVersion } from '../update-check.mjs';

test('update check compares versions and reports a private or missing release source plainly', async () => {
  assert.equal(newerVersion('v0.31.0', '0.30.0'), true); assert.equal(newerVersion('0.30.0', '0.30.0'), false); assert.equal(newerVersion('0.29.9', '0.30.0'), false); assert.equal(newerVersion('x', '0.30.0'), false);
  const reply = (status, body) => async url => { assert.match(url, /api\.github\.com\/repos\/skingko\/rna_dev\/releases\/latest/); return new Response(JSON.stringify(body ?? {}), { status }); };
  assert.equal((await checkForUpdate({ current: '0.30.0', fetchImpl: reply(404) })).status, 'source_unavailable');
  assert.deepEqual((({ status, latest }) => ({ status, latest }))(await checkForUpdate({ current: '0.30.0', fetchImpl: reply(200, { tag_name: 'v0.31.0', html_url: 'https://github.com/skingko/rna_dev/releases/tag/v0.31.0' }) })), { status: 'available', latest: '0.31.0' });
  assert.equal((await checkForUpdate({ current: '0.30.0', fetchImpl: reply(200, { tag_name: 'v0.30.0' }) })).status, 'current');
  assert.equal((await checkForUpdate({ current: '0.30.0', fetchImpl: async () => { throw new Error('offline'); } })).status, 'unreachable');
});
