import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionKernel, deriveDecisionPolicy, decisionVerdict, minimizeDecisionState, JEV_ENDPOINT, DECISION_ASSESSMENT_PLAN_SCHEMA, validateDecisionAssessmentPlan, decisionAssessmentPlanHash } from '../src/decision-kernel.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';

const scope = { projectId: 'project-1', sessionId: 'session-1', revision: 'evidence-1' };
const booleanQuestion = (instructions = 'Do the supplied project events need another main-model review?') => ({ type: 'boolean', instructions, criteria: { true: 'A newly supported unresolved project concern needs the main agent to examine it.', false: 'The same events have already been examined without a new unresolved concern.' } });
const assessmentPlan = { version: 1, questions: { initiative_need: booleanQuestion() } };
const input = extra => ({ point: 'initiative.review', assessmentPlan, scope, state: { task: { title: '研究项目', goal: '每日报告' }, evidence: [{ id: 'e1', summary: '新来源更正了昨天的一项结论', verified: true }] }, fallback: { review: true }, ...extra });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const response = (noul = .99, extra = {}) => json({ answers: { initiative_need: { noul } }, usage: { input_tokens: 71, output_tokens: 0 }, ...extra });
const make = (fetch, options = {}) => createDecisionKernel({ apiKey: 'synthetic-test-credential', mode: 'active', fetch, ...options });

test('real System One wire shape: noul, model and Bearer with no redirects', async () => {
  let sent;
  const kernel = make(async (url, init) => { sent = { url, ...init }; return response(); });
  const result = await kernel.decide(input());
  assert.equal(sent.url, JEV_ENDPOINT);
  assert.equal(sent.redirect, 'manual');
  assert.equal(sent.headers.Authorization, 'Bearer synthetic-test-credential');
  const body = JSON.parse(sent.body);
  assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.initiative_need.type, 'noul');
  assert.equal(result.source, 'judge'); assert.equal(result.outcome.assessments.initiative_need.probability, .99); assert.equal(result.outcome.planRevision, decisionAssessmentPlanHash(assessmentPlan));
  assert.equal(result.networkAttempted, true);
  assert.equal(result.usage.inputTokens, 71);
  assert.equal(body.state.routingSignals.evidenceStrength, .5);
});

test('boolean uncertainty, invalid confidence and low confidence preserve fallback', async t => {
  for (const [name, raw, reason] of [['middle', { noul: .5 }, 'abstain'], ['weak-confidence', { noul: .99, confidence: .4 }, 'abstain'], ['bad-confidence', { noul: .99, confidence: 1.1 }, 'invalid_response'], ['bad-probability', { noul: -1 }, 'invalid_response']]) await t.test(name, async () => {
    const kernel = make(async () => json({ answers: { initiative_need: raw } }));
    const result = await kernel.decide(input({ fallback: { review: true, hostMarker: name } }));
    assert.equal(result.source, 'fallback'); assert.equal(result.reason, reason); assert.equal(result.outcome.hostMarker, name);
  });
});

test('a high-confidence negative scores the main-model criterion without generating an action', async () => {
  const result = await make(async () => response(.01)).decide(input());
  assert.equal(result.outcome.assessments.initiative_need.probability, .01); assert.equal(decisionVerdict(result.outcome.assessments.initiative_need, result.policy), false); assert.equal(result.source, 'judge'); assert.equal(result.outcome.review, undefined);
});

test('explicit requests and important pending events cannot be suppressed', async t => {
  for (const flag of ['explicitRequest', 'dueSchedule', 'severeFailure', 'deliveryJustCompleted', 'unansweredQuestion']) await t.test(flag, async () => {
    let calls = 0; const kernel = make(async () => { calls++; return response(0); });
    const result = await kernel.decide(input({ signals: { [flag]: true, duplicateEvidence: true } }));
    assert.equal(result.source, 'fallback'); assert.equal(result.outcome.review, true); assert.equal(calls, 0);
  });
});

test('duplicate evidence skips paid scoring but cannot invent a plan decision or erase pending work', async () => {
  let calls = 0;
  const kernel = make(async () => { calls++; return response(); });
  let result = await kernel.decide(input({ signals: { duplicateEvidence: true } }));
  assert.equal(result.source, 'fallback'); assert.equal(result.reason, 'duplicate_evidence'); assert.equal(result.outcome.review, true); assert.equal(calls, 0);
  result = await kernel.decide(input({ signals: { duplicateEvidence: true, hasPendingWork: true } }));
  assert.equal(result.source, 'judge'); assert.equal(calls, 1);
  result = await make(async () => { throw new Error('must not call'); }, { apiKey: undefined }).decide(input({ signals: { duplicateEvidence: true } }));
  assert.equal(result.source, 'fallback'); assert.equal(result.outcome.review, true); assert.equal(result.reason, 'unconfigured');
});

test('off performs no request, shadow records a verdict and preserves host outcome', async () => {
  let calls = 0, records = [];
  const fetch = async () => { calls++; return response(.01); };
  const off = make(fetch, { mode: 'off' }); assert.equal((await off.decide(input())).reason, 'off'); assert.equal(calls, 0);
  const shadow = make(fetch, { mode: 'shadow', ledger: row => records.push(row) });
  const result = await shadow.decide(input()); assert.equal(result.source, 'fallback'); assert.equal(result.reason, 'shadow'); assert.equal(result.outcome.review, true); assert.equal(result.judged.assessments.initiative_need.probability, .01); assert.equal(records.length, 1);
  assert.equal(records[0].answers.initiative_need.probability, .01);
});

test('missing key and resolver failure leave the existing main-model path unchanged', async () => {
  for (const apiKey of [undefined, () => undefined, async () => { throw new Error('private resolver error'); }]) {
    const result = await make(() => { throw new Error('no network expected'); }, { apiKey }).decide(input({ fallback: { review: true, marker: 'existing-flow' } }));
    assert.deepEqual(result.outcome, { review: true, marker: 'existing-flow' }); assert.equal(result.source, 'fallback');
    assert.equal(result.networkAttempted, false);
    assert.equal(JSON.stringify(result).includes('private resolver'), false);
  }
});

test('policy varies with project facts inside a conservative bounded envelope', () => {
  const young = deriveDecisionPolicy('evolution.review', { novelty: 1, evidenceStrength: .9, maturity: .1, load: 0, taskType: 'coding' });
  const recurring = deriveDecisionPolicy('evolution.review', { novelty: 0, evidenceStrength: .4, maturity: 1, load: 1, recurring: true, completed: true, taskType: 'research' });
  assert.ok(young.yes < recurring.yes); assert.ok(young.no < recurring.no); assert.ok(young.ttlMs < recurring.ttlMs); assert.ok(young.timeoutMs > recurring.timeoutMs); assert.ok(young.margin < recurring.margin);
  for (const point of ['chat.preflight', 'initiative.review', 'evolution.review']) for (const value of [-200, 0, .5, 1, 999, NaN, Infinity]) {
    const p = deriveDecisionPolicy(point, { novelty: value, evidenceStrength: value, load: value, consequence: value, maturity: value });
    assert.ok(p.yes >= .68 && p.yes <= .94); assert.ok(p.no >= .035 && p.no <= .17); assert.ok(p.no < p.yes); assert.ok(p.margin >= .14 && p.margin <= .34); assert.ok(p.timeoutMs >= 900 && p.timeoutMs <= 4500); assert.ok(p.ttlMs <= 60000);
  }
});

test('minimization drops full transcripts/provider fields and redacts secret forms', () => {
  const secret = 'arbitrary-user-secret-value';
  const result = minimizeDecisionState({ userMessage: `Please use ${secret}; Authorization: Bearer opaque-123456789; API_KEY='unknown-value-123'; sk-12345678901234567890; apikey_abcdefghijklmnopqrstuv`, apiKey: secret,
    transcript: 'FULL-CONVERSATION', task: { summary: 'task summary', token: secret }, evidence: [{ summary: 'fine', raw: secret }], candidate: { changedAreas: ['skills', secret], summary: 'no secret here' } }, { knownSecrets: [secret] });
  const serialized = JSON.stringify(result);
  for (const value of [secret, 'opaque-123456789', 'unknown-value-123', 'sk-12345678901234567890', 'apikey_abcdefghijklmnopqrstuv', 'FULL-CONVERSATION']) assert.equal(serialized.includes(value), false, value);
  assert.deepEqual(result.candidate.changedAreas, ['skills']); assert.equal(result.task.summary, 'task summary');
});

test('state text budget and evidence count stay bounded', () => {
  const result = minimizeDecisionState({ userMessage: 'x'.repeat(200000), task: { goal: 'y'.repeat(200000) }, evidence: Array.from({ length: 500 }, (_, i) => ({ id: String(i), summary: 'z'.repeat(200000) })), recentSummaries: ['a'.repeat(200000)] }, { maxChars: 3000 });
  assert.equal(result.evidence.length, 6); assert.ok(JSON.stringify(result).length < 3500);
});

test('ledger contains bounded decisions and salted digests, never state or server error prose', async () => {
  const records = [], state = { userMessage: 'Private project question marker 4321', task: { summary: 'Never copy this to telemetry' } };
  const kernel = make(async () => new Response(JSON.stringify({ error: { message: 'echo private server response' } }), { status: 500 }), { ledger: row => records.push(row) });
  const result = await kernel.decide(input({ state }));
  assert.equal(result.reason, 'server'); assert.equal(records.length, 1);
  const raw = JSON.stringify(records);
  for (const value of [state.userMessage, state.task.summary, 'synthetic-test-credential', 'echo private server response', 'project-1']) assert.equal(raw.includes(value), false);
  assert.match(records[0].stateDigest, /^[a-f\d]{64}$/);
});

test('cache reuse is scoped by project, session, revision, state, policy, credentials, and TTL', async () => {
  let calls = 0, time = 100, key = 'key-one'; const kernel = make(async () => { calls++; return response(); }, { now: () => time, apiKey: () => key });
  const first = await kernel.decide(input()); const cached = await kernel.decide(input());
  assert.equal(calls, 1); assert.equal(first.cached, false); assert.equal(first.networkAttempted, true); assert.equal(cached.networkAttempted, false); assert.equal(cached.cached, true); assert.deepEqual(cached.usage, {});
  for (const changed of [{ scope: { ...scope, projectId: 'p2' } }, { scope: { ...scope, sessionId: 's2' } }, { scope: { ...scope, revision: 'r2' } }, { state: { currentAction: 'new fact' } }, { signals: { novelty: 1 } }]) await kernel.decide(input(changed));
  assert.equal(calls, 6);
  key = 'key-two'; await kernel.decide(input()); assert.equal(calls, 7);
  time += 60001; await kernel.decide(input()); assert.equal(calls, 8);
});

test('requests without a project scope cannot share caches', async () => {
  let calls = 0; const kernel = make(async () => { calls++; return response(); });
  await kernel.decide(input({ scope: {} })); await kernel.decide(input({ scope: {} })); assert.equal(calls, 2);
});

test('same in-flight judgment coalesces, while individual cancellation is isolated', async () => {
  let resolve, calls = 0; const pending = new Promise(r => { resolve = r; });
  const kernel = make(async () => { calls++; await pending; return response(); });
  const controller = new AbortController();
  const first = kernel.decide(input({ signal: controller.signal })); const second = kernel.decide(input());
  await new Promise(r => setImmediate(r)); controller.abort();
  const cancelled = await first; assert.equal(cancelled.reason, 'aborted'); assert.equal(cancelled.networkAttempted, true);
  resolve(); const continued = await second; assert.equal(continued.source, 'judge'); assert.equal(continued.coalesced, true); assert.equal(continued.networkAttempted, false); assert.equal(continued.usage.inputTokens, 71); assert.equal(calls, 1);
});

test('cancelled sole waiter does not cache a late reply', async () => {
  let resolve, calls = 0; const pending = new Promise(r => { resolve = r; });
  const kernel = make(async () => { calls++; if (calls === 1) await pending; return response(); });
  const controller = new AbortController(), first = kernel.decide(input({ signal: controller.signal }));
  await new Promise(r => setImmediate(r)); controller.abort(); assert.equal((await first).reason, 'aborted'); resolve();
  await new Promise(r => setImmediate(r)); await kernel.decide(input()); assert.equal(calls, 2);
});

test('network hang is bounded even if the fetch implementation ignores abort', async () => {
  const kernel = make(() => new Promise(() => {}), { timeoutMs: 50 });
  const started = Date.now(), result = await kernel.decide(input()); assert.equal(result.reason, 'timeout'); assert.ok(Date.now() - started < 1000); assert.equal(result.source, 'fallback'); assert.equal(result.networkAttempted, true);
});

test('a stalled credential resolver shares the deadline and supports caller cancellation', async () => {
  const kernel = make(() => { throw new Error('never fetch'); }, { apiKey: () => new Promise(() => {}), timeoutMs: 50 });
  const resolverTimeout = await kernel.decide(input()); assert.equal(resolverTimeout.reason, 'timeout'); assert.equal(resolverTimeout.networkAttempted, false);
  const controller = new AbortController(), pending = kernel.decide(input({ signal: controller.signal })); controller.abort();
  assert.equal((await pending).reason, 'aborted');
});

test('closing a kernel stops subscribers even when fetch ignores the signal', async () => {
  const kernel = make(() => new Promise(() => {}));
  const pending = kernel.decide(input()); await new Promise(r => setImmediate(r));
  kernel.close(); const result = await pending; assert.equal(result.reason, 'closed'); assert.equal(result.source, 'fallback');
});

test('unconfident satisfaction scores remain advisory and cannot change model reasoning', async () => {
  const plan = { version: 1, questions: { user_satisfaction: { type: 'score', instructions: 'Rate the explicit user feedback for this research report.', criteria: ['The user says the report does not meet the requested sourcing standard.', 'The user explicitly accepts the sourcing and report quality.'] } } };
  const kernel = make(async () => json({ answers: { user_satisfaction: { score: .1, confidence: .1 } } }));
  const result = await kernel.decide(input({ point: 'chat.preflight', assessmentPlan: plan, fallback: { reasoning: 'high', needsMemory: true } }));
  assert.equal(result.outcome.reasoning, 'high'); assert.equal(result.source, 'fallback'); assert.equal(result.reason, 'abstain'); assert.equal(result.answers.user_satisfaction.score, .1);
});

test('provider failures open a circuit and recover after cooldown', async () => {
  let calls = 0, time = 100;
  const kernel = make(async () => { calls++; return calls <= 2 ? new Response('error', { status: 503 }) : response(); }, { failureThreshold: 2, circuitCooldownMs: 1000, now: () => time });
  const first = await kernel.decide(input()); assert.equal(first.reason, 'server'); assert.equal(first.networkAttempted, true); assert.equal((await kernel.decide(input())).reason, 'server');
  const skipped = await kernel.decide(input()); assert.equal(skipped.reason, 'circuit_open'); assert.equal(skipped.networkAttempted, false); assert.equal(calls, 2);
  time = 1101; assert.equal((await kernel.decide(input())).source, 'judge'); assert.equal(calls, 3); assert.equal(kernel.stats().circuitOpen, false);
});

test('new credential resets an auth circuit without exposing either key', async () => {
  let key = 'old-key', calls = 0; const kernel = make(async () => { calls++; return calls === 1 ? new Response('', { status: 401 }) : response(); }, { apiKey: () => key });
  assert.equal((await kernel.decide(input())).reason, 'auth'); assert.equal((await kernel.decide(input())).reason, 'circuit_open');
  key = 'new-key'; assert.equal((await kernel.decide(input())).source, 'judge'); assert.equal(calls, 2);
});

test('redirects cannot forward credentials and oversized responses are rejected', async () => {
  const redirect = await make(async () => new Response('', { status: 302, headers: { location: 'https://other.example' } })).decide(input()); assert.equal(redirect.reason, 'redirect_rejected');
  const large = await make(async () => new Response('x'.repeat(128001))).decide(input()); assert.equal(large.reason, 'response_limit');
  for (const endpoint of ['http://remote.example/v1', 'https://user:password@example.test', 'https://example.test?key=123', 'javascript:alert(1)']) assert.throws(() => make(async () => response(), { endpoint }), /invalid_endpoint/);
});

const taskPlan = { version: 1, questions: { task_state: { type: 'choice', instructions: 'Which project state is supported by the latest supplied receipts?', criteria: { researching: 'The main-model plan has missing source checks and incomplete acceptance criteria.', delivered: 'All planned artifacts and source checks have explicit receipts.', unknown: 'There is insufficient evidence to match either state.' } } } };
const taskAnswer = overrides => ({ choice: 'researching', probabilities: { researching: .98, delivered: .01, unknown: .01 }, ...overrides });
test('main-model supplied task-state options are returned only by existing ID and cannot choose steps or reasoning', async () => {
  const kernel = make(async (_, init) => { const q = JSON.parse(init.body).questions; assert.deepEqual(q, taskPlan.questions); return json({ answers: { task_state: taskAnswer() } }); });
  const result = await kernel.decide(input({ point: 'chat.preflight', assessmentPlan: taskPlan, state: { userMessage: '还有哪些资料没查' }, fallback: { needsMemory: true } }));
  assert.equal(result.outcome.assessments.task_state.choice, 'researching');
  assert.deepEqual(Object.keys(result.outcome).sort(), ['assessments', 'planRevision']);
  for (const key of ['taskType', 'reasoning', 'needsPlan', 'nextStep']) assert.equal(result.outcome[key], undefined);
});

test('unknown, incomplete, contradictory and unconfident option scores abstain', async t => {
  for (const [name, answer, reason] of [
    ['escape', { choice: 'unknown', probabilities: { researching: 0, delivered: 0, unknown: 1 } }, 'abstain'],
    ['no probabilities', { choice: 'researching' }, 'abstain'],
    ['partial distribution', { choice: 'researching', probabilities: { researching: .99 } }, 'invalid_response'],
    ['not maximum', { choice: 'delivered', probabilities: { researching: .98, delivered: .01, unknown: .01 } }, 'invalid_response'],
    ['low confidence', taskAnswer({ confidence: .2 }), 'abstain'],
    ['new option', { choice: 'install_a_new_tool' }, 'invalid_response'],
  ]) await t.test(name, async () => {
    const result = await make(async () => json({ answers: { task_state: answer } })).decide(input({ point: 'chat.preflight', assessmentPlan: taskPlan }));
    assert.equal(result.source, 'fallback'); assert.equal(result.reason, reason);
  });
});

test('choice margin and ordinal score confidence cannot be bypassed', () => {
  const policy = deriveDecisionPolicy('chat.preflight');
  assert.equal(decisionVerdict({ type: 'choice', choice: 'a', probabilities: { a: .51, b: .49 } }, policy), undefined);
  assert.equal(decisionVerdict({ type: 'score', score: 2 }, policy), undefined);
  assert.equal(decisionVerdict({ type: 'score', score: 2, confidence: .99 }, policy), 2);
});

test('missing plan or missing applicable questions never fabricates a paid judgment question', async () => {
  let calls = 0, resolutions = 0;
  const kernel = make(async () => { calls++; return response(); }, { apiKey: () => { resolutions++; return 'synthetic-fixture'; } });
  for (const [extra, reason] of [[{ assessmentPlan: undefined }, 'assessment_plan_required'], [{ assessmentPlan: null }, 'assessment_plan_required'], [{ point: 'evolution.review' }, 'assessment_point_unconfigured']]) {
    const result = await kernel.decide(input(extra)); assert.equal(result.reason, reason); assert.deepEqual(result.outcome, { review: true }); assert.equal(result.networkAttempted, false);
  }
  assert.equal(calls, 0); assert.equal(resolutions, 0);
});

test('model-authored plans validate all text, question semantics, option bounds and unknown fields without silently dropping them', () => {
  assert.equal(DECISION_ASSESSMENT_PLAN_SCHEMA.additionalProperties, false);
  assert.deepEqual(validateToolArguments(DECISION_ASSESSMENT_PLAN_SCHEMA, assessmentPlan), assessmentPlan);
  assert.deepEqual(validateToolArguments(DECISION_ASSESSMENT_PLAN_SCHEMA, taskPlan), taskPlan);
  const valid = validateDecisionAssessmentPlan(assessmentPlan); assert.deepEqual(valid, assessmentPlan); assert.notEqual(valid.questions, assessmentPlan.questions);
  const invalids = [
    { ...assessmentPlan, revision: 'self-attested' }, { ...assessmentPlan, provenance: { source: 'main-model' } }, { version: 1, questions: {} },
    { version: 1, questions: { taskType: booleanQuestion() } }, { version: 2, questions: assessmentPlan.questions },
    { version: 1, questions: { initiative_need: { ...booleanQuestion(), criteria: { true: 'yes' } } } },
    { version: 1, questions: { initiative_need: { ...booleanQuestion(), extra: 'do something' } } },
    { version: 1, questions: { initiative_need: { ...booleanQuestion(), type: 'choice' } } },
    { version: 1, questions: { initiative_need: { ...booleanQuestion(), instructions: ' ' } } },
    { version: 1, questions: { initiative_need: { ...booleanQuestion(), instructions: 'x'.repeat(1201) } } },
    { version: 1, questions: { initiative_need: { ...booleanQuestion(), criteria: { true: 'x'.repeat(401), false: 'none' } } } },
    { version: 1, questions: { task_state: { ...taskPlan.questions.task_state, criteria: { a: 'A', b: 'B' } } } },
    { version: 1, questions: { task_state: { ...taskPlan.questions.task_state, criteria: { unknown: 'Unknown', invalidOptionName: 'Bad internal key' } } } },
    { version: 1, questions: { user_satisfaction: { type: 'score', instructions: 'Rate satisfaction', criteria: ['dissatisfied', 'neutral', 'satisfied'] } } },
    { version: 1, questions: { user_satisfaction: { type: 'score', instructions: 'Rate satisfaction', criteria: Array(2) } } },
  ];
  for (const value of invalids) assert.throws(() => validateDecisionAssessmentPlan(value), { code: 'invalid_assessment_plan' });
});

test('an invalid plan keeps the full host path and does not resolve credentials or call JEV', async () => {
  let calls = 0;
  const kernel = make(() => { throw Error('must not send'); }, { apiKey: () => { calls++; return 'unused-fixture'; } });
  const result = await kernel.decide(input({ assessmentPlan: { ...assessmentPlan, modelGenerated: true } }));
  assert.equal(result.reason, 'invalid_assessment_plan'); assert.equal(result.source, 'fallback'); assert.equal(result.networkAttempted, false); assert.equal(calls, 0);
});

test('plan hash is canonical, changes with model criteria, binds cache and never trusts caller revisions', async () => {
  const reversed = { questions: { initiative_need: { criteria: { false: assessmentPlan.questions.initiative_need.criteria.false, true: assessmentPlan.questions.initiative_need.criteria.true }, instructions: assessmentPlan.questions.initiative_need.instructions, type: 'boolean' } }, version: 1 };
  assert.equal(decisionAssessmentPlanHash(reversed), decisionAssessmentPlanHash(assessmentPlan));
  const changed = { version: 1, questions: { initiative_need: booleanQuestion('Does a new independent contradiction require a main-model examination?') } };
  assert.notEqual(decisionAssessmentPlanHash(changed), decisionAssessmentPlanHash(assessmentPlan));
  let calls = 0; const kernel = make(async () => { calls++; return response(); });
  await kernel.decide(input()); await kernel.decide(input({ assessmentPlan: reversed })); assert.equal(calls, 1);
  await kernel.decide(input({ assessmentPlan: changed })); assert.equal(calls, 2);
});

test('only bounded applicable main-model questions are sent at each assessment point', async () => {
  const plan = { version: 1, questions: { ...taskPlan.questions, initiative_need: booleanQuestion(), initiative_pause: booleanQuestion('Should current unsolicited notifications pause?'), schedule_need: booleanQuestion('Is a future planned occurrence missing from the supplied schedule?'), evolution_need: booleanQuestion('Is there a reusable lesson in the supplied evidence?'), memory_need: booleanQuestion('Would the specified project history inform this request?'), user_satisfaction: { type: 'score', instructions: 'Score explicit user feedback', criteria: ['User feedback rejects the delivered work', 'User feedback accepts the delivered work'] } } };
  const sent = [];
  const kernel = make(async (_, init) => { const questions = JSON.parse(init.body).questions; sent.push(Object.keys(questions)); return json({ answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === 'noul' ? { noul: .99 } : question.type === 'score' ? { score: .5 } : taskAnswer()])) }); });
  for (const point of ['initiative.review', 'evolution.review', 'chat.preflight']) await kernel.decide(input({ point, assessmentPlan: plan }));
  assert.deepEqual(sent, [['task_state', 'initiative_need', 'initiative_pause', 'schedule_need'], ['task_state', 'evolution_need', 'user_satisfaction'], ['task_state', 'user_satisfaction', 'memory_need']]);
});

test('legacy custom questions and map callbacks cannot supply or fabricate assessments', async () => {
  let invoked = false;
  const kernel = make(async () => response());
  const result = await kernel.decide(input({ questions: { arbitrary: { type: 'boolean', instructions: 'Decide an unconfigured action' } }, mapAnswers: () => { invoked = true; return { reasoning: 'high' }; } }));
  assert.equal(invoked, false); assert.equal(result.outcome.reasoning, undefined); assert.equal(result.outcome.assessments.arbitrary, undefined);
  const missing = await kernel.decide(input({ assessmentPlan: undefined, questions: { arbitrary: booleanQuestion() } })); assert.equal(missing.reason, 'assessment_plan_required');
  await assert.rejects(kernel.decide(input({ point: 'custom.rate' })), { code: 'invalid_point' });
});

test('main-model plan prose and provider-generated suggestions do not enter the scoring ledger', async () => {
  const records = [], secret = 'sensitive-plan-marker-fixture';
  const plan = { version: 1, questions: { initiative_need: booleanQuestion(`Main model private criteria ${secret}`) } };
  const kernel = make(async () => response(.99, { generatedSuggestion: 'install arbitrary new capability now' }), { ledger: row => records.push(row), knownSecrets: () => [secret] });
  const result = await kernel.decide(input({ assessmentPlan: plan }));
  assert.equal(result.planRevision, decisionAssessmentPlanHash(plan)); assert.equal(records[0].planRevision, result.planRevision);
  const log = JSON.stringify(records); assert.equal(log.includes(secret), false); assert.equal(log.includes('Main model private criteria'), false); assert.equal(log.includes('install arbitrary'), false);
});
