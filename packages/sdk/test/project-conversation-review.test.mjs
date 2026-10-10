import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenConversationEvidence, validateConversationReview } from '../src/project-conversation-review.mjs';
import { validateProjectGenome } from '../src/project-genome.mjs';
import { projectGenomeFixture } from './fixtures/project-genome.mjs';

const fixture = () => {
  const testCase = { input: 'The source says payer status was not measured. Do not infer historical absence.', followUps: [{ input: 'Explain the distinction without changing the artifact.' }], reviewConversation: true };
  const sides = Object.fromEntries(['left', 'right'].map(side => [side, { turns: [
    { turn: 1, input: testCase.input, answer: 'Payer data was never collected.' },
    { turn: 2, input: testCase.followUps[0].input, answer: 'The source does not establish the collection history. The artifact is unchanged.' },
  ] }]));
  const evidence = frozenConversationEvidence(testCase, sides);
  const review = Object.fromEntries(['left', 'right'].map(side => [side, { turns: evidence.sides[side].turns.map((turn, index) => ({ turn: turn.turn, answerId: turn.answerId, assessment: index ? 'no_material_issue_found' : 'issue_found', reason: index ? 'Later explanation is qualified.' : 'Missing measurement was expanded to a historical claim.', issues: index ? [] : [{ kind: 'unsupported_inference', reason: 'The initial input explicitly limits the source scope.', references: [{ evidenceId: turn.answerId, quote: 'Payer data was never collected.' }, { evidenceId: turn.inputId, quote: 'payer status was not measured' }] }] })), coverage: 'complete', limitations: 'Supplied two turns only; model assessment, not exhaustive semantic proof.' }]));
  return { testCase, sides, evidence, review };
};

test('later correction retains earlier issue, with frozen exact text and every turn bound', () => {
  const { review, evidence } = fixture(), result = validateConversationReview(review, evidence, [{ left: .7, right: .7 }]);
  assert.equal(result.left.turns[0].assessment, 'issue_found'); assert.equal(result.left.turns[1].assessment, 'no_material_issue_found');
  assert.deepEqual(result, review); assert.notEqual(result, review); assert.match(evidence.evidenceHash, /^[a-f0-9]{64}$/);
});
test('legacy cases do not acquire a semantic review or extra evidence', () => {
  assert.equal(frozenConversationEvidence({ input: 'hello' }, {}), undefined); assert.equal(validateConversationReview(undefined, undefined), undefined);
});
for (const [name, mutate] of [
  ['missing first turn', r => r.left.turns.shift()],
  ['duplicate turn', r => r.left.turns[1] = structuredClone(r.left.turns[0])],
  ['opposite-side identity', r => r.left.turns[0].answerId = r.right.turns[0].answerId],
  ['opposite-side quote', r => r.left.turns[0].issues[0].references[0].evidenceId = r.right.turns[0].answerId],
  ['invented quote', r => r.left.turns[0].issues[0].references[0].quote = 'There are zero payers.'],
  ['future evidence used against earlier turn', r => r.left.turns[0].issues[0].references[1] = { evidenceId: r.left.turns[1].answerId, quote: 'The source does not establish the collection history.' }],
  ['answer without task context', r => r.left.turns[0].issues[0].references[1] = { evidenceId: r.left.turns[0].answerId, quote: 'never collected' }],
  ['task context without current answer', r => r.left.turns[0].issues[0].references[0] = structuredClone(r.left.turns[0].issues[0].references[1])],
  ['pass contradicting recorded issue', r => r.left.turns[0].assessment = 'no_material_issue_found'],
  ['empty issue', r => r.left.turns[0].issues = []],
  ['unassessed complete coverage', r => r.left.turns[1].assessment = 'not_assessable'],
]) test(`reject ${name}`, () => { const { review, evidence } = fixture(); mutate(review); assert.throws(() => validateConversationReview(review, evidence), { code: 'invalid_judge' }); });

test('semantic observations do not invent a penalty for unrelated frozen final-artifact criteria', () => {
  const { review, evidence } = fixture(); const result = validateConversationReview(review, evidence, [{ criterionId: 'final_json_value', left: 1, right: 1 }]);
  assert.equal(result.left.turns[0].assessment, 'issue_found');
  assert.equal(result.left.turns[1].assessment, 'no_material_issue_found');
});
test('host refuses missing, reordered or foreign-input turn receipts before judging', () => {
  for (const mutate of [s => s.left.turns.pop(), s => s.left.turns.reverse(), s => s.left.turns[0].input = 'unrelated', s => s.left.turns[0].answerTruncated = true]) {
    const { testCase, sides } = fixture(); mutate(sides); assert.throws(() => frozenConversationEvidence(testCase, sides), { code: 'invalid_judge' });
  }
});
test('bounded preview cannot claim full coverage or quote across omitted text', () => {
  const { testCase, sides } = fixture(); sides.left.turns[0].answer = 'a'.repeat(12000) + 'hidden-middle'.repeat(800) + 'b'.repeat(4000);
  const evidence = frozenConversationEvidence(testCase, sides), { review } = fixture();
  review.left.turns[0].answerId = evidence.sides.left.turns[0].answerId;
  review.left.turns[0].issues[0].references[0] = { evidenceId: review.left.turns[0].answerId, quote: 'aaa' };
  assert.throws(() => validateConversationReview(review, evidence), { code: 'invalid_judge' });
  review.left.coverage = 'partial'; assert.doesNotThrow(() => validateConversationReview(review, evidence));
  review.left.turns[0].issues[0].references[0].quote = 'aaabbb'; assert.throws(() => validateConversationReview(review, evidence), { code: 'invalid_judge' });
});
test('conversation review is explicit frozen suite content and requires follow-ups', () => {
  const genome = projectGenomeFixture(); genome.evaluationSuite.cases[0].reviewConversation = true;
  assert.throws(() => validateProjectGenome(genome), /follow-up/);
  genome.evaluationSuite.cases[0].followUps = [{ input: 'Explain the earlier result.' }]; assert.equal(validateProjectGenome(genome).evaluationSuite.cases[0].reviewConversation, true);
});
