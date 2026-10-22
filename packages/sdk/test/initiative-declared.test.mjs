import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator } from '../src/initiative.mjs';

// A run that finished can declare its own follow-up; the host then makes the decision the review would have made
// (tick({ declaredDecision })): validated like a model's decision, free of charge, recorded as declared. Anything that does
// not validate, or a failure review owed, asks the model as before.
const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'e1', type: 'action_completed', summary: 'The scheduled run finished the daily report.', at: 1000 };
const modelWait = { action: 'wait', reason: 'Nothing more.', evidenceIds: [], content: '', nextReviewAfterMs: 3600000 };
function fixture({ handlers = {}, project = { id: 'p' } } = {}) {
  const calls = [];
  const provider = async function* (options) { calls.push(options); yield { type: 'text_delta', delta: JSON.stringify(modelWait) }; yield { type: 'usage', usage: { input: 100, output: 20, totalTokens: 120 } }; yield { type: 'done', stopReason: 'stop' }; };
  const work = [];
  const coordinator = new InitiativeCoordinator({ project, model, provider, now: () => 5000, handlers: { work: async (action) => { work.push(action); return { summary: 'Checked.', usage: { totalTokens: 0 } }; }, ...handlers }, policy: { reviewMinMs: 1000, reviewMaxMs: 900000 } });
  return { calls, work, coordinator };
}
const declaredWork = { decision: { action: 'work', title: 'Check the open row', reason: 'The finished run declared this follow-up.', evidenceIds: ['e1'], content: 'Re-read the report and verify the one open row against the source.', nextReviewAfterMs: 600000 }, meta: { kind: 'task', from: ['run-1'], depth: 1 } };
const declaredWait = { decision: { action: 'wait', reason: 'The finished run declared no follow-up.', evidenceIds: [], content: '', nextReviewAfterMs: 20 * 3600000 }, meta: { kind: 'none', from: ['run-1'], depth: 0 } };

test('a declared work is admitted without a request: nothing charged, the action row and the decision say it was declared', async () => {
  const { calls, work, coordinator } = fixture();
  try {
    await coordinator.observe(event);
    const result = await coordinator.tick({ declaredDecision: declaredWork });
    assert.equal(result.status, 'decided'); assert.equal(result.decision.action, 'work'); assert.deepEqual(result.declared, { kind: 'task', from: ['run-1'], depth: 1 });
    assert.equal(result.usage.totalTokens, 0); assert.equal(calls.length, 0, 'no request went out');
    const state = coordinator.snapshot();
    assert.equal(state.usedTokens, 0); assert.equal(state.lastDecision.declared, true); assert.equal(state.decisionRevision, state.revision, 'the evidence counts as reviewed');
    await coordinator.idle();
    const action = coordinator.snapshot().actions.find(row => row.action === 'work'); assert.deepEqual(action.hostDeclared, { kind: 'task', from: ['run-1'], depth: 1 }); assert.equal(work.length, 1);
  } finally { await coordinator.close(); }
});

test('a declared wait settles the review, and the situation it was made in lets a later floor wake rest', async () => {
  const { calls, coordinator } = fixture();
  try {
    await coordinator.observe(event);
    const result = await coordinator.tick({ declaredDecision: declaredWait });
    assert.equal(result.decision.action, 'wait'); assert.equal(calls.length, 0);
    const state = coordinator.snapshot();
    assert.equal(state.decisionRevision, state.revision); assert.equal(state.lastDecision.nextReviewAfterMs, 20 * 3600000); assert.match(state.lastDecision.situation, /^[0-9a-f]{32}$/);
    const rested = await coordinator.tick({ wakeFloor: true });
    assert.equal(rested.reason, 'unchanged_since_wait', 'nothing new and the declared rest has not ended');
    assert.equal(calls.length, 0);
  } finally { await coordinator.close(); }
});

test('a declaration that does not validate asks the model: an evidence id the request does not carry', async () => {
  const { calls, coordinator } = fixture();
  try {
    await coordinator.observe(event);
    const bad = { ...declaredWork, decision: { ...declaredWork.decision, evidenceIds: ['never-shown'] } };
    const result = await coordinator.tick({ declaredDecision: bad });
    assert.equal(result.status, 'decided'); assert.equal(result.declared, undefined); assert.equal(calls.length, 1, 'the model was asked');
    assert.equal(coordinator.snapshot().lastDecision.declared, undefined);
  } finally { await coordinator.close(); }
});

test('a failure review owed, a malformed declaration, or no declaration: the model decides', async () => {
  for (const [label, declaredDecision, owed] of [['failure review owed', declaredWait, true], ['no decision object', { meta: {} }, false], ['not an object', 'wait', false]]) {
    const { calls, coordinator } = fixture();
    try {
      await coordinator.observe(event);
      if (owed) coordinator.state.pendingFailureReview = { evidenceKey: 'k', at: 1 };
      const result = await coordinator.tick({ declaredDecision });
      assert.equal(result.status, 'decided', label); assert.equal(calls.length, 1, `${label}: the model was asked`);
    } finally { await coordinator.close(); }
  }
});

test('an assessment the host rhythm asks for is not something a declaration can give: the model is asked', async () => {
  const project = { id: 'p', actionContracts: { wait: { enabled: true, purpose: 'Wait.' }, work: { enabled: true, authorization: 'ok', scope: 's', effects: 'e' }, rhythm: { enabled: true, schemaVersion: 1, requiresAssessment: true, purpose: 'Assess.' } } };
  const { calls, coordinator } = fixture({ project });
  try {
    await coordinator.observe(event);
    // The declaration cannot validate (the contract wants an assessment), so the request goes out; the fixture's answer carries none and fails
    // exactly as a model's would. What matters here is that the model was asked.
    await assert.rejects(coordinator.tick({ declaredDecision: declaredWait }), error => error.code === 'invalid_decision');
    assert.equal(calls.length, 1);
  } finally { await coordinator.close(); }
});
