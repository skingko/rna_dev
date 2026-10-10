import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator } from '../src/initiative.mjs';

// W1 (token-burn study 2026-10-05): the host tells a background worker what its next decision reads of the final reply.
// This is the code that sentence stands on: a finished work action's summary (the host passes the first 6,000
// characters of the worker's final reply) becomes the `action_completed` observation the next decision is asked about,
// whole up to the SDK's 16,000-character bound, beside the one-line handoff in the action's receipt. If either bound moves,
// the worker's prompt (prototypes/control-center/work-run-text.mjs WORKER_REPLY_NOTE) must say so.
const model = { protocol: 'openai', providerId: 'fixture', modelId: 'fixture', maxOutputTokens: 1024 };
const event = { id: 'outside-1', type: 'user_message', summary: 'Tell the user what chapter two says.' };
const answer = (content, evidenceIds = [event.id]) => ({ action: content ? 'work' : 'wait', reason: 'Use the actual evidence', content, evidenceIds, nextReviewAfterMs: 86400000 });
function provider(fn) { return async function* (request) { const value = fn(JSON.parse(request.messages[0].content[0].text)); yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; }; }

async function nextDecisionInput(result) {
  let clock = 1000, calls = 0; const inputs = [];
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, provider: provider(input => { inputs.push(input); calls++; return answer(calls === 1 ? 'Read chapter two and report it' : ''); }), handlers: { work: async () => result } });
  try {
    await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
    clock = coordinator.snapshot().nextReviewAfterMs ?? clock; await coordinator.observe({ id: 'outside-2', type: 'user_message', summary: 'Anything new?' }); await coordinator.tick();
    assert.equal(calls, 2, 'the finished action woke a second decision');
    return { input: inputs[1], action: coordinator.snapshot().actions.find(row => row.action === 'work') };
  } finally { await coordinator.close(); }
}

test('the next decision reads the first 6,000 characters of a worker\'s summary whole, in the action_completed observation, and its handoff beside it', async () => {
  const summary = `OPENING LINE OF THE REPLY\n${'The harbour was grey at dawn. '.repeat(190)}CLOSING LINE OF THE REPLY`, handoff = '写了第二章的概述，正文在回复里，没有剩余，下一步交付给用户。';
  assert.ok(summary.length > 5000 && summary.length <= 6000, `a reply as the host passes it (${summary.length} characters)`);
  const { input, action } = await nextDecisionInput({ summary, handoff, usage: { totalTokens: 5 } });
  assert.equal(action.resultSummary, summary, 'the action keeps the summary');
  const seen = input.events.find(row => row.type === 'action_completed');
  assert.ok(seen, 'the next decision is asked about the completion');
  assert.equal(seen.summary, `work completed. ${summary}`, 'the whole summary, first line to last');
  assert.ok(seen.summary.includes(summary.slice(0, 6000)));
  assert.equal(input.recentActions.find(row => row.actionId === action.id)?.handoff, handoff, 'and the handoff line is in the receipt');
});

test('the observation holds at most 16,000 characters: a longer summary is cut there (the host\'s 6,000 never reaches it)', async () => {
  const summary = 'x'.repeat(20000);
  const { input, action } = await nextDecisionInput({ summary, usage: { totalTokens: 5 } });
  assert.equal(action.resultSummary.length, 16000, 'the action keeps at most 16,000 characters');
  const seen = input.events.find(row => row.type === 'action_completed');
  assert.equal(seen.summary.length, 16000, 'the observation is cut at the same bound');
  assert.ok(seen.summary.startsWith('work completed. xxxx'));
});
