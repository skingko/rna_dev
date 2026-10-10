import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { growthPerRun } from '../src/cache-economics.mjs';

// Plan C5: whether a warm prompt cache may be edited (settle, prune, forget at a run's first request) is decided by the
// break-even share computed from the model's cache prices and this conversation's requests per run (cache-economics.mjs),
// not by a fixed 25%. Without a price a warm cache is left alone; cold-break economies are unchanged. The margin the
// deferred compaction's economies must leave under the trigger is another question — how fast the conversation grows, not
// what a cache read costs — and is measured on its own turns (review of C5, finding 3). Fake providers only.
const model = { providerId: 'econ-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 1000000, maxOutputTokens: 500, reasoning: 'off' };
const receipt = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
const NOTE = '[set aside]';
const settleArguments = (name, args) => name === 'write' && args.content.length > 100 ? { ...args, content: NOTE } : null;
const wire = request => JSON.stringify(request.messages);
const rowsOf = async session => (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

/** A writing conversation: each turn is two requests (the write, then the answer) and writes ~12k characters. */
async function fixture(t, { size = 6000, extra = {}, window } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-warm-edit-')), requests = [];
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const provider = async function* (request) {
    requests.push(request);
    if (request.systemPrompt.startsWith('Summarize the provided')) yield { type: 'text_delta', delta: 'summary' };
    else if (request.messages.at(-1).role === 'user') yield { type: 'tool_call', id: `write-${++calls}`, name: 'write', arguments: { path: `ch${calls}.md`, content: `第${calls}章 ${'正文'.repeat(size)}` } };
    else yield { type: 'text_delta', delta: 'written' };
    yield { type: 'usage', usage: receipt }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'write', effect: 'write', description: 'Write a fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `wrote ${args.path}` }];
  const session = await createSession({ sessionId: 'warm-edit', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model: window ? { ...model, ...window } : model, tools, provider, settleArguments, ...extra });
  t.after(() => session.dispose());
  return { session, requests };
}
const chapters = async (session, count) => { for (let index = 1; index <= count; index++) await session.prompt(`Write chapter ${index}.`); };

test('the break-even is read from the host\'s prices and this conversation\'s requests per run; no price, no break-even', async t => {
  const asked = [];
  const prices = { 'econ-fixture/fixture': { input: 8, cacheRead: 2 }, 'econ-fixture/cheap': { input: 8, cacheRead: 0.4 } };
  const f = await fixture(t, { extra: { cachePricing: input => { asked.push(input); return prices[`${input.providerId}/${input.modelId}`] ?? null; } } });
  assert.deepEqual(f.session.cacheBreakEven(), { share: 0.75, read: 0.25, write: 1, requests: 1 }, 'no turn yet: one request');
  await chapters(f.session, 3);
  const two = f.session.cacheBreakEven();
  assert.equal(two.requests, 2, 'a turn here is two requests'); assert.equal(two.share, 0.75 / (1 + 0.25)); assert.deepEqual(asked.at(-1), { providerId: 'econ-fixture', modelId: 'fixture' });
  // Another model of the session: its own price.
  f.session.setModel({ ...model, modelId: 'cheap' });
  assert.equal(f.session.cacheBreakEven().read, 0.05); assert.ok(f.session.cacheBreakEven().share > two.share, 'cheaper reads: a larger share');
  f.session.setModel({ ...model, modelId: 'unpriced' });
  assert.equal(f.session.cacheBreakEven(), null, 'a model with no price');
  // The option: an object, nothing, a function that throws or returns junk.
  const fixed = await fixture(t, { extra: { cachePricing: { input: 1, cacheRead: 0.5, cacheWrite: 1.25 } } });
  assert.deepEqual(fixed.session.cacheBreakEven(), { share: 0.75 / 1.25, read: 0.5, write: 1.25, requests: 1 });
  for (const cachePricing of [undefined, null, () => { throw new Error('price table down'); }, () => ({ input: 0, cacheRead: 1 }), () => 'cheap']) assert.equal((await fixture(t, { extra: { cachePricing } })).session.cacheBreakEven(), null);
  await assert.rejects(createSession({ sessionId: 'x', cwd: f.session.snapshot().cwd, stateDir: join(f.session.snapshot().cwd, 'state-x'), model, provider: async function* () {}, cachePricing: { input: -1 } }), { code: 'invalid_options' });
});

// The same saving is worth taking at one price and not at another: the scenario is the one the old fixed share was
// written for (the fourth turn's first request has chapter 1 of three written chapters to set aside: about a quarter of
// the context). At a read 0.05 of the uncached rate the saving per request is small next to the re-read it costs, so the
// share is 0.9 and the cache is left alone; at a read 0.6 of it the share is 0.25 and the chapter is set aside.
test('the same saving is taken at one price and refused at another; with no price a warm cache is left alone, a cold one is not', async t => {
  const settled = async (cachePricing, extra = {}) => {
    const f = await fixture(t, { extra: { cachePricing, ...extra } });
    await chapters(f.session, 4);
    const first = wire(f.requests.at(-2));
    return { note: first.includes(NOTE), rows: (await rowsOf(f.session)).filter(row => row.type === 'context_settle').length, share: f.session.cacheBreakEven()?.share ?? null };
  };
  const cheap = await settled({ input: 1, cacheRead: 0.05 }), dear = await settled({ input: 1, cacheRead: 0.6 }), none = await settled(undefined);
  assert.equal(cheap.share, 0.95 / 1.05, 'two requests per run');
  assert.deepEqual({ note: cheap.note, rows: cheap.rows }, { note: false, rows: 0 }, 'the cheap cache read: not worth breaking the cache');
  assert.equal(dear.share, 0.4 / 1.6);
  assert.deepEqual({ note: dear.note, rows: dear.rows }, { note: true, rows: 1 }, 'the dear one: worth it');
  assert.equal(none.share, null);
  assert.deepEqual({ note: none.note, rows: none.rows }, { note: false, rows: 0 }, 'no price: the warm cache is left alone');
  // A cold break needs no price: any saving is committed (the cache is gone anyway).
  let now = Date.parse('2026-10-05T08:00:00Z');
  const cold = await fixture(t, { extra: { clock: () => now, cacheSurvivalMs: 3600000 } });
  await chapters(cold.session, 3);
  now += 2 * 3600000;
  await cold.session.prompt('Write chapter 4.');
  assert.ok(wire(cold.requests.at(-2)).includes(NOTE), 'cold: set aside without a price');
});

test('with no price the forget judgment is not even asked at a warm break; with one it is', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-warm-forget-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (cachePricing, name) => {
    const asked = []; let calls = 0;
    const provider = async function* (request) {
      if (request.messages.at(-1).role === 'user') yield { type: 'tool_call', id: `read-${name}-${++calls}`, name: 'inspect', arguments: { file: `file-${calls}.md` } };
      else yield { type: 'text_delta', delta: 'done' };
      yield { type: 'usage', usage: receipt }; yield { type: 'done', stopReason: 'stop' };
    };
    const tools = [{ name: 'inspect', effect: 'read', description: 'Read.', parameters: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `${args.file}: ${'x '.repeat(3000)}` }];
    const session = await createSession({ sessionId: `warm-forget-${name}`, projectId: 'p', cwd: dir, stateDir: join(dir, name), model, tools, provider, cachePricing, forgetStale: async input => { asked.push(input); return [input.results[0].id]; } });
    t.after(() => session.dispose());
    for (const index of [1, 2, 3, 4]) await session.prompt(`Read file-${index}.`);
    return asked.length;
  };
  assert.equal(await run({ input: 1, cacheRead: 0.6 }, 'priced') > 0, true, 'a priced model: the judgment is asked when its answer could be used');
  assert.equal(await run(undefined, 'unpriced'), 0, 'no price: no judgment whose answer could not be used');
});

// ECON-3 (compaction-review-fixes), as reviewed after C5: the context crosses the deferred trigger by less than settling
// frees. The economies are committed in that break either way; the summary rides with them unless they left a margin under
// the trigger — what one more run of this conversation adds to the context (growthPerRun). That margin was the warm rule's
// break-even share, so at a cheap cache read (DeepSeek's 0.033) the economies had to bring the context under a fifth of the
// window or a summary was paid on top of them, though the fixed 25% before it had let them stand in.
// The two conversations below cross the trigger by the same amount and the economies free the same tokens; they differ only
// in how much a run adds (a short chapter request, or one carrying a long brief), so the dip under the trigger is the same
// and only the growth decides.
const MARGIN_RESERVE = 500, MARGIN_CROSS = 60;
async function marginScenario(t, { window, pad, background, cachePricing }) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-econ-margin-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [], events = []; let calls = 0;
  const provider = async function* (request) {
    requests.push(request);
    if (request.systemPrompt.startsWith('Summarize the provided')) yield { type: 'text_delta', delta: 'summary' };
    else if (request.messages.at(-1).role === 'user') { calls++; yield { type: 'tool_call', id: `w-${calls}`, name: 'write', arguments: { path: `c${calls}.md`, content: calls === 2 ? 'x'.repeat(4500) : 'y'.repeat(100) } }; }
    else yield { type: 'text_delta', delta: 'written' };
    yield { type: 'usage', usage: receipt }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'write', effect: 'write', description: 'Write.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, execute: async () => 'ok' }];
  const session = await createSession({ sessionId: 'econ-margin', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model: { ...model, contextWindow: window, maxOutputTokens: MARGIN_RESERVE }, tools, provider, cachePricing, onEvent: event => events.push(event),
    settleArguments: (name, args) => name === 'write' && args.content.length > 500 ? { ...args, content: NOTE } : null });
  t.after(() => session.dispose());
  await session.prompt(`Background ${'b'.repeat(background)}`);
  for (const index of [1, 2, 3, 4]) await session.prompt(`Write chapter ${index}. ${'note '.repeat(pad)}`);
  const snapshot = session.snapshot();
  return { end: snapshot.contextUsage.estimatedInputTokens, growth: growthPerRun(snapshot.messages, snapshot.compaction), economies: events.filter(event => event.type === 'context_economy' && event.reason === 'compaction'),
    summaries: requests.filter(request => request.systemPrompt.startsWith('Summarize the provided')).length, compactions: (await rowsOf(session)).filter(row => row.type === 'context_compaction').map(row => row.data.trigger) };
}
test('the margin the deferred compaction\'s economies must leave under the trigger is what one more run adds to the context, whatever a cache read costs', async t => {
  const outcome = async (variant, cachePricing) => {
    // The window is set from a dry run (no compaction): the fourth chapter's run ends MARGIN_CROSS tokens over the trigger.
    const dry = await marginScenario(t, { ...variant, window: 1000000 });
    const window = Math.ceil((dry.end + MARGIN_RESERVE - MARGIN_CROSS) / 0.8) + 1;
    const real = await marginScenario(t, { ...variant, window, cachePricing }), freed = real.economies[0]?.freedTokens ?? 0;
    // What the economies left under the trigger (the reserve counted): the threshold less the dry run's context less what they freed.
    return { ...real, window, dip: Math.floor(window * 0.8) - MARGIN_RESERVE - (dry.end - freed) };
  };
  const small = { pad: 0, background: 30000 }, large = { pad: 1000, background: 10000 };
  for (const cachePricing of [undefined, { input: 1, cacheRead: 0.05 }, { input: 1, cacheRead: 0.6 }]) {
    const price = JSON.stringify(cachePricing ?? null);
    // Growth well under the dip the settle leaves: the economies stand in for the summary, at every price.
    const a = await outcome(small, cachePricing), dipA = a.dip;
    assert.equal(a.economies.length, 1, `${price}: the crossing was met by the economies, in the compaction's own break`);
    assert.ok(dipA > 1000 && a.growth < dipA / 4, `${price}: a dip of ${dipA} tokens against ${a.growth} added per run`);
    assert.deepEqual([a.summaries, a.compactions], [0, []], `${price}: no summary on top of the economies`);
    // The same dip, but a run adds more than it: the next run would cross again, so the summary rides along in this break.
    const b = await outcome(large, cachePricing), dipB = b.dip;
    assert.equal(b.economies.length, 1, price); assert.ok(Math.abs(dipB - dipA) < 100, `the same dip: ${dipB} against ${dipA}`);
    assert.ok(b.growth > dipB, `${price}: ${b.growth} tokens added per run against a dip of ${dipB}`);
    assert.deepEqual([b.summaries, b.compactions], [1, ['after_response']], `${price}: a summary with the economies`);
  }
});
