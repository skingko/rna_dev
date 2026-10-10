import test from 'node:test';
import assert from 'node:assert/strict';
import { turnRouteTemplate, mindJudgeTemplate, captureQuestions, combineCapture, combineMindJudge, lintDecisionTemplate, validateSpecTemplate, CAPTURE_KEYS } from '../src/decision-templates.mjs';
import { buildDecisionState } from '../src/decision-state.mjs';

const noul = p => ({ type: 'boolean', probability: p });
const choice = (value, confidence = .95) => ({ type: 'choice', choice: value, confidence, probabilities: { [value]: confidence } });

test('turn.route capture questions: English, atomic, escape options, lint-clean and spec-valid within one request', () => {
  const plan = turnRouteTemplate({ efforts: ['low', 'medium', 'high'], memory: true, skills: [{ id: 'a', name: 'A', description: 'a skill' }], background: true, fastModel: { providerId: 'p', modelId: 'm' },
    capture: { outputs: [{ text: '报告：……' }, { text: 'second' }], threads: [{ title: 'Ink shader' }] } });
  for (const id of [...CAPTURE_KEYS, 'durable_vs_one_off', 'target_of_feedback']) assert.ok(plan.questions[id], id);
  assert.ok(Object.keys(plan.questions).length <= 20, 'fits one request');
  assert.deepEqual(lintDecisionTemplate(plan), []);
  assert.ok(validateSpecTemplate(plan), 'spec-valid');
  assert.deepEqual(Object.keys(plan.questions.target_of_feedback.criteria), ['out_0', 'out_1', 'thr_0', 'none', 'unknown']);
  assert.ok(Object.values(captureQuestions()).every(question => /[A-Za-z]/.test(question.instructions) && !/[一-鿿]/.test(question.instructions)), 'English instructions');
  assert.equal(captureQuestions().target_of_feedback, undefined, 'no target question without enumerated outputs');
  assert.equal(turnRouteTemplate({}).questions.is_correction, undefined, 'capture is opt-in');
});

test('capture combiner: medium stake per signal, abstains in the uncertain band, maps target indexes', () => {
  const out = combineCapture({ is_correction: noul(.9), is_standing_preference: noul(.5), is_approval: noul(.1), has_pending_request: noul(.7), durable_vs_one_off: choice('durable'), target_of_feedback: choice('out_1') }, { outputs: 2, threads: 0 });
  assert.deepEqual(out, { isCorrection: true, isApproval: false, durable: 'durable', target: { kind: 'output', index: 1 } });
  assert.equal(combineCapture({ is_correction: noul(.8) }, { backend: 'llm' }).isCorrection, undefined, 'LLM judge thresholds are raised');
  assert.equal(combineCapture({ target_of_feedback: choice('out_2') }, { outputs: 1 }).target, undefined, 'unknown index is ignored');
});

test('mind.judge template + state: positional ids, lint-clean, bounded; combiner stakes', () => {
  const plan = mindJudgeTemplate({ dedup: 3, applies: 4, resolved: 2 });
  assert.equal(Object.keys(plan.questions).length, 15, 'three questions per dedup lesson: same, refines, contradicts');
  assert.deepEqual(lintDecisionTemplate(plan), []); assert.ok(validateSpecTemplate(plan));
  assert.equal(Object.keys(mindJudgeTemplate({ dedup: 9, applies: 30, resolved: 20 }).questions).length, 5 * 3 + 12 + 8);
  const state = buildDecisionState('mind.judge', { candidate: 'Keep reports short', lessons: [{ kind: 'preference', text: 'Reports under 300 words' }], commitments: [{ request: 'Report test results', createdAt: Date.now() - 1000 }], evidence: ['Assistant: all tests pass'], message: 'x' });
  assert.deepEqual(state.mind.lessons[0], { id: 'L0', kind: 'preference', text: 'Reports under 300 words' }); assert.equal(state.mind.commitments[0].id, 'C0'); assert.equal(state.mind.commitments[0].age, 'just_now');
  const combined = combineMindJudge({ same_0: noul(.8), contradicts_0: noul(.8), refines_0: noul(.8), refines_1: noul(.97), applies_0: noul(.1), applies_1: noul(.9), resolved_0: noul(.9) });
  assert.deepEqual(combined, { same: [0], contradicts: [], refines: [1], applies: [1], notApplies: [0], resolved: [0] }, 'contradicts and refines need the high stake');
});
