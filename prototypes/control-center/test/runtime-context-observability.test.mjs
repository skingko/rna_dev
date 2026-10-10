import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeController } from '../runtime-controller.mjs';

const projection = { estimatedInputTokens: 3500, capacity: 6000, outputReserve: 500, inputTrigger: 4300, method: 'UTF-8 bytes / 3; not billed tokens', status: 'ready', automaticEnabled: true, compactionId: null };
function fixture() {
  const turn = { id: 'turn', status: 'running' };
  const session = { id: 'session', projectId: 'project', activeTurnId: turn.id, status: 'running', turns: [turn], items: [], usage: { tokens: 5000000 }, context: { tokens: 5500, capacity: 6000, compactions: 0 }, runtime: { sessionFile: '/owned/session.rna.jsonl' } };
  const store = { state: { sessions: [session], projects: [{ id: 'project' }] }, mutate(fn) { return fn(this.state); } };
  const runtime = Object.create(RuntimeController.prototype); runtime.store = store;
  const context = { sessionId: session.id, turnId: turn.id, cancelled: false, submitted: new Map(), usageKeys: new Set() };
  return { runtime, context, session, turn, store };
}

test('runtime updates current pressure before and after compression independently of cumulative charges', () => {
  const { runtime, context, session } = fixture();
  session.context.measurementScope = 'maintenance';
  runtime.event(context, { type: 'context_usage', usage: { ...projection, status: 'compacting', beforeTokens: 5500, requestId: 'summary' } });
  assert.equal(session.context.usage.status, 'compacting'); assert.equal(session.context.tokens, 3500);
  assert.equal(session.context.measurementScope, undefined);
  runtime.event(context, { type: 'auto_compaction_end', result: { id: 'compaction', automatic: true } });
  runtime.event(context, { type: 'auto_compaction_end', result: { id: 'compaction', automatic: true } });
  runtime.event(context, { type: 'context_usage', usage: { ...projection, estimatedInputTokens: 1200, beforeTokens: 5500, afterTokens: 1200, compactionId: 'compaction' } });
  assert.equal(session.context.tokens, 1200); assert.equal(session.context.usage.afterTokens, 1200);
  assert.equal(session.context.usage.status, 'ready'); assert.equal(session.context.usage.requestId, undefined);
  assert.equal(session.context.compactions, 1); assert.equal(session.items.filter(item => item.kind === 'notice').length, 1);
  assert.equal(session.usage.tokens, 5000000);
  const saved = structuredClone(session.context);
  runtime.event(context, { type: 'context_usage', usage: { ...projection, estimatedInputTokens: NaN } });
  assert.deepEqual(session.context, saved, 'invalid telemetry cannot corrupt the retained projection');
});

test('summary usage is recorded once per request and its cache metadata does not change numerical totals', () => {
  const { runtime, context, session, turn } = fixture();
  const event = { type: 'compaction_request_end', requestId: 'summary-one', usageReported: true, usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cacheUsageReported: true } };
  runtime.event(context, event); runtime.event(context, structuredClone(event));
  assert.equal(turn.compactionUsage.length, 1); assert.equal(turn.compactionUsage[0].usage.cacheUsageReported, true);
  assert.equal(turn.compactionUsage[0].usageReported, true); assert.equal(turn.usage.totalTokens, 15);
  assert.equal(session.usage.tokens, 5000015);
  runtime.event(context, { ...event, requestId: 'summary-two', code: 'invalid_summary', usage: { ...event.usage, cacheUsageReported: false } });
  assert.equal(turn.compactionUsage.length, 2); assert.equal(turn.compactionUsage[1].code, 'invalid_summary');
  assert.equal(turn.compactionUsage[1].usage.cacheUsageReported, false);
  assert.equal(turn.usage.totalTokens, 30); assert.equal(session.usage.tokens, 5000030);
  assert.ok(Object.values(turn.usage).filter(value => typeof value === 'number').every(Number.isFinite));
});

test('conversation item distinguishes reported zero cache usage from unknown and final projection supersedes receipt size', () => {
  const { runtime, context, session, turn } = fixture();
  for (const reported of [true, false]) {
    const message = { id: String(reported), role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', usageReported: true, usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, ...(reported ? { cacheUsageReported: true } : {}) } };
    runtime.event(context, { type: 'message_start', message }); runtime.event(context, { type: 'message_end', message });
  }
  assert.deepEqual(session.items.map(item => item.usage.cacheUsageReported), [true, false]);
  assert.ok(session.items.every(item => item.usageReported === true));
  assert.ok(session.items.every(item => item.stopReason === 'stop'));
  assert.equal(turn.usage.totalTokens, 30); assert.equal(session.usage.tokens, 5000030);
  runtime.event(context, { type: 'context_usage', usage: projection });
  assert.equal(session.context.tokens, projection.estimatedInputTokens);
});

test('assistant terminal identity preserves failed/truncated evidence boundaries without inventing old stop reasons', () => {
  const { runtime, context, session } = fixture();
  for (const reason of ['stop', 'toolUse', 'length', 'error', 'aborted', undefined, 'made_up']) {
    const message = { id: String(reason), role: 'assistant', content: [{ type: 'text', text: 'fixture evidence' }], ...(reason !== undefined ? { stopReason: reason } : {}) };
    runtime.event(context, { type: 'message_start', message }); runtime.event(context, { type: 'message_end', message });
  }
  assert.deepEqual(session.items.map(item => item.stopReason), ['stop', 'toolUse', 'length', 'error', 'aborted', undefined, undefined]);
});

test('cancelled or archived writers settle compression display from their disposed snapshot without reviving or overwriting successors', () => {
  for (const status of ['paused', 'archived']) {
    const { runtime, context, session } = fixture();
    runtime.event(context, { type: 'context_usage', usage: { ...projection, status: 'compacting', requestId: 'summary' } });
    context.cancelled = true; session.status = status === 'archived' ? 'paused' : status;
    if (status === 'archived') session.archivedAt = new Date().toISOString();
    const settled = { sessionFile: session.runtime.sessionFile, contextUsage: { ...projection, estimatedInputTokens: 3400 } };
    context.handle = { snapshot: () => structuredClone(settled) };
    runtime.event(context, { type: 'context_usage', usage: settled.contextUsage });
    assert.equal(session.context.usage.status, 'compacting', 'ordinary cancelled events are suppressed');
    runtime.settleContextUsage(context, settled);
    assert.equal(session.context.usage.status, 'ready'); assert.equal(session.context.usage.requestId, undefined);
    assert.equal(session.context.tokens, 3400); assert.equal(session.status, 'paused');
    session.context.tokens = 900; session.context.usage.estimatedInputTokens = 900; session.activeTurnId = 'successor-turn';
    runtime.settleContextUsage(context, settled); assert.equal(session.context.tokens, 900);
    session.activeTurnId = null; session.runtime.sessionFile = '/new/session.rna.jsonl';
    runtime.settleContextUsage(context, settled); assert.equal(session.context.tokens, 900);
  }
});
