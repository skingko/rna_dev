import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { compactionForkEnabled, ProviderError } from '../src/providers.mjs';

// Plan C5 (TC-6 on GLM): the paid probe of 2026-10-05 measured GLM-5.3 — 4 of 4 forks read at least 0.999 of the shared
// prefix from cache and answered in text only — so the fork is on for it without a saved flag. Automatic compaction at
// context pressure forks; idle, manual and overflow compaction never do; a fork past the cache's survival gives way to the
// flattened record; a rejected fork falls back once; the compaction record names the request and the prefix it extended.
// Fake providers only.
const base = { providerId: 'glm-fixture', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', contextWindow: 30000, maxOutputTokens: 800, reasoning: 'off' };
const glm = (patch = {}) => ({ ...base, ...patch });
const flattened = request => request.systemPrompt.startsWith('Summarize the provided');
const forked = request => request.purpose === 'compaction' && !flattened(request);
const rowsOf = async session => (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const usage = { input: 9, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10 };

async function fixture(t, { model = glm(), chapter = 2400, fork = () => [{ type: 'text_delta', delta: 'Forked summary of the earlier chapters.' }], flat = () => [{ type: 'text_delta', delta: 'Flattened summary.' }], tick = () => {}, extra = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-compaction-fork-c5-')), requests = [];
  const provider = async function* (request) {
    requests.push(request);
    if (flattened(request)) yield* flat(request);
    else if (forked(request)) yield* fork(request);
    else { tick(request); yield { type: 'text_delta', delta: `Chapter ${'正文'.repeat(chapter)}` }; }
    yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'lookup', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }];
  const session = await createSession({ sessionId: 'compaction-fork-c5', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model, tools, provider, systemPrompt: 'You are the fork fixture.', ...extra });
  t.after(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { session, requests, dir };
}
const run = async session => { for (let index = 1; index <= 6 && !session.snapshot().compaction; index++) await session.prompt(`Write chapter ${index}.`); };

test('compactionForkEnabled: GLM-5.3 on the official routes, an explicit boolean either way, nothing else', () => {
  for (const baseUrl of ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4/']) assert.equal(compactionForkEnabled(glm({ baseUrl })), true, baseUrl);
  assert.equal(compactionForkEnabled(glm({ modelId: 'glm-5.3-flash' })), false, 'Flash was not measured');
  assert.equal(compactionForkEnabled(glm({ modelId: 'glm-5.3-flashx' })), false);
  assert.equal(compactionForkEnabled(glm({ baseUrl: 'https://proxy.example.com/api/paas/v4' })), false, 'a proxy is not the measured route');
  assert.equal(compactionForkEnabled(glm({ baseUrl: 'https://api.z.ai/api/coding/paas/v4' })), false, 'another endpoint was not measured');
  assert.equal(compactionForkEnabled(glm({ protocol: 'anthropic' })), false);
  assert.equal(compactionForkEnabled(glm({ compat: { compactionFork: false } })), false, 'an explicit false wins');
  assert.equal(compactionForkEnabled(glm({ modelId: 'glm-5.3-flash', compat: { compactionFork: true } })), true, 'an explicit true wins');
  assert.equal(compactionForkEnabled(glm({ compat: { compactionFork: 'yes' } })), true, 'a non-boolean flag is ignored');
  assert.equal(compactionForkEnabled({ ...base, providerId: 'x', modelId: 'fixture', baseUrl: 'http://127.0.0.1:9' }), false, 'a model without the flag');
  assert.equal(compactionForkEnabled({ ...base, modelId: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' }), false);
  assert.equal(compactionForkEnabled(undefined), false);
});

test('a GLM-5.3 conversation forks with no saved flag; Flash, a proxy and an explicit false stay flattened', async t => {
  const f = await fixture(t);
  await run(f.session);
  const fork = f.requests.find(forked), previous = f.requests[f.requests.indexOf(fork) - 1];
  assert.ok(fork, 'the fork was sent'); assert.equal(f.requests.filter(flattened).length, 0);
  assert.equal(fork.cache.prefixHash, previous.cache.prefixHash, 'same system prompt and tools as the request before it');
  assert.ok(JSON.stringify(fork.messages).startsWith(JSON.stringify(previous.messages).slice(0, -1)), 'its messages extend that request\'s');
  for (const [name, model] of [['Flash', glm({ modelId: 'glm-5.3-flash' })], ['a proxy', glm({ baseUrl: 'https://proxy.example.com/api/paas/v4' })], ['an explicit false', glm({ compat: { compactionFork: false } })], ['a model with no flag', glm({ modelId: 'other', baseUrl: 'http://127.0.0.1:9' })]]) {
    const g = await fixture(t, { model });
    await run(g.session);
    assert.ok(g.session.snapshot().compaction, name); assert.equal(g.requests.filter(forked).length, 0, name); assert.ok(g.requests.filter(flattened).length >= 1, name);
  }
});

test('the compaction record names the fork: fork, the request that wrote the text, and the answer whose prefix it extended', async t => {
  const f = await fixture(t);
  await run(f.session);
  const rows = await rowsOf(f.session), at = rows.findIndex(row => row.type === 'context_compaction'), compaction = rows[at].data, started = rows.filter(row => row.type === 'compaction_request_started');
  assert.equal(started.length, 1); assert.equal(started[0].data.fork, true);
  assert.equal(compaction.fork, true); assert.equal(compaction.requestId, started[0].data.requestId); assert.equal(compaction.forkRejected, undefined);
  const lastAnswer = rows.slice(0, at).findLast(row => row.type === 'request_completed' && row.data.message?.role === 'assistant' && row.data.discarded !== true).data.message;
  assert.equal(compaction.prefixMessageId, lastAnswer.id, 'the last answer sent before the compaction');
  assert.ok(rows.some(row => row.type === 'compaction_request_completed' && row.data.requestId === compaction.requestId), 'its usage receipt carries the same id');
  // A flattened compaction says it was not a fork.
  const g = await fixture(t, { model: glm({ compat: { compactionFork: false } }) });
  await run(g.session);
  const flat = (await rowsOf(g.session)).find(row => row.type === 'context_compaction').data;
  assert.equal(flat.fork, undefined); assert.equal(typeof flat.requestId, 'string'); assert.equal(flat.forkRejected, undefined);
});

test('a fork that calls a tool falls back to flat once; the record names the rejected request', async t => {
  const f = await fixture(t, { fork: () => [{ type: 'tool_call', id: 'x', name: 'lookup', arguments: {} }] });
  await run(f.session);
  const rows = await rowsOf(f.session), compaction = rows.find(row => row.type === 'context_compaction').data, started = rows.filter(row => row.type === 'compaction_request_started');
  assert.equal(started.length, 2); assert.equal(started[0].data.fork, true); assert.equal(started[1].data.fork, undefined);
  assert.equal(f.requests.filter(forked).length, 1, 'one fork, never a retry of it'); assert.equal(f.requests.filter(flattened).length, 1);
  assert.equal(f.session.snapshot().compaction.summary, 'Flattened summary.');
  assert.equal(compaction.fork, undefined); assert.equal(compaction.requestId, started[1].data.requestId);
  assert.deepEqual(compaction.forkRejected, { reason: 'tool_call', requestId: started[0].data.requestId });
  assert.equal(rows.find(row => row.type === 'compaction_fork_rejected').data.requestId, started[0].data.requestId);
  // An empty answer is rejected the same way, and so is a truncated one.
  for (const [name, fork] of [['empty', () => []], ['truncated', () => [{ type: 'text_delta', delta: 'cut off' }, { type: 'usage', usage }, { type: 'done', stopReason: 'length' }]]]) {
    const g = await fixture(t, { fork: function* () { yield* fork(); } });
    await run(g.session);
    assert.equal(g.session.snapshot().compaction.summary, 'Flattened summary.', name); assert.equal(g.session.snapshot().compaction.forkRejected.reason, 'invalid_summary', name);
  }
});

test('a fork the service refuses as too long gives way to one flattened request (a smaller batch cannot help a fork)', async t => {
  const overflow = () => new ProviderError('模型请求失败（HTTP 400）：Your input exceeds the context window of this model.', { code: 'http_error', status: 400, providerCode: 'context_length_exceeded', category: 'context_limit' });
  const f = await fixture(t, { fork: function* () { throw overflow(); } });
  await run(f.session);
  const rows = await rowsOf(f.session), compaction = rows.find(row => row.type === 'context_compaction').data, started = rows.filter(row => row.type === 'compaction_request_started');
  assert.equal(f.requests.filter(forked).length, 1, 'the fork once, not once per shrunken batch'); assert.equal(f.requests.filter(flattened).length, 1);
  assert.equal(compaction.fork, undefined); assert.deepEqual(compaction.forkRejected, { reason: 'context_limit', requestId: started[0].data.requestId });
  assert.equal(f.session.snapshot().compaction.summary, 'Flattened summary.');
});

// Review of C5 (finding 4): the shrink loop re-enters the summary step with a smaller source batch when the flattened request
// is too long for the service. A fork is the whole conversation plus an instruction, so a smaller batch changes nothing for
// it: it is weighed once per compaction. Before, a fork the model answered with a tool call was sent again for every shrink.
test('the fork is sent once per compaction, however many times the flattened request has to be shrunk', async t => {
  const overflow = () => new ProviderError('模型请求失败（HTTP 400）：Your input exceeds the context window of this model.', { code: 'http_error', status: 400, providerCode: 'context_length_exceeded', category: 'context_limit' });
  let flats = 0;
  // The flattened request is too long twice (two shrinks), then fits.
  const g = await fixture(t, { fork: () => [{ type: 'tool_call', id: 'x', name: 'lookup', arguments: {} }], flat: () => { if (++flats <= 2) throw overflow(); return [{ type: 'text_delta', delta: 'Flattened summary after two shrinks.' }]; } });
  await run(g.session);
  const rows = await rowsOf(g.session), started = rows.filter(row => row.type === 'compaction_request_started'), compaction = rows.find(row => row.type === 'context_compaction').data;
  assert.equal(g.requests.filter(forked).length, 1, 'one fork for the whole compaction'); assert.equal(g.requests.filter(flattened).length, 3, 'the flattened request three times: two too long, one that fits');
  assert.equal(started.filter(row => row.data.fork === true).length, 1);
  assert.equal(rows.filter(row => row.type === 'compaction_fork_rejected').length, 1, 'the rejection is journaled once');
  assert.equal(g.session.snapshot().compaction.summary, 'Flattened summary after two shrinks.');
  assert.deepEqual(compaction.forkRejected, { reason: 'tool_call', requestId: started[0].data.requestId }, 'the record that follows the shrinks still names the rejected fork');
  assert.equal(compaction.fork, undefined);
});

test('idle and manual compaction never fork, whatever the flag says', async t => {
  const f = await fixture(t, { model: glm({ compat: { compactionFork: true } }), chapter: 600 });
  for (const index of [1, 2, 3, 4]) await f.session.prompt(`Write chapter ${index}.`);
  // Idle: the plan's requests are the flattened record.
  const plan = f.session.prepareCompaction();
  assert.ok(plan); assert.ok(plan.requests.every(entry => flattened(entry.request)));
  // Manual: the user's own compaction, with the model summarizing.
  f.requests.length = 0;
  const done = await f.session.compact({ generate: true });
  assert.equal(done.compacted, true);
  assert.equal(f.requests.filter(forked).length, 0, 'no fork request'); assert.ok(f.requests.filter(flattened).length >= 1);
  const rows = await rowsOf(f.session);
  assert.equal(rows.some(row => row.type === 'compaction_fork_rejected'), false);
  assert.ok(rows.filter(row => row.type === 'compaction_request_started').every(row => row.data.fork === undefined));
  assert.equal(rows.find(row => row.type === 'context_compaction').data.fork, undefined);
  assert.equal(rows.find(row => row.type === 'context_compaction').data.forkRejected, undefined, 'not a rejected fork either: it was never considered');
});

test('an overflow recovery never forks: the service just refused a request this long, and the fork is that request plus an instruction', async t => {
  const overflow = () => new ProviderError('模型请求失败（HTTP 400）：Your input exceeds the context window of this model.', { code: 'http_error', status: 400, providerCode: 'context_length_exceeded', category: 'context_limit' });
  const first = await fixture(t, { chapter: 600 });
  for (const index of [1, 2, 3]) await first.session.prompt(`Write chapter ${index}.`);
  const { sessionFile } = first.session.snapshot(); await first.session.dispose();
  const requests = []; let refused = false;
  const provider = async function* (request) {
    requests.push(request);
    if (request.purpose !== 'compaction' && !refused) { refused = true; throw overflow(); }
    yield { type: 'text_delta', delta: flattened(request) ? 'Flattened summary after the overflow.' : forked(request) ? 'A fork must not be sent here.' : 'Answered after making room.' };
    yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' };
  };
  const session = await createSession({ sessionId: 'compaction-fork-c5', projectId: 'p', cwd: first.dir, stateDir: join(first.dir, 'state'), sessionFile, model: glm(), provider, systemPrompt: 'You are the fork fixture.' });
  t.after(() => session.dispose());
  await session.prompt('Next step?');
  assert.ok(refused); assert.ok(session.snapshot().compaction, 'the overflow was summarized');
  assert.equal(requests.filter(forked).length, 0); assert.ok(requests.filter(flattened).length >= 1);
  assert.equal(session.snapshot().compaction.fork, undefined); assert.equal(session.snapshot().compaction.forkRejected, undefined);
});

test('past the cache\'s survival there is no prefix to reuse: the fork gives way to the flattened record, and the journal says why', async t => {
  let now = Date.parse('2026-10-05T08:00:00Z');
  // Every answer takes three hours (the cache of a model that keeps nothing past an hour is gone by the time the run ends).
  const f = await fixture(t, { tick: () => { now += 3 * 3600000; }, extra: { clock: () => now, cacheSurvivalMs: 3600000 } });
  await run(f.session);
  const rows = await rowsOf(f.session), compaction = rows.find(row => row.type === 'context_compaction').data;
  assert.equal(f.requests.filter(forked).length, 0); assert.ok(f.requests.filter(flattened).length >= 1);
  assert.equal(compaction.fork, undefined); assert.deepEqual(compaction.forkRejected, { reason: 'cold', cold: 'idle' });
  assert.deepEqual(rows.filter(row => row.type === 'compaction_fork_rejected').map(row => row.data), [{ reason: 'cold', cold: 'idle' }]);
  // The same conversation with a warm cache forks.
  let warmNow = Date.parse('2026-10-05T08:00:00Z');
  const g = await fixture(t, { tick: () => { warmNow += 60000; }, extra: { clock: () => warmNow, cacheSurvivalMs: 3600000 } });
  await run(g.session);
  assert.ok(g.requests.some(forked)); assert.equal(g.session.snapshot().compaction.fork, true);
});

// Review of C5 (finding 5): a model whose cache survival nobody has measured read as warm at any gap, so a fork after hours of
// idle (a first request of a run) paid the whole context uncached. The host's longest observed warm gap is the evidence
// there is: within it the fork goes ahead, beyond it (or with no sample at all) it gives way to the flattened record.
test('with no known cache survival the fork counts the gap against the longest warm gap the host has seen', async t => {
  const HOUR = 3600000, outcome = async extra => {
    let now = Date.parse('2026-10-05T08:00:00Z');
    // Every answer takes three hours: the gap between the last request and the compaction.
    const f = await fixture(t, { tick: () => { now += 3 * HOUR; }, extra: { clock: () => now, ...extra } });
    await run(f.session);
    const rows = await rowsOf(f.session), compaction = rows.find(row => row.type === 'context_compaction').data;
    return { forks: f.requests.filter(forked).length, flats: f.requests.filter(flattened).length, forkRejected: compaction.forkRejected ?? null, journaled: rows.filter(row => row.type === 'compaction_fork_rejected').map(row => row.data) };
  };
  const cold = { reason: 'cold', cold: 'unknown_survival' };
  const none = await outcome({}); assert.equal(none.forks, 1, 'a host that tracks nothing: the old reading, warm'); assert.equal(none.forkRejected, null);
  const seenNothing = await outcome({ cacheWarmMaxMs: null });
  assert.equal(seenNothing.forks, 0, 'tracked, no warm gap ever seen: nothing says the cache holds'); assert.ok(seenNothing.flats >= 1); assert.deepEqual(seenNothing.forkRejected, cold); assert.deepEqual(seenNothing.journaled, [cold]);
  const shorter = await outcome({ cacheWarmMaxMs: HOUR }); assert.equal(shorter.forks, 0, 'a warm gap of an hour seen, three hours now'); assert.deepEqual(shorter.forkRejected, cold);
  const longer = await outcome({ cacheWarmMaxMs: 4 * HOUR }); assert.equal(longer.forks, 1, 'the cache was seen to survive four hours'); assert.equal(longer.forkRejected, null);
  // A known survival is judged by the idle rule as before; the warm gap is not asked.
  const known = await outcome({ cacheSurvivalMs: 6 * HOUR, cacheWarmMaxMs: null }); assert.equal(known.forks, 1, 'survival six hours, gap three: warm');
  const expired = await outcome({ cacheSurvivalMs: HOUR, cacheWarmMaxMs: 10 * HOUR }); assert.deepEqual(expired.forkRejected, { reason: 'cold', cold: 'idle' }, 'a known survival that has passed is idle, whatever was seen once');
  await assert.rejects(fixture(t, { extra: { cacheWarmMaxMs: -1 } }), { code: 'invalid_options' }); await assert.rejects(fixture(t, { extra: { cacheWarmMaxMs: 'long' } }), { code: 'invalid_options' });
});

// The economies of a compaction (settle, prune, forget) are committed before its summary, in the same break. They change
// messages the provider cached with the last answer, so a fork built on the edited projection would read that cache only up
// to the first edit. The fork request is built as the last answer left it: the economies recorded after it are left out.
// The scenario: the fourth chapter's run ends just over the deferred trigger, settling chapter 2's write brings the context
// back under it, and a run adds more than the room that leaves (each request carries a long brief), so the summary is due
// beside the economies (warm-edit-break-even.test.mjs). The window is set from a dry run that never compacts.
test('economies committed in the compaction\'s own break do not move the fork off the cached prefix', async t => {
  const build = async window => {
    const dir = await mkdtemp(join(tmpdir(), 'rna-compaction-fork-econ-')), requests = [];
    t.after(() => rm(dir, { recursive: true, force: true }));
    let calls = 0;
    const provider = async function* (request) {
      requests.push(request);
      if (flattened(request)) yield { type: 'text_delta', delta: 'Flattened summary.' };
      else if (forked(request)) yield { type: 'text_delta', delta: 'Forked summary.' };
      else if (request.messages.at(-1).role === 'user') { calls++; yield { type: 'tool_call', id: `w-${calls}`, name: 'write', arguments: { path: `c${calls}.md`, content: calls === 2 ? 'x'.repeat(4500) : 'y'.repeat(100) } }; }
      else yield { type: 'text_delta', delta: 'written' };
      yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' };
    };
    const tools = [{ name: 'write', effect: 'write', description: 'Write.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, execute: async () => 'ok' }];
    const session = await createSession({ sessionId: 'fork-econ', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model: glm({ contextWindow: window, maxOutputTokens: 500 }), tools, provider, cachePricing: { input: 1, cacheRead: 0.6 },
      settleArguments: (name, args) => name === 'write' && args.content.length > 500 ? { ...args, content: '[set aside]' } : null });
    t.after(() => session.dispose());
    await session.prompt(`Background ${'b'.repeat(10000)}`);
    for (const index of [1, 2, 3, 4]) await session.prompt(`Write chapter ${index}. ${'note '.repeat(1000)}`);
    return { session, requests };
  };
  const dry = await build(1000000), window = Math.ceil((dry.session.snapshot().contextUsage.estimatedInputTokens + 500 - 60) / 0.8) + 1;
  const { session, requests } = await build(window);
  const rows = await rowsOf(session), settle = rows.findIndex(row => row.type === 'context_settle'), compaction = rows.findIndex(row => row.type === 'context_compaction');
  assert.ok(settle > 0 && compaction > settle, 'the settle was committed first, in the same break');
  const fork = requests.find(forked), previous = requests[requests.indexOf(fork) - 1];
  assert.ok(fork, 'the fork was sent'); assert.equal(rows[compaction].data.fork, true);
  const wire = JSON.stringify(fork.messages);
  assert.ok(wire.includes('x'.repeat(4500)) && !wire.includes('[set aside]'), 'chapter 2 reads as the last answer saw it');
  assert.ok(wire.startsWith(JSON.stringify(previous.messages).slice(0, -1)), 'the fork extends the previous request\'s messages byte for byte');
  // The next ordinary request has the edit (and the summary): the economy is not undone, only left out of the fork.
  await session.prompt('Write chapter 5.');
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes('x'.repeat(4500)));
});
