import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, cacheAlignedReviewDue } from '../src/initiative.mjs';

const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'e1', type: 'project_opened', summary: 'The project needs a periodic check.' };
const wait = { action: 'wait', reason: 'Nothing actionable in the current evidence', evidenceIds: ['e1'], content: '', nextReviewAfterMs: 600000 };
function provider(onCall) { return async function* () { onCall(); yield { type: 'text_delta', delta: JSON.stringify(wait) }; yield { type: 'usage', usage: { input: 10, output: 30, totalTokens: 40 } }; yield { type: 'done', stopReason: 'stop' }; }; }

test('cacheAlignedReviewDue only advances an idle review in its last quarter, past the minimum spacing, before the cache ends', () => {
  const policy = { reviewMinMs: 60000 }, state = { reviewSchedule: { at: 0 }, nextReviewAt: 400000 };
  assert.equal(cacheAlignedReviewDue(state, policy, 320000, 330000), true, 'last quarter, cache still warm, expires before due');
  assert.equal(cacheAlignedReviewDue(state, policy, 200000, 330000), false, 'too early in the planned wait');
  assert.equal(cacheAlignedReviewDue(state, policy, 320000, 410000), false, 'cache outlives the due time: no reason to move');
  assert.equal(cacheAlignedReviewDue(state, policy, 320000, 310000), false, 'cache already expired');
  assert.equal(cacheAlignedReviewDue(state, policy, 320000, undefined), false, 'unknown TTL: no preference');
  assert.equal(cacheAlignedReviewDue({ ...state, nextReviewAt: 60000 }, { reviewMinMs: 60000 }, 50000, 55000), false, 'never before reviewMinMs');
  assert.equal(cacheAlignedReviewDue({ ...state, failureRetryAt: 350000 }, policy, 320000, 330000), false, 'failure backoff wins');
});

test('an idle coordinator review runs early only with a cache window, and never later than due', async () => {
  let clock = 0, calls = 0;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, provider: provider(() => calls++), policy: { reviewMinMs: 60000, reviewMaxMs: 600000, reviewJitterRatio: 0 } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle(); assert.equal(calls, 1);
  const due = coordinator.snapshot().nextReviewAt, at = coordinator.snapshot().reviewSchedule.at;
  clock = due - (due - at) / 8;
  assert.equal((await coordinator.tick()).status, 'idle'); assert.equal(calls, 1, 'no window: waits for due');
  await coordinator.tick({ cacheWindowUntil: clock + 5000 }); await coordinator.idle(); assert.equal(calls, 2, 'inside the cache window: reviewed now');
  await coordinator.close();
});

// Seen live (2026-10-01): one project's decisions switched between two system prompts as a paused task or a pending
// review changed which actions were open, and each switch re-sent the whole decision uncached; the clock, new on every
// wake, sat inside the project and cut the cached prefix before the receipts and events.
test('the decision system prompt does not change with the open actions, and the clock is the last field of the request', async () => {
  const { decideInitiative } = await import('../src/initiative.mjs');
  const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
  const event = { id: 'e1', type: 'project_opened', summary: 'A migration tool; compatibility needs checking.' };
  const seen = [];
  const provider = async function* (options) { seen.push(options); yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', reason: 'Nothing new to act on', evidenceIds: [], content: '', nextReviewAfterMs: 60000 }) }; yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } }; yield { type: 'done', stopReason: 'stop' }; };
  const project = { id: 'p1', title: 'Tool', clock: { now: '2026-10-02T00:00:00.000Z' }, description: 'A migration tool' };
  await decideInitiative({ model, project, events: [event], availableActions: ['work', 'share', 'learn'], promptActions: ['work', 'share', 'learn'], provider });
  await decideInitiative({ model, project: { ...project, clock: { now: '2026-10-02T00:10:00.000Z' } }, events: [event], availableActions: ['share'], promptActions: ['work', 'share', 'learn'], provider });
  assert.equal(seen[0].systemPrompt, seen[1].systemPrompt, 'same system prompt while work and learn are closed');
  const requests = seen.map(options => JSON.parse(options.messages[0].content[0].text));
  assert.deepEqual(requests[1].availableActions, ['wait', 'share'], 'the request says which actions are open');
  assert.equal(Object.keys(requests[0]).at(-1), 'clock'); assert.equal(requests[0].project.clock, undefined);
  const text = seen.map(options => options.messages[0].content[0].text), same = [...text[0]].findIndex((char, index) => char !== text[1][index]);
  assert.ok(same > text[0].indexOf('"recentActions"'), 'the two requests differ only after the receipts and events');
});
