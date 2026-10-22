import test from 'node:test';
import assert from 'node:assert/strict';
import { lightWakeRequest, parseLightDecision, decideLight, LIGHT_SYSTEM, LIGHT_DIGEST_MAX_CHARS } from '../benchmark/wake-light-request.mjs';

// Light floor wake: the digest a floor wake without new evidence reads instead of the whole request, and the one
// call that answers wait | reread. Every failure of the light path must end in `reread` (the whole request).
const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 4096 };
const NOW = Date.parse('2026-10-22T12:00:00Z');
const events = Array.from({ length: 12 }, (_, index) => ({ id: `e${index}`, type: index % 2 ? 'action_completed' : 'workspace_change', summary: `Event ${index}: ${'long text '.repeat(100)}`, at: NOW - (12 - index) * 3600000 }));
const receipts = Array.from({ length: 7 }, (_, index) => ({ id: `a${index}`, action: 'work', status: 'completed', content: `Task ${index} ${'instruction '.repeat(100)}`, handoff: `Outcome ${index} ${'report '.repeat(100)}`, evidenceIds: ['E1'] }));
const last = { action: 'wait', at: NOW - 7200000, nextReviewAfterMs: 3600000, reason: 'Waiting for the 09:00 run.' };
const input = { view: { title: 'Daily research', agenda: [{ kind: 'todo', text: 'Write the report' }] }, events, recentActions: receipts, lastDecision: last, now: NOW, availableActions: ['work', 'share'], presence: { typing: false }, policy: { notificationMuted: true } };
const stream = (...parts) => async function* () { for (const part of parts) yield part; };
const answer = body => stream({ type: 'text_delta', delta: typeof body === 'string' ? body : JSON.stringify(body) }, { type: 'usage', usage: { input: 1200, output: 300, totalTokens: 1500 } }, { type: 'done', stopReason: 'stop' });

test('the digest keeps the view, the last wait and the newest lines, not the texts', () => {
  const request = lightWakeRequest(input), digest = JSON.parse(request.text);
  assert.equal(request.system, LIGHT_SYSTEM);
  assert.deepEqual(digest.project, input.view);
  assert.equal(digest.lastDecision.reason, 'Waiting for the 09:00 run.'); assert.equal(digest.lastDecision.elapsedMs, 7200000); assert.equal(digest.lastDecision.askedRestMs, 3600000);
  assert.equal(digest.evidence.total, 12); assert.equal(digest.evidence.newest.length, 8); assert.equal(digest.evidence.newest.at(-1).id, 'e11'); assert.equal(digest.evidence.sinceLastDecision, 0);
  assert.ok(digest.evidence.newest.every(line => line.summary.length <= 140), 'event text is cut to a line');
  assert.equal(digest.receipts.total, 7); assert.equal(digest.receipts.newest.length, 5); assert.equal(digest.receipts.newest[0].task.slice(0, 6), 'Task 2');
  assert.ok(digest.receipts.newest.every(row => row.task.length <= 160 && row.outcome.length <= 280), 'receipt bodies are cut to headlines');
  assert.deepEqual(digest.availableActions, ['wait', 'work', 'share']); assert.equal(digest.presence.notificationMuted, true); assert.equal(digest.clock.now, '2026-10-22T12:00:00.000Z');
  assert.ok(request.text.length < LIGHT_DIGEST_MAX_CHARS && request.text.length < 8000, 'a digest is a fraction of the request it replaces');
});
test('a receipt line carries the end time of its completion event', () => {
  const lines = JSON.parse(lightWakeRequest({ ...input, events: [{ id: 'action:a6:completed', type: 'action_completed', summary: 's', at: NOW - 1000 }] }).text).receipts.newest;
  assert.equal(lines.at(-1).endedAt, '2026-10-22T11:59:59.000Z'); assert.equal(lines[0].endedAt, undefined);
});
test('an earlier wait whose reason was not kept says so, without a rest it never asked', () => {
  const digest = JSON.parse(lightWakeRequest({ ...input, lastDecision: { action: 'wait', at: NOW - 60000 } }).text);
  assert.equal(digest.lastDecision.reason, 'not kept'); assert.equal(digest.lastDecision.askedRestMs, undefined);
  assert.equal(JSON.parse(lightWakeRequest({ ...input, lastDecision: null }).text).lastDecision, null);
});
test('no view, no clock or a digest that is not light gives no light request', () => {
  assert.equal(lightWakeRequest({ ...input, view: null }), null); assert.equal(lightWakeRequest({ ...input, now: undefined }), null);
  assert.equal(lightWakeRequest({ ...input, view: { text: 'x'.repeat(LIGHT_DIGEST_MAX_CHARS) } }), null);
});
test('a light answer is parsed strictly', () => {
  assert.deepEqual(parseLightDecision('{"decision":"wait","reason":" Nothing due. ","nextReviewAfterMs":3600000}'), { decision: 'wait', reason: 'Nothing due.', nextReviewAfterMs: 3600000 });
  assert.deepEqual(parseLightDecision('```json\n{"decision":"reread","reason":"Unsure.","nextReviewAfterMs":3600000}\n```'), { decision: 'reread', reason: 'Unsure.', nextReviewAfterMs: 3600000 });
  assert.equal(parseLightDecision('{"decision":"reread","reason":"Unsure."}').nextReviewAfterMs, 3600000, 'a reread needs no rest');
  for (const bad of ['', 'nope', '[]', '{"decision":"work","reason":"x","nextReviewAfterMs":5000}', '{"decision":"wait","reason":"x"}', '{"decision":"wait","reason":"x","nextReviewAfterMs":999}', '{"decision":"wait","reason":"x","nextReviewAfterMs":86400001}', '{"decision":"wait","reason":"  ","nextReviewAfterMs":5000}', '{"decision":"wait","reason":"x","nextReviewAfterMs":1.5}']) assert.equal(parseLightDecision(bad), null, bad);
});
test('wait and reread come back with their usage', async () => {
  const wait = await decideLight({ request: lightWakeRequest(input), model, apiKey: 'test-key', provider: answer({ decision: 'wait', reason: 'The next run is due 09:00.', nextReviewAfterMs: 28800000 }) });
  assert.equal(wait.outcome, 'wait'); assert.equal(wait.nextReviewAfterMs, 28800000); assert.equal(wait.usage.totalTokens, 1500); assert.equal(wait.usage.estimatedTokens, 0);
  const reread = await decideLight({ request: lightWakeRequest(input), model, apiKey: 'test-key', provider: answer({ decision: 'reread', reason: 'A finished result is not in any delivery.', nextReviewAfterMs: 3600000 }) });
  assert.equal(reread.outcome, 'reread'); assert.equal(reread.failure, undefined);
});
test('the request is the small one: its own system prompt, no tools, the digest as the only message', async () => {
  let seen; const provider = async function* (options) { seen = options; yield* answer({ decision: 'wait', reason: 'x', nextReviewAfterMs: 5000 })(); };
  await decideLight({ request: lightWakeRequest(input), model, apiKey: 'test-key', provider, reasoning: 'low' });
  assert.equal(seen.systemPrompt, LIGHT_SYSTEM); assert.deepEqual(seen.tools, []); assert.equal(seen.messages.length, 1); assert.equal(seen.model.reasoning, 'low'); assert.equal(seen.purposeDetail, 'decision-light');
  assert.equal(seen.cache.prefixHash, 'rna-initiative-light-v1');
});
test('every failure of the light path rereads and is charged', async () => {
  const cases = { invalid_answer: answer('not json'), truncated: stream({ type: 'text_delta', delta: '{"decision":"wa' }, { type: 'usage', usage: { input: 1200, output: 4096, totalTokens: 5296 } }, { type: 'done', stopReason: 'length' }),
    rate_limit: stream({ type: 'error', error: { message: 'busy', code: 'rate_limit' } }), unexpected_tool_call: stream({ type: 'tool_call', name: 'x' }), output_limit: stream({ type: 'text_delta', delta: 'x'.repeat(9000) }) };
  for (const [failure, provider] of Object.entries(cases)) {
    const result = await decideLight({ request: lightWakeRequest(input), model, apiKey: 'test-key', provider });
    assert.equal(result.outcome, 'reread', failure); assert.equal(result.failure, failure); assert.ok(result.usage.totalTokens > 0, `${failure} is charged`);
  }
  const unreported = await decideLight({ request: lightWakeRequest(input), model, apiKey: 'test-key', provider: stream({ type: 'text_delta', delta: 'zzz' }, { type: 'done', stopReason: 'stop' }) });
  assert.equal(unreported.usage.estimatedTokens, unreported.usage.totalTokens, 'a request that reported nothing is charged its estimate');
});
test('a cancelled light call rethrows instead of rereading', async () => {
  const controller = new AbortController(), provider = async function* () { controller.abort(); yield { type: 'text_delta', delta: '{}' }; };
  await assert.rejects(decideLight({ request: lightWakeRequest(input), model, apiKey: 'test-key', provider, signal: controller.signal }));
});
