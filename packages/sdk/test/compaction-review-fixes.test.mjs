import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { buildRequest, streamCompletion } from '../src/providers.mjs';
import { summaryRequestFor } from '../src/context.mjs';
import { growthPerRun } from '../src/cache-economics.mjs';
import { defaultReasoningUsable, lighterReasoning, summaryReasoning } from '../src/compaction-request.mjs';
import * as effort from '../src/reasoning-effort.mjs';
import { createFakeAnthropic } from './fixtures/fake-anthropic.mjs';

// P1 review of the cold-break economy and idle compaction (compaction D2/D3/D5, claude CLAUDE-5, integration INT-6
// and INT-10, economy ECON-3). Fake providers only; keys are synthetic.
const KEY = 'sk-ant-fixture-not-a-real-key';
const SUMMARY = /^Summarize the provided conversation record/;
const records = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const efforts = ids => ids.map(id => ({ id }));
const opusCapability = { control: 'adaptive', efforts: efforts(['low', 'medium', 'high', 'xhigh', 'max']), canDisable: false, providerDefault: 'medium' };
const sonnetCapability = { ...opusCapability, providerDefault: 'high' };
const glmCapability = { control: 'effort', efforts: efforts(['low', 'high', 'max']), canDisable: false, providerDefault: null };
const deepseekCapability = { control: 'effort', efforts: efforts(['high', 'max']), canDisable: true, providerDefault: 'high' };
const haikuCapability = { control: 'budget', efforts: efforts(['low', 'medium', 'high']), canDisable: true, providerDefault: null };

test('summary effort: the provider default where it is usable and no deeper than the chat, else the chat\'s own; one step lighter on a retry', () => {
  // User decision 2: internal calls stop inheriting the chat's max.
  assert.equal(summaryReasoning({ reasoning: 'max', reasoningSelection: 'max', reasoningCapability: opusCapability }), 'default', 'Opus: adaptive default (medium) under a max chat');
  assert.equal(summaryReasoning({ reasoning: 'low', reasoningSelection: 'low', reasoningCapability: opusCapability }), 'low', 'never deeper than the chat\'s choice');
  assert.equal(summaryReasoning({ reasoning: 'medium', reasoningSelection: 'medium', reasoningCapability: sonnetCapability }), 'medium', 'Sonnet\'s default (high) is above a medium chat');
  assert.equal(summaryReasoning({ reasoning: 'default', reasoningSelection: 'auto', reasoningCapability: sonnetCapability }), 'default');
  assert.equal(summaryReasoning({ reasoning: 'max', reasoningSelection: 'max', reasoningCapability: deepseekCapability }), 'default', 'DeepSeek: default high is not its top');
  assert.equal(summaryReasoning({ reasoning: 'max', reasoningSelection: 'max', reasoningCapability: glmCapability }), 'max', 'GLM: the default is its deepest level, so today\'s effort stays');
  assert.equal(summaryReasoning({ reasoning: 'high', reasoningSelection: 'high', reasoningCapability: haikuCapability }), 'high', 'budget: omitting thinking turns it off');
  assert.equal(summaryReasoning({ reasoning: 'off', reasoningSelection: 'off', reasoningCapability: deepseekCapability }), 'off');
  assert.equal(summaryReasoning({ reasoning: 'max' }), 'max', 'no declared capability: nothing is known about the default');
  assert.equal(defaultReasoningUsable(glmCapability), false); assert.equal(defaultReasoningUsable({ control: 'toggle' }), true); assert.equal(defaultReasoningUsable(null), false);
  // One step lighter for the single length retry.
  assert.equal(lighterReasoning({ reasoningCapability: glmCapability }, 'max'), 'high');
  assert.equal(lighterReasoning({ reasoningCapability: glmCapability }, 'default'), 'high', 'GLM default is max');
  assert.equal(lighterReasoning({ reasoningCapability: glmCapability }, 'low'), null);
  assert.equal(lighterReasoning({ reasoningCapability: opusCapability }, 'default'), 'low', 'Opus default is medium');
  assert.equal(lighterReasoning({ reasoningCapability: deepseekCapability }, 'default'), null, 'DeepSeek\'s default is already its lightest');
  assert.equal(lighterReasoning({ reasoningCapability: opusCapability }, 'off'), null); assert.equal(lighterReasoning({}, 'max'), null);
});

test('one rule for summary effort: summaryReasoning is the internal plan (auto) and lighterReasoning its step down', () => {
  // The host's routes (internal-reasoning.mjs) and the SDK's own summary default read the same plan; no second helper.
  assert.equal(defaultReasoningUsable, effort.defaultReasoningUsable);
  assert.equal(defaultReasoningUsable({ control: 'effort', efforts: efforts(['low']), providerDefault: null, defaultAdaptive: true }), true, 'Claude-style adaptive default');
  const capabilities = [opusCapability, sonnetCapability, glmCapability, deepseekCapability, haikuCapability, { control: 'toggle', efforts: efforts(['high']), canDisable: true }, undefined];
  for (const reasoningCapability of capabilities) for (const selection of ['auto', 'off', 'default', 'low', 'medium', 'high', 'max']) {
    const model = { reasoning: selection === 'auto' ? 'default' : selection, reasoningSelection: selection, ...(reasoningCapability ? { reasoningCapability } : {}) };
    const plan = effort.internalReasoningPlan(model);
    assert.equal(summaryReasoning(model), plan.mode === 'fixed' ? plan.effort : plan.fallback, `${reasoningCapability?.control}/${selection}`);
    assert.equal(lighterReasoning(model, model.reasoning), effort.stepDownReasoning(model) ?? null, `${reasoningCapability?.control}/${selection} step`);
  }
});

test('a flattened summary request carries no cache_control on Anthropic (a one-off record nothing reads); other protocols keep their cache key', () => {
  const archived = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'Earlier chapter.' }] }];
  const claude = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', compat: { adaptiveThinking: true } };
  const request = summaryRequestFor({ archived, sessionId: 's', projectId: 'p', model: claude });
  assert.equal(request.context.cache.retention, 'none');
  const body = buildRequest({ model: claude, systemPrompt: request.systemPrompt, messages: request.messages, cache: request.context.cache, maxOutputTokens: 4000 }).body;
  assert.doesNotMatch(JSON.stringify(body), /cache_control/);
  const glm = { providerId: 'zhipu', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', contextWindow: 1000000, maxOutputTokens: 32000, reasoning: 'max' };
  assert.equal(summaryRequestFor({ archived, sessionId: 's', projectId: 'p', model: glm }).context.cache.retention, 'short');
});

test('a Claude conversation at max effort sends its summary at the adaptive default, without cache_control; its turns keep max', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-summary-effort-')); t.after(() => rm(root, { recursive: true, force: true }));
  const fake = createFakeAnthropic({ respond: body => SUMMARY.test(body.system?.[0]?.text ?? '') ? [{ text: 'Summary of the earlier chapters.' }] : [{ thinking: 'plan' }, { text: `Chapter ${'正文'.repeat(400)}` }] });
  const provider = Object.assign(input => streamCompletion({ ...input, fetch: fake.fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
  const opus = { providerId: 'anthropic', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'max', reasoningSelection: 'max', reasoningCapability: opusCapability, compat: { adaptiveThinking: true, thinkingDisplay: 'summarized' } };
  const session = await createSession({ sessionId: 'summary-effort', projectId: 'p', cwd: root, stateDir: join(root, 'state'), model: opus, apiKey: KEY, provider, autoCompaction: false });
  t.after(() => session.dispose());
  for (const index of [1, 2, 3]) await session.prompt(`Write chapter ${index}.`);
  const result = await session.compact({ generate: true, keepLastTurns: 1 });
  assert.equal(result.compacted, true);
  const summary = fake.requests.find(row => SUMMARY.test(row.body.system?.[0]?.text ?? '')).body, turn = fake.requests[0].body;
  assert.deepEqual(turn.output_config, { effort: 'max' }, 'the conversation itself keeps the chat\'s effort');
  assert.equal(summary.output_config, undefined, 'the summary uses the adaptive default (no effort field)');
  assert.equal(summary.thinking?.type, 'adaptive');
  assert.doesNotMatch(JSON.stringify({ system: summary.system, messages: summary.messages }), /cache_control/, 'no 1.25× write for a record nothing reads');
  assert.deepEqual(fake.errors, []);
});

const fixtureModel = { providerId: 'review-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 200000, maxOutputTokens: 2000, reasoning: 'off' };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
async function chapters(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-review-prepared-')), requests = [], handles = [];
  const provider = async function* (request) { requests.push(request); yield { type: 'text_delta', delta: SUMMARY.test(request.systemPrompt) ? 'Focused summary.' : `Chapter ${'正文'.repeat(2000)}` }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; };
  const args = { sessionId: 'review-prepared', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model: fixtureModel, provider, ...extra };
  const open = async more => { const handle = await createSession({ ...args, ...more }); handles.push(handle); return handle; };
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { open, requests };
}

test('discardPreparedCompaction sets a prepared summary aside (superseded) so a focused manual compaction summarizes the history itself', async t => {
  const f = await chapters(t), session = await f.open();
  for (const index of [1, 2, 3, 4]) await session.prompt(`Write chapter ${index}.`);
  const plan = session.prepareCompaction({ keepUserTurns: 2 });
  const prepared = { id: 'idle-r1', sessionId: plan.sessionId, trigger: 'idle', previousCompactionId: plan.previousCompactionId, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary: 'Idle summary made without the focus.', archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId: 'r1', usage, usageReported: true, model: plan.model, startedAt: 1, completedAt: 2, beforeTokens: plan.beforeTokens };
  assert.equal(session.offerCompaction(prepared), true);
  assert.deepEqual(session.discardPreparedCompaction(), { discarded: true, code: 'superseded', id: 'idle-r1' });
  assert.deepEqual(session.discardPreparedCompaction(), { discarded: false, code: 'none' });
  const result = await session.compact({ generate: true, instructions: 'Keep every character setting.' });
  assert.equal(result.compacted, true);
  const summary = f.requests.filter(request => SUMMARY.test(request.systemPrompt)).at(-1).messages[0].content[0].text;
  assert.match(summary, /Write chapter 1\./, 'the raw history is summarized'); assert.match(summary, /Keep every character setting\./);
  assert.doesNotMatch(summary, /Idle summary made without the focus/);
  const file = session.snapshot().sessionFile, journal = await records(file);
  assert.deepEqual(journal.filter(row => row.type === 'compaction_prepared_discarded').map(row => [row.data.id, row.data.code]), [['idle-r1', 'superseded']]);
  await session.dispose();
  const reopened = await f.open({ sessionFile: file });
  assert.equal(reopened.snapshot().preparedCompaction, undefined, 'replay keeps it set aside');
  assert.deepEqual(reopened.commitPreparedCompaction(), { committed: false, code: 'none' });
});

test('at the deferred trigger, economies that only dip under it do not replace the summary: both go in the same break', async t => {
  // ECON-3: the context crosses 80% by less than what settling frees, and one more run adds more than the room that
  // leaves. Before, the settle broke the warm cache, the summary was skipped, and the next turn crossed again; the
  // economies now ride with the summary. (The margin they must leave is what a run of this conversation adds, measured
  // on its own turns since the review of C5; it used to be the warm rule's price share, calibrated here by a fixed
  // background size. The window is now set from a dry run that never compacts, so the crossing is by construction.)
  const build = async window => {
    const dir = await mkdtemp(join(tmpdir(), 'rna-econ-trigger-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const requests = [], events = [];
    let calls = 0;
    const provider = async function* (request) {
      requests.push(request);
      if (SUMMARY.test(request.systemPrompt)) yield { type: 'text_delta', delta: 'summary' };
      else if (request.messages.at(-1).role === 'user') { calls++; yield { type: 'tool_call', id: `w-${calls}`, name: 'write', arguments: { path: `c${calls}.md`, content: calls === 2 ? 'x'.repeat(4500) : 'y'.repeat(100) } }; }
      else yield { type: 'text_delta', delta: 'written' };
      yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' };
    };
    const tools = [{ name: 'write', effect: 'write', description: 'Write.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, execute: async () => 'ok' }];
    const session = await createSession({ sessionId: 'econ-trigger', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model: { ...fixtureModel, contextWindow: window, maxOutputTokens: 500 }, tools, provider,
      settleArguments: (name, args) => name === 'write' && args.content.length > 500 ? { ...args, content: '[set aside]' } : null, onEvent: event => { if (['context_economy', 'auto_compaction_end'].includes(event.type)) events.push(event); } });
    t.after(() => session.dispose());
    await session.prompt(`Background ${'b'.repeat(10000)}`);
    for (const index of [1, 2, 3]) await session.prompt(`Write chapter ${index}. ${'note '.repeat(1000)}`);
    return { session, requests, events };
  };
  // The fourth chapter's run ends 60 tokens over the trigger (the window less its 500 reserve), settling chapter 2 frees far more.
  const dry = await build(1000000); await dry.session.prompt(`Write chapter 4. ${'note '.repeat(1000)}`);
  const window = Math.ceil((dry.session.snapshot().contextUsage.estimatedInputTokens + 500 - 60) / 0.8) + 1;
  const { session, requests, events } = await build(window);
  assert.equal(requests.filter(request => SUMMARY.test(request.systemPrompt)).length, 0, 'under the trigger');
  const before = session.snapshot().contextUsage.estimatedInputTokens;
  await session.prompt(`Write chapter 4. ${'note '.repeat(1000)}`);
  const settled = events.find(event => event.type === 'context_economy' && event.settled > 0);
  assert.ok(settled && settled.freedTokens > 0, 'settling ran at the trigger');
  const room = Math.floor(window * 0.8) - 500 - (dry.session.snapshot().contextUsage.estimatedInputTokens - settled.freedTokens);
  assert.ok(room > 0, `fixture: the economies alone bring the context under the trigger, by ${room} tokens`);
  assert.ok(growthPerRun(session.snapshot().messages) > room, `fixture: one more run adds more than that room (${growthPerRun(session.snapshot().messages)} tokens against ${room})`);
  assert.equal(requests.filter(request => SUMMARY.test(request.systemPrompt)).length, 1, 'the summary still runs');
  assert.equal(events.at(-1).type, 'auto_compaction_end');
  const journal = await records(session.snapshot().sessionFile), settle = journal.findIndex(row => row.type === 'context_settle'), compaction = journal.findIndex(row => row.type === 'context_compaction');
  assert.ok(before > 0 && settle > 0 && compaction > settle, 'one break: settle, then the summary');
  assert.equal(journal.slice(settle, compaction).some(row => row.type === 'request_started'), false, 'no conversation request between them');
});

test('a set-aside step-limit response is journaled with no content of its own, so an older replay projects nothing from it', async t => {
  // INT-10: the replay of host ≤ 0.65.0 adds every request_completed as a message. The record now carries an empty
  // message (what the model wrote is kept beside it); the current replay still bills it once and never projects it.
  const dir = await mkdtemp(join(tmpdir(), 'rna-set-aside-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let executed = 0, summaries = 0;
  const provider = async function* (request) {
    if (request.purpose === 'summary') { summaries++; if (summaries === 1) { yield { type: 'text_delta', delta: 'Partial words before the tool call.' }; yield { type: 'tool_call', id: 'sneaky', name: 'lookup', arguments: { query: 'more' } }; } else yield { type: 'text_delta', delta: 'Concluded without more tools.' }; }
    else yield { type: 'tool_call', id: `call-${executed + 1}`, name: 'lookup', arguments: { query: 'x' } };
    yield { type: 'usage', usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const lookup = { name: 'lookup', effect: 'read', parameters: { type: 'object', properties: { query: { type: 'string' } } }, execute: async () => `observed ${++executed}` };
  const args = { sessionId: 'set-aside', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model: fixtureModel, maxSteps: 2, stepLimitBehavior: 'summarize', tools: [lookup], provider, systemPrompt: 'Fixture agent.' };
  const session = await createSession(args);
  await session.prompt('Inspect.');
  const file = session.snapshot().sessionFile;
  await session.dispose();
  const rows = await records(file), aside = rows.find(row => row.type === 'request_completed' && row.data.discarded === true).data;
  assert.deepEqual(aside.message.content, []); assert.equal(aside.message.stopReason, 'error'); assert.equal(aside.message.usage.totalTokens, 6, 'its usage stays on the message (older replays bill it there)');
  assert.deepEqual(aside.discardedContent, [{ type: 'text', text: 'Partial words before the tool call.' }], 'what the model wrote is kept for audit');
  // The 0.65.0 replay rule (add(data.message) for every request_completed), then both serializers: nothing is sent for it.
  const legacy = []; const ids = new Set();
  for (const { type, data } of rows) if ((type === 'message' || type === 'request_completed' || type === 'tool_completed' || type === 'inbox_claimed') && data.message && !ids.has(data.message.id)) { ids.add(data.message.id); legacy.push(data.message); }
  const index = legacy.findIndex(message => message.id === aside.message.id);
  assert.ok(index > 0);
  for (const protocol of ['openai', 'anthropic']) {
    const model = { ...fixtureModel, protocol, ...(protocol === 'anthropic' ? { reasoning: 'off' } : {}) };
    const withIt = buildRequest({ model, systemPrompt: 'x', messages: legacy.slice(0, index + 1), maxOutputTokens: 100 }).body.messages;
    const without = buildRequest({ model, systemPrompt: 'x', messages: legacy.slice(0, index), maxOutputTokens: 100 }).body.messages;
    assert.deepEqual(withIt, without, `${protocol}: the set-aside record adds nothing to an older projection`);
  }
  // The current replay: billed once, never projected.
  const reopened = await createSession({ ...args, sessionFile: file });
  t.after(() => reopened.dispose());
  assert.equal(reopened.snapshot().usage.totalTokens, 4 * 6);
  assert.equal(reopened.snapshot().messages.some(message => message.id === aside.message.id), false);
  assert.equal(reopened.snapshot().messages.at(-1).content[0].text, 'Concluded without more tools.');
});
