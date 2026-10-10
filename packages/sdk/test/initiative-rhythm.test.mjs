import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, decideInitiative, validateInitiativeDecision, getInitiativeDecisionSchema, getInitiativePromptSchema, initiativeDecisionSchema } from '../src/initiative.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';
import { projectRhythmAssessmentSchema, resolveProjectRhythm } from '../src/index.mjs';

const model = { protocol: 'openai', providerId: 'fixture', modelId: 'fixture', maxOutputTokens: 2048 };
const events = [{ id: 'evidence-1', type: 'project_state', summary: 'Daily research is a continuing responsibility; the latest delivery is verified.', at: 1 }];
const project = { id: 'project', title: '游戏工作台', description: 'Every day, deliver a researched report.', actionContracts: { rhythm: { enabled: true, requiresAssessment: true } }, schedules: [{ id: 'daily-report', enabled: true, nextRunAt: '2026-09-27T00:00:00Z' }] };
const rhythm = { lifecycle: 'recurring', reason: 'The verified delivery completes this occurrence; next duty is registered.', evidenceIds: ['evidence-1'], scheduleIds: ['daily-report'], initiative: { mode: 'event_only', reviewAfterMs: 86400000 }, evolution: { mode: 'weekly', maxPerDay: 1, maxPerWeek: 1, minIntervalMs: 86400000 } };
const decision = extra => ({ action: 'wait', reason: 'Wait for the next responsibility or changed evidence.', content: '', evidenceIds: [], nextReviewAfterMs: 86400000, ...extra });
const providerFor = (value, inspect = () => {}) => async function* (request) { inspect(request); yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; };

test('rhythm schema is opt-in and a first assessment is explicitly required in the published contract', () => {
  const original = structuredClone(initiativeDecisionSchema);
  assert.equal(getInitiativeDecisionSchema().properties.rhythm, undefined);
  const required = getInitiativeDecisionSchema({ project });
  assert.deepEqual(required.properties.rhythm, projectRhythmAssessmentSchema); assert.ok(required.required.includes('rhythm'));
  assert.throws(() => validateToolArguments(required, decision()), { code: 'invalid_arguments' });
  assert.doesNotThrow(() => validateToolArguments(required, decision({ rhythm })));
  assert.deepEqual(initiativeDecisionSchema, original);
});

test('an existing assessment can be left unchanged, but disabled host support rejects smuggled policy', () => {
  const optional = { ...project, actionContracts: { rhythm: { enabled: true } } };
  assert.doesNotThrow(() => validateInitiativeDecision(decision(), { project: optional, events }));
  for (const actionContracts of [{}, { rhythm: { enabled: false } }, { rhythm: { enabled: 'true' } }]) {
    assert.throws(() => validateInitiativeDecision(decision({ rhythm }), { project: { ...project, actionContracts }, events }), { code: 'invalid_decision' });
  }
});

test('missing mandatory rhythm exposes a bounded diagnostic field without response text', async () => {
  await assert.rejects(decideInitiative({ project, events, model, provider: providerFor(decision()) }), error => {
    assert.equal(error.code, 'invalid_decision');
    assert.deepEqual(error.decisionValidation.missingFields, ['rhythm']);
    assert.deepEqual(error.initiativeFailure.decisionValidation.missingFields, ['rhythm']);
    assert.equal(error.initiativeFailure.request.responseBytes > 0, true);
    assert.equal(error.initiativeFailure.request.responseText, undefined);
    return true;
  });
});

test('rhythm evidence requires exact current event ids even when the outer wait has no citations', () => {
  for (const evidenceIds of [['receipt-evidence-1'], ['invented']]) {
    assert.throws(() => validateInitiativeDecision(decision({ rhythm: { ...rhythm, evidenceIds } }), { project, events }), { code: 'invalid_decision' });
  }
  const result = validateInitiativeDecision(decision({ rhythm }), { project, events });
  assert.deepEqual(result.rhythm, rhythm); assert.notEqual(result.rhythm, rhythm);
});

test('schedule references must identify actual project.schedules records, not context prose or new proposed ids', () => {
  const forged = decision({ rhythm: { ...rhythm, scheduleIds: ['proposed-schedule'] } });
  assert.throws(() => validateInitiativeDecision(forged, { project: { ...project, scheduleContext: { schedules: [{ id: 'proposed-schedule' }] } }, events }), { code: 'invalid_decision' });
  assert.throws(() => validateInitiativeDecision(decision({ rhythm }), { project: { ...project, schedules: [] }, events }), { code: 'invalid_decision' });
});

test('an available but empty scheduler cannot silently sleep an unregistered recurring responsibility', () => {
  const capable = { ...project, schedules: [], scheduleContext: { cancelled: [] }, actionContracts: { ...project.actionContracts, schedule: { schemaVersion: 1, enabled: true } } };
  const unregistered = { ...rhythm, scheduleIds: [] };
  for (const action of ['wait', 'share']) {
    assert.throws(() => validateInitiativeDecision(decision({ action, content: action === 'share' ? 'I will deliver it daily.' : '', evidenceIds: action === 'share' ? ['evidence-1'] : [], rhythm: unregistered }), { project: capable, events, availableActions: ['share', 'work', 'ask', 'schedule'] }), error => {
      assert.equal(error.code, 'invalid_decision'); assert.ok(error.message.includes('no registered schedule')); assert.ok(error.message.includes('actual missing condition')); return true;
    });
  }
  const choices = [
    decision({ action: 'work', content: 'Inspect existing report requirements before registering a duty.', evidenceIds: ['evidence-1'], rhythm: unregistered }),
    decision({ action: 'ask', content: 'The delivery destination is missing.', evidenceIds: ['evidence-1'], questions: [{ id: 'destination', question: 'Which permitted project conversation should receive the report?', allowCustom: true }], rhythm: unregistered }),
    decision({ action: 'schedule', content: 'Register this daily responsibility.', evidenceIds: ['evidence-1'], schedule: { operation: 'create', purposeKey: 'daily-report', title: 'Daily report', task: 'Research and deliver one daily report.', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: 'conversation' }, rhythm: unregistered }),
    decision({ rhythm: { ...unregistered, lifecycle: 'blocked', reason: 'A required source has not been configured; there is no useful independent work yet.' } }),
  ];
  for (const value of choices) assert.doesNotThrow(() => validateInitiativeDecision(value, { project: capable, events, availableActions: ['share', 'work', 'ask', 'schedule'] }));
});

test('the recurring completeness check preserves disabled, cancelled and unavailable scheduling boundaries', () => {
  const base = { ...project, schedules: [], actionContracts: { ...project.actionContracts, schedule: { schemaVersion: 1, enabled: true } } };
  const value = decision({ rhythm: { ...rhythm, scheduleIds: [] } });
  for (const allowed of [
    { ...base, schedules: [{ id: 'human-paused', enabled: false, nextRunAt: null }] },
    { ...base, scheduleContext: { cancelled: [{ purposeKey: 'daily-report', lastEditedBy: 'user' }] } },
    { ...base, actionContracts: { ...base.actionContracts, schedule: { enabled: false } } },
    { ...base, actionContracts: { rhythm: { enabled: true, requiresAssessment: true } } },
  ]) assert.doesNotThrow(() => validateInitiativeDecision(value, { project: allowed, events, availableActions: ['schedule'] }));
});

test('rhythm can accompany an authorized schedule action without being treated as a tool or additional action', () => {
  const combined = { ...project, actionContracts: { ...project.actionContracts, schedule: { enabled: true, schemaVersion: 1 } } };
  const value = decision({ action: 'schedule', evidenceIds: ['evidence-1'], content: 'Pause this exact existing duty.', rhythm, schedule: { operation: 'update', id: 'daily-report', expectedRevision: 1, enabled: false } });
  const validated = validateInitiativeDecision(value, { project: combined, events, availableActions: ['schedule'] });
  assert.equal(validated.action, 'schedule'); assert.deepEqual(validated.rhythm, rhythm);
  assert.equal(getInitiativeDecisionSchema({ project: combined, availableActions: ['schedule'] }).properties.action.enum.includes('rhythm'), false);
});

test('ordinary initiative request includes the exact dynamic schema and methodology without a second model call', async () => {
  let requests = 0;
  const value = await decideInitiative({ project, events, model, provider: providerFor(decision({ rhythm }), request => {
    requests++;
    assert.ok(request.systemPrompt.includes('Do not classify by project-name keywords'));
    assert.ok(request.systemPrompt.includes('a review need not generate a candidate'));
    assert.ok(request.systemPrompt.includes('never enable a user-disabled lane'));
    // The prompt shows the stable schema: an assessment being due is a hostConditions condition, not a `required` toggle.
    assert.ok(request.systemPrompt.endsWith(JSON.stringify(getInitiativePromptSchema({ project }))));
    assert.deepEqual(getInitiativePromptSchema({ project }), getInitiativePromptSchema({ project: { ...project, actionContracts: { ...project.actionContracts, rhythm: { ...project.actionContracts.rhythm, requiresAssessment: false } } } }));
    assert.match(getInitiativePromptSchema({ project }).properties.rhythm.description, /Required when hostConditions\.rhythm\.requiresAssessment is true/);
    assert.equal(request.tools.length, 0);
    const input = JSON.parse(request.messages[0].content[0].text);
    // The contract leads the request; its changing state (an assessment due) is sent at the end as hostConditions.
    const { requiresAssessment, ...stable } = project.actionContracts.rhythm;
    assert.deepEqual(input.hostActionContracts.rhythm, stable);
    assert.deepEqual(input.hostConditions.rhythm, { requiresAssessment });
    assert.ok(Object.keys(input).indexOf('hostConditions') > Object.keys(input).indexOf('events'), 'conditions follow the evidence');
    assert.deepEqual(input.project.schedules, project.schedules);
    // The model cites short handles; the host maps E1 back to evidence-1 before validation.
    assert.deepEqual(input.allowedEvidenceIds, ['E1']);
  }) });
  assert.equal(requests, 1); assert.deepEqual(value.decision.rhythm, rhythm);
});

test('rhythm guidance is also present when the host enables the richer schedule prompt', async () => {
  const combined = { ...project, actionContracts: { ...project.actionContracts, schedule: { enabled: true, schemaVersion: 1 } } };
  await decideInitiative({ project: combined, events, availableActions: ['schedule'], model, provider: providerFor(decision({ rhythm }), request => {
    assert.ok(request.systemPrompt.includes('Project rhythm is an assessment'));
    assert.ok(request.systemPrompt.includes('Maintain responsibilities'));
    assert.ok(request.systemPrompt.endsWith(JSON.stringify(getInitiativePromptSchema({ project: combined, availableActions: ['schedule'] }))));
  }) });
});

test('rhythm validates against the exact request snapshot rather than schedule ids added during inference', async () => {
  const changing = structuredClone(project);
  await assert.rejects(decideInitiative({ project: changing, events, model, provider: providerFor(decision({ rhythm: { ...rhythm, scheduleIds: ['late-record'] } }), () => {
    changing.schedules.push({ id: 'late-record', enabled: true, nextRunAt: '2026-09-28T00:00:00Z' });
    changing.actionContracts.rhythm.requiresAssessment = false;
  }) }), { code: 'invalid_decision' });
});

test('sleeping tick neither calls a provider nor consumes a fresh-evidence/failure review watermark', async () => {
  let requests = 0;
  const coordinator = new InitiativeCoordinator({ project, model, provider: providerFor(decision({ rhythm }), () => { requests++; }) });
  await coordinator.observe(events[0]);
  coordinator.state.pendingFailureReview = { actionId: 'previous', evidenceKey: 'external-key' };
  const before = coordinator.snapshot();
  for (let i = 0; i < 100; i++) assert.equal((await coordinator.tick({ decisionEnabled: false })).reason, 'decision_disabled');
  const after = coordinator.snapshot();
  assert.equal(requests, 0); assert.equal(after.decisionRevision, before.decisionRevision);
  assert.deepEqual(after.pendingFailureReview, before.pendingFailureReview); assert.equal(after.reservedTokens, 0); assert.equal(after.usedTokens, 0);
  assert.equal((await coordinator.tick()).status, 'decided'); assert.equal(requests, 1);
  await coordinator.close();
});

test('sleeping tick drains a queued share once despite model failure backoff and preserves typing gates', async () => {
  let requests = 0, deliveries = 0;
  const coordinator = new InitiativeCoordinator({ model, now: () => 1000, provider: providerFor(decision(), () => { requests++; }), handlers: { share: async () => { deliveries++; return { usage: { totalTokens: 0 } }; } } });
  await coordinator.observe(events[0]);
  coordinator.state.actions.push({ id: 'queued-share', action: 'share', reason: 'Verified new finding', content: 'The actual result.', evidenceIds: ['evidence-1'], revision: coordinator.state.revision, status: 'queued', createdAt: 1 });
  coordinator.state.failureRetryAt = 100000;
  await coordinator.tick({ decisionEnabled: false, presence: { typing: true } });
  assert.equal(deliveries, 0); assert.equal(coordinator.state.actions[0].deferredReason, 'user_typing');
  await coordinator.tick({ decisionEnabled: false, presence: { typing: false } }); await coordinator.idle();
  assert.equal(deliveries, 1); assert.equal(requests, 0); assert.equal(coordinator.state.failureRetryAt, 100000);
  await coordinator.tick({ decisionEnabled: false }); assert.equal(deliveries, 1);
  await coordinator.close();
});

test('sleeping tick executes an already-admitted host schedule occurrence without making a generic decision', async () => {
  let requests = 0, works = 0;
  const coordinator = new InitiativeCoordinator({ model, provider: providerFor(decision(), () => { requests++; }), handlers: { work: async () => { works++; return { usage: { totalTokens: 4 } }; } } });
  await coordinator.enqueueHostAction({ id: 'duty-occurrence', action: 'work', reason: 'The exact registered occurrence is due.', content: 'Produce one report.', source: { id: 'occurrence-evidence', type: 'scheduled_occurrence', summary: 'Due registered daily report.', at: 1 }, hostSchedule: { key: 'schedule:daily:1', scheduleId: 'daily-report', scheduleRevision: 1, destinationSessionId: 'chat' } });
  await coordinator.tick({ decisionEnabled: false }); await coordinator.idle();
  assert.equal(works, 1); assert.equal(requests, 0); assert.equal(coordinator.snapshot().usedTokens, 4);
  await coordinator.close();
});

test('decision gating cannot bypass explicit disable, unsettled operations or unknown execution barriers', async () => {
  let works = 0;
  const coordinator = new InitiativeCoordinator({ model, policy: { enabled: false }, handlers: { work: async () => { works++; } } });
  assert.equal((await coordinator.tick({ decisionEnabled: false })).status, 'paused');
  await coordinator.updatePolicy({ enabled: true });
  coordinator.unsettled.add(Promise.resolve());
  assert.equal((await coordinator.tick({ decisionEnabled: false })).reason, 'unsettled_operation');
  coordinator.unsettled.clear();
  coordinator.state.actions.push({ id: 'uncertain', action: 'work', reason: 'Host result unknown', content: 'Original task', evidenceIds: [], status: 'needs_review', blocksExecution: true, revision: 0, createdAt: 1 }, { id: 'queued', action: 'work', reason: 'Queued task', content: 'Replacement task', evidenceIds: [], status: 'queued', revision: 0, createdAt: 2 });
  await coordinator.tick({ decisionEnabled: false });
  assert.equal(works, 0); assert.equal(coordinator.state.actions[1].deferredReason, 'unresolved_execution');
  await coordinator.close();
});

test('accepted rhythm is durably retained in the decision and an invalid host gate fails before side effects', async () => {
  const saves = [], coordinator = new InitiativeCoordinator({ project, model, provider: providerFor(decision({ rhythm })), saveState: state => { saves.push(state); } });
  await coordinator.observe(events[0]);
  await assert.rejects(coordinator.tick({ decisionEnabled: 'false' }), { code: 'invalid_policy' });
  await coordinator.tick();
  assert.deepEqual(saves.at(-1).lastDecision.rhythm, rhythm);
  const restored = new InitiativeCoordinator({ project, model, state: saves.at(-1) });
  assert.deepEqual(restored.snapshot().lastDecision.rhythm, rhythm);
  assert.equal(resolveProjectRhythm({ assessment: restored.snapshot().lastDecision.rhythm, now: 1000, schedules: project.schedules }).initiative.eligible, false);
  await coordinator.close(); await restored.close();
});

test('project rhythm remains in the decision receipt and is excluded from execution and action history', async () => {
  const handled = [], saves = [];
  const value = decision({ action: 'share', content: 'The completed report is ready.', evidenceIds: ['evidence-1'], rhythm });
  const coordinator = new InitiativeCoordinator({ project, model, provider: providerFor(value), saveState: state => { saves.push(state); }, handlers: { share: async action => { handled.push(action); return { usage: { totalTokens: 0 } }; } } });
  await coordinator.observe(events[0]); await coordinator.tick(); await coordinator.idle();
  assert.equal(handled.length, 1); assert.equal(handled[0].rhythm, undefined);
  assert.equal(coordinator.snapshot().actions.length, 1); assert.equal(coordinator.snapshot().actions[0].rhythm, undefined);
  assert.equal(saves.some(state => state.actions.some(action => Object.hasOwn(action, 'rhythm'))), false);
  assert.deepEqual(saves.at(-1).lastDecision.rhythm, rhythm);
  await coordinator.close();
});
