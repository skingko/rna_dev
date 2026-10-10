import { createDecisionKernel, createDecisionCalibration, freezeDecisionCalibrationCase, type DecisionCalibrationObservation, type DecisionCalibrationUsage } from '../src/index.js';
const fixture = freezeDecisionCalibrationCase({
  id: 'case', point: 'initiative.review', fallbackRoute: 'main-review', mainInputHash: 'a'.repeat(64), thresholdVersion: 'v1', runtimeVersion: 'v1',
  planProvenance: { source: 'main_model', receiptHash: 'b'.repeat(64) },
  assessmentPlan: { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Question', criteria: { true: 'Unresolved', false: 'Settled' } } } },
  models: { main: { provider: 'main', id: 'main', revision: 'v1', parameters: { temperature: 0 } }, jev: { provider: 'typesafe', id: 'jev', revision: 'v1' } },
});
const experiment = createDecisionCalibration({ cases: [fixture], tokenBudget: 10000 });
const kernel = createDecisionKernel({ mode: 'off' });
const result = await kernel.decide(fixture.input);
const ticket = experiment.admitRequest({ caseId: 'case', mode: 'off', component: 'main', reservedTokens: 1000 });
const usage: DecisionCalibrationUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 };
experiment.settleRequest(ticket.id, { status: 'completed', networkAttempted: true, usage, latencyMs: 1, receiptHash: 'c'.repeat(64) });
const observation: DecisionCalibrationObservation = { source: 'host_verifier', receiptHash: 'd'.repeat(64), windowClosed: false,
  notification: { required: null, delivered: null, useful: null }, completion: { required: true, completed: null } };
experiment.recordRun({ caseId: 'case', mode: 'off', identityHash: fixture.identity.hash, decision: result, routeId: 'main-review', elapsedMs: 10, observation });
const delta: number | null | undefined = experiment.snapshot().comparisons[0]?.observedTokenDelta;
void delta; kernel.close();
// @ts-expect-error A JEV-generated plan cannot provide main-model provenance.
const provenance: Parameters<typeof freezeDecisionCalibrationCase>[0]['planProvenance'] = { source: 'jev', receiptHash: 'x' };
// @ts-expect-error A model's completion claim is not an execution oracle.
const source: DecisionCalibrationObservation['source'] = 'model_claim';
// @ts-expect-error Unknown metrics use null, not invented confidence strings.
const invalid: DecisionCalibrationObservation['notification'] = { required: true, delivered: false, useful: 'unknown' };
void provenance; void source; void invalid;
