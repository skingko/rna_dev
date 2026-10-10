import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator } from '../src/initiative.mjs';
const model = { protocol: 'openai', providerId: 'fixture', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'e1', type: 'note', summary: 'Actual outside project context' };
function fixture({ action = 'wait', policy = {}, state, fail = false } = {}) {
  let clock = 1000, requests = 0, learns = 0, shares = 0, saved;
  const coordinator = new InitiativeCoordinator({ model, project: { id: 'timing' }, now: () => clock, policy: { reviewMinMs: 30000, reviewMaxMs: 900000, ...policy }, state, saveState: value => { saved = value; }, provider: async function* (request) {
    requests++; if (fail) throw Object.assign(new Error('Isolated provider failure'), { code: 'provider_error' });
    const input = JSON.parse(request.messages[0].content[0].text);
    yield { type: 'text_delta', delta: JSON.stringify({ action, content: action === 'wait' ? '' : 'Use checked project evidence', reason: 'Concrete context supports this choice', evidenceIds: action === 'wait' ? [] : [input.events.at(-1).id], nextReviewAfterMs: 1000 }) };
    yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done' };
  }, handlers: { learn: async () => { learns++; return { usage: { totalTokens: 0 } }; }, share: async () => { shares++; return { usage: { totalTokens: 0 } }; } } });
  return { coordinator, clock: value => { clock = value; }, stats: () => ({ requests, learns, shares }), saved: () => saved };
}
test('review edits recalculate from the original review anchor, preserve past due eligibility, and survive restart', async () => {
  const f = fixture(); await f.coordinator.observe(event); await f.coordinator.tick(); assert.equal(f.saved().nextReviewAt, 31000);
  f.clock(11000); await f.coordinator.updatePolicy({ reviewMinMs: 120000, reviewMaxMs: 600000 }); assert.equal(f.saved().nextReviewAt, 121000);
  await f.coordinator.updatePolicy({ reviewMinMs: 5000, reviewMaxMs: 60000 }); assert.equal(f.saved().nextReviewAt, 6000);
  const state = f.saved(); await f.coordinator.close();
  const resumed = fixture({ state, policy: { reviewMinMs: 10000, reviewMaxMs: 60000 } }); resumed.clock(11000);
  assert.equal(resumed.coordinator.snapshot().nextReviewAt, 11000); await resumed.coordinator.tick(); assert.equal(resumed.stats().requests, 1); await resumed.coordinator.close();
});
test('new evidence remains reactive while interval changes never erase error backoff or invent evidence', async () => {
  const empty = fixture(); await empty.coordinator.updatePolicy({ reviewMinMs: 5000, reviewMaxMs: 5000 }); empty.clock(999999); await empty.coordinator.tick(); assert.equal(empty.stats().requests, 0); await empty.coordinator.close();
  const f = fixture({ fail: true }); await f.coordinator.observe(event); await assert.rejects(f.coordinator.tick()); const backoff = f.saved().failureRetryAt, requests = f.stats().requests;
  f.clock(5000); await f.coordinator.updatePolicy({ reviewMinMs: 1000, reviewMaxMs: 1000 }); assert.equal(f.saved().failureRetryAt, backoff); assert.ok(f.saved().nextReviewAt >= backoff); await f.coordinator.tick(); assert.equal(f.stats().requests, requests); await f.coordinator.close();
  const reactive = fixture({ policy: { reviewMinMs: 86400000, reviewMaxMs: 86400000 } }); await reactive.coordinator.observe(event); await reactive.coordinator.tick(); reactive.clock(2000); await reactive.coordinator.observe({ ...event, id: 'fresh' }); await reactive.coordinator.tick(); assert.equal(reactive.stats().requests, 2); await reactive.coordinator.close();
});
test('invalid min/max edits reject atomically without changing a valid schedule', async () => {
  const f = fixture(); await f.coordinator.observe(event); await f.coordinator.tick(); const state = f.coordinator.snapshot(), policy = { ...f.coordinator.policy };
  await assert.rejects(f.coordinator.updatePolicy({ notificationMuted: true, reviewMinMs: 1000000, reviewMaxMs: 1000 }), { code: 'invalid_policy' });
  assert.deepEqual(f.coordinator.policy, policy); assert.deepEqual(f.coordinator.snapshot(), state); await f.coordinator.close();
});
test('host learning time gates queued work before reservation; changing it takes effect without manufacturing another intent', async () => {
  const f = fixture({ action: 'learn' }); await f.coordinator.observe(event);
  // Seed one already-decided intent to isolate eligibility from model choice.
  f.coordinator.state.actions.push({ id: 'queued', action: 'learn', reason: 'Existing evidence', content: 'Evaluate isolated candidate', evidenceIds: ['e1'], revision: 1, status: 'queued', createdAt: 1000 });
  f.coordinator.state.decisionRevision = 1; f.coordinator.state.nextReviewAt = 999999;
  await f.coordinator.updatePolicy({ learnNotBefore: 100000 }); await f.coordinator.tick(); assert.equal(f.stats().learns, 0); assert.equal(f.saved().reservedTokens, 0); const tokens = f.saved().usedTokens;
  for (let i = 0; i < 1000; i++) await f.coordinator.tick(); assert.equal(f.stats().requests, 0);
  f.clock(6000); await f.coordinator.updatePolicy({ learnNotBefore: 5000 }); await f.coordinator.tick(); await f.coordinator.idle(); assert.equal(f.stats().learns, 1); assert.equal(f.saved().usedTokens, tokens); await f.coordinator.close();
});
test('share cooldown changes use the actual last delivery time and a blocked queue delivers once', async () => {
  const f = fixture({ action: 'share', policy: { cooldownMs: 100000 } }); await f.coordinator.observe(event); await f.coordinator.tick(); await f.coordinator.idle(); assert.equal(f.stats().shares, 1);
  f.clock(2000); await f.coordinator.observe({ ...event, id: 'second' }); await f.coordinator.tick(); assert.equal(f.stats().shares, 1);
  await f.coordinator.updatePolicy({ cooldownMs: 1000 }); await f.coordinator.tick(); await f.coordinator.idle(); assert.equal(f.stats().shares, 2);
  await f.coordinator.tick(); assert.equal(f.stats().shares, 2); await f.coordinator.close();
});
