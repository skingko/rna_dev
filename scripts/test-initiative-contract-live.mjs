// Explicitly authorized, isolated provider acceptance: no Store constructor,
// project mutations, tool handlers, retries or production action execution.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decideInitiative } from '../packages/sdk/src/initiative.mjs';
import { resolveModel } from '../prototypes/control-center/configuration.mjs';
import { readStateFile } from '../prototypes/control-center/state-shards.mjs';

const stateFile = resolve(process.argv[2] ?? 'prototypes/control-center/.state/state.json');
const reportFile = resolve(process.argv[3] ?? 'prototypes/control-center/qa/initiative-contract-live-report.json');
const state = readStateFile(stateFile).state;
const selection = state.projects.find(project => project.initiativeRuntime?.modelSelection)?.initiativeRuntime.modelSelection ?? state.configuration.defaultModel;
const model = resolveModel(state.configuration, selection), provider = state.configuration.providers.find(item => item.id === model.providerId);
const secrets = JSON.parse(readFileSync(`${stateFile}.secrets`, 'utf8'));
const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : secrets[provider.id];
if (!apiKey || model.execution !== 'rna') throw new Error('A configured real model credential is required.');
const cases = [
  { id: 'wait-complete-contract', availableActions: [], events: [{ id: 'fixture-observed', type: 'status', summary: 'Artificial QA project is idle. No action has been requested or justified and no action handlers are enabled.' }], project: { focus: 'Observe the artificial fixture only.' } },
  { id: 'work-complete-contract', availableActions: ['work'], events: [{ id: 'fixture-test-failure', type: 'test_failure', summary: 'Artificial QA test expects normalize(0) to preserve zero, but the reviewed implementation uses value || 1 and returns one. This is a reproducible fixture defect.' }], project: { focus: 'Investigate the artificial fixture defect.', actionContracts: { work: { enabled: true, scope: 'Read-only investigation of the artificial test evidence and a proposed correction.', effects: 'Only an intent is being validated; the QA host will not execute this handler.' } } } },
  { id: 'ask-complete-contract', availableActions: ['ask'], events: [{ id: 'fixture-required-choice', type: 'user_request', summary: 'Artificial QA task requires choosing either browser or desktop as a release target before the next implementation decision. The user has provided neither target; both options are valid and materially different.' }], project: { focus: 'Resolve the missing release target.', actionContracts: { ask: { enabled: true, scope: 'Present a structured question with browser and desktop options. Include a brief content introduction and cite the fixture event.', effects: 'Only validation, no question is sent to any user and no action handler is executed.' } } } }
];
const report = { version: 1, startedAt: new Date().toISOString(), model: { id: model.modelId, reasoning: model.reasoning, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens }, scope: 'Isolated artificial project data only. Real paid decision requests; zero production mutations or action executions; each case has one attempt. Usage is QA usage recorded here, not the production chat ledger.', cases: [], totalTokens: 0 };
for (const testCase of cases) {
  const start = Date.now();
  try {
    const result = await decideInitiative({ project: { id: `rna-contract-${testCase.id}`, ...testCase.project }, events: testCase.events, availableActions: testCase.availableActions, model, apiKey, maxAttempts: 1, signal: AbortSignal.timeout(120000) });
    const decision = result.decision;
    report.cases.push({ id: testCase.id, passed: result.status === 'decided', action: decision?.action, evidenceCount: decision?.evidenceIds.length, contentLength: decision?.content.length, nextReviewAfterMs: decision?.nextReviewAfterMs, questionsCount: decision?.questions?.length ?? 0, permissionRequest: Boolean(decision?.permissionRequest), attempts: result.attempts, usage: result.usage, durationMs: Date.now() - start });
    report.totalTokens += result.usage?.totalTokens ?? 0;
  } catch (error) {
    report.cases.push({ id: testCase.id, passed: false, code: /^[a-z_]{1,80}$/.test(error.code ?? '') ? error.code : 'request_failed', decisionValidation: error.initiativeFailure?.decisionValidation, responseBytes: error.initiativeFailure?.request?.responseBytes, responseSha256: error.initiativeFailure?.request?.responseSha256, usage: error.usage, durationMs: Date.now() - start });
    report.totalTokens += error.usage?.totalTokens ?? 0;
  }
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const last = report.cases.at(-1); console.log(JSON.stringify({ case: last.id, passed: last.passed, action: last.action, totalTokens: last.usage?.totalTokens ?? null }));
}
report.completedAt = new Date().toISOString(); report.passed = report.cases.every(item => item.passed);
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
if (!report.passed) process.exitCode = 1;
