import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, decideInitiative, validateInitiativeDecision } from '../src/initiative.mjs';
import { buildRequest, ProviderError } from '../src/providers.mjs';
const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'e1', type: 'project_opened', summary: 'The project title is a migration tool; introduction says compatibility needs checking.' };
const decision = (action = 'work', content = 'Check the existing compatibility notes', evidenceIds = ['e1']) => ({ action, reason: 'The project introduction identifies an unresolved compatibility issue', evidenceIds, content, nextReviewAfterMs: 60000 });
function provider(values, inspect = () => {}) { let count = 0; return async function* (options) { inspect(options, count); const item = values[Math.min(count++, values.length - 1)]; yield { type: 'text_delta', delta: JSON.stringify(item) }; yield { type: 'usage', usage: { input: 10, output: 30, totalTokens: 40 } }; yield { type: 'done', stopReason: 'stop' }; }; }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('initiative native JSON is capability-gated and audited, with business validation and no retry downgrade after provider rejection', async () => {
  const official = { ...model, contextWindow: 128000, modelId: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' };
  for (const [selected, native] of [[official, true], [{ ...official, baseUrl: 'https://fixture.invalid/v1' }, false], [{ ...official, baseUrl: 'https://fixture.invalid/v1', compat: { supportsJsonObject: true, supportsToolChoiceNone: true } }, true], [{ ...official, compat: { supportsJsonObject: false, supportsToolChoiceNone: false } }, false]]) {
    let calls = 0; const events = [];
    const result = await decideInitiative({ model: selected, events: [event], availableActions: ['work'], onEvent: value => events.push(value), provider: provider([decision()], request => {
      calls++; const wire = buildRequest(request).body; assert.deepEqual(wire.response_format, native ? { type: 'json_object' } : undefined); assert.equal(wire.tool_choice, native ? 'none' : undefined); assert.deepEqual(request.tools, []);
    }) });
    assert.equal(calls, 1); assert.equal(result.usage.totalTokens, 40); assert.equal(result.responseContract.mode, native ? 'native' : 'prompt_only'); assert.deepEqual(events[0].responseContract, result.responseContract);
  }
  await assert.rejects(decideInitiative({ model: official, events: [event], availableActions: ['work'], provider: provider([decision('work', 'unverified', ['fabricated'])]) }), error => error.code === 'invalid_decision' && error.usage.totalTokens === 40 && error.initiativeFailure.request.responseContract.mode === 'native');
  let calls = 0;
  await assert.rejects(decideInitiative({ model: official, events: [event], maxAttempts: 2, provider: async function* () { calls++; yield { type: 'usage', usage: { totalTokens: 4 } }; yield { type: 'error', error: { code: 'http_400', status: 400 } }; } }), error => error.code === 'http_400' && error.usage.totalTokens === 4 && error.initiativeFailure.request.responseContract.mode === 'native');
  assert.equal(calls, 1, 'HTTP rejection cannot trigger a prompt-only resend');
  const events = [], coordinator = new InitiativeCoordinator({ model: official, provider: provider([decision('wait', '')]), onEvent: value => events.push(value) });
  try { await coordinator.observe(event); await coordinator.tick(); assert.equal(coordinator.snapshot().lastDecision.responseContract.mode, 'native'); assert.equal(events.find(row => row.type === 'initiative_decision').responseContract.mode, 'native'); }
  finally { await coordinator.close(); }
});
test('superseded learning retains only a known redacted gate reason without fabricating an outcome or re-running the handler', async () => {
  for (const [reason, redactValues, expected] of [
    ['learning_requires_new_evidence', [], 'learning_requires_new_evidence'],
    ['host_context_changed', [], 'host_context_changed'],
    ['unknown_host_reason', [], 'host_context_changed'],
    ['a'.repeat(81), [], 'host_context_changed'],
    [{ token: 'private' }, [], 'host_context_changed'],
    ['learning_requires_new_evidence', ['requires_new'], 'host_context_changed']
  ]) {
    let calls = 0, saved;
    const coordinator = new InitiativeCoordinator({ model, redactValues, provider: provider([decision('learn')]), saveState: state => { saved = state; }, handlers: { learn: async () => { calls++; return { superseded: true, reason, usage: { totalTokens: 0 } }; } } });
    await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
    assert.equal(saved.actions[0].status, 'cancelled'); assert.equal(saved.actions[0].cancellationReason, expected);
    assert.deepEqual(saved.events.map(row => row.id), [event.id]); assert.equal(saved.actions[0].resultSummary, undefined);
    await coordinator.tick(); assert.equal(calls, 1); await coordinator.close();
  }
});
test('the direct decision API uses configured output capacity unless an explicit decision limit is supplied', async () => {
  for (const [policy, expected] of [[{}, 8192], [{ decisionMaxTokens: 1000 }, 1000], [{ decisionMaxTokens: 32000 }, 8192]]) {
    await decideInitiative({ model: { ...model, maxOutputTokens: 8192 }, policy, events: [event], availableActions: ['work'], provider: provider([decision()], request => assert.equal(request.model.maxOutputTokens, expected)) });
  }
});
test('subsequent decisions see redacted failed receipts as failures, without creating evidence or blindly retrying them', async () => {
  let clock = 1000, calls = 0, work = 0;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, redactValues: ['tool-secret'], provider: provider([decision(), decision('wait', '')], request => {
    if (++calls === 2) {
      const input = JSON.parse(request.messages[0].content[0].text); assert.equal(input.recentActions.length, 1); assert.equal(input.recentActions[0].status, 'failed'); assert.equal(input.recentActions[0].failure.code, 'step_limit'); assert.ok(!JSON.stringify(input.recentActions).includes('tool-secret')); assert.equal(input.events.length, 1); assert.match(request.systemPrompt, /do not blindly repeat/);
    }
  }), handlers: { work: async () => { work++; throw Object.assign(new Error('tool-secret; incomplete read chain'), { code: 'step_limit', usage: { totalTokens: 20 } }); } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle(); clock = coordinator.snapshot().nextReviewAt; await coordinator.tick();
  assert.equal(calls, 2); assert.equal(work, 1); assert.equal(coordinator.snapshot().events.length, 1); await coordinator.close();
});

test('unknown external execution persists a work/learn hold while proactive sharing remains available until explicit resolution', async () => {
  let clock = 1000, works = 0, shares = 0, saved;
  const handlers = { work: async () => { works++; if (works === 1) throw Object.assign(new Error('External command may still be running; inspect before resuming'), { code: 'uncertain_tool', usage: { totalTokens: 25 } }); return { summary: 'Verified after explicit resolution', usage: { totalTokens: 10 } }; }, learn: async () => assert.fail('Learning cannot run beside unknown execution'), share: async () => { shares++; return { usage: { totalTokens: 0 } }; } };
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, handlers, saveState: state => { saved = state; }, provider: provider([decision(), decision('share', 'A command outcome must be inspected.')], (request, index) => {
    if (index === 1) { const input = JSON.parse(request.messages[0].content[0].text); assert.deepEqual(input.availableActions.sort(), ['share', 'wait']); assert.equal(input.recentActions[0].status, 'needs_review'); assert.equal(input.recentActions[0].failure.code, 'uncertain_tool'); assert.equal(input.recentActions[0].blocksExecution, true); assert.match(input.recentActions[0].recovery, /Do not repeat/); }
  }) });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
  assert.equal(saved.actions[0].status, 'needs_review'); assert.equal(saved.actions[0].blocksExecution, true); assert.equal(saved.usedTokens, 65);
  clock = saved.nextReviewAt; await coordinator.tick(); await coordinator.idle(); assert.equal(shares, 1); assert.equal(works, 1); await coordinator.close();
  let resumedRequests = 0;
  const restarted = new InitiativeCoordinator({ state: saved, model, now: () => clock, handlers, provider: provider([decision('work', 'Inspect the newly verified evidence', ['new-evidence'])], request => { resumedRequests++; assert.deepEqual(JSON.parse(request.messages[0].content[0].text).availableActions.sort(), ['learn', 'share', 'wait', 'work']); }) });
  clock = restarted.snapshot().nextReviewAt; assert.equal((await restarted.tick()).reason, 'awaiting_external_review'); assert.equal(works, 1); assert.equal(resumedRequests, 0);
  await restarted.resolveAction(saved.actions[0].id, { status: 'completed', summary: 'Caller verified and stopped the original command', source: 'user' });
  await restarted.observe({ ...event, id: 'new-evidence', summary: 'The caller has verified the original command and provided a new fact.' });
  await restarted.tick(); await restarted.idle(); assert.equal(works, 2); assert.equal(restarted.snapshot().actions[0].resolutionSource, 'user'); await restarted.close();
});

test('execution remains held while resolution is persisting and after a failed resolution write', async () => {
  const entered = deferred(), release = deferred(); let failResolution = false, calls = 0, clock = 1000;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, handlers: { work: async () => { throw Object.assign(new Error('unknown'), { code: 'uncertain_tool', usage: { totalTokens: 0 } }); }, share: async () => {} }, provider: provider([decision(), decision('wait', '')], (request, index) => { calls++; if (index > 0) assert.deepEqual(JSON.parse(request.messages[0].content[0].text).availableActions.sort(), ['share', 'wait']); }), saveState: async state => {
    if (failResolution && state.actions[0]?.status === 'completed') { entered.resolve(); await release.promise; throw new Error('fixture resolution persistence failed'); }
  } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle(); failResolution = true;
  const pending = coordinator.resolveAction(coordinator.snapshot().actions[0].id, { status: 'completed', summary: 'Checked' }); const rejection = assert.rejects(pending, /persistence failed/);
  await entered.promise; assert.equal(coordinator._executionBlocked(), true); release.resolve(); await rejection;
  assert.equal(coordinator.snapshot().actions[0].status, 'needs_review'); assert.equal(coordinator._executionBlocked(), true);
  failResolution = false; clock = coordinator.snapshot().nextReviewAt; await coordinator.tick(); assert.equal(calls, 2); await coordinator.close();
});
test('sequential request reservations settle cumulative action usage once and honor a tightened policy before the next request', async () => {
  const snapshots = [], started = deferred(), release = deferred();
  const coordinator = new InitiativeCoordinator({ model, policy: { tokenBudget: null }, provider: provider([decision()]), saveState: (state, metadata) => snapshots.push({ state, metadata }), handlers: { work: async (_action, { reserveTokens, reportUsage }) => {
    await reserveTokens(400); await reportUsage({ totalTokens: 100, estimatedTokens: 20 });
    started.resolve(); await release.promise; await reserveTokens(400);
    assert.fail('No second request can be admitted under the tightened cap');
  } } });
  await coordinator.observe(event); await coordinator.tick(); await started.promise;
  assert.equal(coordinator.snapshot().usedTokens, 140); assert.equal(coordinator.snapshot().reservedTokens, 0); assert.equal(coordinator.snapshot().estimatedTokens, 20);
  await coordinator.updatePolicy({ tokenBudget: 500 }); release.resolve(); await coordinator.idle();
  assert.equal(coordinator.snapshot().usedTokens, 140); assert.equal(coordinator.snapshot().reservedTokens, 0); assert.equal(coordinator.snapshot().actions[0].errorCode, 'budget'); assert.ok(snapshots.some(row => row.metadata?.reservationAdmission && row.state.reservedTokens === 400));
  await coordinator.close();
});
test('a prior unspent reservation cannot authorize a new request after the policy falls below already spent tokens', async () => {
  const entered = deferred(), release = deferred(); let admitted = false;
  const coordinator = new InitiativeCoordinator({ model, provider: provider([decision()]), policy: { tokenBudget: null, workBudgetTokens: 4000 }, handlers: { work: async (_action, { reserveTokens }) => { entered.resolve(); await release.promise; try { await reserveTokens(1); admitted = true; } catch (failure) { failure.usage = { totalTokens: 0 }; throw failure; } } } });
  await coordinator.observe(event); await coordinator.tick(); await entered.promise;
  await coordinator.updatePolicy({ tokenBudget: 1 }); release.resolve(); await coordinator.idle();
  assert.equal(admitted, false); assert.equal(coordinator.snapshot().usedTokens, 40); assert.equal(coordinator.snapshot().reservedTokens, 0); assert.equal(coordinator.snapshot().actions[0].errorCode, 'budget'); await coordinator.close();
});
test('sequential request metering reconciles success and unknown in-flight cancellation without double charging', async () => {
  const entered = deferred(), release = deferred();
  const coordinator = new InitiativeCoordinator({ model, provider: provider([decision()]), handlers: { work: async (_action, { reserveTokens, reportUsage }) => {
    await reserveTokens(100); await reportUsage({ totalTokens: 60, estimatedTokens: 0 });
    await reserveTokens(200); await reportUsage({ totalTokens: 170, estimatedTokens: 110 });
    return { summary: 'completed', usage: { totalTokens: 170, estimatedTokens: 110 } };
  } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle(); assert.equal(coordinator.snapshot().usedTokens, 210); assert.equal(coordinator.snapshot().estimatedTokens, 110); assert.equal(coordinator.snapshot().reservedTokens, 0); await coordinator.close();
  const interrupted = new InitiativeCoordinator({ model, provider: provider([decision()]), handlers: { work: async (_action, { reserveTokens, reportUsage }) => {
    await reserveTokens(100); await reportUsage({ totalTokens: 60 }); await reserveTokens(200); entered.resolve(); await release.promise; return { usage: { totalTokens: 80 } };
  } } });
  await interrupted.observe(event); await interrupted.tick(); await entered.promise; interrupted.interrupt('test'); await interrupted.idle();
  assert.equal(interrupted.snapshot().usedTokens, 300); assert.equal(interrupted.snapshot().estimatedTokens, 200); assert.equal(interrupted.snapshot().reservedTokens, 0); assert.equal(interrupted.snapshot().actions[0].status, 'needs_review'); release.resolve(); await interrupted.close();
});
test('request admission cannot overwrite an unsettled request, and a failed usage persistence does not double charge its receipt', async () => {
  let rejectedPersistence = false;
  const coordinator = new InitiativeCoordinator({ model, provider: provider([decision()]), saveState: state => { if (state.usedTokens === 100 && !rejectedPersistence) { rejectedPersistence = true; throw Object.assign(new Error('Fixture storage failure'), { code: 'storage_failed' }); } }, handlers: { work: async (_action, { reserveTokens, reportUsage }) => {
    await reserveTokens(200); await assert.rejects(reserveTokens(300), { code: 'request_pending' }); await reportUsage({ totalTokens: 60 });
  } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
  assert.ok(rejectedPersistence); assert.equal(coordinator.snapshot().usedTokens, 100); assert.equal(coordinator.snapshot().reservedTokens, 0); assert.equal(coordinator.snapshot().actions[0].errorCode, 'storage_failed'); await coordinator.close();
});
test('decision failures retain their exact stage and code with credentials redacted, and recover only on a successful review', async () => {
  let clock = 1000, calls = 0;
  const credential = 'fixture-secret+password', toolCredential = 'tool-credential-value';
  const coordinator = new InitiativeCoordinator({ model, apiKey: credential, redactValues: [toolCredential], now: () => clock, provider: async function* () {
    calls++;
    if (calls === 1) throw Object.assign(new Error(`HTTP rejected ${credential}; ${encodeURIComponent(credential)}; ${toolCredential}; Bearer unknowncredential; https://user:pass@host/path?token=hidden`), { code: 'authentication', status: 401, retryable: false });
    yield { type: 'text_delta', delta: calls === 2 ? 'not json with private response text' : JSON.stringify(decision('wait', '')) };
    yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: 'stop' };
  } });
  await coordinator.observe(event); await assert.rejects(coordinator.tick(), { code: 'authentication' });
  const first = coordinator.snapshot();
  assert.equal(first.lastFailure.source, 'provider'); assert.equal(first.lastFailure.code, 'authentication'); assert.equal(first.lastFailure.httpStatus, 401); assert.equal(first.lastFailure.retryable, false);
  const saved = JSON.stringify(first);
  for (const secret of [credential, encodeURIComponent(credential), toolCredential, 'unknowncredential', 'user:pass', 'hidden']) assert.ok(!saved.includes(secret));
  assert.equal(first.lastFailure.request.responseBytes, 0); assert.match(first.lastFailure.request.responseSha256, /^[a-f0-9]{64}$/);
  await coordinator.tick(); assert.equal(calls, 1); assert.equal(coordinator.snapshot().failureCount, 1);
  clock = first.nextReviewAt; await assert.rejects(coordinator.tick(), { code: 'invalid_decision' });
  const second = coordinator.snapshot(); assert.equal(second.lastFailure.source, 'response_validation'); assert.equal(second.lastFailure.request.stopReason, 'stop'); assert.equal(second.lastFailure.request.responseBytes, 35); assert.ok(!JSON.stringify(second).includes('private response text')); assert.equal(second.failureCount, 2);
  clock = second.nextReviewAt; await coordinator.tick();
  assert.equal(coordinator.snapshot().failureCount, 0); assert.equal(coordinator.snapshot().lastFailure.recoveredAt, clock); assert.equal(coordinator.snapshot().lastFailure.id, second.lastFailure.id);
  await coordinator.close();
});
test('failed host actions preserve concrete diagnostic codes without exposing tool credentials or treating failure as new evidence', async () => {
  const coordinator = new InitiativeCoordinator({ model, redactValues: ['tool-secret'], provider: provider([decision()]), handlers: { work: async () => { throw Object.assign(new Error('Tool failed with tool-secret api_key=unconfigured-secret'), { code: 'step_limit', usage: { totalTokens: 123 } }); } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
  const state = coordinator.snapshot(), action = state.actions[0];
  assert.equal(action.status, 'failed'); assert.equal(action.errorCode, 'step_limit'); assert.equal(action.failure.source, 'host_handler'); assert.equal(action.failure.phase, 'work'); assert.equal(state.usedTokens, 163); assert.equal(state.failureCount, 0); assert.equal(state.events.length, 1);
  assert.ok(!JSON.stringify(state).includes('tool-secret')); assert.ok(!JSON.stringify(state).includes('unconfigured-secret'));
  await coordinator.close();
});
test('model initiative observes project state without requiring a Goal', async () => {
  let requested = false;
  const result = await decideInitiative({ project: { id: 'p1', title: 'Migration tool' }, events: [event], model, availableActions: ['work'], provider: provider([decision()], options => { requested = true; assert.deepEqual(options.tools, []); const data = JSON.parse(options.messages[0].content[0].text); assert.equal(data.project.goal, undefined); assert.equal(data.events[0].id, 'E1'); }) });
  assert.ok(requested); assert.equal(result.decision.action, 'work'); assert.equal(result.usage.totalTokens, 40);
});

test('a missing conversation holds queued sharing across 1000 ticks without repeated writes and delivers once when one is available', async () => {
  let saves = 0, shares = 0, requests = 0;
  const state = { schemaVersion: 1, revision: 1, events: [event], seenEventIds: [event.id], actions: [{ ...decision('share', 'Verified finding'), id: 'share-one', status: 'queued', revision: 1 }], decisionRevision: 1, nextReviewAt: 1000000, lastSharedAt: null, usedTokens: 0, reservedTokens: 0 };
  const coordinator = new InitiativeCoordinator({ state, model, now: () => 1000, saveState: () => { saves++; }, provider: async function* () { requests++; assert.fail('An idle delivery gate must not ask the model again'); }, handlers: { share: async () => { shares++; return { usage: { totalTokens: 0 } }; } } });
  await coordinator.tick({ presence: { conversationAvailable: false } }); const baseline = saves;
  assert.equal(coordinator.snapshot().actions[0].deferredReason, 'no_conversation');
  for (let tick = 0; tick < 1000; tick++) { await coordinator.tick({ presence: { conversationAvailable: false } }); await coordinator.idle(); }
  assert.equal(saves, baseline); assert.equal(shares, 0); assert.equal(requests, 0); assert.equal(coordinator.snapshot().reservedTokens, 0);
  await coordinator.tick({ presence: { conversationAvailable: true } }); await coordinator.idle();
  assert.equal(shares, 1); assert.equal(coordinator.snapshot().actions[0].status, 'completed'); const settled = saves;
  for (let tick = 0; tick < 10; tick++) await coordinator.tick({ presence: { conversationAvailable: true } });
  assert.equal(shares, 1); assert.equal(saves, settled); assert.equal(requests, 0); await coordinator.close();
});
test('initiative rejects invented evidence, unavailable handlers and malformed outputs', async () => {
  assert.throws(() => validateInitiativeDecision(decision('work', 'work', ['invented']), { events: [event], availableActions: ['work'] }), { code: 'invalid_decision' });
  assert.throws(() => validateInitiativeDecision(decision('learn'), { events: [event], availableActions: ['work'] }), { code: 'invalid_decision' });
  await assert.rejects(decideInitiative({ model, events: [event], availableActions: ['work'], provider: provider([{ ...decision(), grantAllTools: true }]) }), { code: 'invalid_decision' });
  assert.equal((await decideInitiative({ model: { modelId: 'demo', protocol: 'demo' } })).status, 'blocked');
});
test('coordinator persists event dedup, runs host work once, records result as new evidence', async () => {
  const saves = []; let calls = 0;
  const coordinator = new InitiativeCoordinator({ project: { id: 'p1' }, model, provider: provider([decision()]), saveState: async state => saves.push(state), handlers: { work: async (action, context) => { calls++; assert.equal(context.idempotencyKey, action.id); assert.ok(saves.at(-1).actions.some(item => item.id === action.id && item.status === 'running')); return { summary: 'Three compatibility cases found', usage: { totalTokens: 50 } }; } } });
  assert.equal((await coordinator.observe(event)).accepted, true); assert.equal((await coordinator.observe(event)).duplicate, true);
  await coordinator.tick(); await coordinator.idle(); assert.equal(calls, 1); assert.equal(coordinator.snapshot().usedTokens, 90); assert.equal(coordinator.snapshot().reservedTokens, 0);
  assert.ok(coordinator.snapshot().events.some(item => item.type === 'action_completed'));
  const restarted = new InitiativeCoordinator({ state: saves.at(-1), model }); assert.equal((await restarted.observe(event)).duplicate, true);
  await coordinator.close(); await restarted.close();
});
test('muted and typing deferred shares never block independent background work', async () => {
  const state = { schemaVersion: 1, revision: 1, events: [event], seenEventIds: ['e1'], decisionRevision: 1, nextReviewAt: Date.now() + 100000, lastSharedAt: null, usedTokens: 0, reservedTokens: 0, actions: [{ ...decision('share', 'Useful finding'), id: 'share1', revision: 1, status: 'queued' }, { ...decision('work'), id: 'work1', revision: 1, status: 'queued' }] };
  let shares = 0, works = 0;
  const coordinator = new InitiativeCoordinator({ state, model, policy: { notificationMuted: true }, handlers: { share: async () => { shares++; }, work: async () => { works++; return { summary: 'Done', usage: { totalTokens: 3 } }; } }, provider: provider([decision('wait', '', ['e1'])]) });
  await coordinator.tick({ presence: { typing: true } }); await coordinator.idle(); assert.equal(works, 1); assert.equal(shares, 0);
  assert.equal(coordinator.snapshot().actions.find(item => item.id === 'share1').status, 'cancelled'); // Work result made the old intervention stale.
  await coordinator.close();
});
test('typing and cooldown gate sharing; unmute drains an unchanged queued message exactly once', async () => {
  let clock = 1000000, shares = 0;
  const coordinator = new InitiativeCoordinator({ project: { id: 'p' }, model, now: () => clock, policy: { notificationMuted: true, cooldownMs: 5000 }, provider: provider([decision('share', 'I found a useful issue')]), handlers: { share: async () => { shares++; return { usage: { totalTokens: 0 } }; } } });
  await coordinator.observe(event); await coordinator.tick(); assert.equal(shares, 0); assert.equal(coordinator.snapshot().actions[0].deferredReason, 'notification_muted');
  await coordinator.updatePolicy({ notificationMuted: false }); await coordinator.tick({ presence: { typing: true } }); assert.equal(shares, 0); assert.equal(coordinator.snapshot().actions[0].deferredReason, 'user_typing');
  await coordinator.tick(); await coordinator.idle(); assert.equal(shares, 1);
  // A delivery receipt does not create new evidence or another pending share.
  await coordinator.tick(); await coordinator.idle(); assert.equal(shares, 1); assert.equal(coordinator.snapshot().actions.length, 1);
  await coordinator.close();
});
test('share receipts never self-wake and paraphrases on the same evidence are deduplicated after timed review', async () => {
  let clock = 1000, shares = 0, calls = 0;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, policy: { cooldownMs: 0, reviewMinMs: 1000 }, provider: provider([decision('share', 'One finding'), decision('share', 'Same finding, different wording')], () => calls++), handlers: { share: async () => { shares++; return { usage: { totalTokens: 0 } }; } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
  assert.equal(coordinator.snapshot().revision, 1); assert.equal(coordinator.snapshot().events.length, 1);
  await coordinator.tick(); assert.equal(calls, 1);
  clock += 60001; await coordinator.tick(); await coordinator.idle(); assert.equal(calls, 2); assert.equal(shares, 1); assert.equal(coordinator.snapshot().actions.length, 1);
  await coordinator.close();
});
test('idle and provider failure back off, but new external evidence bypasses an idle timer', async () => {
  let clock = 1000, calls = 0;
  const coordinator = new InitiativeCoordinator({ model, now: () => clock, policy: { reviewMinMs: 30000, reviewMaxMs: 120000 }, provider: provider([{ ...decision('wait', ''), nextReviewAfterMs: 1000 }], () => calls++) });
  await coordinator.observe(event); await coordinator.tick(); assert.equal(coordinator.snapshot().nextReviewAt, 31000);
  clock = 31000; await coordinator.tick(); assert.equal(coordinator.snapshot().nextReviewAt, 91000);
  clock++; await coordinator.tick(); assert.equal(calls, 2);
  await coordinator.observe({ id: 'new', type: 'user', summary: 'A new fact has arrived' }); await coordinator.tick(); assert.equal(calls, 3);
  await coordinator.close();
  let failures = 0;
  const broken = new InitiativeCoordinator({ model, now: () => clock, provider: async function* () { failures++; throw new Error('fixture failure'); } });
  await broken.observe(event); await assert.rejects(broken.tick()); await broken.tick(); assert.equal(failures, 1); assert.ok(broken.snapshot().nextReviewAt > clock); await broken.close();
});
test('host rechecks can defer a share without claiming delivery', async () => {
  let ready = false, shares = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: provider([decision('share', 'Finding')]), handlers: { share: async () => { if (!ready) return { deferred: true, reason: 'fresh_typing', usage: { totalTokens: 0 } }; shares++; return { usage: { totalTokens: 0 } }; } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle(); assert.equal(coordinator.snapshot().actions[0].status, 'queued'); assert.equal(coordinator.snapshot().lastSharedAt, null);
  ready = true; await coordinator.tick(); await coordinator.idle(); assert.equal(shares, 1); assert.equal(coordinator.snapshot().actions[0].status, 'completed'); await coordinator.close();
});
test('a handler that ignores abort cannot publish its late result as completed evidence', async () => {
  const started = deferred(), release = deferred();
  const coordinator = new InitiativeCoordinator({ model, provider: provider([decision()]), handlers: { work: async () => { started.resolve(); await release.promise; return { summary: 'obsolete result', usage: { totalTokens: 4 } }; } } });
  await coordinator.observe(event); await coordinator.tick(); await started.promise; coordinator.interrupt('user_changed_scope'); release.resolve(); await coordinator.idle();
  assert.equal(coordinator.snapshot().actions[0].status, 'needs_review'); assert.ok(!coordinator.snapshot().events.some(item => item.summary.includes('obsolete result'))); await coordinator.close();
});
test('pausing during a provider decision prevents late host effects even if the provider ignores abort', async () => {
  const started = deferred(), release = deferred(); let effects = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: async function* () { started.resolve(); await release.promise; yield { type: 'text_delta', delta: JSON.stringify(decision('share', 'too late')) }; yield { type: 'usage', usage: { totalTokens: 4 } }; }, handlers: { share: async () => effects++ } });
  await coordinator.observe(event); const running = coordinator.tick(); await started.promise; await coordinator.updatePolicy({ enabled: false }); release.resolve(); assert.equal((await running).status, 'stale'); assert.equal(effects, 0); await coordinator.close();
});
test('new evidence during a model request invalidates the stale decision before effects', async () => {
  const started = deferred(), released = deferred(); let calls = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: async function* () { started.resolve(); await released.promise; yield { type: 'text_delta', delta: JSON.stringify(decision()) }; yield { type: 'usage', usage: { totalTokens: 40 } }; }, handlers: { work: async () => { calls++; } } });
  await coordinator.observe(event); const tick = coordinator.tick(); await started.promise;
  await coordinator.observe({ id: 'e2', type: 'user_correction', summary: 'Do not pursue the migration; scope changed.' }); released.resolve();
  assert.equal((await tick).status, 'stale'); assert.equal(calls, 0); assert.equal(coordinator.snapshot().actions.length, 0); assert.ok(coordinator.snapshot().usedTokens > 40); assert.equal(coordinator.snapshot().usedTokens, coordinator.snapshot().estimatedTokens); await coordinator.close();
});
test('budget and max concurrency are enforced before handlers, cancellation requires outcome review', async () => {
  let requested = false;
  const poor = new InitiativeCoordinator({ model, policy: { tokenBudget: 1 }, provider: provider([decision()], () => { requested = true; }) });
  await poor.observe(event); assert.equal((await poor.tick()).reason, 'budget_exhausted'); assert.equal(requested, false); await poor.close();
  const hold = deferred(); let active = 0, maximum = 0;
  const state = { schemaVersion: 1, revision: 1, events: [event], seenEventIds: ['e1'], decisionRevision: 1, nextReviewAt: Date.now() + 100000, lastSharedAt: null, usedTokens: 0, reservedTokens: 0, actions: [1, 2].map(i => ({ ...decision(), id: `work${i}`, revision: 1, status: 'queued' })) };
  const coordinator = new InitiativeCoordinator({ model, state, policy: { maxConcurrent: 1 }, handlers: { work: async (_action, context) => { active++; maximum = Math.max(maximum, active); await new Promise((resolve, reject) => { context.signal.addEventListener('abort', () => { active--; reject(context.signal.reason); }, { once: true }); hold.promise.then(resolve); }); } } });
  const controller = new AbortController(); await coordinator.tick({ signal: controller.signal }); assert.equal(coordinator.active.size, 1); assert.equal(maximum, 1); controller.abort(); await coordinator.idle(); assert.equal(coordinator.snapshot().actions[0].status, 'needs_review');
  await coordinator.resolveAction('work1', { status: 'not-executed', summary: 'Fixture stopped before effects' }); assert.equal(coordinator.snapshot().actions[0].status, 'cancelled'); await coordinator.close();
});
test('restart never replays an in-flight side effect and policy remains persisted', async () => {
  const state = { schemaVersion: 1, revision: 1, events: [event], seenEventIds: ['e1'], decisionRevision: 1, nextReviewAt: Date.now() + 100000, lastSharedAt: null, usedTokens: 10, reservedTokens: 50, actions: [{ ...decision('share', 'A previous message'), id: 'inflight', revision: 1, status: 'running' }], policy: { notificationMuted: true } };
  let calls = 0; const coordinator = new InitiativeCoordinator({ model, state, handlers: { share: async () => { calls++; } } });
  await coordinator.tick(); assert.equal(calls, 0); assert.equal(coordinator.snapshot().actions[0].status, 'needs_review'); assert.equal(coordinator.snapshot().usedTokens, 60); assert.equal(coordinator.policy.notificationMuted, true); await coordinator.close();
});

test('unlimited policy passes no hard action cap and still accounts measured usage', async () => {
  let allowance = 'unset';
  const coordinator = new InitiativeCoordinator({ model, policy: { tokenBudget: null, workBudgetTokens: 5 }, provider: provider([decision('learn')]), handlers: { learn: async (_action, context) => { allowance = context.tokenBudget; return { summary: 'Evaluation completed', usage: { totalTokens: 80000 } }; } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
  assert.equal(allowance, null); assert.equal(coordinator.snapshot().usedTokens, 80040); assert.equal(coordinator.snapshot().reservedTokens, 0);
  await coordinator.updatePolicy({ tokenBudget: 1 }); assert.equal(coordinator._remaining(), 0); await coordinator.updatePolicy({ tokenBudget: null }); assert.equal(coordinator._remaining(), Infinity); await coordinator.close();
});

test('uncapped learning reserves its own estimate without making it a hard cap, including crash recovery', async () => {
  const started = deferred(), release = deferred(); let allowance;
  const coordinator = new InitiativeCoordinator({ model, policy: { tokenBudget: null, workBudgetTokens: 12000, learnBudgetTokens: 150000 }, provider: provider([decision('learn')]), handlers: { learn: async (_action, context) => { allowance = context.tokenBudget; started.resolve(); await release.promise; return { usage: { totalTokens: 160000 } }; } } });
  await coordinator.observe(event); await coordinator.tick(); await started.promise;
  assert.equal(allowance, null); assert.equal(coordinator.snapshot().reservedTokens, 150000);
  const recovered = new InitiativeCoordinator({ model, state: coordinator.snapshot() }); assert.equal(recovered.snapshot().estimatedTokens, 150000); assert.equal(recovered.snapshot().usedTokens, 150040); assert.equal(recovered.snapshot().actions[0].status, 'needs_review'); await recovered.close();
  release.resolve(); await coordinator.idle(); assert.equal(coordinator.snapshot().usedTokens, 160040); assert.equal(coordinator.snapshot().reservedTokens, 0); await coordinator.close();
});

test('explicit spending caps bound learning independently of its reservation estimate and legacy work-only policies remain compatible', async () => {
  let allowance, reserved; const coordinator = new InitiativeCoordinator({ model, policy: { tokenBudget: 200000, workBudgetTokens: 12000, learnBudgetTokens: 900000 }, provider: provider([decision('learn')]), handlers: { learn: async (_action, context) => { allowance = context.tokenBudget; reserved = coordinator.snapshot().reservedTokens; return { usage: { totalTokens: 50000 } }; } } });
  await coordinator.observe(event); await coordinator.tick(); await coordinator.idle(); assert.equal(allowance, 199960); assert.equal(reserved, allowance); assert.equal(coordinator.snapshot().usedTokens, 50040); await coordinator.close();
  const legacy = new InitiativeCoordinator({ model, policy: { workBudgetTokens: 4 } }); assert.equal(legacy.policy.learnBudgetTokens, null); await legacy.updatePolicy({ workBudgetTokens: 8 }); assert.equal(legacy.policy.learnBudgetTokens, null); await legacy.updatePolicy({ learnBudgetTokens: 20 }); assert.equal(legacy.policy.learnBudgetTokens, 20); await legacy.close();
});

test('host reservation conflict rolls back local reservation without poisoning future persistence', async () => {
  let rejectReservation = true, calls = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: provider([decision('wait', '')], () => calls++), saveState: async snapshot => { if (rejectReservation && snapshot.reservedTokens > 0) throw Object.assign(new Error('concurrent budget reservation'), { code: 'budget' }); } });
  await coordinator.observe(event); await assert.rejects(coordinator.tick(), { code: 'budget' }); assert.equal(calls, 0); assert.equal(coordinator.snapshot().reservedTokens, 0);
  rejectReservation = false; await coordinator.tick(); assert.equal(calls, 1); assert.equal(coordinator.snapshot().usedTokens, 40); await coordinator.close();
});

test('reported usage is retained when validation fails instead of converting it into a guessed charge', async () => {
  const coordinator = new InitiativeCoordinator({ model, provider: provider([{ ...decision('wait', ''), evidenceIds: ['invented'] }]) });
  await coordinator.observe(event); await assert.rejects(coordinator.tick(), { code: 'invalid_decision' });
  assert.equal(coordinator.snapshot().usedTokens, 40); assert.equal(coordinator.snapshot().estimatedTokens, 0); assert.equal(coordinator.snapshot().reservedTokens, 0); await coordinator.close();
});

test('initiative cumulative usage frames replace the current request receipt while completed repair attempts still add', async () => {
  for (const attempts of [1, 2]) {
    let calls = 0; const events = [];
    const result = await decideInitiative({ model, events: [event], availableActions: ['work'], maxAttempts: attempts, onEvent: value => events.push(value), provider: async function* () {
      calls++;
      // Explicit provider fixture emits cumulative receipts, as streaming adapters do.
      yield { type: 'usage', usage: { input: 10, output: 1, totalTokens: 11 } };
      yield { type: 'text_delta', delta: JSON.stringify(calls < attempts ? { ...decision(), evidenceIds: ['not-an-event'] } : decision()) };
      yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } };
      yield { type: 'done', stopReason: 'stop' };
    } });
    assert.equal(calls, attempts); assert.equal(result.attempts, attempts); assert.equal(result.usageReported, true);
    assert.deepEqual(result.usage, { input: attempts * 10, output: attempts * 3, cacheRead: 0, cacheWrite: 0, totalTokens: attempts * 13 });
    assert.deepEqual(events.find(row => row.type === 'initiative_decision').usage, result.usage);
  }
});

test('initiative terminal provider failure settles the latest cumulative receipt once and cannot dispatch a plausible decision', async () => {
  let calls = 0, works = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: async function* () {
    calls++; yield { type: 'usage', usage: { input: 10, output: 1, totalTokens: 11 } };
    yield { type: 'text_delta', delta: JSON.stringify(decision()) };
    yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } };
    throw new ProviderError('Explicit abnormal termination fixture', { code: 'provider_termination', providerFinishReason: 'content_filter' });
  }, handlers: { work: async () => { works++; } } });
  try {
    await coordinator.observe(event);
    await assert.rejects(coordinator.tick(), error => error.code === 'provider_termination' && error.usage.totalTokens === 13);
    assert.equal(calls, 1); assert.equal(works, 0); assert.equal(coordinator.snapshot().usedTokens, 13);
    assert.equal(coordinator.snapshot().estimatedTokens, 0); assert.equal(coordinator.snapshot().reservedTokens, 0);
  } finally { await coordinator.close(); }
});


test('append-only communication has one independent slot beside a long action; ask still respects the foreground boundary', async () => {
  const longWork = deferred(), delivery = deferred(); let shares = 0, asks = 0, works = 0, requests = 0;
  const state = { schemaVersion: 1, revision: 1, events: [event], seenEventIds: ['e1'], decisionRevision: 1, nextReviewAt: 1000000, lastSharedAt: null, usedTokens: 0, reservedTokens: 0, actions: [
    { ...decision('work'), id: 'long-work', revision: 1, status: 'queued' },
    { ...decision('work', 'Other work'), id: 'other-work', revision: 1, status: 'queued' },
    { ...decision('share', 'Useful previously verified result'), id: 'independent-share', revision: 1, status: 'queued' },
    { ...decision('ask', 'A separate choice'), id: 'question', revision: 1, status: 'queued' }
  ] };
  const c = new InitiativeCoordinator({ model, state, now: () => 1000, policy: { maxConcurrent: 1, cooldownMs: 0 }, provider: async function* () { requests++; assert.fail('No new evidence justifies a decision'); }, handlers: {
    work: async () => { works++; await longWork.promise; return { usage: { totalTokens: 0 } }; },
    share: async () => { shares++; await delivery.promise; return { usage: { totalTokens: 0 } }; },
    ask: async () => { asks++; return { usage: { totalTokens: 0 } }; }
  } });
  await c.tick({ presence: { activeTurn: true } }); assert.equal(works, 1); assert.equal(shares, 0);
  assert.equal(c.state.actions.find(a => a.id === 'independent-share').deferredReason, 'active_turn');
  await c.tick({ presence: { activeTurn: true, allowInterleavedShare: true } }); assert.equal(shares, 1); assert.equal(works, 1); assert.equal(asks, 0); assert.equal(c.active.size, 2);
  await c.tick({ presence: { activeTurn: false, allowInterleavedShare: true } }); assert.equal(asks, 0, 'a second communication waits for the first delivery commit');
  delivery.resolve(); await c.active.get('independent-share').promise;
  await c.tick({ presence: { activeTurn: true, allowInterleavedShare: true } }); assert.equal(asks, 0); assert.equal(c.state.actions.find(a => a.id === 'question').deferredReason, 'active_turn');
  await c.tick({ presence: { activeTurn: false, allowInterleavedShare: true } }); await c.active.get('question')?.promise; assert.equal(asks, 1); assert.equal(works, 1); assert.equal(shares, 1); assert.equal(requests, 0);
  longWork.resolve(); await c.idle(); await c.close();
});

test('interleaved share keeps typing, mute, quiet and cooldown gates and new user evidence still revokes stale queued content', async () => {
  let clock = 1000, shares = 0, saves = 0;
  const state = { schemaVersion: 1, revision: 1, events: [event], seenEventIds: ['e1'], decisionRevision: 1, nextReviewAt: 1000000, lastSharedAt: null, usedTokens: 0, reservedTokens: 0, actions: [{ ...decision('share', 'Old finding'), id: 'old-share', status: 'queued', revision: 1 }] };
  const c = new InitiativeCoordinator({ model, state, now: () => clock, saveState: () => { saves++; }, handlers: { share: () => { shares++; } } });
  const presence = { activeTurn: true, allowInterleavedShare: true, typing: true };
  await c.tick({ presence }); const baseline = saves;
  for (let n = 0; n < 1000; n++) await c.tick({ presence });
  assert.equal(saves, baseline); assert.equal(shares, 0); assert.equal(c.state.actions[0].deferredReason, 'user_typing');
  assert.equal(c._shareGate({ ...presence, typing: false, quiet: true }), 'quiet_until');
  await c.updatePolicy({ notificationMuted: true }); assert.equal(c._shareGate({ ...presence, typing: false }), 'notification_muted');
  await c.updatePolicy({ notificationMuted: false }); c.state.lastSharedAt = clock;
  assert.equal(c._shareGate({ ...presence, typing: false }), 'cooldown');
  await c.observe({ id: 'user-steering', type: 'user_message', summary: 'The earlier finding is superseded by a changed constraint.' });
  assert.equal(c.state.actions[0].status, 'cancelled'); assert.equal(c.state.actions[0].cancellationReason, 'new_evidence'); assert.equal(shares, 0); await c.close();
});


test('only explicitly nonblocking hosts interleave ask; an answerable question prevents another card without paid reviews or idle writes', async () => {
  let asks = 0, saves = 0, requests = 0;
  const state = { schemaVersion: 1, revision: 1, events: [event], seenEventIds: ['e1'], decisionRevision: 1, nextReviewAt: 1000000, lastSharedAt: null, usedTokens: 0, reservedTokens: 0, actions: [{ ...decision('ask', 'Choose the useful next direction'), id: 'ask-one', revision: 1, status: 'queued' }] };
  const c = new InitiativeCoordinator({ model, state, now: () => 1000, saveState: () => { saves++; }, provider: async function* () { requests++; assert.fail('Question delivery must not trigger a new paid decision'); }, handlers: { ask: () => { asks++; return { usage: { totalTokens: 0 } }; } } });
  await c.tick({ presence: { activeTurn: true, allowInterleavedShare: true } }); assert.equal(asks, 0); assert.equal(c.state.actions[0].deferredReason, 'active_turn');
  const presence = { activeTurn: true, allowInterleavedAsk: true, pendingQuestion: true };
  await c.tick({ presence }); assert.equal(c.state.actions[0].deferredReason, 'pending_question'); const saved = saves;
  for (let i = 0; i < 1000; i++) await c.tick({ presence });
  assert.equal(saves, saved); assert.equal(requests, 0); assert.equal(asks, 0);
  for (const [patch, gate] of [[{ typing: true }, 'user_typing'], [{ quiet: true }, 'quiet_until'], [{ conversationAvailable: false }, 'no_conversation']]) assert.equal(c._shareGate({ ...presence, pendingQuestion: false, ...patch }, 'ask'), gate);
  await c.tick({ presence: { ...presence, pendingQuestion: false } }); await c.idle();
  assert.equal(asks, 1); assert.equal(c.state.actions[0].status, 'completed');
  await c.tick({ presence: { ...presence, pendingQuestion: false } }); assert.equal(asks, 1); assert.equal(requests, 0); await c.close();
});

test('prompt divergence: where consecutive decision requests first differ, measured and reported with each decision, never persisted', async () => {
  const { promptDivergence, jsonKeyAt } = await import('../src/initiative.mjs');
  const text = JSON.stringify({ hostActionContracts: { work: { enabled: true } }, availableActions: ['wait', 'work'], project: { id: 'p', title: 'T', recentConversation: [{ text: 'hi' }] }, events: [{ id: 'E1' }] });
  assert.equal(jsonKeyAt(text, text.indexOf('"recentConversation"') + 5), 'project.recentConversation');
  assert.equal(jsonKeyAt(text, 2), 'hostActionContracts'); assert.equal(jsonKeyAt(text, text.indexOf('"events"') + 1), 'events'); assert.equal(jsonKeyAt('not json', 1), null);
  const first = promptDivergence({ system: 'S', text }, null); assert.equal(first.measured, false); assert.equal(first.textChars, text.length);
  const second = promptDivergence({ system: 'S', text: text.replace('"hi"', '"hello"') }, { system: 'S', text });
  assert.equal(second.measured, true); assert.equal(second.divergedIn, 'project.recentConversation'); assert.ok(second.sharedRatio > .5 && second.sharedRatio < 1, String(second.sharedRatio));
  assert.equal(promptDivergence({ system: 'S2', text }, { system: 'S', text }).divergedIn, 'system');
  assert.deepEqual(promptDivergence({ system: 'S', text }, { system: 'S', text }).divergedIn, 'none');
  const coordinator = new InitiativeCoordinator({ model, provider: provider([decision('wait', '', ['e1'])]) });
  try {
    await coordinator.observe(event); const one = await coordinator.tick();
    assert.equal(one.status, 'decided'); assert.equal(one.prompt.measured, false, 'nothing to compare with on the first decision');
    await coordinator.observe({ ...event, id: 'e2', summary: 'A second note arrived.' }); const two = await coordinator.tick();
    assert.equal(two.status, 'decided'); assert.equal(two.prompt.measured, true); assert.ok(two.prompt.sharedRatio > 0); assert.equal(typeof two.prompt.divergedIn, 'string');
    assert.equal(coordinator.snapshot().lastPrompt, undefined, 'the previous request text stays in memory only');
  } finally { await coordinator.close(); }
});

test('decisionAttempts is opt-in: by default an invalid decision is one metered failure; with 2, it is asked once more with the validation message', async () => {
  const outputs = [decision('work', 'Check the notes', ['fabricated']), decision('work', 'Check the notes', ['e1'])];
  let calls = 0; const seen = [];
  const fixture = async function* (options) { calls++; seen.push(options.messages.length); yield { type: 'text_delta', delta: JSON.stringify(outputs[Math.min(calls - 1, outputs.length - 1)]) }; yield { type: 'usage', usage: { input: 10, output: 30, totalTokens: 40 } }; yield { type: 'done', stopReason: 'stop' }; };
  const single = new InitiativeCoordinator({ model, provider: fixture, handlers: { work: async () => ({ summary: 'done', usage: { totalTokens: 0 } }) } });
  try { await single.observe(event); await assert.rejects(single.tick(), { code: 'invalid_decision' }); assert.equal(calls, 1, 'the default repairs nothing'); assert.equal(single.policy.decisionAttempts, 1); } finally { await single.close(); }
  calls = 0; seen.length = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: fixture, policy: { decisionAttempts: 2 }, handlers: { work: async () => ({ summary: 'done', usage: { totalTokens: 0 } }) } });
  try {
    await coordinator.observe(event); const outcome = await coordinator.tick();
    assert.equal(outcome.status, 'decided'); assert.equal(calls, 2); assert.deepEqual(seen, [1, 3], 'the repair round carries the rejected answer and the validation message');
    assert.equal(coordinator.snapshot().usedTokens, 80, 'both attempts are charged');
  } finally { await coordinator.close(); }
});

test('evidence handles written into a task, reason or question become a short quote of the evidence; evidenceIds keep the mapping', async () => {
  const { describeHandles } = await import('../src/initiative.mjs');
  const events = [
    { id: 'message:u1', type: 'user_message', summary: '把第 8 章扩到三千字以上，保持原有伏笔' },
    { id: 'turn:t1:completed@x', type: 'conversation_result', summary: JSON.stringify({ final: { text: '## 本轮扩容完成\n\n**成果**：Ch8 1989→3072' } }) },
    { id: 'action:a1:completed', type: 'action_completed', summary: 'work completed. ## 收尾登记轮完成（未动任何正文）\n…' },
  ];
  const decision = { action: 'work', evidenceIds: ['turn:t1:completed@x'], content: '与 E2 报告表逐章比对，按 E1 的要求继续；E3「收尾登记」已做。E2E 测试不受影响。', reason: '依据 E2。', questions: [{ id: 'q', question: 'E1 里的伏笔要保留吗？' }] };
  const out = describeHandles(decision, events);
  assert.equal(out.content, '与「本轮扩容完成」报告表逐章比对，按「把第 8 章扩到三千字以上，保持原有伏笔」的要求继续；「收尾登记」已做。E2E 测试不受影响。');
  assert.equal(out.reason, '依据「本轮扩容完成」。');
  assert.equal(out.questions[0].question, '「把第 8 章扩到三千字以上，保持原有伏笔」里的伏笔要保留吗？');
  assert.deepEqual(out.evidenceIds, ['turn:t1:completed@x']);
  assert.equal(describeHandles({ content: 'E9 不存在' }, events).content, 'E9 不存在', 'a token that is not a current handle is left alone');
});

test('updateModel moves later decisions to the refreshed model, credential and output cap and keeps events, receipts and revisions', async () => {
  const seen = [];
  const coordinator = new InitiativeCoordinator({ model: { ...model, modelId: 'first', maxOutputTokens: 2048 }, apiKey: 'synthetic-key-first', policy: { decisionMaxTokens: 2048, cooldownMs: 0 }, provider: provider([decision('wait', ''), decision('wait', '')], options => seen.push({ modelId: options.model.modelId, maxOutputTokens: options.model.maxOutputTokens, apiKey: options.apiKey })) });
  await coordinator.observe(event); await coordinator.tick();
  assert.deepEqual(seen[0], { modelId: 'first', maxOutputTokens: 2048, apiKey: 'synthetic-key-first' });
  const before = coordinator.snapshot();
  coordinator.updateModel({ model: { ...model, modelId: 'second', maxOutputTokens: 8192 }, apiKey: 'synthetic-key-second', redactValues: ['synthetic-tool-secret'], decisionMaxTokens: 4096 });
  assert.deepEqual(coordinator.snapshot(), before, 'drift keeps events, receipts and revisions');
  assert.equal(coordinator.policy.decisionMaxTokens, 4096); assert.deepEqual(coordinator.redactValues, ['synthetic-key-second', 'synthetic-tool-secret']);
  await coordinator.observe({ id: 'e2', type: 'project_opened', summary: 'A second observation after the model changed.' }); await coordinator.tick();
  assert.deepEqual(seen[1], { modelId: 'second', maxOutputTokens: 4096, apiKey: 'synthetic-key-second' });
  await coordinator.close();
  assert.throws(() => coordinator.updateModel({ model, apiKey: 'synthetic-key-third' }), { code: 'closed' });
  assert.throws(() => new InitiativeCoordinator({ model }).updateModel({}), { code: 'invalid_policy' });
});
