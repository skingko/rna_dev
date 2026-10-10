import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { InitiativeCoordinator } from '../src/initiative.mjs';

const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('Isolated uncertainty fixture timed out'); await delay(5); } };
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', maxOutputTokens: 1024 };

for (const failSave of [false, true]) test(`late tool uncertainty upgrades an interrupted action before quarantine ends; persistence failure=${failSave}`, async t => {
  const entered = hold(), release = hold(), saving = hold(), allowSave = hold(); let requests = 0, saved;
  const c = new InitiativeCoordinator({ model, saveState: async state => {
    if (state.actions.some(a => a.blocksExecution)) { saving.resolve(); await allowSave.promise; if (failSave) throw new Error('Controlled late-receipt persistence failure'); }
    saved = state;
  }, provider: async function* (request) {
    requests++; const input = JSON.parse(request.messages[0].content[0].text);
    yield { type: 'text_delta', delta: JSON.stringify({ action: 'work', content: 'Controlled operation', reason: 'Inspect real evidence', evidenceIds: [input.events[0].id], nextReviewAfterMs: 60000 }) };
    yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done' };
  }, handlers: { work: async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('Controlled external cleanup unknown'), { code: 'uncertain_tool' }); } } });
  t.after(async () => { release.resolve(); allowSave.resolve(); await c.close().catch(() => {}); });
  await c.observe({ id: 'external', type: 'user_message', summary: 'Inspect the project' }); await c.tick(); await entered.promise;
  c.interrupt('new user input'); await c.idle(); const before = c.snapshot(), id = before.actions[0].id;
  assert.equal(before.actions[0].status, 'needs_review'); assert.equal(c.unsettled.size, 1);
  await assert.rejects(c.resolveAction(id, { status: 'cancelled', summary: 'Too early to confirm' }), { code: 'action_still_running' });
  release.resolve(); await saving.promise;
  assert.equal(c.snapshot().actions[0].blocksExecution, true); assert.equal(c.unsettled.size, 1);
  assert.equal((await c.tick()).reason, 'unsettled_operation'); allowSave.resolve(); await until(() => c.unsettled.size === 0);
  const after = c.snapshot(); assert.equal(after.actions[0].errorCode, 'uncertain_tool'); assert.equal(c._executionBlocked(), true);
  assert.deepEqual(after.events, before.events); assert.equal(after.revision, before.revision); assert.equal(after.usedTokens, before.usedTokens); assert.equal(after.pendingFailureReview, undefined); assert.equal(requests, 1);
  if (failSave) assert.equal(after.lastObserverError.type, 'initiative_receipt_persistence_failed');
  else { assert.equal(saved.actions[0].blocksExecution, true); const restarted = new InitiativeCoordinator({ model, state: saved }); assert.equal(restarted._executionBlocked(), true); await restarted.close(); }
});

test('verified cancellation preserves original failure and partial result without claiming success or replaying', async () => {
  const state = { schemaVersion: 1, revision: 1, events: [], seenEventIds: [], actions: [{ id: 'action', action: 'work', status: 'needs_review', blocksExecution: true, evidenceIds: [], content: 'Inspect', resultSummary: 'Only a partial result was recorded.', failure: { code: 'uncertain_tool', message: 'Original diagnostic' }, errorCode: 'uncertain_tool' }], reservedTokens: 0, usedTokens: 0 };
  const c = new InitiativeCoordinator({ model, state, provider: async function* () { assert.fail('Cancellation cannot request a model'); } });
  await assert.rejects(c.resolveAction('action', { status: 'cancelled', summary: ' ' }), { code: 'invalid_resolution' });
  const a = await c.resolveAction('action', { status: 'cancelled', summary: 'Verified original process has exited; partial output remains unvalidated.', source: 'user' });
  assert.equal(a.status, 'cancelled'); assert.equal(a.resolutionOutcome, 'cancelled'); assert.equal(a.resolutionSource, 'user'); assert.equal(a.resultSummary, state.actions[0].resultSummary); assert.deepEqual(a.failure, state.actions[0].failure); assert.equal(c._executionBlocked(), false);
  assert.equal((await c.tick()).reason, 'no_evidence'); await c.close();
});
