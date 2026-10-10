import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { normalizeJudgeRatings } from '../src/judge-submission.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

// P4 reliability: production evolution versions 41a6ee52 / 4c9cc499 / 1cd069d7
// spent 18 author requests each because a prose final ("I have all the info…")
// restarted six-request research twice. Settled research is now reused for one
// native submission call.
const evidence = [{ id: 'observed-source', summary: 'Completion was claimed without checking the actual boundary.' }];
const context = { schemaVersion: 1, evidence: [{ id: 'observed-source', content: 'The actual tool receipt reported an unresolved boundary.' }], files: [{ path: 'src/method.js', content: '0123456789'.repeat(20) }] };
const proposal = () => { const genome = projectGenomeFixture({ candidate: true }); delete genome.evaluationSuite; return { summary: 'Check completion against actual evidence', hypothesis: 'An explicit completion check prevents unchecked delivery claims.', diagnosis: { ...diagnosisFixture(), evidenceIds: ['observed-source'] }, changes: ['Require a completion check'], genome }; };
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off' };
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30 };

test('a prose final after settled research is repaired by one native submission instead of a new research session', async () => {
  const calls = [];
  const provider = async function* (request) {
    calls.push(request); const n = calls.length, names = request.tools.map(tool => tool.name);
    if (n <= 5) { assert.ok(names.includes('learning_context_read')); yield { type: 'tool_call', id: `read-${n}`, name: 'learning_context_read', arguments: { id: 'file:src/method.js', offset: (n - 1) * 8, limit: 8 } }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    if (n === 6) { yield { type: 'text_delta', delta: 'I have all the information I need. The top-level change should add a completion check.' }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; return; }
    assert.deepEqual(names, ['submit_project_artifact']);
    assert.ok(request.messages.some(row => row.role === 'toolResult' || row.role === 'tool' || row.content?.some?.(part => part.type === 'toolResult')), 'research receipts are reused');
    yield { type: 'tool_call', id: 'submit-1', name: 'submit_project_artifact', arguments: proposal() }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'toolUse' };
  };
  const events = [];
  const result = await proposeProjectGenome({ project: { id: 'reuse' }, baseline: projectGenomeFixture(), evidence, learningContext: context, model, provider, maxAttempts: 2, onProgress: row => events.push(row) });
  assert.equal(calls.length, 7); assert.equal(result.attempts, 2); assert.equal(result.validation.passed, true);
  assert.equal(result.repairEvidence[0].error.code, 'invalid_output');
  assert.ok(events.some(row => row.type === 'author_submission_selected'));
});

test('unsupported evidence IDs are reported with the IDs the author may cite', async () => {
  let calls = 0;
  const provider = async function* () { calls++; const bad = proposal(); bad.diagnosis.evidenceIds = ['invented-id']; yield { type: 'text_delta', delta: JSON.stringify(bad) }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; };
  await assert.rejects(proposeProjectGenome({ project: { id: 'ids' }, baseline: projectGenomeFixture(), evidence, model, provider, maxAttempts: 1 }), failure => { assert.match(failure.message, /"invented-id"/); assert.match(failure.message, /"observed-source"/); return true; });
  assert.equal(calls, 1);
});

test('judge envelope normalization aliases criterion IDs only when unambiguous and known', () => {
  const schema = { properties: { ratings: { items: { properties: { criterionId: { enum: ['accuracy'] } } } } } };
  assert.deepEqual(normalizeJudgeRatings({ ratings: [{ criterion: 'accuracy', left: 1, right: 0.5, reason: 'r' }] }, schema), { value: { ratings: [{ criterionId: 'accuracy', left: 1, right: 0.5, reason: 'r' }] }, repairs: ['criterion_id_alias'] });
  assert.deepEqual(normalizeJudgeRatings({ ratings: [{ criterion: 'unknown', left: 1, right: 0.5, reason: 'r' }] }, schema).repairs, []);
  assert.deepEqual(normalizeJudgeRatings({ ratings: [{ criterion: 'accuracy', id: 'accuracy', left: 1, right: 0.5, reason: 'r' }] }, schema).repairs, []);
});

test('RRSI critic screens every candidate before evaluation with exactly one bounded repair', async () => {
  let calls = 0; const reviews = [];
  const provider = async function* () { calls++; yield { type: 'text_delta', delta: JSON.stringify(proposal()) }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; };
  const run = verdicts => proposeProjectGenome({ project: { id: 'critic' }, baseline: projectGenomeFixture(), evidence, model, provider, maxAttempts: 3, critic: async ({ attempt }) => { reviews.push(attempt); return verdicts[attempt - 1]; } });
  const repaired = await run([{ verdict: 'reject', reasons: [{ code: 'case_leakage', message: 'copies a frozen case' }], repairable: true }, { verdict: 'accept' }]);
  assert.equal(repaired.attempts, 2); assert.equal(repaired.proposal.criticReview.verdict, 'accept'); assert.equal(calls, 2);
  calls = 0; reviews.length = 0;
  await assert.rejects(run([{ verdict: 'reject', reasons: [{ code: 'x', message: 'first' }] }, { verdict: 'reject', reasons: [{ code: 'x', message: 'second' }] }, { verdict: 'accept' }]), failure => { assert.equal(failure.code, 'critic_rejected'); assert.match(failure.message, /second/); return true; });
  assert.equal(calls, 2); assert.deepEqual(reviews, [1, 2]);
  calls = 0;
  await assert.rejects(run([{ verdict: 'reject', reasons: [{ code: 'credential', message: 'secret' }], repairable: false }]), { code: 'critic_rejected' });
  assert.equal(calls, 1);
});
