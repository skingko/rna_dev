import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { forgottenResultText } from '../src/context.mjs';

// Plan 2026-09-30 §9 D4 (context.forget): near the context limit, earlier tool
// results the host judges superseded become one line each before any summary.
const model = { providerId: 'forget-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 7000, maxOutputTokens: 500, reasoning: 'off' };
const isSummary = request => request.systemPrompt.startsWith('Summarize the provided');
const receipt = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
const placeholder = forgottenResultText('inspect');

async function fixture(t, { forgetStale } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-context-forget-')), handles = [], requests = [];
  let calls = 0;
  const provider = async function* (request) {
    requests.push(request);
    if (isSummary(request)) yield { type: 'text_delta', delta: 'Earlier reads summarized.' };
    else if (request.messages.at(-1).role === 'user') yield { type: 'tool_call', id: `read-${++calls}`, name: 'inspect', arguments: { file: `file-${calls}.md` } };
    else yield { type: 'text_delta', delta: 'done' };
    yield { type: 'usage', usage: receipt }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'inspect', effect: 'read', description: 'Read a fixture file.', parameters: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `${args.file}: ${'x '.repeat(3000)}` }];
  // A run here is two requests; a cache read at 0.6 of the uncached rate makes the warm break-even share 0.25 (cache-economics.mjs).
  const args = { sessionId: 'context-forget', projectId: 'forget-project', cwd: dir, stateDir: join(dir, 'state'), model, tools, provider, forgetStale, cachePricing: { input: 1, cacheRead: 0.6 } };
  const create = async extra => { const session = await createSession({ ...args, ...extra }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { session: await create(), create, requests };
}
const wire = request => JSON.stringify(request.messages);

test('superseded tool results become one line each, so no summary is needed, and the choice survives reopening', async t => {
  const asked = [];
  const f = await fixture(t, { forgetStale: async input => { asked.push(input); return [input.results[0].id]; } });
  await f.session.prompt('Read file-1.'); await f.session.prompt('Read file-2.');
  const before = f.session.snapshot().contextUsage.estimatedInputTokens;
  await f.session.prompt('Read file-3.');
  assert.equal(f.requests.filter(isSummary).length, 0, 'forgetting was enough; no summary request');
  assert.equal(asked.length, 1);
  // Only results outside the last two user turns are offered, with their tool, arguments and a preview.
  assert.deepEqual(asked[0].results.map(row => [row.toolName, row.args]), [['inspect', '{"file":"file-1.md"}']]);
  assert.match(asked[0].results[0].preview, /^file-1\.md: x x/);
  assert.equal(asked[0].request, 'Read file-3.');
  // The judgment is asked under the blocking trigger, once this turn's own call is in: the recent calls are the
  // last two completed turns' (ECON-1: the same targets the after-run pass had).
  assert.deepEqual(asked[0].recent, ['inspect {"file":"file-2.md"}', 'inspect {"file":"file-3.md"}']);
  const last = f.requests.at(-1);
  assert.ok(wire(last).includes(placeholder)); assert.ok(!wire(last).includes('file-1.md: x x'));
  assert.ok(wire(last).includes('file-3.md: x x'), 'recent results stay whole');
  // The journal keeps the whole result; the estimate drops with the placeholder.
  const saved = f.session.snapshot();
  assert.match(JSON.stringify(saved.messages), /file-1\.md: x x/);
  assert.ok(saved.contextUsage.estimatedInputTokens < before + 2000);
  await f.session.dispose();
  const reopened = await f.create({ sessionFile: saved.sessionFile });
  assert.deepEqual(reopened.snapshot().contextUsage, saved.contextUsage);
  await reopened.prompt('Anything else?');
  assert.ok(wire(f.requests.at(-1)).includes(placeholder));
});

test('when nothing is judged superseded (or no hook), the summary compaction runs as before', async t => {
  const f = await fixture(t, { forgetStale: async () => [] });
  for (const index of [1, 2, 3]) await f.session.prompt(`Read file-${index}.`);
  assert.ok(f.requests.filter(isSummary).length >= 1);
  assert.ok(!f.requests.some(request => wire(request).includes(placeholder)));
  const g = await fixture(t, { forgetStale: async () => { throw new Error('judge down'); } });
  for (const index of [1, 2, 3]) await g.session.prompt(`Read file-${index}.`);
  assert.ok(g.requests.filter(isSummary).length >= 1);
});

// TC-4: the judgment starts with the run, beside the request hook (routing, memory), so the first request rarely
// waits; a judgment slower than PREFLIGHT_BUDGET_MS after the run started is skipped for that request.
test('the forget judgment starts with the run and is skipped past its budget at the first request', async t => {
  const { PREFLIGHT_BUDGET_MS } = await import('../src/session.mjs');
  const timeline = [];
  let delay = 0;
  const f = await fixture(t, { forgetStale: async input => { timeline.push(['judge', performance.now()]); await new Promise(resolve => setTimeout(resolve, delay)); return [input.results[0].id]; } });
  await f.session.dispose();
  const hook = async () => { timeline.push(['hook', performance.now()]); await new Promise(resolve => setTimeout(resolve, 150)); return undefined; };
  const session = await f.create({ sessionId: 'forget-preflight', model: { ...model, contextWindow: 1000000 }, beforeRequest: hook });
  await session.prompt('Read file-1.'); await session.prompt('Read file-2.');
  // ECON-1: at a run's start its own turn has no response yet, so the last two COMPLETED turns stay whole: the third
  // run has nothing to offer (file-1 and file-2 are those turns), the fourth offers file-1.
  timeline.length = 0;
  await session.prompt('Read file-3.');
  assert.equal(timeline.filter(row => row[0] === 'judge').length, 0, 'nothing outside the last two completed turns yet');
  assert.ok(wire(f.requests.at(-2)).includes('file-1.md: x x') && wire(f.requests.at(-2)).includes('file-2.md: x x'), 'the last two completed turns stay whole in the first request');
  timeline.length = 0;
  await session.prompt('Read file-4.');
  const judged = timeline.find(row => row[0] === 'judge'), hooked = timeline.find(row => row[0] === 'hook');
  assert.ok(judged && hooked && judged[1] <= hooked[1] + 5, 'the judgment started with the run, not after the request hook');
  assert.ok(wire(f.requests.at(-2)).includes(placeholder), 'a prompt judgment is committed at the first request (it frees over the share)');
  assert.ok(wire(f.requests.at(-2)).includes('file-2.md: x x') && wire(f.requests.at(-2)).includes('file-3.md: x x'), 'the two completed turns before the run stay whole');
  // Warm, with candidates too small to reach the share: the judgment is not even asked.
  const quiet = await f.create({ sessionId: 'forget-quiet', model: { ...model, contextWindow: 1000000 }, forgetStale: async input => { timeline.push(['quiet', performance.now()]); return [input.results[0].id]; } });
  await quiet.prompt(`Background: ${'资料'.repeat(30000)}`); for (const index of [1, 2, 3, 4]) await quiet.prompt(`Read file-${index}.`);
  assert.equal(timeline.filter(row => row[0] === 'quiet').length, 0, 'no judgment whose answer could not be used');
  // A slow judge: the first request does not wait past the budget, and nothing is set aside for it.
  delay = PREFLIGHT_BUDGET_MS + 1500;
  const started = performance.now();
  await session.prompt('Read file-5.');
  assert.ok(performance.now() - started < PREFLIGHT_BUDGET_MS + 1000, 'the turn did not wait for the slow judgment');
  assert.ok(wire(f.requests.at(-2)).includes('file-2.md: x x'), 'the late answer is not applied to this request');
});
