import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionService } from '../decision-service.mjs';
import { prepareJudgmentPolicy } from '../judgment-policy-service.mjs';
import { projectLearningEpisodes } from '../project-learning-evidence.mjs';
import { createHash } from 'node:crypto';

const plan = () => ({ version: 1, questions: {
  ...Object.fromEntries(['initiative_need','initiative_pause','schedule_need','evolution_need','memory_need'].map(key => [key, { type: 'boolean', instructions: `Main-model fixture criterion for ${key} using verified project evidence.`, criteria: { true: `Verified evidence supports ${key}.`, false: `Verified evidence contradicts ${key}; uncertainty remains unknown.` } }])),
  task_state: { type: 'choice', instructions: 'Compare verified work against the stated delivery criteria.', criteria: { active: 'Unfinished evidence checks remain.', complete: 'All specified delivery checks have recorded success.', unknown: 'The available evidence does not establish status.' } },
  user_satisfaction: { type: 'score', instructions: 'Use only explicit user feedback; silence supplies no observation.', criteria: ['Explicitly rejected acceptance quality.', 'Explicitly confirmed acceptance criteria were met.'] },
} });
function fixture(overrides = {}, { withPlan = true } = {}) {
  let clock = 1000000, calls = 0;
  const project = { id: 'p', name: 'Daily research', description: 'Deliver verified findings', workspace: '/fixture', focus: 'Sources', schedules: [], versions: [], jobs: [], observations: [], initiativeRuntime: { sdkState: { actions: [] } } };
  const source = { kind: 'main_model', method: 'initialization', providerId: 'fixture', modelId: 'main', receiptId: 'completed-model-fixture', createdAt: new Date(clock).toISOString() };
  if (withPlan) project.judgmentPolicy = prepareJudgmentPolicy(plan(), { project, source });
  const store = { state: { settings: { realTokenBudget: null }, configuration: { decisionKernel: { mode: 'active', modes: { 'initiative.review': 'active', 'evolution.review': 'active', 'chat.preflight': 'active' } } }, projects: [project], sessions: [{ id: 's', projectId: 'p', items: [], turns: [], status: 'idle' }] }, configurationService: { secrets: { 'judge:jev': 'TEST-ONLY-SECRET' }, writeSecret(id, input) { if (input.apiKey !== undefined) this.secrets[id] = input.apiKey; } }, mutate(fn) { return fn(this.state); } };
  const requests = [], answers = { initiative_need: { type: 'boolean', probability: .01 }, initiative_pause: { type: 'boolean', probability: .99 }, schedule_need: { type: 'boolean', probability: .01 }, evolution_need: { type: 'boolean', probability: .01 }, memory_need: { type: 'boolean', probability: .01 }, user_satisfaction: { type: 'score', score: .8, confidence: .99 }, task_state: { type: 'choice', choice: 'active', probabilities: { active: .99, complete: .005, unknown: .005 } }, ...overrides };
  const service = new DecisionService(store, { now: () => clock, kernelFactory: options => ({ close() {}, async decide(input) { calls++; requests.push(input); const mode = options.modes[input.point] ?? options.mode, measured = structuredClone(answers), planRevision = input.hostPolicy.revision; return { point: input.point, source: mode === 'active' ? 'judge' : 'fallback', networkAttempted: true, mode, planRevision, outcome: { planRevision, assessments: measured }, ledgerId: `j${calls}`, reason: mode === 'active' ? 'accepted' : 'shadow', policy: { confidence: .9, yes: .8, no: .05, margin: .1 }, answers: measured, usage: { inputTokens: 200, outputTokens: 20 }, latencyMs: 12 }; } }) });
  return { service, store, project, requests, answers, source, calls: () => calls, advance(ms) { clock += ms; } };
}
test('off/unconfigured judges leave existing review path untouched', async () => {
  const f = fixture(); f.store.state.configuration.decisionKernel.mode = 'off';
  assert.deepEqual(await f.service.review('initiative.review', f.project), { review: true });
  f.store.state.configuration.decisionKernel.mode = 'active'; f.store.configurationService.secrets = {}; const old = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  try { assert.deepEqual(await f.service.chat(f.project, { userMessage: 'hello' }), { needsMemory: true }); assert.equal(f.calls(), 0); }
  finally { if (old !== undefined) process.env.TYPESAFE_API_KEY = old; }
});
test('negative verdict defers without consuming evidence; bounded full review prevents starvation', async () => {
  const f = fixture(), evidence = [{ id: 'e', summary: 'unchanged' }];
  assert.equal((await f.service.review('initiative.review', f.project, { evidence })).review, false);
  assert.equal((await f.service.review('initiative.review', f.project, { evidence })).review, false); assert.equal(f.calls(), 1);
  f.advance(60001); assert.equal((await f.service.review('initiative.review', f.project, { evidence })).review, false); assert.equal(f.calls(), 2);
  f.advance(60001); const forced = await f.service.review('initiative.review', f.project, { evidence });
  assert.equal(forced.review, true); assert.equal(forced.forced, true); assert.deepEqual(forced.deferredLedgerIds, ['j1', 'j2'], 'the deferrals it overrides are handed back for labeling');
  assert.equal(f.calls(), 2); assert.equal(f.project.learningRuntime, undefined);
  // The main model's decision after a forced review labels the deferrals it followed: a real action means they were missed.
  assert.equal(f.service.labelWake(forced, { action: 'share' }), 2);
  assert.deepEqual(f.store.decisionLedger.rows().filter(row => ['j1', 'j2'].includes(row.id)).map(row => row.label.value), ['defer_missed', 'defer_missed']);
});
test('initiative.gate: a confident "nothing to do" from the host gate defers a review the plan is unsure about; the decision that follows labels it', async () => {
  const unsure = { initiative_need: { type: 'boolean', probability: .5 }, initiative_pause: { type: 'boolean', probability: .5 } };
  const idle = { ...unsure, needs_main_model: { type: 'boolean', probability: .05 }, evidence_relevant: { type: 'boolean', probability: .1 }, already_reported: { type: 'boolean', probability: .9 }, likely_action: { type: 'choice', choice: 'wait', probabilities: { wait: .96, work: .01, share: .01, ask: .01, schedule: .005, unknown: .005 }, confidence: .96 } };
  const f = fixture(idle); f.store.state.configuration.decisionKernel.modes['initiative.gate'] = 'active';
  const evidence = [{ id: 'e', summary: 'a nightly log line' }];
  // Before: an unsure plan meant a full review whatever the gate said. Now the gate's confident idle defers it.
  const first = await f.service.review('initiative.review', f.project, { evidence, freshCount: 1 });
  assert.equal(first.review, false); assert.equal(first.reason, 'judged_idle'); assert.equal(first.likelyAction, 'wait'); assert.equal(f.calls(), 1);
  const row = f.store.decisionLedger.rows().at(-1);
  assert.equal(row.disposition, 'deferred'); assert.equal(row.savings.mainModelCalls, 1); assert.equal(row.predictions.needs_main_model, .05);
  assert.equal(f.store.state.decisionKernelRuntime.metrics.deferredReviews, 1);
  // The gate's confident "wake" still overrides the same unsure plan.
  Object.assign(f.answers, { needs_main_model: { type: 'boolean', probability: .95 } });
  f.advance(60001);
  const second = await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e2', summary: 'deploy failed' }], freshCount: 1 });
  assert.equal(second.review, true); assert.equal(second.result.ledgerId, 'j2'); assert.deepEqual(second.deferredLedgerIds, [], 'different evidence: the earlier deferral is not this wake\'s');
  // What the main model then does labels the wake judgment for calibration.
  assert.equal(f.service.labelWake(second, { action: 'wait' }), 1);
  assert.equal(f.store.decisionLedger.rows().find(item => item.id === 'j2').label.value, 'wake_unneeded');
  assert.equal(f.service.labelWake(second, { action: 'work' }), 1);
  assert.equal(f.store.decisionLedger.rows().find(item => item.id === 'j2').label.value, 'wake_needed_work');
  assert.equal(f.service.labelWake(second, { action: 'nonsense' }), 0); assert.equal(f.service.labelWake(null, { action: 'work' }), 0);
});
test('rules before the judge: nothing new and nothing the assistant can advance defers with no judge call; an overdue request forces the review', async () => {
  const f = fixture(); f.store.state.configuration.decisionKernel.modes['initiative.gate'] = 'active';
  const at = new Date(1000000).toISOString();
  f.project.mind = { agenda: [{ id: 'q1', kind: 'awaiting_user', status: 'open', text: '推送渠道是什么？', createdAt: at }, { id: 'q2', kind: 'awaiting_user', status: 'open', text: '时区按哪个？', createdAt: at }], commitments: [], threads: [], lessons: [] };
  const first = await f.service.review('initiative.review', f.project, { evidence: [], freshCount: 0 });
  assert.equal(first.review, false); assert.equal(first.reason, 'nothing_actionable'); assert.equal(f.calls(), 0, 'no judge call for a wake that could only end in wait');
  const row = f.store.decisionLedger.rows().at(-1);
  assert.equal(row.source, 'rule'); assert.equal(row.disposition, 'deferred'); assert.equal(row.applied, true); assert.equal(row.savings.mainModelCalls, 1); assert.equal(row.id, first.ledgerId);
  // The bound still holds: the same identity is deferred at most twice, then the main model reviews.
  f.advance(60001); assert.equal((await f.service.review('initiative.review', f.project, { evidence: [], freshCount: 0 })).review, false);
  f.advance(60001); const forced = await f.service.review('initiative.review', f.project, { evidence: [], freshCount: 0 });
  assert.equal(forced.review, true); assert.equal(forced.forced, true); assert.equal(forced.deferredLedgerIds.length, 2); assert.equal(f.calls(), 0);
  // An open agenda item the assistant can advance itself is not "nothing actionable": the judge is asked.
  f.project.mind.agenda.push({ id: 't1', kind: 'todo', status: 'open', text: '整理来源清单', createdAt: at });
  f.advance(60001); await f.service.review('initiative.review', f.project, { evidence: [], freshCount: 0 }); assert.equal(f.calls(), 1);
  assert.equal(f.requests.at(-1).state.review.openWork.openAgenda, 'few'); assert.equal(f.requests.at(-1).state.review.openWork.waitingOnUser, 'few'); assert.equal(f.requests.at(-1).state.review.newSinceLastDecision, 'none');
  // An overdue request from the user always reaches the main model, before any judge call.
  f.project.mind.commitments.push({ id: 'c1', status: 'pending', request: '把日报改成周报', createdAt: at, overdueAt: new Date(1000000 + 1000).toISOString() });
  f.advance(60001); const overdue = await f.service.review('initiative.review', f.project, { evidence: [], freshCount: 0 });
  assert.deepEqual(overdue, { review: true, reason: 'commitment_overdue' }); assert.equal(f.calls(), 1);
  assert.equal(f.store.decisionLedger.rows().at(-1).reason, 'bypass_commitment_overdue', 'one rule row for the bypass');
});
test('new evidence and configuration changes invalidate waiting judgments immediately', async () => {
  const f = fixture(); await f.service.review('evolution.review', f.project, { evidence: [{ id: 'a' }] });
  await f.service.review('evolution.review', f.project, { evidence: [{ id: 'b' }] }); assert.equal(f.calls(), 2);
  f.service.update({ mode: 'shadow' }); assert.equal(f.service.deferrals.size, 0);
});
test('a fixed learning revision cannot hide new user input or changed project focus', async () => {
  const f = fixture(), options = { revision: 'stable-learning-scope', evidence: [{ id: 'a' }] };
  await f.service.review('evolution.review', f.project, options);
  await f.service.review('evolution.review', f.project, options); assert.equal(f.calls(), 1);
  f.store.state.sessions[0].items.push({ id: 'new-request', kind: 'user', text: 'Review the new acceptance requirement now' });
  await f.service.review('evolution.review', f.project, options); assert.equal(f.calls(), 2);
  f.project.focus = 'Changed acceptance requirement';
  await f.service.review('evolution.review', f.project, options); assert.equal(f.calls(), 3);
});
test('explicit review bypasses judge and future daily duty supplies recurring signal', async () => {
  const f = fixture(); f.project.schedules = [{ id: 'daily', title: 'Daily research', task: 'Deliver verified findings', enabled: true, nextRunAt: new Date(2000000).toISOString() }];
  f.project.judgmentPolicy = prepareJudgmentPolicy(plan(), { project: f.project, source: { ...f.source, receiptId: 'scheduled-duty-model-fixture' } });
  assert.equal((await f.service.review('evolution.review', f.project, { force: true })).review, true); assert.equal(f.calls(), 0);
  await f.service.review('initiative.review', f.project);
  assert.equal(f.requests[0].signals.recurring, true); assert.equal(f.requests[0].signals.dueSchedule, false);
});
test('due schedules, open interactions, failures and work waiting to be checked bypass JEV before any paid admission, one rule row each', async () => {
  for (const [kind, signal] of [['due', 'due_schedule'], ['question', 'unanswered_question'], ['failure', 'severe_failure'], ['needs_review', 'pending_review']]) {
    const f = fixture();
    if (kind === 'due') { f.project.schedules = [{ id: 'due', title: 'Due research', task: 'Deliver verified findings', enabled: true, nextRunAt: new Date(1000).toISOString() }]; f.project.judgmentPolicy = prepareJudgmentPolicy(plan(), { project: f.project, source: { ...f.source, receiptId: 'due-duty-model-fixture' } }); }
    if (kind === 'question') f.store.state.sessions[0].items.push({ interaction: { status: 'pending', canRespond: true } });
    if (kind === 'needs_review') f.project.initiativeRuntime.sdkState.actions.push({ action: 'work', status: 'needs_review' });
    assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: kind === 'failure' ? [{ id: 'f', type: 'tool_failure' }] : [] }), { review: true, reason: 'main_review_required', bypass: signal });
    assert.equal(f.calls(), 0); assert.equal(f.store.state.realUsage, undefined);
    const rows = f.store.decisionLedger.rows();
    assert.equal(rows.length, 1, kind); assert.deepEqual([rows[0].source, rows[0].reason, rows[0].disposition, rows[0].networkAttempted], ['rule', `bypass_${signal}`, 'main_review', false], kind);
  }
});
// L2: a bypass signal can last for hours (a result waiting to be checked, an overdue request). Asking about the same
// situation again (a pump while the coordinator still waits) writes no second row; a review the main model actually made
// moves the review clock, and the next bypass of the same signal gets its own row.
test('a persistent bypass writes one rule row per situation, not one per ask', async () => {
  for (const [signal, setup] of [['pending_review', f => f.project.initiativeRuntime.sdkState.actions.push({ action: 'work', status: 'needs_review' })], ['commitment_overdue', f => { f.project.mind = { commitments: [{ id: 'c1', text: 'Send the outline', status: 'pending', overdueAt: new Date(999000).toISOString() }] }; f.store.state.configuration.decisionKernel.modes['initiative.gate'] = 'active'; }]]) {
    const f = fixture(); setup(f);
    const rows = () => f.store.decisionLedger.rows().filter(row => row.reason === `bypass_${signal}`) ?? [];
    for (let n = 0; n < 50; n++) assert.equal((await f.service.review('initiative.review', f.project, { evidence: [], revision: 'scope:7' })).review, true, signal);
    assert.equal(rows().length, 1, `${signal}: one row for one situation`); assert.equal(f.calls(), 0);
    // The main model reviewed it (the coordinator's clock moved): the next bypass is a new review with its own row.
    f.project.initiativeRuntime.sdkState.lastDecision = { at: 1000500, action: 'wait' }; f.project.initiativeRuntime.sdkState.nextReviewAt = 1900000;
    await f.service.review('initiative.review', f.project, { evidence: [], revision: 'scope:7' }); await f.service.review('initiative.review', f.project, { evidence: [], revision: 'scope:7' });
    assert.equal(rows().length, 2, `${signal}: the next review's row`);
    // New evidence is a new situation too.
    await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e9', summary: 'new' }], revision: 'scope:8' });
    assert.equal(rows().length, 3, signal);
  }
});
test('PDL-2: queued or running work and a running turn reach the judge (one call) instead of bypassing it', async () => {
  for (const kind of ['queued', 'running', 'turn']) {
    const f = fixture();
    if (kind === 'turn') f.store.state.sessions[0].status = 'running';
    else f.project.initiativeRuntime.sdkState.actions.push({ action: 'work', status: kind });
    const result = await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e', summary: 'a log line' }] });
    assert.equal(f.calls(), 1, kind); assert.equal(result.bypass, undefined, kind);
    assert.equal(f.requests[0].signals.hasPendingWork, true, 'kernel policy keeps the combined signal');
    assert.equal(f.store.decisionLedger.rows().filter(row => row.source === 'rule').length, 0);
  }
});
test('PDL-2: a background delivery that just completed is judged during a foreground turn and bypasses outside one', async () => {
  const completedAction = f => { f.project.initiativeRuntime.sdkState.actions.push({ id: 'w', action: 'work', status: 'completed' }); return [{ id: 'action:w:completed', type: 'action_completed', summary: 'work completed. Checked the sources.', at: 2000000 }]; };
  const outside = fixture(), evidence = completedAction(outside);
  assert.deepEqual(await outside.service.review('initiative.review', outside.project, { evidence }), { review: true, reason: 'main_review_required', bypass: 'delivery_just_completed' }); assert.equal(outside.calls(), 0);
  const inside = fixture(), during = completedAction(inside);
  await inside.service.review('initiative.review', inside.project, { evidence: during, progress: { key: 'k', foreground: { turnIds: ['t'], sessionIds: ['s'], request: 'Write chapter 4' }, work: [] } });
  assert.equal(inside.calls(), 1, 'judged, not bypassed');
});
test('chat memory uses only the main-model memory option, preserves pending work and never predicts task type', async () => {
  const f = fixture(); const first = await f.service.chat(f.project, { sessionId: 's', userMessage: 'Hello' });
  assert.equal(first.needsMemory, false); assert.equal(first.assessment.planRevision, f.project.judgmentPolicy.revision);
  assert.equal(first.taskType, undefined); assert.equal(first.needsPlan, undefined); assert.equal(first.reasoning, undefined);
  f.project.initiativeRuntime.sdkState.actions.push({ action: 'work', status: 'queued' });
  assert.equal((await f.service.chat(f.project, { sessionId: 's', userMessage: 'Continue' })).needsMemory, true);
  await f.service.drain();
  const g = fixture({ memory_need: { type: 'boolean', probability: .5 } }); assert.equal((await g.service.chat(g.project, { sessionId: 's', userMessage: 'Continue' })).needsMemory, true);
});
test('observability retains parameters and usage but no prompts or credential', async () => {
  const f = fixture(); await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e', summary: 'PRIVATE-PROMPT' }] });
  const response = f.service.public(), raw = JSON.stringify(response);
  assert.equal(raw.includes('TEST-ONLY-SECRET'), false); assert.equal(raw.includes('PRIVATE-PROMPT'), false);
  assert.equal(response.metrics.totalTokens, 220); assert.equal(response.recent[0].policy.confidence, .9);
});
test('ledger excludes removed sessions and projects', async () => {
  const f = fixture(); await f.service.chat(f.project, { sessionId: 's', userMessage: 'hello' });
  assert.equal(f.service.ledger().length, 1); f.store.state.sessions = []; assert.equal(f.service.ledger().length, 0);
  await f.service.review('initiative.review', f.project); f.project.archivedAt = 'now'; assert.equal(f.service.ledger().length, 0);
});
test('configuration validates before credential writes and never permits redirecting the key', () => {
  const f = fixture();
  for (const input of [{ endpoint: 'https://example.test', apiKey: 'new' }, { apiKey: 'key\nline' }, { modes: { permission: 'active' } }, { mode: 'yes' }]) assert.throws(() => f.service.update(input), /配置无效/);
  assert.equal(f.store.configurationService.secrets['judge:jev'], 'TEST-ONLY-SECRET');
  f.service.update({ apiKey: '', mode: 'off' }); assert.equal(f.service.public().apiKeyConfigured, false);
});
test('abort wins over late judge result and does not record or suppress work', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.review('evolution.review', f.project, { signal: controller.signal }));
  assert.equal(f.service.deferrals.size, 0); assert.equal(f.service.ledger().length, 0);
});

test('JEV uses real budget accounting and does not dispatch when cap cannot admit it', async () => {
  const f = fixture(); await f.service.review('initiative.review', f.project);
  assert.equal(f.store.state.realUsage.reportedTokens, 220); assert.equal(f.store.state.realUsage.reservedTokens, 0);
  const g = fixture(); g.store.state.settings.realTokenBudget = 10;
  assert.equal((await g.service.review('initiative.review', g.project)).review, true); assert.equal(g.calls(), 0);
});
test('cancellation after dispatch remains observable and billed without consuming the verdict', async () => {
  const f = fixture(), controller = new AbortController(), original = f.service.kernelFactory;
  f.service.kernelFactory = options => { const kernel = original(options); return { ...kernel, async decide(input) { const result = await kernel.decide(input); controller.abort(); return result; } }; };
  await assert.rejects(f.service.review('evolution.review', f.project, { signal: controller.signal }));
  assert.equal(f.service.deferrals.size, 0); assert.equal(f.service.public().metrics.requests, 1);
  assert.equal(f.service.ledger()[0].disposition, 'cancelled');
  assert.equal(f.store.state.realUsage.reportedTokens, 220); assert.equal(f.store.state.realUsage.reservedTokens, 0);
});

test('missing or invalidated main-model policies cause zero JEV calls and leave memory/review paths intact', async () => {
  const missing = fixture({}, { withPlan: false });
  assert.deepEqual(await missing.service.review('initiative.review', missing.project), { review: true, reason: 'assessment_plan_required' });
  assert.deepEqual(await missing.service.chat(missing.project, { sessionId: 's', userMessage: 'Continue' }), { needsMemory: true, source: 'fallback', reason: 'assessment_plan_required' });
  assert.equal(missing.calls(), 0); assert.equal(missing.store.state.realUsage, undefined); assert.equal(missing.service.public().planReadyCount, 0);
  const changed = fixture(); changed.project.description = 'A different project responsibility';
  assert.equal((await changed.service.review('evolution.review', changed.project)).reason, 'assessment_plan_required'); assert.equal(changed.calls(), 0); assert.equal(changed.service.public().plans.length, 0);
});

test('initiative deferral requires low need, strong pause and no unregistered schedule need simultaneously', async () => {
  for (const overrides of [{ initiative_need: { type: 'boolean', probability: .9 } }, { initiative_pause: { type: 'boolean', probability: .01 } }, { initiative_pause: { type: 'boolean', probability: .5 } }, { initiative_pause: { type: 'boolean', probability: .99, confidence: .1 } }, { schedule_need: { type: 'boolean', probability: .99 } }]) {
    const f = fixture(overrides); assert.equal((await f.service.review('initiative.review', f.project)).review, true); assert.equal(f.service.deferrals.size, 0);
  }
  const partial = fixture(); delete partial.answers.initiative_pause;
  assert.equal((await partial.service.review('initiative.review', partial.project)).review, true);
  const f = fixture(); assert.equal((await f.service.review('initiative.review', f.project)).review, false);
});

test('observation-only scores are retained but cannot suppress main review or memory', async () => {
  const f = fixture(); f.service.update({ mode: 'shadow', modes: { 'initiative.review': 'shadow', 'evolution.review': 'shadow', 'chat.preflight': 'shadow' } });
  for (const point of ['initiative.review', 'evolution.review']) assert.equal((await f.service.review(point, f.project)).review, true);
  assert.equal((await f.service.chat(f.project, { sessionId: 's', userMessage: 'Continue' })).needsMemory, true);
  assert.equal(f.calls(), 3); assert.equal(f.service.deferrals.size, 0); assert.ok(f.service.ledger().every(row => row.mode === 'shadow' && row.reason === 'shadow')); assert.equal(f.store.state.realUsage.reportedTokens, 660);
});

test('in-flight policy replacement or evidence change invalidates stale deferral without relabeling its source', async () => {
  for (const kind of ['plan', 'evidence']) {
    const f = fixture(), previous = f.project.judgmentPolicy, original = f.service.kernelFactory;
    f.service.kernelFactory = options => { const kernel = original(options); return { ...kernel, async decide(input) { const result = await kernel.decide(input); if (kind === 'plan') { const updated = plan(); updated.questions.initiative_pause.instructions += ' Apply the newly confirmed deadline.'; f.project.judgmentPolicy = prepareJudgmentPolicy(updated, { project: f.project, source: { ...f.source, receiptId: 'later-main-model' } }); } else f.project.focus = 'New acceptance requirement'; return result; } }; };
    assert.deepEqual(await f.service.review('initiative.review', f.project), { review: true, stale: true }); assert.equal(f.service.deferrals.size, 0);
    const receipt = f.service.ledger()[0]; assert.equal(receipt.disposition, 'stale'); assert.equal(receipt.planRevision, previous.revision); assert.equal(receipt.planSource.receiptId, previous.source.receiptId);
  }
});

test('chat policy replacement during a score cannot suppress memory recall', async () => {
  const f = fixture(), original = f.service.kernelFactory;
  f.service.kernelFactory = options => { const kernel = original(options); return { ...kernel, async decide(input) { const result = await kernel.decide(input); f.project.description = 'Changed task context'; return result; } }; };
  const result = await f.service.chat(f.project, { sessionId: 's', userMessage: 'Continue' }); assert.equal(result.needsMemory, true); assert.equal(result.source, 'fallback'); assert.equal(result.assessment, undefined); assert.equal(f.service.ledger()[0].disposition, 'stale');
});

test('explicit dissatisfaction can request reflection but cannot adopt a version or change project permissions and schedules', async () => {
  for (const score of [.01, .99]) {
    const f = fixture({ user_satisfaction: { type: 'score', score, confidence: .99 }, task_state: { type: 'choice', choice: 'complete', probabilities: { active: .005, complete: .99, unknown: .005 } } });
    f.project.versions = [{ id: 'candidate', status: 'ready' }]; f.project.activeVersionId = 'baseline'; f.project.permissions = { workspace: 'read' };
    const before = structuredClone(f.project); const result = await f.service.review('evolution.review', f.project);
    assert.equal(result.review, score < .25); assert.deepEqual(f.project, before); assert.equal(f.project.learningRuntime, undefined); assert.equal(f.project.activeVersionId, 'baseline');
  }
});

test('a deadline crossing or new pending work during scoring overrides an otherwise negative result', async () => {
  // PDL-2: queued work and a running foreground turn no longer force the review (the gate judges them); a needs_review action does.
  for (const change of ['clock_crossing', 'due_created', 'question', 'needs_review']) {
    const f = fixture(), original = f.service.kernelFactory; let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    if (change === 'clock_crossing') { f.project.schedules = [{ id: 'future', title: 'Upcoming research', task: 'Deliver verified findings', enabled: true, nextRunAt: new Date(1000001).toISOString() }]; f.project.judgmentPolicy = prepareJudgmentPolicy(plan(), { project: f.project, source: { ...f.source, receiptId: 'future-duty-model-fixture' } }); }
    f.service.kernelFactory = options => { const kernel = original(options); return { ...kernel, async decide(input) { const result = await kernel.decide(input); entered(); await gate; return result; } }; };
    const pending = f.service.review('initiative.review', f.project); await Promise.race([started, pending.then(() => { throw new Error('Scoring fixture was not admitted before the boundary change'); })]);
    assert.equal(f.requests[0].signals.hasPendingWork, false); assert.equal(f.requests[0].signals.dueSchedule, false); assert.equal(f.requests[0].signals.unansweredQuestion, false);
    if (change === 'clock_crossing') f.advance(2);
    if (change === 'due_created') f.project.schedules.push({ id: 'new-due', enabled: true, nextRunAt: new Date(900000).toISOString() });
    if (change === 'question') f.store.state.sessions[0].items.push({ id: 'new-question', kind: 'question', interaction: { status: 'pending', canRespond: true } });
    if (change === 'needs_review') f.project.initiativeRuntime.sdkState.actions.push({ id: 'new-work', action: 'work', status: 'needs_review' });
    release(); const result = await pending;
    assert.equal(result.review, true, change); assert.equal(f.service.deferrals.size, 0); assert.equal(f.calls(), 1); assert.equal(f.store.state.realUsage.reportedTokens, 220); assert.equal(f.store.state.realUsage.reservedTokens, 0);
    const receipt = f.service.ledger()[0];
    // A new needs_review action changes the rhythm evidence key too: the result is stale and the review goes ahead.
    if (['due_created', 'needs_review'].includes(change)) { assert.equal(result.stale, true); assert.equal(receipt.disposition, 'stale'); }
    else { assert.equal(result.forced, true); assert.equal(result.reason, 'main_review_required'); assert.equal(receipt.disposition, 'main_review'); }
    assert.equal(receipt.planRevision, f.project.judgmentPolicy.revision);
  }
});

const realEvidenceTurn = (id, completedAt) => ({ id, status: 'completed', createdAt: completedAt, completedAt, modelConfig: { execution: 'rna' } });
const completedEvidenceItems = (id, marker) => [
  { id: `${id}-u`, turnId: id, kind: 'user', text: `${marker} user request`, createdAt: '2026-09-27T01:00:00Z' },
  { id: `${id}-a`, turnId: id, kind: 'assistant', text: `${marker} assistant claims everything is complete` },
  { id: `${id}-e`, turnId: id, kind: 'tool', tool: { name: 'project_exec', status: 'succeeded', output: `${marker} verified 2 checks, 1 boundary remains` } },
];

test('JEV projects the actual SDK lastDecision as an assessment, never as verified work or permission', () => {
  const f = fixture();
  f.project.initiativeRuntime.lastDecisionSourceIds = ['session:s'];
  Object.assign(f.project.initiativeRuntime.sdkState, { events: [{ id: 'e', type: 'user_message' }], lastDecision: { action: 'wait', reason: 'User prefers a daily report; stay quiet between deliveries.', evidenceIds: ['e'] } });
  const projected = f.service.projection(f.project, { sessionId: 's' }).state;
  const decision = JSON.parse(projected.recentSummaries[0]);
  assert.equal(decision.source, 'initiative_assessment'); assert.equal(decision.action, 'wait');
  assert.match(decision.reason, /daily report/); assert.match(decision.interpretation, /not an execution result.*permission grant/);
  assert.equal(projected.task.completed, false); assert.equal(projected.pending.delivery, false);
  f.project.initiativeRuntime.sdkState.decisions = [{ action: 'share', reason: 'WRONG_LEGACY_ARRAY' }];
  assert.doesNotMatch(JSON.stringify(f.service.projection(f.project)), /WRONG_LEGACY_ARRAY/);
});

test('lastDecision cannot reintroduce revoked, removed or foreign-session evidence', () => {
  for (const change of ['decision_revoked', 'event_revoked', 'event_missing', 'session_removed', 'session_archived', 'foreign_scope']) {
    const f = fixture(); f.project.initiativeRuntime.lastDecisionSourceIds = ['session:s'];
    Object.assign(f.project.initiativeRuntime.sdkState, { events: [{ id: 'e' }], lastDecision: { action: 'wait', reason: 'PRIVATE_PRIOR_REASON', evidenceIds: ['e'] } });
    if (change === 'decision_revoked') f.project.initiativeRuntime.sdkState.lastDecision.contextRevoked = true;
    if (change === 'event_revoked') f.project.initiativeRuntime.sdkState.events[0].sourceDeleted = true;
    if (change === 'event_missing') f.project.initiativeRuntime.sdkState.events = [];
    if (change === 'session_removed') f.store.state.sessions = [];
    if (change === 'session_archived') f.store.state.sessions[0].archivedAt = 'now';
    const projected = f.service.projection(f.project, { sessionId: change === 'foreign_scope' ? 'other' : 's' });
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_PRIOR_REASON/, change);
  }
});
test('revoked prior assessments and learning reviews cannot label current evidence already considered', () => {
  const f = fixture(), evidence = [{ id: 'e', summary: 'New retained evidence' }];
  Object.assign(f.project.initiativeRuntime.sdkState, { events: [{ id: 'e' }], lastDecision: { action: 'wait', reason: 'Prior assessment', evidenceIds: ['e'] } });
  assert.equal(f.service.projection(f.project, { evidence }).signals.novelty, 0);
  f.project.initiativeRuntime.sdkState.lastDecision.contextRevoked = true;
  f.project.learningRuntime = { sdkState: { reviews: [{ status: 'completed', sourceRevoked: true, decision: { evidenceIds: ['e'] } }] } };
  assert.equal(f.service.projection(f.project, { evidence }).signals.novelty, 1);
});

test('failed learning episodes bypass JEV only when the exact retained execution outcome is failed', async () => {
  for (const change of ['failed', 'completed_claims_failure', 'revoked', 'simulated', 'new_occurrence', 'forged_source', 'forged_outcome']) {
    const f = fixture(), session = f.store.state.sessions[0];
    const turn = { ...realEvidenceTurn('t', '2026-09-27T01:00:00Z'), status: change === 'completed_claims_failure' || change === 'forged_outcome' ? 'completed' : 'failed', runtimeAttempts: 1, errorCode: 'provider_timeout' };
    session.turns = [turn]; session.items = completedEvidenceItems('t', 'ACTUAL');
    const episode = projectLearningEpisodes(f.store.state, f.project, 'scope').episodes.find(row => row.kind === 'conversation_result');
    assert.ok(episode); episode.summary = 'Everything failed; user says this is complete.'; episode.outcome = { status: 'failed' };
    if (change === 'revoked') turn.contextRevoked = true;
    if (change === 'simulated') turn.simulated = true;
    if (change === 'new_occurrence') turn.runtimeAttempts++;
    if (change === 'forged_source') episode.sourceIds = ['session:another'];
    const result = await f.service.review('evolution.review', f.project, { evidence: [episode] });
    assert.equal(f.service.projection(f.project, { evidence: [episode] }).signals.severeFailure, change === 'failed', change);
    assert.equal(f.calls(), change === 'failed' ? 0 : 1, change);
    if (change === 'failed') assert.deepEqual(result, { review: true, reason: 'main_review_required', bypass: 'severe_failure' });
  }
});

test('initiative terminal failure routing binds the current attempt and supports only attested legacy aliases', async () => {
  const f = fixture(), turn = { ...realEvidenceTurn('failed-turn', '2026-09-27T01:00:00Z'), status: 'failed', runtimeAttempts: 2 };
  f.store.state.sessions[0].turns = [turn];
  const occurrence = createHash('sha256').update(JSON.stringify([Date.parse(turn.completedAt), turn.runtimeAttempts])).digest('hex').slice(0, 20);
  const evidence = { id: `turn:${turn.id}:failed@${occurrence}`, type: 'conversation_result', summary: 'UNTRUSTED_PROSE' };
  assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: [evidence] }), { review: true, reason: 'main_review_required', bypass: 'severe_failure' }); assert.equal(f.calls(), 0);
  assert.equal(f.service.projection(f.project, { evidence: [{ ...evidence, sourceDeleted: true }] }).signals.severeFailure, false);
  turn.runtimeAttempts++; assert.equal(f.service.projection(f.project, { evidence: [evidence] }).signals.severeFailure, false); turn.runtimeAttempts--;
  const legacy = { ...evidence, id: `turn:${turn.id}:failed` };
  assert.equal(f.service.projection(f.project, { evidence: [legacy] }).signals.severeFailure, false);
  f.project.initiativeRuntime.terminalSourceIdentity = { legacy: [{ id: legacy.id, occurrence }] };
  assert.equal(f.service.projection(f.project, { evidence: [legacy] }).signals.severeFailure, true);
});

test('scoped foreground evidence excludes other sessions, projects, simulated turns and revoked receipts', () => {
  const f = fixture(), session = f.store.state.sessions[0];
  session.turns = [realEvidenceTurn('allowed', '2026-09-27T01:00:00Z'), { ...realEvidenceTurn('simulated', '2026-09-27T03:00:00Z'), simulated: true }, { ...realEvidenceTurn('revoked', '2026-09-27T04:00:00Z'), contextRevoked: true }, { ...realEvidenceTurn('nonreal', '2026-09-27T05:00:00Z'), modelConfig: { execution: 'simulation' } }];
  session.items = [...completedEvidenceItems('allowed', 'SCOPED'), ...completedEvidenceItems('simulated', 'SIMULATED'), ...completedEvidenceItems('revoked', 'REVOKED_TURN'), ...completedEvidenceItems('nonreal', 'NONREAL')];
  for (const [flag, value] of [['sourceDeleted', true], ['contextRevoked', true], ['simulated', true], ['streaming', true]]) session.items.push({ id: flag, turnId: 'allowed', kind: 'tool', [flag]: value, tool: { name: 'project_exec', status: 'succeeded', output: `EXCLUDED_${flag}` } });
  session.items.push({ id: 'revoked-interaction', turnId: 'allowed', kind: 'assistant', text: 'EXCLUDED_INTERACTION', interaction: { contextRevoked: true } });
  for (const [id, projectId, archivedAt] of [['other-session', 'p', undefined], ['other-project', 'private-project', undefined], ['archived-session', 'p', 'now']]) f.store.state.sessions.push({ id, projectId, archivedAt, turns: [realEvidenceTurn(id, '2026-09-27T09:00:00Z')], items: completedEvidenceItems(id, 'PRIVATE_'+id).map(row => ({ ...row, createdAt: '2026-09-27T09:00:00Z' })) });
  const projected = f.service.projection(f.project, { sessionId: 's' }).state;
  assert.ok(projected.recentSummaries.length > 0); assert.match(JSON.stringify(projected.recentSummaries), /SCOPED/);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|SIMULATED|REVOKED_TURN|NONREAL|EXCLUDED_/);
  assert.equal(projected.userMessage, 'SCOPED user request');
});

test('foreground summaries distinguish assistant claims from retained tool results and never copy successful file-read content', () => {
  const f = fixture(), session = f.store.state.sessions[0]; session.turns = [realEvidenceTurn('t', '2026-09-27T01:00:00Z')];
  session.items = completedEvidenceItems('t', 'CURRENT'); session.items.splice(2, 0, { id: 'read', turnId: 't', kind: 'tool', tool: { name: 'project_read', status: 'succeeded', output: 'PRIVATE_RAW_PROJECT_FILE_CONTENT' } });
  const projection = f.service.projection(f.project, { sessionId: 's' }).state, summary = JSON.parse(projection.recentSummaries[0]);
  assert.equal(summary.source, 'foreground_turn'); assert.match(summary.assistantClaim, /claims everything is complete/); assert.match(summary.scope, /not.*prove overall project completion/); assert.match(summary.scope, /claim.*unverified/i);
  const exec = summary.receipts.find(row => row.name === 'project_exec'), read = summary.receipts.find(row => row.name === 'project_read');
  assert.ok(exec); assert.ok(read); assert.equal(exec.status, 'succeeded'); assert.match(exec.resultExcerpt, /1 boundary remains/); assert.equal(read.resultExcerpt, undefined);
  assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_RAW_PROJECT_FILE_CONTENT/); assert.equal(projection.task.completed, false);
});

test('foreground projection keeps bounded recent turns and failed tool diagnostics without promoting them to completion', () => {
  const f = fixture(), session = f.store.state.sessions[0];
  for (let index = 0; index < 4; index++) { const id = `turn-${index}`, at = `2026-09-27T0${index}:00:00Z`; session.turns.push(realEvidenceTurn(id, at)); session.items.push(...completedEvidenceItems(id, `ROUND_${index}`)); }
  session.items.push({ id: 'failure', turnId: 'turn-3', kind: 'tool', tool: { name: 'project_exec', status: 'failed', output: `FAILED_CHECK_HEAD ${'x'.repeat(3000)} FAILED_CHECK_TAIL` } });
  const projection = f.service.projection(f.project, { sessionId: 's' }).state, rows = projection.recentSummaries.map(value => JSON.parse(value));
  assert.equal(rows.length, 2); assert.match(rows[0].userRequest, /ROUND_3/); assert.match(rows[1].userRequest, /ROUND_2/); assert.doesNotMatch(JSON.stringify(rows), /ROUND_0|ROUND_1/);
  const failure = rows[0].receipts.find(row => row.status === 'failed'); assert.ok(failure); assert.match(failure.resultExcerpt, /FAILED_CHECK_HEAD.*excerpt.*FAILED_CHECK_TAIL/); assert.ok(failure.resultExcerpt.length <= 230); assert.ok(rows.every(row => row.receipts.length <= 3));
  assert.equal(projection.task.completed, false);
});

test('the ledger keeps every judgment out of state: the newest 200 in full, older ones compact; a late label still lands and the experience report counts it', async () => {
  const { experienceReport } = await import('../experience-report.mjs');
  const f = fixture();
  for (let index = 0; index < 205; index++) { f.advance(1000); await f.service.review('evolution.review', f.project, { evidence: [{ id: `e${index}`, summary: `episode ${index}` }] }); }
  const rows = () => f.store.decisionLedger.rows(), find = id => rows().find(row => row.id === id);
  assert.equal(rows().length, 205); assert.deepEqual(f.store.state.decisionKernelRuntime.recent, [], 'no judgment row lives in state');
  assert.equal(f.store.state.decisionKernelRuntime.index, undefined); assert.equal(f.store.state.decisionKernelRuntime.metrics.requests, 205, 'the running counters stay');
  assert.deepEqual(rows().filter(row => row.compact).map(row => row.id), ['j1', 'j2', 'j3', 'j4', 'j5'], 'rows past the newest 200 keep their compact form');
  assert.equal(find('j1').point, 'evolution.review'); assert.equal(find('j1').scored, true); assert.equal(find('j1').policy, undefined);
  assert.equal(f.service.labelDecision('j1', 'defer_right'), true, 'a label for an old row is kept');
  assert.deepEqual(find('j1').label, { value: 'defer_right', at: find('j1').label.at, source: 'self' }, 'the main model\'s own next decision is a self-label');
  assert.equal(f.service.labelDecision('j200', 'defer_missed'), true); assert.equal(find('j200').label.value, 'defer_missed');
  assert.equal(f.service.labelDecision('j199', 'delivery_replied'), true); assert.equal(find('j199').label.source, 'outcome');
  assert.equal(f.service.labelDecision('j198', 'drift_clear', { source: 'outcome' }), true); assert.equal(find('j198').label.source, 'outcome', 'a caller may name the source');
  assert.throws(() => f.service.labelDecision('j197', 'x', { source: 'guess' }), { status: 400 });
  assert.equal(f.service.labelDecision('never-recorded', 'defer_right'), false);
  const report = experienceReport(f.store.state, { now: rows().at(-1).at, ledger: f.store.decisionLedger });
  // Self labels (PDL-7) are counted by source but are no label coverage: only the two outcome labels are `labeled`.
  assert.deepEqual(report.jev.points['evolution.review'], { decisions: 205, judged: 205, labeled: 2, labelCoverage: .01, labels: { outcome: 2, self: 2, heuristic: 0 } });
  // Rows leave 31 days after their judgment, in daily batches.
  f.advance(33 * 86400000); await f.service.review('evolution.review', f.project, { evidence: [{ id: 'late', summary: 'a month later' }] });
  assert.deepEqual(rows().map(row => row.id), ['j206']);
});
test('a ledger page continues by cursor, without a 100-row cap; archived projects show only when asked', async () => {
  const f = fixture();
  for (let index = 0; index < 130; index++) { f.advance(1000); await f.service.review('evolution.review', f.project, { evidence: [{ id: `e${index}`, summary: `episode ${index}` }] }); }
  const first = f.service.ledgerPage({ limit: 120 });
  assert.equal(first.rows.length, 120); assert.equal(first.rows[0].id, 'j130'); assert.equal(first.hasMore, true); assert.equal(first.nextBefore, 'j11');
  const second = f.service.ledgerPage({ limit: 120, before: first.nextBefore });
  assert.deepEqual(second.rows.map(row => row.id), ['j10', 'j9', 'j8', 'j7', 'j6', 'j5', 'j4', 'j3', 'j2', 'j1']); assert.equal(second.hasMore, false); assert.equal(second.nextBefore, null);
  assert.equal(f.service.ledgerPage({ limit: 1000 }).rows.length, 130, 'a page is at most 200 rows; this ledger fits');
  assert.throws(() => f.service.ledgerPage({ before: 'nope' }), { status: 400 });
  assert.equal(f.service.ledger({ limit: 3 }).length, 3, 'the legacy route keeps its array shape');
  f.project.archivedAt = new Date().toISOString();
  assert.equal(f.service.ledgerPage({}).rows.length, 0, 'archived projects are left out by default');
  assert.equal(f.service.ledgerPage({ archived: 'include', limit: 200 }).rows.length, 130);
  assert.equal(f.service.ledgerPage({ archived: 'only', limit: 5 }).rows.length, 5);
  assert.throws(() => f.service.ledgerPage({ archived: 'maybe' }), { status: 400 });
});

// ---------------------------------------------------------------- B3: overdue requests, work lines, provisional labels
test('B3: the overdue rule never bypasses a foreground turn, pursues a request for at most 14 days, and a decline holds it until a new revision', async () => {
  const { declineOverdue, PENDING_MAX_AGE_MS } = await import('../proactive-pacing.mjs');
  const f = fixture(); f.store.state.configuration.decisionKernel.modes['initiative.gate'] = 'active';
  const at = new Date(1000000).toISOString(), bypasses = () => f.store.decisionLedger.rows().filter(row => row.reason === 'bypass_commitment_overdue').length;
  f.project.mind = { commitments: [{ id: 'c1', status: 'pending', request: '把日报改成周报', createdAt: at, overdueAt: at }], agenda: [], threads: [], lessons: [] };
  // During a foreground turn the judge weighs it with the work in progress (the turn may be serving it).
  const turn = await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e1', summary: 'a message' }], freshCount: 1, revision: 'scope:1', progress: { key: 'turn-1', foreground: { startedAt: at, request: '先改第一章' }, work: [] } });
  assert.notEqual(turn.reason, 'commitment_overdue'); assert.equal(bypasses(), 0); assert.equal(f.calls(), 1, 'the judge was asked instead');
  assert.equal(f.requests.at(-1).state.review.openWork.overdueRequests, 'one', 'and sees the overdue request');
  // Between turns it goes to the main model by rule.
  f.advance(60001);
  assert.deepEqual(await f.service.review('initiative.review', f.project, { evidence: [], freshCount: 0, revision: 'scope:1' }), { review: true, reason: 'commitment_overdue' }); assert.equal(bypasses(), 1);
  // The main model saw it and chose to wait, with its reason: not again at this revision; the judge decides.
  f.project.mind.pacing = { overdueDeclined: declineOverdue(f.project.mind, { now: 1000000 + 60001, revision: 'scope:1', reason: 'Waiting for the user to choose the weekly format.' }) };
  assert.deepEqual(f.project.mind.pacing.overdueDeclined.ids, ['c1']);
  f.advance(60001); f.project.initiativeRuntime.sdkState.lastDecision = { at: 1000000 + 60001, action: 'wait' };
  const held = await f.service.review('initiative.review', f.project, { evidence: [], freshCount: 0, revision: 'scope:1' });
  assert.notEqual(held.reason, 'commitment_overdue'); assert.equal(bypasses(), 1); assert.equal(f.calls(), 2);
  // New evidence (another revision): owed again.
  f.advance(60001);
  assert.equal((await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e2', summary: 'new' }], freshCount: 1, revision: 'scope:2' })).reason, 'commitment_overdue'); assert.equal(bypasses(), 2);
  // A request nobody has touched for more than 14 days (made and fallen due that long ago) is no longer pursued by rule (Headlong PENDING_MAX_AGE); the judge still sees it.
  // (D4: the 14 days run from its last sign of life, lastLifeAt, not from when it was made: the fixture ages the due moment with the creation.)
  f.project.mind.pacing = {}; f.project.mind.commitments[0].createdAt = new Date(1000000 - PENDING_MAX_AGE_MS - 1000).toISOString(); f.project.mind.commitments[0].overdueAt = new Date(1000000 - PENDING_MAX_AGE_MS - 500).toISOString();
  f.advance(60001); const aged = await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e3', summary: 'later' }], freshCount: 1, revision: 'scope:3' });
  assert.notEqual(aged.reason, 'commitment_overdue'); assert.equal(bypasses(), 2); assert.equal(f.requests.at(-1).state.review.openWork.overdueRequests, 'one');
  // The same request, made as long ago, that the due judge found due just now is alive again (D4 review): pursued from then.
  f.project.mind.commitments[0].overdueAt = at; f.project.mind.commitments[0].dueBy = 'judge';
  f.advance(60001); assert.equal((await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e4', summary: 'again' }], freshCount: 1, revision: 'scope:4' })).reason, 'commitment_overdue'); assert.equal(bypasses(), 3);
});
test('B3: what the user was told includes the latest finished background run\'s line, one of the four rows the SDK keeps; lines of work in progress never push a report out', () => {
  const f = fixture(), session = f.store.state.sessions[0], stamp = minute => new Date(Date.UTC(2026, 9, 5, 8, minute)).toISOString();
  const line = (n, status, minute, extra = {}) => ({ id: `line-${n}`, kind: 'assistant', source: 'initiative', initiativeActionId: `a${n}-changes`, text: status === 'running' ? `Background work started: check ${n}\n\nIn progress; what it did and the files it changed will be added here when it finishes.` : `Background work: check ${n}\n\nDone: fixed ${n} links in chapter.md.`, createdAt: stamp(minute), updatedAt: stamp(minute + 1), initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: `a${n}`, status, ...extra } } });
  // The review's case: a share told a finding, the user answered, the foreground replied, then three runs started.
  session.turns = [{ id: 't1', status: 'completed', createdAt: stamp(2), completedAt: stamp(3), modelConfig: { execution: 'rna' } }];
  session.items.push({ id: 'share', kind: 'assistant', source: 'initiative', text: 'Chapter two has a broken link.', createdAt: stamp(0), initiative: { kind: 'insight', reach: 'inline' } },
    { id: 'u1', kind: 'user', text: 'Start chapter four.', createdAt: stamp(2), turnId: 't1' }, { id: 'r1', kind: 'assistant', text: 'Started chapter four.', createdAt: stamp(3), turnId: 't1' },
    line(5, 'running', 5), line(6, 'running', 6), line(7, 'paused', 7), line(8, 'interrupted', 8, { recovering: true }));
  f.project.inbox = [{ id: 'entry', actionId: 'share-action', kind: 'share', tier: 'inline', text: 'Chapter two has a broken link.', createdAt: stamp(0), sessionId: 's', itemId: 'share' }];
  const reports = () => f.service.initiativeGateState(f.project, [], { freshCount: 0 }).review.recentReports;
  assert.deepEqual(reports(), ['[proactive message] Chapter two has a broken link.', '[foreground reply] Started chapter four.'], 'work in progress is review.backgroundWork, not a report');
  // Finished runs: only the latest line is a report (a revert notice or a thread close is not a run's report).
  session.items.push(line(1, 'done', 10), line(2, 'failed', 12), { id: 'revert', kind: 'assistant', source: 'initiative', initiativeActionId: 'a2-changes-revert', text: 'Reverted the four files.', createdAt: stamp(20), initiative: { kind: 'insight', reach: 'inbox' } });
  assert.deepEqual(reports(), ['[proactive message] Chapter two has a broken link.', '[foreground reply] Started chapter four.', '[background work line] Background work: check 2 Done: fixed 2 links in chapter.md.']);
  // Newer messages: the line competes by time for the four rows the SDK keeps, and is never more than one of them.
  f.project.inbox.push(...[30, 31, 32].map(minute => ({ id: `e${minute}`, actionId: `x${minute}`, kind: 'share', tier: 'inline', text: `Finding ${minute}.`, createdAt: stamp(minute), sessionId: 's', itemId: null })));
  assert.deepEqual(reports(), ['[background work line] Background work: check 2 Done: fixed 2 links in chapter.md.', '[proactive message] Finding 30.', '[proactive message] Finding 31.', '[proactive message] Finding 32.']);
  session.items.push(line(9, 'done', 40));
  assert.deepEqual(reports(), ['[proactive message] Finding 30.', '[proactive message] Finding 31.', '[proactive message] Finding 32.', '[background work line] Background work: check 9 Done: fixed 9 links in chapter.md.']);
});
test('B3 (PDL-7) on the B7 ledger: a wake label from the main model\'s own next choice is a self label: kept, never calibrated or counted as coverage, never over an outcome label; an outcome label replaces it and is calibrated', async () => {
  const { pendingObservations, calibrationReport } = await import('../decision-calibration-report.mjs');
  const { experienceReport } = await import('../experience-report.mjs');
  const wake = { initiative_need: { type: 'boolean', probability: .5 }, initiative_pause: { type: 'boolean', probability: .5 }, needs_main_model: { type: 'boolean', probability: .95 }, evidence_relevant: { type: 'boolean', probability: .9 }, already_reported: { type: 'boolean', probability: .1 }, likely_action: { type: 'choice', choice: 'work', probabilities: { wait: .01, work: .96, share: .01, ask: .01, schedule: .005, unknown: .005 }, confidence: .96 } };
  const f = fixture(wake); f.store.state.configuration.decisionKernel.modes['initiative.gate'] = 'active';
  const woke = await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e', summary: 'deploy failed' }], freshCount: 1 });
  assert.equal(woke.review, true);
  assert.equal(f.service.labelWake(woke, { action: 'work' }), 1);
  const ledger = f.store.decisionLedger, id = woke.result.ledgerId, row = () => ledger.get(id);
  assert.deepEqual([row().label.value, row().label.source], ['wake_needed_work', 'self'], 'labelWake writes a self label (B3\'s provisional)');
  assert.equal(row().predictions.needs_main_model, .95);
  const brier = () => f.service.calibration({ point: 'initiative.review', window: 'all' }).questions.needs_main_model;
  const coverage = () => experienceReport(f.store.state, { now: row().at, ledger }).jev.points['initiative.review'];
  // Never calibrated: no observation is taken from it, so neither the Brier nor a bucket nor `labeled` sees it.
  assert.deepEqual(pendingObservations(f.store.state, ledger.rows()), [], 'no observation from a self label');
  assert.equal(f.service.backfill({ force: true }), 0); assert.equal(row().observed, undefined);
  assert.deepEqual([brier().labeled, brier().brier, brier().buckets], [0, null, []]);
  assert.equal(f.service.calibration({ point: 'initiative.review', window: 'all' }).labels.self, 1, 'shown by source, for reading');
  assert.deepEqual([coverage().labeled, coverage().labels.self, coverage().labelCoverage], [0, 1, 0], 'not label coverage');
  // Even an observation already on the row (an older release took one from such a label) is not scored.
  assert.equal(calibrationReport([{ ...row(), observed: { needs_main_model: true, at: row().at } }], { point: 'initiative.review', window: 'all', now: row().at }).questions.needs_main_model.labeled, 0);
  // Never over an outcome label: the user replied to the delivery this wake led to.
  assert.equal(f.service.labelDecision(id, 'delivery_replied'), true);
  assert.equal(f.service.labelWake(woke, { action: 'wait' }), 0, 'the next self label is refused');
  assert.equal(f.service.labelDecision(id, 'wake_unneeded', { provisional: true }), false, 'B3\'s provisional flag is source self');
  assert.equal(f.service.labelDecision(id, 'delivery_dismissed', { provisional: true }), false, 'whatever the value');
  assert.equal(f.service.labelDecision(id, 'drift_clear', { source: 'self' }), false);
  assert.deepEqual([row().label.value, row().label.source], ['delivery_replied', 'outcome']);
  // The outcome is calibrated and counted.
  assert.equal(f.service.backfill({ force: true }), 1); assert.deepEqual(row().observed.needs_main_model, true);
  assert.deepEqual([brier().labeled, brier().brier], [1, .0025]);
  assert.deepEqual([coverage().labeled, coverage().labels.outcome, coverage().labels.self], [1, 1, 0]);
});
test('B3 (PDL-7) on the B7 ledger: an outcome label replaces a self label, drops an observation the self label left, and is observed; the file replays the same', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { DecisionLedger } = await import('../decision-ledger.mjs');
  const { pendingObservations } = await import('../decision-calibration-report.mjs');
  const file = join(mkdtempSync(join(tmpdir(), 'rna-self-label-')), 'decision-ledger.jsonl'), now = Date.parse('2026-10-05T08:00:00Z');
  const review = id => ({ id, at: now - 60000, point: 'initiative.review', source: 'judge', mode: 'active', scope: { projectId: 'p' }, predictions: { needs_main_model: .9 } });
  const ledger = new DecisionLedger({ file, now: () => now });
  ledger.add(review('a')); ledger.add(review('b'));
  assert.equal(ledger.label('a', 'wake_needed_share'), true); assert.equal(ledger.get('a').label.source, 'self');
  // An older release's backfill observed b from its own wake label (the case B3's migration dropped).
  ledger.label('b', 'wake_unneeded'); ledger.get('b').observed = { needs_main_model: false, at: now };
  assert.equal(ledger.label('a', 'delivery_acted'), true, 'an outcome replaces a self label');
  assert.equal(ledger.label('b', 'delivery_replied'), true);
  assert.deepEqual([ledger.get('a').label.source, ledger.get('b').label.source], ['outcome', 'outcome']);
  assert.equal(ledger.get('b').observed, undefined, 'the observation the self label left is gone');
  assert.deepEqual(pendingObservations({}, ledger.rows()).map(row => [row.id, row.observed]), [['a', { needs_main_model: true }], ['b', { needs_main_model: true }]], 'both outcomes are observed');
  assert.equal(ledger.label('a', 'defer_right'), false, 'and a self label never comes back over them');
  // The file replays to the same rows; a self label line after an outcome line (any writer) does not win either.
  const reloaded = new DecisionLedger({ file, now: () => now });
  assert.deepEqual(['a', 'b'].map(id => [reloaded.get(id).label.value, reloaded.get(id).label.source, reloaded.get(id).observed ?? null]), [['delivery_acted', 'outcome', null], ['delivery_replied', 'outcome', null]]);
  writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ t: 'label', id: 'a', value: 'wake_unneeded', at: now, source: 'self' })}\n`);
  assert.equal(new DecisionLedger({ file, now: () => now }).get('a').label.value, 'delivery_acted');
});
test('B3 (PDL-7, review finding 3) after B7: wake labels an older release wrote without a source, or flagged provisional, read as self when the rows move into the ledger; their observations go, outcome labels stay; a second start writes nothing', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { experienceReport } = await import('../experience-report.mjs');
  const f = fixture(), now = 1000000, at = now - 60000;
  // A host started on this store: the ledger beside its state file.
  delete f.store.decisionLedger; f.store.file = join(mkdtempSync(join(tmpdir(), 'rna-pdl7-')), 'state.json');
  const review = (id, label, observed = null) => ({ id, at, point: 'initiative.review', source: 'judge', mode: 'active', disposition: 'main_review', scope: { projectId: 'p' }, predictions: { needs_main_model: .9 }, label, ...(observed ? { observed: { ...observed, at: at + 1000 } } : {}) });
  // As 0.68.0 left them (no flag; the backfill already observed one), plus one B3 flagged before the ledger moved out.
  f.store.state.decisionKernelRuntime = { metrics: {},
    recent: [review('w1', { value: 'wake_needed_work', at }, { needs_main_model: true }), review('w2', { value: 'defer_right', at }), review('w3', { value: 'delivery_replied', at }, { needs_main_model: true }), review('w4', { value: 'wake_unneeded', at, provisional: true }, { needs_main_model: false }),
      { id: 'd1', at, point: 'delivery.reach', source: 'judge', mode: 'active', scope: { projectId: 'p' }, predictions: { engaged: .7 }, label: { value: 'replied', at }, observed: { engaged: true, at: at + 1000 } }],
    index: { [new Date(at).toISOString().slice(0, 10)]: [...['w1', 'w2', 'w3', 'w4', 'w5'].map(id => ({ id, point: 'initiative.review', at, source: 'judge', projectId: 'p' })), { id: 'd1', point: 'delivery.reach', at, source: 'judge', projectId: 'p' }, { id: 'x1', point: 'turn.drift', at, source: 'judge', projectId: 'p' }] },
    labels: { w1: { value: 'wake_needed_work', at }, w2: { value: 'defer_right', at }, w3: { value: 'delivery_replied', at }, w4: { value: 'wake_unneeded', at, provisional: true }, w5: { value: 'wake_needed_share', at }, d1: { value: 'replied', at }, x1: { value: 'drift_clear', at } } };
  // The import itself reads them as self and drops their observations, before any startup pass (one atomic write).
  const { DecisionLedger } = await import('../decision-ledger.mjs');
  const alone = new DecisionLedger({ now: () => now }), copy = { state: structuredClone(f.store.state), mutate(fn) { return fn(this.state); } };
  alone.absorb(copy);
  assert.deepEqual(['w1', 'w4', 'w3', 'd1'].map(id => [alone.get(id).label.source, Boolean(alone.get(id).observed)]), [['self', false], ['self', false], ['outcome', true], ['outcome', true]]);
  // Startup: server.mjs constructs the service on the loaded store.
  let writes = 0; const mutate = f.store.mutate.bind(f.store); f.store.mutate = fn => { writes++; return mutate(fn); };
  const started = new DecisionService(f.store, { now: () => now }), ledger = f.store.decisionLedger, row = id => ledger.get(id);
  assert.equal(writes, 1, 'one state write: state forgets the rows once they are on disk');
  assert.deepEqual(f.store.state.decisionKernelRuntime.recent, []); assert.equal(f.store.state.decisionKernelRuntime.labels, undefined);
  assert.deepEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'd1', 'x1'].map(id => [id, row(id).label.value, row(id).label.source, Boolean(row(id).observed)]),
    [['w1', 'wake_needed_work', 'self', false], ['w2', 'defer_right', 'self', false], ['w3', 'delivery_replied', 'outcome', true], ['w4', 'wake_unneeded', 'self', false], ['w5', 'wake_needed_share', 'self', false], ['d1', 'replied', 'outcome', true], ['x1', 'drift_clear', 'heuristic', false]],
    'self labels kept and the observations taken from them dropped; outcome and heuristic labels and their observations kept');
  const scored = () => started.calibration({ point: 'initiative.review', window: 'all' }).questions.needs_main_model.labeled, coverage = () => experienceReport(f.store.state, { now, ledger }).jev.points['initiative.review'];
  assert.equal(scored(), 1, 'only the outcome label is scored');
  assert.deepEqual([coverage().labeled, coverage().labels], [1, { outcome: 1, self: 4, heuristic: 0 }], 'and only it is label coverage');
  // A second start (and any later one, reading the file) finds nothing to do and writes nothing.
  const bytes = readFileSync(ledger.file, 'utf8');
  new DecisionService(f.store, { now: () => now });
  delete f.store.decisionLedger; const restarted = new DecisionService(f.store, { now: () => now });
  assert.equal(writes, 1, 'idempotent: no state write'); assert.equal(readFileSync(ledger.file, 'utf8'), bytes, 'and no ledger rewrite');
  assert.deepEqual(['w1', 'w4', 'w3'].map(id => [id, f.store.decisionLedger.get(id).label.source, Boolean(f.store.decisionLedger.get(id).observed)]), [['w1', 'self', false], ['w4', 'self', false], ['w3', 'outcome', true]]);
  // An outcome label that arrives later replaces the self label and is observed.
  assert.equal(restarted.labelDecision('w1', 'delivery_replied'), true);
  assert.equal(restarted.backfill({ force: true }), 1); assert.deepEqual(f.store.decisionLedger.get('w1').observed.needs_main_model, true);
});
test('B3 (PDL-7) after B7: a self observation already in the ledger file (rows that moved before the rule) is dropped at startup, once, and persisted', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { decisionLedgerFile } = await import('../decision-ledger.mjs');
  const f = fixture(), now = 1000000, at = now - 60000;
  delete f.store.decisionLedger; f.store.file = join(mkdtempSync(join(tmpdir(), 'rna-pdl7-file-')), 'state.json');
  const file = decisionLedgerFile(f.store.file); (await import('node:fs')).mkdirSync(join(file, '..'), { recursive: true });
  const row = id => ({ id, at, point: 'initiative.review', source: 'judge', mode: 'active', scope: { projectId: 'p' }, predictions: { needs_main_model: .8 } });
  writeFileSync(file, [{ t: 'row', row: row('s1') }, { t: 'row', row: row('o1') }, { t: 'label', id: 's1', value: 'wake_needed_work', at, source: 'self' }, { t: 'observed', id: 's1', observed: { needs_main_model: true, at } },
    { t: 'label', id: 'o1', value: 'delivery_replied', at }, { t: 'observed', id: 'o1', observed: { needs_main_model: true, at } }].map(value => JSON.stringify(value)).join('\n') + '\n');
  const service = new DecisionService(f.store, { now: () => now });
  assert.deepEqual(['s1', 'o1'].map(id => Boolean(f.store.decisionLedger.get(id).observed)), [false, true]);
  assert.equal(service.calibration({ point: 'initiative.review', window: 'all' }).questions.needs_main_model.labeled, 1);
  const bytes = readFileSync(file, 'utf8');
  delete f.store.decisionLedger; new DecisionService(f.store, { now: () => now });
  assert.equal(f.store.decisionLedger.get('s1').observed, undefined, 'persisted'); assert.equal(readFileSync(file, 'utf8'), bytes, 'a second start writes nothing');
});
test('B3 + B7: ledger migration, rollback to 0.68.0 and upgrade again keep every row and label; self labels written during the rollback stay out of calibration', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { experienceReport } = await import('../experience-report.mjs');
  const f = fixture(), now = 1000000, at = now - 60000, day = new Date(at).toISOString().slice(0, 10);
  delete f.store.decisionLedger; f.store.file = join(mkdtempSync(join(tmpdir(), 'rna-rollback-')), 'state.json');
  const review = (id, extra = {}) => ({ id, at, point: 'initiative.review', source: 'judge', mode: 'active', scope: { projectId: 'p' }, predictions: { needs_main_model: .9 }, ...extra });
  const reach = (id, extra = {}) => ({ id, at, point: 'delivery.reach', source: 'judge', mode: 'active', scope: { projectId: 'p' }, predictions: { engaged: .6 }, ...extra });
  // 0.68.0's state: a self-labelled wake (observed by its backfill), an outcome-labelled delivery, an index-only outcome label.
  f.store.state.decisionKernelRuntime = { metrics: { requests: 3 },
    recent: [review('r1', { label: { value: 'wake_needed_work', at }, observed: { needs_main_model: true, at } }), reach('r2', { label: { value: 'replied', at }, observed: { engaged: true, at } })],
    index: { [day]: [{ id: 'r1', point: 'initiative.review', at, source: 'judge', projectId: 'p' }, { id: 'r2', point: 'delivery.reach', at, source: 'judge', projectId: 'p' }, { id: 'i1', point: 'message.value', at, source: 'judge', projectId: 'p' }] },
    labels: { r1: { value: 'wake_needed_work', at }, r2: { value: 'replied', at }, i1: { value: 'dismissed', at } } };
  const labels = () => Object.fromEntries(f.store.decisionLedger.rows().filter(row => row.label).map(row => [row.id, [row.label.value, row.label.source, Boolean(row.observed)]]));
  // Upgrade.
  new DecisionService(f.store, { now: () => now });
  assert.deepEqual(labels(), { r1: ['wake_needed_work', 'self', false], r2: ['replied', 'outcome', true], i1: ['dismissed', 'outcome', false] });
  assert.deepEqual(f.store.state.decisionKernelRuntime.recent, []); assert.equal(f.store.state.decisionKernelRuntime.index, undefined); assert.equal(f.store.state.decisionKernelRuntime.labels, undefined);
  // Rollback: 0.68.0 reads state only. It appends its own rows to `recent` and the index, labels its own wake judgment
  // from the main model's next choice (no flag, no source) and observes it, labels a delivery from a reply, and cannot
  // label rows it does not know (r1 stays as the ledger holds it).
  f.store.mutate(state => { const live = state.decisionKernelRuntime;
    live.recent.push(review('n1', { label: { value: 'wake_unneeded', at }, observed: { needs_main_model: false, at } }), reach('n2', { label: { value: 'acted', at }, observed: { engaged: true, at } }));
    live.index = { [day]: [{ id: 'n1', point: 'initiative.review', at, source: 'judge', projectId: 'p' }, { id: 'n2', point: 'delivery.reach', at, source: 'judge', projectId: 'p' }] };
    live.labels = { n1: { value: 'wake_unneeded', at }, n2: { value: 'acted', at } }; });
  // Upgrade again (a fresh process: the ledger is read from its file).
  delete f.store.decisionLedger; const upgraded = new DecisionService(f.store, { now: () => now });
  const expected = { r1: ['wake_needed_work', 'self', false], r2: ['replied', 'outcome', true], i1: ['dismissed', 'outcome', false], n1: ['wake_unneeded', 'self', false], n2: ['acted', 'outcome', true] };
  assert.deepEqual(labels(), expected, 'no row or label lost; the rollback\'s wake label reads as self and its observation is gone');
  assert.deepEqual(f.store.decisionLedger.rows().map(row => row.id).sort(), ['i1', 'n1', 'n2', 'r1', 'r2']);
  assert.deepEqual(f.store.state.decisionKernelRuntime.recent, []); assert.equal(f.store.state.decisionKernelRuntime.metrics.requests, 3);
  const calibration = upgraded.calibration({ window: 'all' });
  assert.equal(calibration.points['initiative.review'].questions.needs_main_model.labeled, 0, 'self labels stay out of calibration');
  assert.equal(calibration.points['delivery.reach'].questions.engaged.labeled, 2, 'outcome labels are calibrated');
  const jev = experienceReport(f.store.state, { now, ledger: f.store.decisionLedger }).jev.points;
  assert.deepEqual([jev['initiative.review'].labeled, jev['initiative.review'].labels.self, jev['delivery.reach'].labeled, jev['message.value'].labeled], [0, 2, 2, 1]);
  // A further restart changes nothing.
  const bytes = readFileSync(f.store.decisionLedger.file, 'utf8');
  delete f.store.decisionLedger; new DecisionService(f.store, { now: () => now });
  assert.deepEqual(labels(), expected); assert.equal(readFileSync(f.store.decisionLedger.file, 'utf8'), bytes);
});
test('C2 (PDL-7): the outcome of the action a wake admitted labels the wake judgment (source outcome); it replaces the self label, is calibrated, and an outcome that moves relabels the row and drops the observation read from the old one', async () => {
  const { pendingObservations } = await import('../decision-calibration-report.mjs');
  const wake = { initiative_need: { type: 'boolean', probability: .5 }, initiative_pause: { type: 'boolean', probability: .5 }, needs_main_model: { type: 'boolean', probability: .8 }, evidence_relevant: { type: 'boolean', probability: .9 }, already_reported: { type: 'boolean', probability: .1 }, likely_action: { type: 'choice', choice: 'work', probabilities: { wait: .01, work: .96, share: .01, ask: .01, schedule: .005, unknown: .005 }, confidence: .96 } };
  const f = fixture(wake); f.store.state.configuration.decisionKernel.modes['initiative.gate'] = 'active';
  const woke = await f.service.review('initiative.review', f.project, { evidence: [{ id: 'e', summary: 'deploy failed' }], freshCount: 1 });
  const id = woke.result.ledgerId, ledger = f.store.decisionLedger, row = () => ledger.get(id);
  // The decision is admitted: the model's own next choice is a self label, which calibration does not read.
  assert.equal(f.service.labelWake(woke, { action: 'work' }), 1); assert.equal(row().label.source, 'self');
  assert.equal(f.service.backfill({ force: true }), 0, 'nothing is observed from it');
  // The run's change set is kept: an outcome label, calibrated.
  assert.equal(f.service.labelOutcome(id, 'wake_needed_work'), true);
  assert.deepEqual([row().label.value, row().label.source], ['wake_needed_work', 'outcome']);
  assert.equal(f.service.backfill({ force: true }), 1); assert.equal(row().observed.needs_main_model, true);
  assert.equal(f.service.labelOutcome(id, 'wake_needed_work'), false, 'idempotent: the same outcome again writes nothing');
  assert.equal(f.service.labelWake(woke, { action: 'wait' }), 0, 'and the model\'s own next choice never comes back over it');
  // The user takes the change back, days later: the outcome moved, so does the label, and the observation read from the old one is dropped and read again.
  assert.equal(f.service.labelOutcome(id, 'wake_unneeded'), true);
  assert.deepEqual([row().label.value, row().label.source, row().observed], ['wake_unneeded', 'outcome', undefined], 'the stale observation is gone');
  assert.deepEqual(pendingObservations(f.store.state, ledger.rows()).map(entry => [entry.id, entry.observed.needs_main_model]), [[id, false]], 'read again from the new label');
  assert.equal(f.service.backfill({ force: true }), 1); assert.equal(row().observed.needs_main_model, false);
  // A delivery reaction label that already says the same is left as it is (the label the delivery path wrote stays).
  assert.equal(f.service.labelDecision(id, 'delivery_dismissed'), true);
  assert.equal(f.service.labelOutcome(id, 'wake_unneeded'), false); assert.equal(row().label.value, 'delivery_dismissed');
  // Not a label, not a row: refused quietly.
  assert.equal(f.service.labelOutcome(id, 'Not A Label!'), false); assert.equal(f.service.labelOutcome('unknown-row', 'wake_unneeded'), false);
  // A deferral of the same situation is labelled the same way.
  ledger.add({ id: 'd1', at: 1000000 - 1000, point: 'initiative.review', source: 'judge', mode: 'active', scope: { projectId: 'p' }, predictions: { needs_main_model: .1 } });
  assert.equal(f.service.labelWake({ review: true, deferredLedgerIds: ['d1'] }, { action: 'wait' }), 1); assert.equal(ledger.get('d1').label.source, 'self');
  assert.equal(f.service.labelOutcome('d1', 'defer_missed'), true); assert.deepEqual([ledger.get('d1').label.value, ledger.get('d1').label.source], ['defer_missed', 'outcome']);
});
test('C2 review: a different outcome label replacing a calibrated one drops the observation read from the old one at any labelled point, not only the wake judgment; the same label again keeps it', () => {
  const f = fixture(), ledger = f.store.decisionLedger, row = id => ledger.get(id);
  // delivery.reach: the user replied (engaged), the backfill observed it, then the delivery's reaction changed to a dismissal.
  ledger.add({ id: 'r1', at: 1000000 - 1000, point: 'delivery.reach', source: 'judge', mode: 'active', scope: { projectId: 'p' }, predictions: { engaged: .7 } });
  assert.equal(f.service.labelDecision('r1', 'delivery_replied'), true);
  assert.equal(f.service.backfill({ force: true }), 1); assert.deepEqual(row('r1').observed.engaged, true);
  assert.equal(f.service.labelDecision('r1', 'delivery_replied'), true); assert.deepEqual(row('r1').observed.engaged, true, 'the same label again: the observation stands');
  assert.equal(f.service.labelDecision('r1', 'delivery_dismissed'), true);
  assert.deepEqual([row('r1').label.value, row('r1').observed], ['delivery_dismissed', undefined], 'the observation read from the old label is gone');
  assert.equal(f.service.backfill({ force: true }), 1); assert.equal(row('r1').observed.engaged, false, 'read again from the new label');
  // A point that is not observed from labels is untouched by the rule: relabelling it drops nothing it never had.
  ledger.add({ id: 'x1', at: 1000000 - 500, point: 'turn.route', source: 'judge', mode: 'active', scope: { projectId: 'p' }, predictions: { route: .5 } });
  assert.equal(f.service.labelDecision('x1', 'drift_clear'), true); assert.equal(f.service.labelDecision('x1', 'drift_steered'), true); assert.equal(row('x1').observed, undefined);
});
