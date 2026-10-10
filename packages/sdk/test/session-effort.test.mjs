import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';

// spec p1 effort §3.4/§3.5: a summary's effort can be chosen by the host for that request only (sideReasoning); a
// step-limit summary cut off by its output allowance is asked once more at the lightest effort; every request carries
// its estimated input for the ledger.
const glm = { control: 'effort', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], providerDefault: null, canDisable: false };
const model = { providerId: 'effort-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 64000, maxOutputTokens: 1000, reasoning: 'max', reasoningCapability: glm };
const lookup = { name: 'lookup', effect: 'read', parameters: { type: 'object', properties: { query: { type: 'string' } } }, execute: async () => 'observed' };

async function fixture(t, { summary, base = model, extra = {}, maxSteps = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-session-effort-')), requests = [];
  const provider = async function* (request) {
    requests.push(request);
    const n = requests.filter(row => row.purpose === 'summary').length;
    if (request.purpose === 'summary') { const { text, stop } = summary(n); yield { type: 'text_delta', delta: text }; yield { type: 'usage', usage: { input: 5, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 14 } }; yield { type: 'done', stopReason: stop }; return; }
    if (request.purpose === 'compaction' || /^Summarize/.test(request.systemPrompt)) { yield { type: 'text_delta', delta: 'Earlier work: two lookups, nothing open.' }; yield { type: 'done', stopReason: 'stop' }; return; }
    if (extra.answer) { yield { type: 'text_delta', delta: 'Done. '.repeat(300) }; yield { type: 'done', stopReason: 'stop' }; return; }
    yield { type: 'tool_call', id: `call-${requests.length}`, name: 'lookup', arguments: { query: String(requests.length) } };
    yield { type: 'usage', usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const session = await createSession({ sessionId: 'session-effort', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model: base, maxSteps, stepLimitBehavior: 'summarize', tools: [lookup], provider, systemPrompt: 'You are the fixture agent.', autoCompaction: false, ...(extra.options ?? {}) });
  t.after(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { session, requests };
}
const journal = async session => (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('a truncated step-limit summary is set aside and asked once more at the lightest effort', async t => {
  const f = await fixture(t, { summary: n => (n === 1 ? { text: 'Two observ', stop: 'length' } : { text: 'Two observations; the rest remains.', stop: 'stop' }) });
  await f.session.prompt('Inspect.');
  const summaries = f.requests.filter(row => row.purpose === 'summary');
  assert.deepEqual(summaries.map(row => row.model.reasoning), ['max', 'low']);
  assert.equal(summaries[1].messages.length, summaries[0].messages.length, 'the retry repeats the same request');
  assert.ok(f.requests.every(row => Number.isFinite(row.estimatedInputTokens) && row.estimatedInputTokens > 0), 'every request carries its estimated input');
  const snapshot = f.session.snapshot();
  assert.equal(snapshot.messages.at(-1).content[0].text, 'Two observations; the rest remains.');
  assert.equal(snapshot.messages.filter(message => message.source === 'step-limit-summary').length, 1, 'the cut answer is not in the conversation');
  const rows = await journal(f.session);
  assert.deepEqual(rows.filter(row => row.type === 'request_started' && row.data.purpose === 'step-limit-summary').map(row => [row.data.model.reasoning, row.data.retry ?? null]), [['max', null], ['low', 'output_limit']]);
  assert.equal(rows.filter(row => row.type === 'request_completed' && row.data.discarded === true).length, 1);
  assert.equal(f.session.snapshot().model.modelId, 'fixture');
});

test('a second truncation is a step-limit failure; Anthropic and a model already at its lightest get no lighter retry', async t => {
  const twice = await fixture(t, { summary: () => ({ text: 'cut', stop: 'length' }) });
  await assert.rejects(twice.session.prompt('Inspect.'), { code: 'step_limit' });
  assert.deepEqual(twice.requests.filter(row => row.purpose === 'summary').map(row => row.model.reasoning), ['max', 'low']);
  const lightest = await fixture(t, { base: { ...model, reasoning: 'low' }, summary: () => ({ text: 'cut', stop: 'length' }) });
  await assert.rejects(lightest.session.prompt('Inspect.'), { code: 'step_limit' });
  assert.equal(lightest.requests.filter(row => row.purpose === 'summary').length, 1);
  const anthropic = await fixture(t, { base: { ...model, providerId: 'anthropic-fixture', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', reasoningCapability: { ...glm, control: 'adaptive' } }, summary: () => ({ text: 'cut', stop: 'length' }) });
  await assert.rejects(anthropic.session.prompt('Inspect.'), { code: 'step_limit' });
  assert.equal(anthropic.requests.filter(row => row.purpose === 'summary').length, 1, 'preserved thinking binds the effort: no lighter retry');
});

test('sideReasoning sets the effort of one summary request only; the session keeps its own', async t => {
  const calls = [];
  const f = await fixture(t, { extra: { answer: true, options: { sideReasoning: input => { calls.push(input); return 'low'; } } }, maxSteps: 8 });
  await f.session.prompt('First.'); await f.session.prompt('Second.'); await f.session.prompt('Third.');
  const result = await f.session.compact({ generate: true, keepLastTurns: 1 });
  assert.equal(result.compacted, true);
  const summary = f.requests.find(row => row.purpose === 'compaction');
  assert.equal(summary.model.reasoning, 'low');
  assert.ok(summary.estimatedInputTokens > 0);
  assert.equal(calls.length, 1); assert.equal(calls[0].purpose, 'compaction'); assert.equal(calls[0].automatic, false); assert.ok(calls[0].signal instanceof AbortSignal);
  await f.session.prompt('Fourth.');
  assert.equal(f.requests.at(-1).model.reasoning, 'max', 'the conversation keeps its effort');
  const rows = await journal(f.session);
  assert.equal(rows.find(row => row.type === 'compaction_request_started').data.reasoning, 'low');
  // An invalid value or a throw keeps the session's effort.
  const g = await fixture(t, { extra: { answer: true, options: { sideReasoning: () => 'turbo' } }, maxSteps: 8 });
  await g.session.prompt('First.'); await g.session.prompt('Second.'); await g.session.prompt('Third.');
  await g.session.compact({ generate: true, keepLastTurns: 1 });
  assert.equal(g.requests.find(row => row.purpose === 'compaction').model.reasoning, 'max');
  await assert.rejects(createSession({ sideReasoning: 'low' }), { code: 'invalid_options' });
});

test('sideReasoning is told the effort the conversation sends now, after a per-turn route moved it (review EFF-3)', async t => {
  const calls = [];
  const f = await fixture(t, { base: { ...model, reasoning: 'default', reasoningSelection: 'auto' }, extra: { answer: true, options: { beforeRequest: () => ({ reasoning: 'max' }), sideReasoning: input => { calls.push(input); return undefined; } } }, maxSteps: 8 });
  await f.session.prompt('First.'); await f.session.prompt('Second.'); await f.session.prompt('Third.');
  await f.session.compact({ generate: true, keepLastTurns: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].model, { reasoning: 'max', reasoningSelection: 'auto', reasoningCapability: glm }, 'the routed level, not the session\'s starting value');
  assert.equal(f.requests.find(row => row.purpose === 'compaction').model.reasoning, 'max', 'undefined keeps the conversation\'s effort');
});
