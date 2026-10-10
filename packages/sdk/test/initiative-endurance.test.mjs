import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { InitiativeCoordinator } from '../src/initiative.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', maxOutputTokens: 2048 };
const observation = n => ({ id: `outside:${n}`, type: 'user_observation', summary: `Verified external project finding ${n}` });
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const output = (input, action = 'wait') => ({ action, content: action === 'wait' ? '' : 'Investigate the new project finding', reason: 'Grounded in external evidence', evidenceIds: [input.events.at(-1).id], nextReviewAfterMs: 60000 });
const completed = decision => [{ type: 'text_delta', delta: JSON.stringify(decision) }, { type: 'usage', usage: { totalTokens: 20 } }, { type: 'done', stopReason: 'stop' }];

test('120 virtual hours preserve wake deadlines, reconcile usage and bound archived hot history across restarts and provider faults', async t => {
  let clock = Date.parse('2026-01-01T00:00:00Z'), calls = 0, faults = 0, works = 0, persisted, maximumBytes = 0, maximumActions = 0, maximumSeen = 0;
  const archivedActions = new Map(), archivedSeen = new Set();
  const options = {
    project: { id: 'endurance-project' }, model, now: () => clock,
    policy: { tokenBudget: null, maxEvents: 8, maxHistory: 32, maxSeenEvents: 64, reviewMinMs: 30000, reviewMaxMs: 900000, reviewJitterRatio: 0.1 },
    saveState: state => { persisted = structuredClone(state); },
    archiveHistory: ({ actions, seenEventIds }) => { for (const action of actions) archivedActions.set(action.id, action); for (const id of seenEventIds) archivedSeen.add(id); },
    provider: async function* (request) {
      calls++; const input = JSON.parse(request.messages[0].content[0].text);
      if (calls % 19 === 0) { faults++; yield { type: 'usage', usage: { totalTokens: 3 } }; throw new Error('Injected provider disconnect'); }
      yield* completed(output(input, input.events.at(-1).type === 'user_observation' ? 'work' : 'wait'));
    },
    handlers: { work: async () => { works++; return { summary: 'Read-only finding verified', usage: { totalTokens: 7 } }; } }
  };
  let coordinator = new InitiativeCoordinator(options);
  for (let step = 0; step < 1440; step++) {
    clock += 300000;
    await coordinator.observe(observation(step));
    try { await coordinator.tick(); } catch (error) { assert.match(error.message, /Injected provider disconnect/); }
    await coordinator.idle();
    try { await coordinator.tick(); } catch (error) { assert.match(error.message, /Injected provider disconnect/); }
    await coordinator.idle();
    const snapshot = coordinator.snapshot();
    maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(snapshot))); maximumActions = Math.max(maximumActions, snapshot.actions.length); maximumSeen = Math.max(maximumSeen, snapshot.seenEventIds.length);
    assert.equal(snapshot.reservedTokens, 0);
    assert.equal(snapshot.usedTokens, (calls - faults) * 20 + faults * 3 + works * 7);
    if (step % 97 === 0) {
      const nextReviewAt = snapshot.nextReviewAt, recordedCalls = calls;
      await coordinator.close(); coordinator = new InitiativeCoordinator({ ...options, state: persisted });
      assert.equal(coordinator.snapshot().nextReviewAt, nextReviewAt);
      await coordinator.tick(); assert.equal(calls, recordedCalls, 'restart does not replay or discard an unexpired durable wake');
    }
  }
  await coordinator.close();
  assert.ok(faults > 100); assert.ok(works > 1000); assert.ok(archivedActions.size > 1000); assert.ok(archivedSeen.size > 1000);
  assert.ok(maximumActions <= 33, `hot actions: ${maximumActions}`); assert.ok(maximumSeen <= 66, `hot seen IDs: ${maximumSeen}`); assert.ok(maximumBytes < 45000, `hot state bytes: ${maximumBytes}`);
  assert.equal(coordinator.snapshot().archivedHistory.actions, archivedActions.size);
  t.diagnostic(JSON.stringify({ virtualHours: 120, observations: 1440, calls, faults, works, archivedActions: archivedActions.size, archivedSeenIds: archivedSeen.size, maximumActions, maximumSeen, maximumBytes, accountedTokens: coordinator.snapshot().usedTokens }));
});

test('new evidence wakes ordinary idle but cannot reset provider failure backoff', async () => {
  let clock = 1000, calls = 0;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, provider: async function* () { calls++; throw new Error('offline'); } });
  await coordinator.observe(observation(1)); await assert.rejects(coordinator.tick(), /offline/); const retry = coordinator.snapshot().failureRetryAt;
  for (let n = 2; n < 20; n++) { clock++; await coordinator.observe(observation(n)); assert.equal((await coordinator.tick()).reason, 'failure_backoff'); }
  assert.equal(calls, 1); assert.equal(coordinator.snapshot().failureRetryAt, retry);
  clock = retry; await assert.rejects(coordinator.tick(), /offline/); assert.equal(calls, 2); assert.equal(coordinator.snapshot().failureCount, 2); await coordinator.close();
});

test('a provider ignoring timeout is quarantined and close completes without waiting for its late output', async () => {
  const released = hold(); let calls = 0, effects = 0;
  const coordinator = new InitiativeCoordinator({ model, policy: { decisionTimeoutMs: 20 }, provider: async function* (request) { calls++; await released.promise; yield* completed(output(JSON.parse(request.messages[0].content[0].text), 'work')); }, handlers: { work: async () => { effects++; } } });
  await coordinator.observe(observation(1)); await assert.rejects(coordinator.tick());
  assert.equal((await coordinator.tick()).reason, 'unsettled_operation'); assert.equal(calls, 1); assert.equal(coordinator.unsettled.size, 1);
  await Promise.race([coordinator.close(), delay(250).then(() => { throw new Error('close stalled'); })]);
  released.resolve(); await delay(5); assert.equal(effects, 0); assert.equal(coordinator.unsettled.size, 0); assert.equal(coordinator.snapshot().reservedTokens, 0);
});

test('a timed-out host effect stays needs_review, is never replayed, and does not block shutdown', async () => {
  const released = hold(); let effects = 0;
  const coordinator = new InitiativeCoordinator({ model, policy: { actionTimeoutMs: 20 }, provider: async function* (request) { yield* completed(output(JSON.parse(request.messages[0].content[0].text), 'work')); }, handlers: { work: async () => { effects++; await released.promise; return { summary: 'Late unconfirmed effect', usage: { totalTokens: 2 } }; } } });
  await coordinator.observe(observation(1)); await coordinator.tick(); await coordinator.idle();
  assert.equal(coordinator.snapshot().actions[0].status, 'needs_review'); assert.equal((await coordinator.tick()).reason, 'unsettled_operation');
  await Promise.race([coordinator.close(), delay(250).then(() => { throw new Error('close stalled'); })]);
  released.resolve(); await delay(5); assert.equal(effects, 1); assert.ok(!coordinator.snapshot().events.some(event => event.summary.includes('Late unconfirmed')));
});

test('archive failure retains complete old receipts and backs off before another paid request', async () => {
  let clock = 0, calls = 0, failed = true;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, policy: { maxSeenEvents: 64 }, archiveHistory: async () => { if (failed) throw new Error('archive disk full'); }, provider: async function* (request) { calls++; yield* completed(output(JSON.parse(request.messages[0].content[0].text))); } });
  for (let n = 0; n < 80; n++) await coordinator.observe(observation(n));
  await assert.rejects(coordinator.tick(), /archive disk full/); assert.equal(coordinator.snapshot().seenEventIds.length, 80); assert.equal(calls, 0);
  assert.equal((await coordinator.tick()).reason, 'failure_backoff'); failed = false; clock = coordinator.snapshot().failureRetryAt;
  await coordinator.tick(); assert.equal(coordinator.snapshot().seenEventIds.length, 64); assert.equal(calls, 1); await coordinator.close();
});

test('an observer error cannot relabel a committed host effect as retryable failure', async () => {
  let effects = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: async function* (request) { yield* completed(output(JSON.parse(request.messages[0].content[0].text), 'work')); }, handlers: { work: async () => { effects++; return { summary: 'Committed', usage: { totalTokens: 2 } }; } }, onEvent: event => { if (event.type === 'initiative_action_completed') throw new Error('Observer failed after effect'); } });
  await coordinator.observe(observation(1)); await coordinator.tick(); await coordinator.idle();
  assert.equal(effects, 1); assert.equal(coordinator.snapshot().actions[0].status, 'completed'); assert.equal(coordinator.snapshot().lastObserverError.type, 'initiative_action_completed'); await coordinator.close();
});

test('unresolved effects cannot grow without bound or finance repeated paid decisions', async () => {
  let calls = 0;
  const state = { schemaVersion: 1, revision: 1, events: [observation(1)], seenEventIds: ['outside:1'], actions: [{ ...output({ events: [observation(1)] }, 'work'), id: 'uncertain', revision: 1, status: 'needs_review', createdAt: 0 }], decisionRevision: -1, nextReviewAt: 0, lastSharedAt: null, usedTokens: 0, reservedTokens: 0 };
  const coordinator = new InitiativeCoordinator({ model, state, policy: { maxPendingActions: 1 }, provider: async function* () { calls++; } });
  assert.equal((await coordinator.tick()).reason, 'action_history_full'); assert.equal(calls, 0); assert.equal(coordinator.snapshot().actions[0].status, 'needs_review'); await coordinator.close();
});

test('a new observation arriving during archive commit keeps its dedup receipt', async () => {
  const entered = hold(), released = hold();
  const coordinator = new InitiativeCoordinator({ model, policy: { maxSeenEvents: 64, maxEvents: 50 }, archiveHistory: async () => { entered.resolve(); await released.promise; }, provider: async function* (request) { yield* completed(output(JSON.parse(request.messages[0].content[0].text))); } });
  for (let n = 0; n < 80; n++) await coordinator.observe(observation(n));
  const tick = coordinator.tick(); await entered.promise; await coordinator.observe(observation('during-archive')); released.resolve(); await tick;
  assert.ok(coordinator.snapshot().seenEventIds.includes('outside:during-archive')); assert.equal((await coordinator.observe(observation('during-archive'))).duplicate, true); await coordinator.close();
});
