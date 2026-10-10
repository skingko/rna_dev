import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { executeProjectEvaluationCase, evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { validateProjectGenome } from '../src/project-genome.mjs';
import { projectGenomeFixture } from './fixtures/project-genome.mjs';
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4096 };
const hash = value => createHash('sha256').update(value).digest('hex');
function genome(candidate = false) {
  const value = projectGenomeFixture({ candidate }); value.tools = [];
  value.evaluationSuite.cases = [1,2,3].map(index => ({ id: `conversation_${index}`, input: 'Create ledger.json with currency USD and integer cents [101,202]. Always retain integer cents and currency USD in later revisions. Summarize evidence.', requiredTerms: ['evidence'], forbiddenTerms: ['fabricated'], requiredToolIds: ['project_write'], weight: 1,
    workspace: { files: [], checks: [{ id: 'currency', kind: 'text_includes', path: 'ledger.json', values: ['"currency":"USD"'] }] },
    followUps: [
      { input: 'Append a refund of -10 cents; retain the earlier entries and summarize evidence.', artifactChecks: [{ id: 'refund', kind: 'json_equals', path: 'ledger.json', expected: { currency: 'USD', cents: [101,202,-10] } }] },
      { input: 'Add a note "reviewed". Preserve every cents entry and summarize evidence.', artifactChecks: [{ id: 'note', kind: 'json_equals', path: 'ledger.json', expected: { currency: 'USD', cents: [101,202,-10], note: 'reviewed' } }] },
    ] }));
  return value;
}
function provider({ loseConstraint = false, calls = [], abortOnSecond, afterRequest } = {}) {
  return async function* (request) {
    calls.push(request);
    const users = request.messages.filter(row => row.role === 'user'), turn = users.length, text = users.at(-1).content[0].text;
    assert.ok(!request.systemPrompt.includes('json_equals')); assert.ok(!request.systemPrompt.includes('artifactChecks'));
    if (turn === 1) assert.ok(!JSON.stringify(request.messages).includes('Add a note'), 'Future turns are not revealed before they arrive');
    if (turn === 2 && abortOnSecond) { abortOnSecond.abort(); yield { type: 'usage', usage: { totalTokens: 10 } }; return; }
    if (request.messages.at(-1).role === 'user') {
      assert.equal(users[0].content[0].text, genome().evaluationSuite.cases[0].input);
      const current = turn === 1 ? { currency: 'USD', cents: [101,202] } : turn === 2 ? { currency: loseConstraint ? 'EUR' : 'USD', cents: [101,202,-10] } : { currency: 'USD', cents: [101,202,-10], note: 'reviewed' };
      const previous = turn === 2 ? { currency: 'USD', cents: [101,202] } : { currency: loseConstraint ? 'EUR' : 'USD', cents: [101,202,-10] };
      yield { type: 'tool_call', id: `write-${turn}`, name: 'project_write', arguments: { path: 'ledger.json', expectedHash: turn === 1 ? null : hash(JSON.stringify(previous)), content: JSON.stringify(current) } };
      yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'toolUse' };
    } else { yield { type: 'text_delta', delta: `Retained evidence for turn ${turn}: ${text}` }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; }
    afterRequest?.(request);
  };
}
test('three real SDK prompts share history/workspace while checking every revision and retaining per-turn cost', async () => {
  const calls = [], result = await executeProjectEvaluationCase({ genome: genome(), caseId: 'conversation_1', model, provider: provider({ calls }) });
  assert.equal(result.result.passed, true); assert.equal(result.result.turns.length, 3); assert.equal(calls.length, 6);
  assert.deepEqual(result.result.turns.map(turn => turn.usage.totalTokens), [20,20,20]); assert.equal(result.usage.totalTokens, 60);
  assert.ok(result.result.turns.every(turn => turn.checks.artifactInvariants)); assert.equal(result.result.turns[2].revision.passed, true);
  assert.equal(result.evaluationExecution.cases[0].conversation.turns, 3); assert.equal(result.evaluationExecution.cases[0].conversation.session, 'persistent');
  assert.equal(result.result.turns[0].workspace.artifacts[0].content, '{"currency":"USD","cents":[101,202]}');
  assert.equal(result.result.turns[2].workspace.artifacts[0].content, '{"currency":"USD","cents":[101,202,-10],"note":"reviewed"}');
});
test('later repair cannot erase an earlier lost currency constraint or refund failure', async () => {
  const result = await executeProjectEvaluationCase({ genome: genome(), caseId: 'conversation_1', model, provider: provider({ loseConstraint: true }) });
  assert.equal(result.result.workspace.passed, true); assert.equal(result.result.turns[2].passed, true);
  assert.equal(result.result.turns[1].checks.artifactInvariants, false); assert.equal(result.result.turns[1].checks.revisionArtifacts, false);
  assert.equal(result.result.checks.conversation, false); assert.equal(result.result.passed, false);
});
test('a failed intermediate candidate turn stops paid judging despite a correct final artifact', async () => {
  const calls = [], normal = provider({ calls }), failing = provider({ loseConstraint: true, calls });
  const result = await evaluateProjectGenomes({ baseline: genome(), candidate: genome(true), model, provider: async function* (request) { assert.ok(!request.systemPrompt.includes('blind evaluator')); yield* (request.systemPrompt.includes('CANDIDATE_AGENT') ? failing : normal)(request); } });
  assert.equal(result.earlyStopReason, 'candidate_deterministic_failed'); assert.equal(result.candidateScore, null); assert.equal(result.details[0].candidate.turns[2].passed, true); assert.equal(calls.length, 12);
});
test('live admission remains per-request during follow-ups and retains completed earlier turns', async () => {
  let admitted = 0; const calls = [];
  await assert.rejects(executeProjectEvaluationCase({ genome: genome(), caseId: 'conversation_1', model, provider: provider({ calls }), requestControl: { beforeRequest() { if (admitted++ === 2) throw Object.assign(new Error('bounded allowance'), { code: 'budget' }); } } }), error => {
    assert.equal(error.code, 'budget'); assert.equal(error.usage.totalTokens, 20); assert.equal(error.requests.length, 2); assert.equal(error.evaluationEvidence.execution.turns[0].passed, true); return true;
  });
  assert.equal(calls.length, 2);
});
test('cancelled follow-up does not execute later edits and keeps the first turn evidence', async () => {
  const controller = new AbortController(), calls = [];
  await assert.rejects(executeProjectEvaluationCase({ genome: genome(), caseId: 'conversation_1', model, signal: controller.signal, provider: provider({ calls, abortOnSecond: controller }) }), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.evaluationEvidence.execution.turns[0].passed, true); assert.ok(error.requests.length <= 3); return true;
  });
  assert.equal(calls.length, 3); assert.equal(calls.filter(request => request.messages.filter(row => row.role === 'user').length === 3).length, 0);
});
test('follow-up validation preserves host boundaries, declared tools and bounded conversation length', () => {
  for (const change of [value => { value.evaluationSuite.cases[0].followUps.push(...value.evaluationSuite.cases[0].followUps, ...value.evaluationSuite.cases[0].followUps); }, value => { value.evaluationSuite.cases[0].followUps[0].requiredToolIds = ['shell']; }, value => { value.evaluationSuite.cases[0].followUps[0].artifactChecks[0].path = '../private'; }, value => { delete value.evaluationSuite.cases[0].workspace; }]) { const value = genome(); change(value); assert.throws(() => validateProjectGenome(value), { code: 'invalid_genome' }); }
});
