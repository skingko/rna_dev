import test from 'node:test';
import assert from 'node:assert/strict';
import { geneRouteTemplate, geneReviewTemplate, geneConsolidateTemplate, combineGeneConsolidate, GENE_PLACE_LIMIT } from '../src/decision-templates.mjs';
import { validateHostTemplatePlan } from '../src/decision-kernel.mjs';

// Seen live (0.46.2 → 0.48.7): gene.route gained a `periodic` question but its spec did not, so the kernel rejected
// every plan as invalid_assessment_plan and no lesson was routed into evolution for days.
test('the evolution templates pass the kernel validation they are sent through', () => {
  assert.doesNotThrow(() => validateHostTemplatePlan(geneRouteTemplate()));
  for (const args of [{}, { existing: 2 }, { existing: 3, replaced: 2 }]) assert.doesNotThrow(() => validateHostTemplatePlan(geneReviewTemplate(args)));
  for (const existing of [1, 6, GENE_PLACE_LIMIT]) assert.doesNotThrow(() => validateHostTemplatePlan(geneConsolidateTemplate({ existing })), `consolidate with ${existing}`);
});

test('work.completion (D2, shadow) passes kernel validation with all of its question ids listed in TEMPLATE_SPECS', async () => {
  const { workCompletionTemplate } = await import('../src/decision-templates.mjs');
  assert.doesNotThrow(() => validateHostTemplatePlan(workCompletionTemplate()));
});

test('session.resume (shadow) passes kernel validation; likely = (work left or iterating) and not closed', async () => {
  const { sessionResumeTemplate, combineSessionResume } = await import('../src/decision-templates.mjs');
  const { buildDecisionState } = await import('../src/decision-state.mjs');
  assert.doesNotThrow(() => validateHostTemplatePlan(sessionResumeTemplate()));
  const state = buildDecisionState('session.resume', { idle: '2-6h', conversationTurns: '10+', latest: true, projectTurns: '10+', lastUserMessage: '继续写第 41 章', lastReply: '第 41 章写好了。要我接着写第 42 章吗？', plan: ['写第 42 章'], project: { title: 'novel' } });
  assert.deepEqual(Object.keys(state.resume), ['idle', 'conversationTurns7d', 'latestConversation', 'projectTurns7d', 'lastUserMessage', 'lastReply', 'openPlan']);
  const yes = probability => ({ type: 'boolean', probability });
  assert.equal(combineSessionResume({ work_left: yes(.9), iterating: yes(.2), closed: yes(.1) }).likely, true);
  assert.equal(combineSessionResume({ work_left: yes(.2), iterating: yes(.9), closed: yes(.9) }).likely, false, 'a closed topic is not resumed');
  assert.equal(combineSessionResume({ work_left: yes(.5), iterating: yes(.5), closed: yes(.5) }).likely, false, 'uncertain is not likely');
});

test('placing among every rule in force can name any of them', () => {
  const answers = { overlap: { type: 'choice', choice: 'rule_17', probabilities: { rule_17: .95, none: .05 } }, adds: { type: 'boolean', probability: .02 } };
  assert.deepEqual(combineGeneConsolidate(answers, { existing: 20 }), { action: 'skip', index: 17 });
  assert.deepEqual(combineGeneConsolidate(answers, { existing: 10 }), { action: 'add', index: null }, 'an index beyond the list is not a match');
});
