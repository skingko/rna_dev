import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { getProjectEvolutionIdentity } from '../project-evolution-identity.mjs';
import { decideInitiative } from '../../../packages/sdk/src/initiative.mjs';

const model = { protocol: 'openai', providerId: 'fixture', modelId: 'fixture', contextWindow: 64000, maxOutputTokens: 2048, reasoning: 'off' };
const observations = [{ id: 'observed-a', type: 'conversation_result', summary: 'Actual tool result omitted an input variant.', at: 1 }, { id: 'observed-b', type: 'user_observation', summary: 'The second input is also required.', at: 2 }];
function fixture() {
  return { id: 'p', rhythm: { control: 'manual' }, workspace: tmpdir(), name: 'Learning fixture', description: 'Improve verified input handling', decisionMode: 'rna-model', initialization: { status: 'ready' }, initiative: { enabled: true }, evolution: { enabled: true, minIntervalMs: 1000, lastAutonomousStartedAt: new Date(1000).toISOString(), lastEvaluatedAt: new Date(1500).toISOString() }, activeVersionId: 'baseline', versions: [{ id: 'baseline', bundle: { hash: 'baseline-hash', genome: { skills: [], tools: [] } } }], jobs: [], initiativeRuntime: { sdkState: { events: structuredClone(observations), actions: [] } } };
}
function attempt(project, evidence = observations, overrides = {}) {
  const identity = getProjectEvolutionIdentity(project, { evidence, model });
  return { ...identity, id: 'old-attempt', parentVersionId: project.activeVersionId, simulated: false, source: 'autonomous-project-evolution', state: 'rejected', evidenceIds: evidence.map(row => row.id), createdAt: new Date(1000).toISOString(), completedAt: new Date(1500).toISOString(), ...overrides };
}
function harness(project, selectedModel = model) {
  const calls = { start: 0, evaluate: 0, finish: [] };
  const context = { projectId: project.id, coordinator: { model: selectedModel, state: { revision: 1, actions: project.initiativeRuntime.sdkState.actions } } };
  const host = { project: () => project, now: () => 10000, valid: () => true, redactValues: () => [], startJob: () => { calls.start++; }, finishJob: (_context, _action, values) => { calls.finish.push(values); }, evolutionService: { evolve: async (_id, input) => { calls.evaluate++; calls.evidence = structuredClone(input.evidence); calls.learningIntent = structuredClone(input.learningIntent); assert.ok(input.evidence.length); return { status: 'rejected', summary: 'Frozen evaluation rejected the fixture hypothesis.', usage: { totalTokens: 0 }, version: { id: 'new-candidate' } }; } } };
  return { calls, run: (evidence, action = {}) => ProjectInitiativeController.prototype.learn.call(host, context, { id: 'new-action', revision: 1, ...action }, { evidence, signal: new AbortController().signal, tokenBudget: null }) };
}

test('legacy initiative sees exposure counts and bounded targets without exposing raw QA or creating evidence', () => {
  const project = fixture(), change = { id: 'skill_instructions:review', kind: 'skill_instructions', target: 'review' };
  const exposure = { schemaVersion: 1, method: 'host-intervention-exposure-v1', plan: { changes: [change] }, baseline: { changes: [{ ...change, status: 'observed' }] }, candidate: { changes: [{ ...change, status: 'unobserved', observations: [{ caseId: 'PRIVATE_CASE', reason: 'PRIVATE_RESULT' }] }] } };
  project.versions.push(attempt(project, [], { evaluation: { exposure } }));
  const host = { now: () => 10000, redactValues: () => ['review'], evolutionService: { running: new Map() }, store: { state: { sessions: [], emergency: false } } };
  const status = ProjectInitiativeController.prototype.snapshot.call(host, project, model).learningStatus;
  assert.equal(status.recentAttempts[0].exposure.counts.candidate.unobserved, 1);
  assert.equal(status.recentAttempts[0].exposure.unobservedTargets[0].target, '[REDACTED]'); assert.equal(status.evidence.availableCount, 2);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_CASE|PRIVATE_RESULT/);
});

test('learning hands the author a bounded hypothesis with only cited eligible evidence without changing the evidence identity', async () => {
  const project = fixture(), host = harness(project);
  const evidence = Array.from({ length: 20 }, (_, index) => ({ id: `observation-${index}`, type: 'conversation_result', summary: `Checked input ${index}.`, at: index }));
  const ownReceipt = { id: 'action:old-learn:completed', type: 'action_completed', summary: 'Learning cannot supply its own new evidence.' };
  project.initiativeRuntime.sdkState.actions.push({ id: 'old-learn', action: 'learn', status: 'completed' });
  const before = structuredClone(evidence), identity = getProjectEvolutionIdentity(project, { evidence, model });
  const action = { content: `  Hypothesis: ${'x'.repeat(2100)}  `, reason: `  Because: ${'y'.repeat(700)}  `, evidenceIds: [ownReceipt.id, 'not-in-evidence', evidence[0].id, evidence[0].id, ...evidence.slice(1).map(row => row.id)] };
  await host.run([...evidence, ownReceipt], action);
  assert.equal(host.calls.evaluate, 1);
  assert.deepEqual(host.calls.learningIntent, { content: action.content.trim().slice(0, 2000), reason: action.reason.trim().slice(0, 600), evidenceIds: evidence.slice(0, 16).map(row => row.id) });
  assert.deepEqual(host.calls.evidence, before); assert.deepEqual(evidence, before);
  assert.deepEqual(getProjectEvolutionIdentity(project, { evidence: host.calls.evidence, model }), identity);
  project.versions.push(attempt(project, evidence));
  const duplicate = harness(project);
  const result = await duplicate.run(evidence, { ...action, content: 'A different unverified hypothesis still has the same evidence.' });
  assert.equal(result.reason, 'learning_requires_new_evidence'); assert.equal(duplicate.calls.start, 0); assert.equal(duplicate.calls.evaluate, 0);
});

test('legacy or incomplete learning intent is omitted without inventing a hypothesis or evidence reference', async () => {
  for (const action of [{}, { content: 'Hypothesis', reason: ' ', evidenceIds: ['observed-a'] }, { content: 'Hypothesis', reason: 'Reason', evidenceIds: ['not-in-evidence'] }]) {
    const host = harness(fixture()); await host.run(observations, action);
    assert.equal(host.calls.evaluate, 1); assert.equal(host.calls.learningIntent, undefined); assert.deepEqual(host.calls.evidence, observations);
  }
});

test('autonomous admission declines reordered, retimed and pure-subset evidence only under the complete current identity', async () => {
  const project = fixture(); project.versions.push(attempt(project));
  const host = harness(project);
  for (const evidence of [[...observations].reverse().map(row => ({ ...row, at: 987654 })), [observations[0]], [observations[1]], [...observations, observations[0]]]) {
    const result = await host.run(evidence);
    assert.equal(result.superseded, true); assert.equal(result.reason, 'learning_requires_new_evidence'); assert.equal(result.usage.totalTokens, 0);
  }
  assert.equal(host.calls.start, 0); assert.equal(host.calls.evaluate, 0);
});

test('updated content, model, runtime or baseline is not permanently suppressed by an old evidence ID', async () => {
  for (const change of ['content', 'model', 'runtime', 'baseline', 'legacy-no-fingerprints']) {
    const project = fixture(), old = attempt(project); project.versions.push(old);
    let evidence = structuredClone(observations), selectedModel = model;
    if (change === 'content') evidence[0].summary = 'A new checked result for the same input now demonstrates an off-by-one defect.';
    if (change === 'model') selectedModel = { ...model, reasoning: 'high' };
    if (change === 'runtime') old.evaluationRuntimeHash = 'retired-runtime';
    if (change === 'baseline') project.versions[0].bundle.hash = 'changed-baseline-hash';
    if (change === 'legacy-no-fingerprints') { delete old.evidenceFingerprints; delete old.evidenceIdentityVersion; }
    const host = harness(project, selectedModel), result = await host.run(evidence);
    assert.equal(host.calls.start, 1, change); assert.equal(host.calls.evaluate, 1, change); assert.equal(result.superseded, undefined, change);
    assert.equal(host.calls.finish.at(-1).status, 'rejected');
  }
});

test('without a new user message, checked work receipts are available to both snapshot and handler while own learning receipts are excluded', async () => {
  const project = fixture();
  const work = { id: 'action:work-result:completed', type: 'action_completed', summary: 'Work summary claims a missing input case; inspect the recorded tool result before treating the claim as verified.', at: 3000 };
  const learned = { id: 'action:own-learn:completed', type: 'action_completed', summary: 'The previous candidate failed; this is not new evidence.', at: 4000 };
  const unavailable = ['unknown', 'deleted', 'revoked', 'running'].map(id => ({ id: `action:${id}:completed`, type: 'action_completed', summary: 'Unavailable receipt is not new external evidence.' }));
  project.initiativeRuntime.sdkState.events = [work, learned, ...unavailable];
  project.initiativeRuntime.sdkState.actions = [{ id: 'work-result', action: 'work', status: 'completed' }, { id: 'own-learn', action: 'learn', status: 'completed' },
    { id: 'deleted', action: 'work', status: 'completed', sourceDeleted: true }, { id: 'revoked', action: 'work', status: 'completed', contextRevoked: true }, { id: 'running', action: 'work', status: 'running' }];
  const view = () => ProjectInitiativeController.prototype.snapshot.call({ now: () => 10000, store: { state: { sessions: [], emergency: false } } }, project, model);
  const snapshot = view(), evidence = snapshot.learningStatus.evidence;
  assert.equal(evidence.availableCount, 1); assert.equal(evidence.availableExternalCount, 0); assert.equal(evidence.availableWorkReceiptCount, 1);
  assert.equal(evidence.uncoveredCount, 1); assert.deepEqual(evidence.uncoveredEvidenceIds, [work.id]); assert.deepEqual(evidence.uncoveredExternalEvidenceIds, []); assert.deepEqual(evidence.uncoveredWorkReceiptIds, [work.id]);
  assert.match(evidence.workReceiptMeaning, /model-authored summary, not verified tool facts/); assert.match(evidence.workReceiptMeaning, /project_history/);
  assert.match(snapshot.actionContracts.learn.prerequisites, /subjective user feedback blocks only judgments that depend on that feedback/);
  const permitted = harness(project); await permitted.run([work, learned, ...unavailable]); assert.equal(permitted.calls.evaluate, 1); assert.deepEqual(permitted.calls.evidence, [work]);
  project.versions.push(attempt(project, [work]));
  assert.equal(view().learningStatus.evidence.coveredCount, 1); assert.equal(view().learningStatus.evidence.uncoveredCount, 0);
  const duplicate = harness(project); assert.equal((await duplicate.run([work, learned])).reason, 'learning_requires_new_evidence'); assert.equal(duplicate.calls.start, 0); assert.equal(duplicate.calls.evaluate, 0);
  project.initiativeRuntime.sdkState.events = [learned];
  assert.equal(view().learningStatus.evidence.availableCount, 0);
  const selfLoop = harness(project); assert.equal((await selfLoop.run([learned])).reason, 'learning_requires_new_evidence'); assert.equal(selfLoop.calls.start, 0);
});

test('learning status exposes bounded real evaluation outcomes and current coverage independently of deliverable work', async () => {
  const project = fixture();
  project.initiativeRuntime.sdkState.events.push({ id: 'action:own-learn:completed', type: 'action_completed', summary: 'A rejected experiment is not new external evidence.' });
  project.initiativeRuntime.sdkState.actions.push({ id: 'own-learn', action: 'learn', status: 'completed' }, { id: 'last-learn', action: 'learn', status: 'cancelled', cancellationReason: 'learning_requires_new_evidence', content: 'DO_NOT_INCLUDE_RAW_INTENT', startedAt: 1000 });
  const old = attempt(project, [observations[0]], { evaluation: { gatePassed: false, evaluationComplete: false, stage: 'script_preflight', earlyStopReason: 'candidate_smoke_failed', gates: { scripts: false, minimumScore: null }, smoke: { results: Array.from({ length: 30 }, (_, index) => ({ passed: false, case: `case-${index}`, actual: 'DO_NOT_INCLUDE_ACTUAL_PAYLOAD' })) } } });
  project.versions.push({ ...old, id: 'omitted-old', error: { code: 'OMITTED_SECRET' } }, old, { ...old, id: 'last-attempt', error: { code: 'candidate_failed', diagnostic: { phase: 'script-preflight', kind: 'fixture-secret' } } });
  const host = { now: () => 10000, redactValues: () => ['fixture-secret'], evolutionService: { running: new Map() }, store: { state: { sessions: [], emergency: false } } };
  const snapshot = ProjectInitiativeController.prototype.snapshot.call(host, project, model), status = snapshot.learningStatus;
  assert.equal(status.lastAutonomousStartedAt, project.evolution.lastAutonomousStartedAt); assert.equal(status.lastEvaluatedAt, project.evolution.lastEvaluatedAt);
  assert.equal(status.lastAction.cancellationReason, 'learning_requires_new_evidence'); assert.equal(status.lastAction.finishedAt, null); assert.ok(!JSON.stringify(status).includes('DO_NOT_INCLUDE_RAW_INTENT'));
  assert.equal(status.cooldown.elapsed, true); assert.equal(status.cooldown.nextAllowedAt, 2000); assert.equal(status.evaluationInFlight, false);
  assert.equal(status.evidence.availableExternalCount, 2); assert.equal(status.evidence.coveredCount, 1); assert.equal(status.evidence.uncoveredCount, 1); assert.deepEqual(status.evidence.uncoveredEvidenceIds, ['observed-b']);
  assert.deepEqual(status.recentAttempts.map(row => row.versionId), ['old-attempt', 'last-attempt']); assert.equal(status.recentAttempts[0].failure.kind, 'candidate_smoke_failed'); assert.deepEqual(status.recentAttempts[0].failure.failedCaseIds, ['case-0', 'case-1', 'case-2']);
  assert.equal(status.recentAttempts[1].failure.kind, '[REDACTED]'); assert.ok(!JSON.stringify(status).includes('DO_NOT_INCLUDE_ACTUAL_PAYLOAD')); assert.ok(!JSON.stringify(status).includes('OMITTED_SECRET')); assert.ok(JSON.stringify(status).length < 4000);
  for (const action of ['learn', 'wait']) {
    const result = await decideInitiative({ project: snapshot, events: observations, availableActions: ['learn', 'work'], model, provider: async function* (request) {
      const input = JSON.parse(request.messages[0].content[0].text); assert.deepEqual(input.project.learningStatus, { ...status, evidence: { ...status.evidence, uncoveredEvidenceIds: ['E2'], uncoveredExternalEvidenceIds: ['E2'] } }, 'evidence ids read as the same short handles everywhere in the input');
      assert.match(input.hostActionContracts.learn.scope, /Work advances the project deliverable/); assert.match(input.hostActionContracts.learn.prerequisites, /does not require learning/);
      yield { type: 'text_delta', delta: JSON.stringify({ action, reason: 'Consider current evidence and prior results.', content: action === 'learn' ? 'Evaluate one testable input-handling hypothesis.' : '', evidenceIds: action === 'learn' ? ['observed-b'] : [], nextReviewAfterMs: 60000 }) }; yield { type: 'done', stopReason: 'stop' };
    } });
    assert.equal(result.decision.action, action);
  }
  host.now = () => 1500; host.evolutionService.running.set(project.id, {});
  const cooling = ProjectInitiativeController.prototype.snapshot.call(host, project, model);
  assert.equal(cooling.learningStatus.cooldown.elapsed, false); assert.equal(cooling.learningStatus.evaluationInFlight, true); assert.equal(cooling.actionContracts.learn.enabled, false);
  host.now = () => 10000;
  assert.equal(ProjectInitiativeController.prototype.snapshot.call(host, project, model).actionContracts.learn.enabled, false, 'An ongoing manual evaluation remains a concrete prerequisite even after the interval elapsed');
});
