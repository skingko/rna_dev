import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';

// Spec p1 compaction TC-5: a plain-text step-limit summary keeps the conversation's system prompt and tools, so its
// request reads the cached prefix; the boundary and task ride at the tail as a turn-scoped host instruction. A model
// that still calls a tool gets one retry on today's tool-free projection; nothing it asked for executes.
const fixtureModel = { providerId: 'prefix-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 64000, maxOutputTokens: 1000, reasoning: 'off' };
const deepseek = { providerId: 'deepseek', modelId: 'deepseek-v4-pro', protocol: 'openai', baseUrl: 'https://api.deepseek.com', contextWindow: 64000, maxOutputTokens: 1000, reasoning: 'off' };
const lookup = executed => ({ name: 'lookup', effect: 'read', parameters: { type: 'object', properties: { query: { type: 'string' } } }, execute: async () => { executed.count++; return `observed ${executed.count}`; } });

async function fixture(t, { model = fixtureModel, summary = () => [{ type: 'text_delta', delta: 'Two observations; the rest remains.' }], maxSteps = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-step-limit-prefix-')), requests = [], executed = { count: 0 };
  const provider = async function* (request) {
    requests.push(request);
    if (request.purpose === 'summary') yield* summary(request, requests.filter(row => row.purpose === 'summary').length);
    else yield { type: 'tool_call', id: `call-${requests.length}`, name: 'lookup', arguments: { query: String(requests.length) } };
    yield { type: 'usage', usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const session = await createSession({ sessionId: 'step-limit-prefix', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model, maxSteps, stepLimitBehavior: 'summarize', tools: [lookup(executed)], provider, systemPrompt: 'You are the fixture agent.' });
  t.after(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { session, requests, executed };
}
const boundaryOf = request => { const block = request.messages.at(-1).content.at(-1).text; return { label: block.split('\n')[0], items: JSON.parse(block.split('\n').slice(1).join('\n')) }; };

test('the summary request reuses the conversation prefix; the boundary is a host instruction at the tail', async t => {
  const f = await fixture(t);
  await f.session.prompt('Inspect the evidence.');
  const [first, , summary] = f.requests;
  assert.equal(summary.purpose, 'summary');
  assert.equal(summary.cache.prefixHash, first.cache.prefixHash, 'same system + tools: the cached prefix is reused');
  assert.equal(summary.systemPrompt, first.systemPrompt); assert.deepEqual(summary.tools, first.tools);
  const boundary = boundaryOf(summary);
  assert.match(boundary.label, /Rna host instructions/);
  assert.equal(boundary.items[0].source, 'host-purpose-instructions');
  assert.deepEqual(Object.keys(JSON.parse(boundary.items[0].text)), ['boundary', 'rule', 'task', 'constraints']);
  assert.equal(summary.toolChoice, undefined, 'tool_choice none is not verified for this endpoint');
  const journaled = f.session.snapshot().messages.find(message => message.contextKey === 'execution-boundary');
  assert.equal(journaled.contextScope, 'turn');
});

test('toolChoice none is sent only where it is verified (the DeepSeek endpoint)', async t => {
  const f = await fixture(t, { model: deepseek });
  // The verified endpoint is reached through the fixture provider; buildRequest validation is skipped for custom providers.
  await f.session.prompt('Inspect.');
  assert.equal(f.requests.at(-1).toolChoice, 'none');
  assert.equal(f.requests[0].toolChoice, undefined);
});

test('a tool call in the summary is set aside and retried once without tools; nothing executes', async t => {
  const f = await fixture(t, { summary: (_request, attempt) => attempt === 1 ? [{ type: 'tool_call', id: 'sneaky', name: 'lookup', arguments: { query: 'more' } }] : [{ type: 'text_delta', delta: 'Concluded without more tools.' }] });
  await f.session.prompt('Inspect.');
  assert.equal(f.executed.count, 2, 'only the two admitted steps ran');
  const summaries = f.requests.filter(request => request.purpose === 'summary');
  assert.equal(summaries.length, 2);
  assert.ok(summaries[0].tools.length > 0); assert.equal(summaries[1].tools.length, 0, 'the retry is the tool-free projection');
  assert.match(summaries[1].systemPrompt, /Execution boundary: This run has reached its model-step allowance/);
  const snapshot = f.session.snapshot();
  assert.equal(snapshot.messages.at(-1).content[0].text, 'Concluded without more tools.');
  assert.equal(snapshot.messages.filter(message => message.source === 'step-limit-summary').length, 1, 'the set-aside response is not in the conversation');
  assert.equal(snapshot.usage.totalTokens, 4 * 6, 'every request is billed once');
  const rows = (await readFile(snapshot.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.filter(row => row.type === 'tool_calls_rejected').map(row => row.data.retry), [true]);
  assert.equal(rows.filter(row => row.type === 'request_completed' && row.data.discarded === true).length, 1);
});

test('a resumed run in the same turn is told the boundary no longer holds; a new turn needs no clearing', async t => {
  const f = await fixture(t);
  await f.session.prompt('Inspect.');
  await f.session.observe('One more observation arrived.', { wake: false });
  await f.session.resume();
  const boundaries = () => f.session.snapshot().messages.filter(message => message.contextKey === 'execution-boundary').map(message => JSON.parse(message.context[0].text).boundary);
  assert.deepEqual(boundaries(), ['step_allowance_reached', 'cleared', 'step_allowance_reached']);
  const resumedFirst = f.requests.find((request, index) => index > 2 && request.purpose !== 'summary');
  assert.match(JSON.stringify(resumedFirst.messages.slice(-2)), /cleared/, 'the resumed run\'s first request carries the cleared boundary');
  await f.session.prompt('A new task.');
  assert.deepEqual(boundaries(), ['step_allowance_reached', 'cleared', 'step_allowance_reached', 'step_allowance_reached'], 'a new turn starts after the earlier boundary; it is not cleared, only set aside later');
});
