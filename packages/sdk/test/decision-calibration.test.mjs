import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionCalibration, freezeDecisionCalibrationCase } from '../src/decision-calibration.mjs';
import { createDecisionKernel } from '../src/decision-kernel.mjs';
import { digest } from '../src/journal.mjs';

const plan = { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Does verified new evidence need review?', criteria: { true: 'Unresolved useful evidence exists.', false: 'Evidence was already resolved.' } } } };
function fixture(overrides = {}) {
  return freezeDecisionCalibrationCase({ id: 'case_1', point: 'initiative.review', state: { userMessage: 'PRIVATE task content', task: { goal: 'Deliver verified report' } }, signals: { novelty: .6, evidenceStrength: .8 }, scope: { projectId: 'synthetic' },
    assessmentPlan: plan, planProvenance: { source: 'main_model', receiptHash: digest('actual-plan-model-receipt') },
    models: { main: { provider: 'test', id: 'main', revision: 'v1', parameters: { temperature: 0 } }, jev: { provider: 'test', id: 'jev', revision: 'v1' } },
    mainInputHash: digest('actual main serialized system/user/tools input'), thresholdVersion: 'threshold-v1', runtimeVersion: 'runtime-v1', fallbackRoute: 'main-review', ...overrides });
}
function decision(f, mode, overrides = {}) {
  const judged = { planRevision: f.identity.planHash, assessments: { initiative_need: { type: 'boolean', probability: .01 } } };
  const source = mode === 'active' ? 'judge' : 'fallback';
  return { point: f.input.point, mode, source, outcome: source === 'judge' ? judged : structuredClone(f.input.fallback), judged,
    planRevision: f.identity.planHash, policy: f.policy, reason: mode === 'off' ? 'off' : mode === 'shadow' ? 'shadow' : 'accepted',
    latencyMs: 5, networkAttempted: false, cached: false, coalesced: false, ...overrides };
}
function observation(overrides = {}) {
  return { source: 'host_verifier', receiptHash: digest('actual-verification'), windowClosed: true,
    notification: { required: true, delivered: true, useful: true }, completion: { required: true, completed: true }, ...overrides };
}
function run(cal, f, mode, overrides = {}) {
  return cal.recordRun({ caseId: f.identity.caseId, mode, identityHash: f.identity.hash, decision: decision(f, mode), routeId: mode === 'active' ? 'deferred' : f.identity.fallbackRoute,
    elapsedMs: 100, observation: observation(), ...overrides });
}
function request(cal, mode, { f = fixture(), repeat = 0, component = 'main', tokens = 100, cacheReadTokens = 0, cacheWriteTokens = 0, reservedTokens = 1000, networkAttempted = true, usage, status = 'completed', latencyMs = 50 } = {}) {
  const ticket = cal.admitRequest({ caseId: f.identity.caseId, mode, repeat, component, reservedTokens });
  cal.settleRequest(ticket.id, { status, usage: usage === null ? null : usage ?? { inputTokens: tokens - 10, outputTokens: 10, cacheReadTokens, cacheWriteTokens }, networkAttempted, latencyMs, receiptHash: digest(ticket.id) });
  return ticket;
}
const rejects = code => e => e.code === code;

test('fixture freezes actual plan, minimized input, model/settings and thresholds independently', () => {
  const f = fixture(); assert.ok(Object.isFrozen(f.input.assessmentPlan.questions.initiative_need.criteria));
  assert.throws(() => { f.input.state.userMessage = 'mutated'; }, TypeError);
  assert.equal(f.identity.hash, fixture().identity.hash);
  assert.notEqual(f.identity.hash, fixture({ mainInputHash: digest('different main prompt') }).identity.hash);
  assert.notEqual(f.identity.hash, fixture({ thresholdVersion: 'threshold-v2' }).identity.hash);
  assert.notEqual(f.identity.hash, fixture({ signals: { novelty: .1 } }).identity.hash);
  assert.notEqual(f.identity.hash, fixture({ models: { main: { provider: 'test', id: 'main', revision: 'v2' }, jev: { provider: 'test', id: 'jev', revision: 'v1' } } }).identity.hash);
  const p = structuredClone(plan); p.questions.initiative_need.instructions = 'Different main-model question';
  assert.notEqual(f.identity.planHash, fixture({ assessmentPlan: p }).identity.planHash);
});

test('requires main-model plan receipt and actual main-input hash, rejects model-less identity', () => {
  assert.throws(() => fixture({ planProvenance: { source: 'jev', receiptHash: digest('x') } }), rejects('main_model_receipt_required'));
  assert.throws(() => fixture({ mainInputHash: undefined }), rejects('invalid_fixture'));
  assert.throws(() => fixture({ models: { main: { id: 'a' }, jev: {} } }), rejects('model_identity_required'));
  assert.throws(() => fixture({ cacheRegime: 'cross-mode-shared-cache' }), rejects('invalid_fixture'));
});

test('rejects unsupported, oversized and circular fixture JSON before hashing', () => {
  assert.throws(() => fixture({ signals: { novelty: NaN } }), rejects('invalid_fixture'));
  assert.throws(() => fixture({ scope: { invalid: undefined } }), rejects('invalid_fixture'));
  assert.throws(() => fixture({ state: { userMessage: 'x'.repeat(128001) } }), rejects('invalid_fixture'));
  const circular = {}; circular.loop = circular;
  assert.throws(() => fixture({ scope: circular }), rejects('invalid_fixture'));
});

test('changed fixture hashes/policy cannot be accepted for calibration', () => {
  const f = structuredClone(fixture()); f.input.state.userMessage = 'different';
  assert.throws(() => createDecisionCalibration({ cases: [f], tokenBudget: 1000 }), rejects('fixture_changed'));
  assert.throws(() => createDecisionCalibration({ cases: [fixture(), fixture()], tokenBudget: 1000 }), rejects('invalid_fixture'));
});

test('matched off/shadow/active counts actual JEV overhead, no counterfactual savings claim', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 10000 });
  request(cal, 'off', { tokens: 200 }); run(cal, f, 'off');
  request(cal, 'shadow', { tokens: 200 }); request(cal, 'shadow', { component: 'jev', tokens: 30 }); run(cal, f, 'shadow');
  request(cal, 'active', { tokens: 70 }); request(cal, 'active', { component: 'jev', tokens: 30 }); run(cal, f, 'active');
  const s = cal.snapshot(); assert.equal(s.budget.chargedTokens, 530); assert.equal(s.comparisons[0].observedTokenDelta, 100);
  assert.deepEqual(s.comparisons[0].observedModes, ['off', 'shadow', 'active']);
  assert.equal(s.comparisons[0].claim, 'observed_matched_runs_not_causal_savings');
  assert.equal(s.counterfactualSavingsClaim, 'none'); assert.equal(s.statisticalClaim, 'none');
  assert.equal(s.modes.shadow.usage.jev.totalTokens, 30);
});

test('shadow-only and missing active results never invent saved main-model calls', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  run(cal, f, 'shadow'); assert.deepEqual(cal.snapshot().comparisons, []);
  run(cal, f, 'off'); assert.equal(cal.snapshot().comparisons[0].observedTokenDelta, null);
  assert.equal(cal.snapshot().comparisons[0].claim, 'counterfactual_or_usage_unobserved');
});

test('shadow cannot change actual path, fallback payload or route source', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  assert.throws(() => run(cal, f, 'shadow', { routeId: 'deferred' }), rejects('fallback_path_changed'));
  assert.throws(() => run(cal, f, 'shadow', { decision: decision(f, 'shadow', { outcome: { review: false } }) }), rejects('fallback_path_changed'));
  assert.throws(() => run(cal, f, 'shadow', { decision: { ...decision(f, 'active'), mode: 'shadow' } }), rejects('fallback_path_changed'));
  run(cal, f, 'shadow');
});

test('unknown/failed active judgments must preserve fallback; no accepted unknown scoring', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  const fallback = decision(f, 'active', { source: 'fallback', outcome: f.input.fallback, judged: undefined, reason: 'abstain' });
  assert.throws(() => run(cal, f, 'active', { decision: fallback }), rejects('fallback_path_changed'));
  const judged = { planRevision: f.identity.planHash, assessments: { initiative_need: { type: 'boolean', probability: .5 } } };
  assert.throws(() => run(cal, f, 'active', { decision: decision(f, 'active', { judged, outcome: judged }) }), rejects('invalid_judged_receipt'));
  run(cal, f, 'active', { decision: fallback, routeId: f.identity.fallbackRoute });
});

for (const flag of ['explicitRequest', 'dueSchedule', 'severeFailure', 'deliveryJustCompleted', 'unansweredQuestion']) {
  test(`protected ${flag} cannot be suppressed by active receipt`, () => {
    const f = fixture({ signals: { [flag]: true } }), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
    assert.throws(() => run(cal, f, 'active'), rejects('fallback_path_changed'));
    run(cal, f, 'active', { routeId: f.identity.fallbackRoute, decision: decision(f, 'active', { source: 'fallback', outcome: f.input.fallback, judged: undefined, reason: 'main_review_required' }) });
  });
}

test('off admits no JEV calls or fake cache usage', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  assert.throws(() => cal.admitRequest({ caseId: 'case_1', mode: 'off', component: 'jev', reservedTokens: 50 }), rejects('off_cannot_call_jev'));
  assert.throws(() => run(cal, f, 'off', { decision: decision(f, 'off', { cached: true }) }), rejects('off_cannot_call_jev'));
});

test('every actual JEV network attempt needs a linked settled request, including failure', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  assert.throws(() => run(cal, f, 'shadow', { decision: decision(f, 'shadow', { networkAttempted: true }) }), rejects('jev_request_not_accounted'));
  request(cal, 'shadow', { component: 'jev', reservedTokens: 100, usage: null, status: 'failed' });
  run(cal, f, 'shadow', { decision: decision(f, 'shadow', { networkAttempted: true, judged: undefined, reason: 'timeout' }) });
  assert.equal(cal.snapshot().modes.shadow.usage.jev.unknownUsageRequests, 1);
});

test('unknown usage keeps full reservation and excludes token comparison', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 200 });
  request(cal, 'off', { usage: null, reservedTokens: 100, status: 'failed' }); run(cal, f, 'off');
  request(cal, 'active', { tokens: 50, reservedTokens: 100 }); run(cal, f, 'active');
  assert.equal(cal.snapshot().budget.chargedTokens, 150); assert.equal(cal.snapshot().comparisons[0].observedTokenDelta, null);
  assert.throws(() => request(cal, 'active', { repeat: 1, reservedTokens: 51 }), rejects('budget_exhausted'));
});

test('pending calls consume budget; actual overrun halts admission even with remaining budget', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  const t = cal.admitRequest({ caseId: 'case_1', mode: 'off', component: 'main', reservedTokens: 100 });
  assert.equal(cal.snapshot().budget.chargedTokens, 100);
  assert.throws(() => run(cal, f, 'off'), rejects('request_receipt_pending'));
  cal.settleRequest(t.id, { status: 'completed', usage: { inputTokens: 100, outputTokens: 1 }, networkAttempted: true, latencyMs: 5, receiptHash: digest('real') });
  assert.equal(cal.snapshot().budget.overrun, true); assert.equal(cal.snapshot().budget.chargedTokens, 101);
  assert.throws(() => cal.admitRequest({ caseId: 'case_1', mode: 'shadow', component: 'main', reservedTokens: 1 }), rejects('budget_exhausted'));
});

test('receipts settle once, runs record once, no late call can rewrite a completed run', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 }), t = request(cal, 'off');
  assert.throws(() => cal.settleRequest(t.id, {}), rejects('request_already_settled_or_unknown'));
  run(cal, f, 'off'); assert.throws(() => run(cal, f, 'off'), rejects('run_already_recorded'));
  assert.throws(() => request(cal, 'off'), rejects('run_already_recorded'));
});

test('token input includes cache once, missing provider cache fields remain unknown', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 10000 });
  request(cal, 'off', { tokens: 110, cacheReadTokens: 80, cacheWriteTokens: 10 }); run(cal, f, 'off');
  request(cal, 'shadow', { usage: { inputTokens: 100, outputTokens: 10 } }); run(cal, f, 'shadow');
  const s = cal.snapshot(); assert.equal(s.modes.off.usage.main.totalTokens, 110); assert.equal(s.modes.off.usage.main.cacheHitPercent, 80);
  assert.equal(s.modes.shadow.usage.main.cacheReadTokens, null); assert.equal(s.modes.shadow.usage.main.cacheHitPercent, null);
});

test('cache/coalesced decisions record zero extra JEV network tokens, not invented provider cache tokens', () => {
  const f = fixture({ cacheRegime: 'isolated-warm' }), cal = createDecisionCalibration({ cases: [f], tokenBudget: 10000 });
  run(cal, f, 'active', { decision: decision(f, 'active', { cached: true }) });
  run(cal, f, 'active', { repeat: 1, decision: decision(f, 'active', { coalesced: true }) });
  const s = cal.snapshot(); assert.equal(s.modes.active.cachedDecisions, 1); assert.equal(s.modes.active.coalescedDecisions, 1);
  assert.equal(s.modes.active.usage.jev.totalTokens, 0); assert.equal(s.modes.active.usage.jev.networkRequests, 0);
});

test('invalid usage cannot release a reservation; no-network receipt cannot claim billed tokens', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  const t = cal.admitRequest({ caseId: 'case_1', mode: 'off', component: 'main', reservedTokens: 100 });
  const args = { status: 'completed', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 9, cacheWriteTokens: 9 }, networkAttempted: true, latencyMs: 1, receiptHash: digest('x') };
  assert.throws(() => cal.settleRequest(t.id, args), rejects('invalid_usage'));
  assert.throws(() => cal.settleRequest(t.id, { ...args, usage: { inputTokens: 10, outputTokens: 1 }, networkAttempted: false }), rejects('nonnetwork_usage'));
  assert.equal(cal.snapshot().budget.chargedTokens, 100);
  cal.settleRequest(t.id, { ...args, usage: null, networkAttempted: false }); assert.equal(cal.snapshot().budget.chargedTokens, 0);
});

test('metrics require independent closed-window outcomes and separate precision/recall denominators', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  const observations = [observation(), observation({ notification: { required: true, delivered: false, useful: null }, completion: { required: true, completed: false } }),
    observation({ notification: { required: false, delivered: true, useful: false }, completion: { required: false, completed: null } }),
    observation({ windowClosed: false }), observation({ notification: { required: null, delivered: null, useful: null }, completion: { required: null, completed: null } })];
  observations.forEach((o, repeat) => run(cal, f, 'off', { repeat, observation: o }));
  const m = cal.snapshot().modes.off;
  assert.deepEqual(m.falseSilence, { numerator: 1, denominator: 2, rate: .5 });
  assert.deepEqual(m.usefulNotifications, { numerator: 1, denominator: 2, rate: .5 });
  assert.deepEqual(m.completion, { numerator: 1, denominator: 2, rate: .5 });
  assert.equal(m.unknownNotificationOutcomes, 2); assert.equal(m.unknownCompletionOutcomes, 2);
});

test('completion cannot be self-attested by main model or missing outcome fields', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  assert.throws(() => run(cal, f, 'off', { observation: observation({ source: 'model_claim' }) }), rejects('outcome_receipt_required'));
  assert.throws(() => run(cal, f, 'off', { observation: observation({ completion: { required: true } }) }), rejects('invalid_observation'));
  assert.throws(() => run(cal, f, 'off', { observation: observation({ notification: { required: true, delivered: false, useful: true } }) }), rejects('invalid_observation'));
});

test('latency uses end-to-end run receipt p50/p95, independently of JEV latency', () => {
  const f = fixture({ latencyClass: 'parallel', cacheImpact: 'append-only' }), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  for (let i = 1; i <= 20; i++) run(cal, f, 'off', { repeat: i, elapsedMs: i * 10 });
  const s = cal.snapshot(); assert.deepEqual(s.modes.off.elapsedMs, { samples: 20, p50: 100, p95: 190 });
  assert.equal(s.modes.off.decisionLatencyMs.p95, 5); assert.equal(s.fixtures[0].latencyClass, 'parallel');
  assert.deepEqual(s.modes.active.elapsedMs, { samples: 0, p50: null, p95: null });
});

test('different repetitions never get matched; distinct outcome needs disallow quality comparison', () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  run(cal, f, 'off'); run(cal, f, 'active', { repeat: 1 }); assert.equal(cal.snapshot().comparisons[0].observedTokenDelta, null);
  run(cal, f, 'active', { observation: observation({ completion: { required: false, completed: null } }) });
  assert.equal(cal.snapshot().comparisons[0].qualityComparable, false);
});

test('closed window does not make unknown requirements, completion or usefulness comparable', () => {
  for (const observationValue of [observation({ completion: { required: null, completed: null } }), observation({ completion: { required: true, completed: null } }),
    observation({ notification: { required: true, delivered: null, useful: null } }), observation({ notification: { required: true, delivered: true, useful: null } })]) {
    const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
    run(cal, f, 'off', { observation: observationValue }); run(cal, f, 'active', { observation: observationValue });
    assert.equal(cal.snapshot().comparisons[0].qualityComparable, false);
  }
});

test('reports do not retain input prose, raw judgments, extra observation content or credentials', () => {
  const f = fixture({ state: { userMessage: 'PRIVATE task content sk-testcredentialthatmustnotescape000000', rawLog: 'drop me' } }), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  run(cal, f, 'shadow', { observation: observation({ secretExtra: 'DO_NOT_PERSIST' }) });
  const text = JSON.stringify(cal.snapshot()); for (const secret of ['PRIVATE task content', 'sk-testcredential', 'DO_NOT_PERSIST', 'Does verified new evidence']) assert.ok(!text.includes(secret));
  assert.ok(!f.input.state.userMessage.includes('sk-testcredential')); assert.equal(f.input.state.rawLog, undefined);
  assert.ok(Object.isFrozen(cal.snapshot().modes.shadow));
});

test('real decision kernel off/shadow/active remains same-input and shadow uses fallback', async () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 10000 }); let network = 0;
  for (const mode of ['off', 'shadow', 'active']) {
    const kernel = createDecisionKernel({ mode, apiKey: 'synthetic-credential', fetch: async () => { network++; return Response.json({ answers: { initiative_need: { noul: .01 } }, usage: { input_tokens: 30, output_tokens: 2 } }); } });
    const t = mode === 'off' ? null : cal.admitRequest({ caseId: f.identity.caseId, mode, component: 'jev', reservedTokens: 100 });
    const result = await kernel.decide(f.input);
    if (t) cal.settleRequest(t.id, { status: 'completed', usage: result.usage, networkAttempted: result.networkAttempted, latencyMs: result.latencyMs, receiptHash: digest(result.ledgerId) });
    run(cal, f, mode, { decision: result }); kernel.close();
  }
  assert.equal(network, 2); const s = cal.snapshot(); assert.equal(s.modes.shadow.fallbackRuns, 1); assert.equal(s.modes.active.fallbackRuns, 0);
  assert.equal(s.comparisons[0].observedTokenDelta, -32); assert.equal(s.modes.active.usage.jev.cacheReadTokens, null);
});

test('real kernel timeout is recorded as unknown-cost fallback, never a free successful silence', async () => {
  const f = fixture(), cal = createDecisionCalibration({ cases: [f], tokenBudget: 1000 });
  const kernel = createDecisionKernel({ mode: 'active', apiKey: 'synthetic', timeoutMs: 50, fetch: async () => new Promise(() => {}) });
  const t = cal.admitRequest({ caseId: 'case_1', mode: 'active', component: 'jev', reservedTokens: 100 });
  const result = await kernel.decide(f.input);
  cal.settleRequest(t.id, { status: 'failed', usage: null, networkAttempted: result.networkAttempted, latencyMs: result.latencyMs, receiptHash: digest(result.ledgerId) });
  run(cal, f, 'active', { decision: result, routeId: f.identity.fallbackRoute }); kernel.close();
  assert.equal(cal.snapshot().budget.chargedTokens, 100); assert.equal(cal.snapshot().modes.active.usage.jev.usageComplete, false);
});
