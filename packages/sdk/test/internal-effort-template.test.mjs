import test from 'node:test';
import assert from 'node:assert/strict';
import { effortTemplate, combineEffortDepth, lintDecisionTemplate, TEMPLATE_SPECS, stakeThreshold, DECISION_THRESHOLDS } from '../src/decision-templates.mjs';
import { buildDecisionState, effortFacts, EFFORT_POINTS, DECISION_STATE_ROOTS } from '../src/decision-state.mjs';
import { validateHostTemplatePlan, minimizeDecisionState, deriveDecisionPolicy } from '../src/decision-kernel.mjs';
import { rankEffort, effectiveEffort, stepDownReasoning, lightestReasoning } from '../src/reasoning-effort.mjs';

const choice = probabilities => ({ depth: { type: 'choice', choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], probabilities } });

test('every effort template passes kernel validation and the template lint (no numbers, roots, data note, escape option)', () => {
  for (const point of EFFORT_POINTS) {
    const purpose = point.slice('effort.'.length), plan = effortTemplate(purpose);
    assert.doesNotThrow(() => validateHostTemplatePlan(plan), point);
    assert.deepEqual(lintDecisionTemplate(plan), [], point);
    assert.ok(TEMPLATE_SPECS[point] && DECISION_STATE_ROOTS[point] && DECISION_THRESHOLDS.points[point], point);
    assert.deepEqual(Object.keys(plan.questions.depth.criteria), ['light', 'standard', 'deep', 'unknown']);
  }
  assert.throws(() => effortTemplate('chat'), { code: 'invalid_point' });
});

test('depth is cumulative and asymmetric: light at its tier, standard when light+standard reach theirs, unknown abstains', () => {
  const t = DECISION_THRESHOLDS.points['effort.decision'], light = stakeThreshold(t.light), standard = stakeThreshold(t.standard);
  assert.equal(combineEffortDepth(choice({ light: light, standard: 1 - light - .01, deep: .01, unknown: 0 })), 'light');
  assert.equal(combineEffortDepth(choice({ light: light - .02, standard: standard - light + .05, deep: .2, unknown: 0 })), 'standard');
  assert.equal(combineEffortDepth(choice({ light: .3, standard: .3, deep: .35, unknown: .05 })), 'deep');
  assert.equal(combineEffortDepth(choice({ light: .1, standard: .1, deep: .1, unknown: .7 })), null, 'unknown as the most likely option keeps the configured effort');
  assert.equal(combineEffortDepth({}), null);
  // The LLM judge is uncalibrated: every tier is raised by the offset.
  assert.equal(combineEffortDepth(choice({ light: .8, standard: 0, deep: .2, unknown: 0 })), 'standard');
  assert.equal(combineEffortDepth(choice({ light: .8, standard: 0, deep: .2, unknown: 0 }), { backend: 'llm' }), 'deep');
  // work uses its own (probed) tiers.
  const w = DECISION_THRESHOLDS.points['effort.work'];
  assert.equal(combineEffortDepth(choice({ light: stakeThreshold(w.light), standard: 1 - stakeThreshold(w.light), deep: 0, unknown: 0 }), { point: 'effort.work' }), 'light');
});

test('the effort state keeps only call and project; facts are words and buckets, never numbers, and fit the kernel budget', () => {
  const long = 'x'.repeat(5000);
  const state = buildDecisionState('effort.decision', { facts: { wakeSources: ['user message', 'background result'], newEvidence: 'few', failureToReview: false, rawCount: 17, nested: { a: 1 }, 'bad key': 'x' }, evidence: Array.from({ length: 9 }, (_, i) => `e${i}: ${long}`), task: long, message: long, request: long, project: { title: 'Novel', taskTypes: ['creative', 'writing', 'a', 'b', 'c'] }, secret: 'nope' });
  assert.deepEqual(Object.keys(state), ['call', 'project']);
  assert.deepEqual(state.call.facts, { wakeSources: ['user message', 'background result'], newEvidence: 'few', failureToReview: 'no' });
  assert.equal(state.call.purpose, 'decision'); assert.equal(state.call.evidence.length, 6); assert.ok(state.call.evidence.every(row => row.length <= 300));
  assert.ok(state.call.task.length <= 1200 && state.call.message.length <= 1600 && state.call.request.length <= 600);
  assert.deepEqual(state.project, { title: 'Novel', kind: ['creative', 'writing', 'a', 'b'] });
  const sent = minimizeDecisionState(state, { maxChars: deriveDecisionPolicy('effort.decision').maxStateChars });
  assert.ok(JSON.stringify(sent).length < 12000);
  assert.deepEqual(effortFacts({ list: [], many: Array.from({ length: 20 }, (_, i) => `w${i}`) }), { list: ['none'], many: Array.from({ length: 8 }, (_, i) => `w${i}`) });
  assert.equal(Object.keys(effortFacts(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'yes'])))).length, 16);
});

test('effort levels: rank, effective effort, one step down and the lightest, across provider shapes', () => {
  const glm = { control: 'effort', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], providerDefault: null, canDisable: false };
  const deepseek = { control: 'effort', efforts: [{ id: 'high' }, { id: 'max' }], providerDefault: 'high', canDisable: true };
  const opus = { control: 'adaptive', efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id })), providerDefault: 'medium', canDisable: false };
  const codex = { control: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id })), providerDefault: 'medium', canDisable: false };
  const haiku = { control: 'budget', efforts: ['low', 'medium', 'high'].map(id => ({ id })), providerDefault: null, canDisable: true };
  assert.equal(rankEffort(glm, 'default'), 2, 'an unknown default ranks as the deepest level'); assert.equal(rankEffort(glm, 'off'), -1); assert.equal(rankEffort(glm, 'medium'), null);
  assert.equal(rankEffort(opus, 'default'), 1); assert.equal(rankEffort(haiku, 'default'), -1, 'omitted budget thinking is off');
  assert.equal(effectiveEffort({ reasoning: 'default', reasoningCapability: glm }), 'max'); assert.equal(effectiveEffort({ reasoning: 'default', reasoningCapability: deepseek }), 'high');
  assert.equal(effectiveEffort({ reasoning: 'default', reasoningCapability: codex }), 'medium'); assert.equal(effectiveEffort({ reasoning: 'default', reasoningCapability: haiku }), 'off'); assert.equal(effectiveEffort({ reasoning: 'low', reasoningCapability: glm }), 'low');
  assert.equal(stepDownReasoning({ reasoning: 'max', reasoningCapability: glm }), 'high'); assert.equal(stepDownReasoning({ reasoning: 'default', reasoningCapability: glm }), 'high');
  assert.equal(stepDownReasoning({ reasoning: 'low', reasoningCapability: glm }), undefined); assert.equal(stepDownReasoning({ reasoning: 'default', reasoningCapability: opus }), 'low');
  assert.equal(stepDownReasoning({ reasoning: 'high', reasoningCapability: { control: 'toggle', efforts: [{ id: 'high' }], canDisable: true } }), undefined);
  assert.equal(stepDownReasoning({ reasoning: 'max' }), undefined, 'no capability, nothing to step');
  assert.equal(lightestReasoning(glm), 'low'); assert.equal(lightestReasoning(deepseek), 'off'); assert.equal(lightestReasoning(opus), 'low');
});
