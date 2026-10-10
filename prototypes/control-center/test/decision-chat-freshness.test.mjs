import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionService } from '../decision-service.mjs';
import { prepareJudgmentPolicy, validJudgmentPolicy } from '../judgment-policy-service.mjs';

// A held judge response deterministically reproduces concurrent project changes.
// No network, model, persistent project, or memory backend is used by this suite.
function fixture({ lifecycle = 'active', recurring = false, question = false } = {}) {
  let clock = 1000000, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const project = { id: 'p', name: 'Scoped recall', description: 'Preserve accepted constraints when answering', workspace: '/fixture', focus: 'Current accepted constraints',
    schedules: recurring ? [{ id: 'daily', title: 'Daily brief', task: 'Deliver tomorrow', enabled: true, revision: 1, nextRunAt: new Date(clock + 1000).toISOString() }] : [],
    observations: [], jobs: [], versions: [], initiativeRuntime: { sdkState: { actions: [] } },
    rhythmRuntime: { assessment: { lifecycle, initiative: { mode: 'adaptive' }, evolution: { mode: 'evidence' } } } };
  const session = { id: 's', projectId: 'p', status: 'idle', turns: [], items: [{ id: 'u', kind: 'user', text: 'Thanks', createdAt: new Date(clock).toISOString() }] };
  if (question) session.items.push({ id: 'question', kind: 'tool', interaction: { status: 'pending', canRespond: true } });
  const plan = { version: 1, questions: {
    memory_need: { type: 'boolean', instructions: 'Retrieve accepted constraints when the answer needs prior project knowledge; a self-contained acknowledgement needs no recall.', criteria: { true: 'The response depends on remembered project constraints.', false: 'The response is self-contained and there is no unresolved work or user decision.' } },
    task_state: { type: 'choice', instructions: 'Use recorded acceptance evidence, not claims of completion.', criteria: { active: 'Accepted work remains open.', complete: 'All accepted work has passed verification.', unknown: 'Evidence is incomplete.' } },
    user_satisfaction: { type: 'score', instructions: 'Use explicit feedback only; do not infer satisfaction from silence.', criteria: ['Explicitly rejected delivered quality.', 'Explicitly accepted delivered quality.'] },
  } };
  project.judgmentPolicy = prepareJudgmentPolicy(plan, { project, source: { kind: 'main_model', method: 'initialization', providerId: 'fixture', modelId: 'fixture', receiptId: 'main-author-receipt', createdAt: new Date(clock).toISOString() } });
  const other = { id: 'other', name: 'Unrelated', observations: [] };
  const store = { state: { settings: { realTokenBudget: null }, projects: [project, other], sessions: [session], configuration: { decisionKernel: { mode: 'active' } } },
    configurationService: { secrets: { 'judge:jev': 'isolated-test-key' } }, mutate(fn) { return fn(this.state); } };
  const service = new DecisionService(store, { now: () => clock, kernelFactory: () => ({ close() {}, async decide(input) {
    calls++; await gate;
    return { point: input.point, source: 'judge', mode: 'active', planRevision: input.hostPolicy.revision, networkAttempted: true, ledgerId: 'held-receipt', reason: 'accepted',
      policy: { yes: .8, no: .05, confidence: .9, margin: .1 }, answers: { memory_need: { type: 'boolean', probability: .01 }, task_state: { type: 'choice', choice: 'active' } },
      usage: { inputTokens: 123, outputTokens: 0 }, latencyMs: 20 };
  } }) });
  return { store, project, session, other, service, release, calls: () => calls, advance(ms) { clock += ms; } };
}
async function inflight(f, change) {
  const revision = f.project.judgmentPolicy.revision;
  const pending = f.service.chat(f.project, { sessionId: 's', turnId: 'current', userMessage: 'Thanks' });
  assert.equal(f.calls(), 1);
  change(f);
  // All cases exercise the missing evidence binding, not the existing plan CAS.
  assert.equal(validJudgmentPolicy(f.project)?.revision, revision);
  f.release(); const result = await pending;
  assert.equal(f.calls(), 1, 'stale scores must not trigger a second paid request');
  assert.equal(f.store.state.realUsage.reportedTokens, 123);
  assert.equal(f.store.state.realUsage.reservedTokens, 0);
  assert.equal(f.store.state.decisionKernelRuntime.metrics.requests, 1);
  assert.equal(f.store.state.decisionKernelRuntime.metrics.totalTokens, 123);
  await f.service.close(); return result;
}

const staleCases = [
  ['in-progress user correction', {}, f => { f.session.items.push({ id: 'correction', kind: 'user', text: 'Correction: the accepted deadline is Friday, not Monday.' }); }],
  ['completed project receives external change', { lifecycle: 'complete' }, f => { f.project.observations.push({ id: 'external', kind: 'workspace_change', text: 'The accepted source has changed', simulated: false }); }],
  ['recurring delivery receives a new verified receipt', { lifecycle: 'recurring', recurring: true }, f => { f.project.jobs.push({ id: 'delivery', status: 'completed', simulated: false, completedAt: '2026-09-28T01:00:00Z', toolReceiptCounts: { succeeded: 1 } }); }],
  ['new pending user decision', {}, f => { f.session.items.push({ id: 'question', interaction: { status: 'pending', canRespond: true } }); }],
  ['waiting user answers existing card', { lifecycle: 'waiting_user', question: true }, f => { f.session.items.find(row => row.id === 'question').interaction = { status: 'answered', canRespond: false, answer: 'Use the previously agreed constraints' }; }],
  ['new queued background work', {}, f => { f.project.initiativeRuntime.sdkState.actions.push({ id: 'work', action: 'work', status: 'queued' }); }],
  ['project focus changes without rewriting its plan', {}, f => { f.project.focus = 'Apply the corrected constraints'; }],
  ['active project becomes complete', {}, f => { f.project.rhythmRuntime.assessment.lifecycle = 'complete'; }],
  ['source user message is withdrawn', {}, f => { f.session.items[0].contextRevoked = true; }],
  ['source session is deleted', {}, f => { f.store.state.sessions = []; }],
  ['source session is revoked in place', {}, f => { f.session.contextRevoked = true; }],
  ['foreground source receipt is corrected', {}, f => {
    f.session.turns.push({ id: 'previous', status: 'completed', modelConfig: { execution: 'rna' }, completedAt: '2026-09-28T01:00:00Z' });
    f.session.items.push({ id: 'proof', turnId: 'previous', kind: 'tool', tool: { name: 'project_exec', status: 'completed', output: 'Accepted verification result' } });
  }],
];
for (const [name, options, change] of staleCases) test(`late negative memory score is discarded: ${name}`, async () => {
  const f = fixture(options), result = await inflight(f, change);
  assert.equal(result.needsMemory, true);
  assert.equal(result.source, 'fallback');
  assert.equal(result.assessment, undefined, 'a stale task/satisfaction assessment must not enter the main prompt');
  assert.equal(f.store.decisionLedger.rows().at(-1).disposition, 'stale');
});

const stableCases = [
  ['stable active project', {}, () => {}],
  ['stable completed project', { lifecycle: 'complete' }, () => {}],
  ['stable recurring project', { lifecycle: 'recurring', recurring: true }, () => {}],
  ['global telemetry tick and unrelated project', {}, f => { f.store.state.revision = 100; f.project.rhythmRuntime.lastInitiativeAt = 2000000; f.other.observations.push({ id: 'noise', text: 'Elsewhere changed' }); f.store.state.sessions.push({ id: 'elsewhere', projectId: 'other', status: 'running', items: [{ kind: 'user', text: 'Unrelated request' }] }); }],
  ['clock crosses a scheduled deadline without new delivery evidence', { lifecycle: 'recurring', recurring: true }, f => { f.advance(2000); }],
  ['initiative quiet/frequency preference alone', {}, f => { f.project.initiative = { enabled: false, cooldownMs: 3600000 }; f.project.rhythmRuntime.assessment.initiative.mode = 'quiet'; f.project.rhythmRuntime.assessment.evolution.mode = 'paused'; }],
];
for (const [name, options, change] of stableCases) test(`unaffected recall route remains fast: ${name}`, async () => {
  const f = fixture(options), result = await inflight(f, change);
  assert.equal(result.needsMemory, false);
  assert.equal(result.source, 'judge');
  assert.equal(result.assessment.planRevision, f.project.judgmentPolicy.revision);
  assert.equal(f.store.decisionLedger.rows().at(-1).disposition, 'chat_preflight');
});
