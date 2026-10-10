import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../../../packages/sdk/src/session.mjs';

// Plan C5: the compaction record says whether its summary was the TC-6 fork request (`fork`, the `requestId` of the summary
// request, the `prefixMessageId` it extended, `forkRejected` for a flattened fallback), so A3's coverage benchmark can pick the
// next live fork compaction out of the journals. --dry: no model or JEV call.
const script = fileURLToPath(new URL('../benchmark/compaction-summary-coverage.mjs', import.meta.url));
const glm = { providerId: 'glm-fixture', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', contextWindow: 30000, maxOutputTokens: 800, reasoning: 'off' };
const flattened = request => request.systemPrompt.startsWith('Summarize the provided');

async function conversation(root, sessionId, { fork }) {
  const provider = async function* (request) {
    if (flattened(request)) yield { type: 'text_delta', delta: 'Flattened checkpoint: chapters 1 and 2 are done.' };
    else if (request.purpose === 'compaction') yield fork ? { type: 'text_delta', delta: 'Forked checkpoint: chapters 1 and 2 are done.' } : { type: 'tool_call', id: 'x', name: 'lookup', arguments: {} };
    else yield { type: 'text_delta', delta: `Chapter ${'正文'.repeat(2400)}` };
    yield { type: 'usage', usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'lookup', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }];
  const session = await createSession({ sessionId, projectId: 'p', cwd: root, stateDir: join(root, sessionId), model: glm, tools, provider, systemPrompt: 'You are the fork fixture.' });
  for (let index = 1; index <= 6 && !session.snapshot().compaction; index++) await session.prompt(`Write chapter ${index}.`);
  const compaction = session.snapshot().compaction; await session.dispose();
  return compaction;
}
const run = (root, ...args) => execFileSync(process.execPath, [script, root, '--dry', ...args], { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));

test('the coverage benchmark tells a fork compaction from a flattened one, and --fork picks the fork ones out', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-coverage-fork-')); t.after(() => rm(root, { recursive: true, force: true }));
  const forked = await conversation(root, 'forked', { fork: true }), fallback = await conversation(root, 'fallback', { fork: false });
  assert.equal(forked.fork, true); assert.equal(fallback.fork, undefined); assert.equal(fallback.forkRejected.reason, 'tool_call');
  const all = run(root).filter(row => row.id);
  assert.deepEqual(all.map(row => [row.session, row.fork, row.forkRejected]).sort(), [['forked', true, null], ['fallback', false, 'tool_call']].sort());
  assert.equal(all.find(row => row.fork).requestId, forked.requestId.slice(0, 12));
  const only = run(root, '--fork').filter(row => row.id);
  assert.deepEqual(only.map(row => row.session), ['forked'], 'only the fork compaction');
});
