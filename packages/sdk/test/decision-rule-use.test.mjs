import test from 'node:test';
import assert from 'node:assert/strict';
import { turnRouteTemplate, ruleExposureQuestions, combineRuleExposure, lessonAppliedTemplate, combineLessonApplied, lintDecisionTemplate, validateSpecTemplate, DECISION_THRESHOLDS, EXPOSURE_INJECTED, LESSON_USE_OPTIONS, TEMPLATE_SPECS, stakeThreshold } from '../src/decision-templates.mjs';
import { buildDecisionState, DECISION_STATE_ROOTS, USE_LESSON_LIMIT, USE_METHOD_LIMIT, EXPOSE_LESSON_LIMIT, EXPOSE_METHOD_LIMIT } from '../src/decision-state.mjs';
import { validateHostTemplatePlan, minimizeDecisionState, deriveDecisionPolicy, STATE_CHARS_CEILING } from '../src/decision-kernel.mjs';

// D1 (plan §2.2 D1): the two judgment points, exposure in turn.route and use in lesson.applied v2. The thresholds come from
// docs/research/jev-rule-use-probe-20261005.md; here are the plan shapes, the combiners and the sizes.
const yes = probability => ({ type: 'boolean', probability });
const choice = (choice, probabilities) => ({ type: 'choice', choice, probabilities });
const use = (followed, wentAgainst, notRelevant, unclear = 0) => choice('followed', { followed, went_against: wentAgainst, not_relevant_here: notRelevant, unclear });
const rule = (index, extra = {}) => ({ text: `Rule ${index}: always do thing ${index}.`, ...extra });

test('exposure: the rule questions ride turn.route, pass the kernel and the lint, and name the rulebook paths', () => {
  const plan = turnRouteTemplate({ efforts: ['low', 'medium', 'high'], memory: true, capture: { outputs: [{ text: 'x' }], threads: [], questions: [] }, rulebook: { lessons: 12, methods: 8 } });
  assert.deepEqual(Object.keys(plan.questions).filter(id => /^(rule|method)_/.test(id)), [...Array.from({ length: 12 }, (_, index) => `rule_${index}`), ...Array.from({ length: 8 }, (_, index) => `method_${index}`)]);
  assert.doesNotThrow(() => validateHostTemplatePlan(plan)); assert.deepEqual(lintDecisionTemplate(plan), []);
  assert.ok(Object.keys(plan.questions).length > 20, 'more questions than the old cap of twenty: the spec raises it for this template');
  assert.match(plan.questions.rule_3.instructions, /lesson with id L3 in `rulebook\.lessons`/); assert.match(plan.questions.method_2.instructions, /"when" field of the working rule with id M2 in `rulebook\.methods`/);
  // No rulebook, no rule questions; the plan is what it was.
  assert.deepEqual(Object.keys(turnRouteTemplate({ memory: true }).questions).filter(id => /^(rule|method)_/.test(id)), []);
  // Capped at what the spec allows: 12 lessons and 8 working rules.
  assert.deepEqual(Object.keys(ruleExposureQuestions({ lessons: 40, methods: 40 })).length, EXPOSE_LESSON_LIMIT + EXPOSE_METHOD_LIMIT);
  assert.ok(DECISION_STATE_ROOTS['turn.route'].includes('rulebook'));
  // The plan's own bound: too many questions is refused, not cut.
  const spec = TEMPLATE_SPECS['turn.route'], over = { ...plan, questions: { ...plan.questions, ...Object.fromEntries(Array.from({ length: spec.maxQuestions }, (_, index) => [`rule_${index + 40}`, plan.questions.rule_0])) } };
  assert.equal(validateSpecTemplate(over), null);
});

test('exposure: only a confident yes counts, the most confident first; no answer at all is not an answer', () => {
  const stake = DECISION_THRESHOLDS.points['turn.route'].rule;
  assert.equal(stake, .67, 'between the plain misses (up to 0.57) and the plain hits (from 0.76) of the labelled set');
  const answers = { rule_0: yes(.9), rule_1: yes(.66), rule_2: yes(.67), rule_3: yes(.2), method_0: yes(.99), method_1: yes(.5) };
  const verdict = combineRuleExposure(answers, { lessons: 4, methods: 2 });
  assert.deepEqual(verdict.lessons, [{ index: 0, p: .9 }, { index: 2, p: .67 }]); assert.deepEqual(verdict.methods, [{ index: 0, p: .99 }]);
  assert.equal(verdict.answered, true);
  assert.equal(combineRuleExposure({}, { lessons: 2, methods: 0 }).answered, false); assert.deepEqual(combineRuleExposure({}, { lessons: 2, methods: 0 }).lessons, []);
  assert.equal(combineRuleExposure({ rule_0: yes(.9) }, { lessons: 2, methods: 0 }).answered, false, 'one of two answered');
  assert.equal(combineRuleExposure({}, { lessons: 0, methods: 0 }).answered, false);
  assert.equal(EXPOSURE_INJECTED, 5);
  // The LLM backend's tiers are raised by its offset, a literal line too.
  assert.equal(combineRuleExposure({ rule_0: yes(.7) }, { lessons: 1, backend: 'llm' }).lessons.length, 0);
});

test('exposure: the rulebook state carries each rule\'s body, bounded, and fits the point\'s budget with every question asked', () => {
  const lessons = Array.from({ length: 14 }, (_, index) => rule(index, { text: 'L'.repeat(900) })), methods = Array.from({ length: 10 }, (_, index) => ({ title: `Method ${index}`.repeat(10), when: 'W'.repeat(400), text: 'B'.repeat(2000) }));
  const state = buildDecisionState('turn.route', { message: 'M'.repeat(5000), project: { title: 'Novel', goal: 'g' }, rulebook: { lessons, methods } });
  assert.equal(state.rulebook.lessons.length, EXPOSE_LESSON_LIMIT); assert.equal(state.rulebook.methods.length, EXPOSE_METHOD_LIMIT);
  assert.deepEqual(state.rulebook.lessons.slice(0, 2).map(row => row.id), ['L0', 'L1']); assert.equal(state.rulebook.methods[0].id, 'M0'); assert.ok(state.rulebook.methods[0].text.length <= 500); assert.ok(state.rulebook.methods[0].when.length <= 160);
  const policy = deriveDecisionPolicy('turn.route'), sent = minimizeDecisionState(state, { maxChars: policy.maxStateChars });
  const chars = value => typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.values(value).reduce((sum, item) => sum + chars(item), 0) : 0;
  assert.ok(chars(sent) <= policy.maxStateChars && chars(sent.rulebook) === chars(state.rulebook), 'every rule reaches the judge whole even beside the longest message');
  assert.deepEqual(buildDecisionState('turn.route', { message: 'm', rulebook: { lessons: [], methods: [] } }).rulebook, {}, 'an empty rulebook is empty');
  assert.equal(buildDecisionState('turn.route', { message: 'm' }).rulebook, undefined);
});

test('use: one choice per rule, four options, valid for the kernel and the lint; a lesson and a working rule ask the same question about their own path', () => {
  const plan = lessonAppliedTemplate({ lessons: 3, methods: 2 });
  assert.deepEqual(Object.keys(plan.questions), ['use_0', 'use_1', 'use_2', 'usem_0', 'usem_1']);
  for (const question of Object.values(plan.questions)) { assert.equal(question.type, 'choice'); assert.deepEqual(Object.keys(question.criteria), [...LESSON_USE_OPTIONS]); }
  assert.doesNotThrow(() => validateHostTemplatePlan(plan)); assert.deepEqual(lintDecisionTemplate(plan), []);
  assert.match(plan.questions.use_1.instructions, /lesson with id L1 in `lessons\.rules`/); assert.match(plan.questions.usem_1.instructions, /working rule with id M1 in `lessons\.methods`/);
  assert.match(plan.questions.use_0.instructions, /not_relevant_here when the situation it is about does not come up/);
  const full = lessonAppliedTemplate({ lessons: 40, methods: 40 });
  assert.equal(Object.keys(full.questions).length, USE_LESSON_LIMIT + USE_METHOD_LIMIT); assert.doesNotThrow(() => validateHostTemplatePlan(full)); assert.deepEqual(lintDecisionTemplate(full), []);
  assert.ok(JSON.stringify(full).length < 96000);
  assert.ok(stakeThreshold('medium') > DECISION_THRESHOLDS.points['lesson.applied'].followed, 'followed is read lower than the others, from its measured gap');
});

test('use: the judge\'s own distribution says what the turn did; only a confident option counts, anything else changes nothing', () => {
  const t = DECISION_THRESHOLDS.points['lesson.applied'];
  assert.deepEqual([t.followed, t.wentAgainst, t.notRelevant], [.6, 'medium', 'medium']);
  const answers = {
    use_0: use(.92, .02, 0, .06), use_1: use(.62, .18, 0, .2), use_2: use(.55, .3, 0, .15), use_3: use(.01, .98, 0, .01), use_4: use(0, .01, .96, .03), use_5: use(.3, .45, .1, .15),
    use_6: use(.3, .2, .1, .4), usem_0: use(.9, .05, 0, .05), usem_1: use(.05, .8, .1, .05),
  };
  const verdict = combineLessonApplied(answers, { lessons: 8, methods: 2 });
  assert.deepEqual(verdict.lessons.map(row => row.use), ['followed', 'followed', 'unsure', 'went_against', 'not_relevant', 'unsure', 'unsure', 'unsure'], 'use_7 has no answer: unsure');
  assert.deepEqual(verdict.methods.map(row => row.use), ['followed', 'went_against']);
  assert.deepEqual([verdict.followed, verdict.wentAgainst, verdict.notRelevant], [[0, 1], [3], [4]]); assert.deepEqual([verdict.methodsFollowed, verdict.methodsWentAgainst, verdict.methodsNotRelevant], [[0], [1], []]);
  assert.equal(verdict.lessons[0].p, .92); assert.equal(verdict.answered, false, 'one question had no answer');
  assert.equal(combineLessonApplied(Object.fromEntries(Array.from({ length: 2 }, (_, index) => [`use_${index}`, use(.9, 0, 0, .1)])), { lessons: 2 }).answered, true);
  // An unclear lead is an answer that says nothing; a followed lead below its line is unsure, whoever wins.
  assert.equal(combineLessonApplied({ use_0: choice('unclear', { followed: .1, went_against: .1, not_relevant_here: .1, unclear: .7 }) }, { lessons: 1 }).lessons[0].use, 'unsure');
  assert.equal(combineLessonApplied({ use_0: use(.59, .1, .1, .21) }, { lessons: 1 }).lessons[0].use, 'unsure'); assert.equal(combineLessonApplied({ use_0: use(.6, .1, .1, .2) }, { lessons: 1 }).lessons[0].use, 'followed');
  assert.equal(combineLessonApplied({ use_0: use(.1, .74, .1, .06) }, { lessons: 1 }).lessons[0].use, 'unsure'); assert.equal(combineLessonApplied({ use_0: use(.1, .75, .1, .05) }, { lessons: 1 }).lessons[0].use, 'went_against');
});

test('use: the state is the turn digest and the rules\' bodies, and fits the point\'s budget at its largest', () => {
  const digest = { request: 'Write chapter twelve', firstSteps: ['read glossary.md -> ok', 'write chapters/12.md -> ok'], skipped: '(4 more steps)', lastSteps: ['write chapters/12.md -> ok'], wrote: 'chapters/12.md', excerpts: [{ path: 'chapters/12.md', text: 'Chapter twelve opens in the rain.' }], ended: '', reply: 'Done: chapters/12.md.' };
  const state = buildDecisionState('lesson.applied', { digest, lessons: [{ kind: 'preference', text: 'Cite the file.' }], methods: [{ title: 'Beat list first', when: 'writing a chapter', text: '- write beats first' }] });
  assert.deepEqual(state.reply, { request: 'Write chapter twelve', firstSteps: digest.firstSteps, between: '(4 more steps)', lastSteps: digest.lastSteps, wrote: 'chapters/12.md', written: [{ path: 'chapters/12.md', text: 'Chapter twelve opens in the rain.' }], text: 'Done: chapters/12.md.' });
  assert.deepEqual(state.lessons, { rules: [{ id: 'L0', kind: 'preference', text: 'Cite the file.' }], methods: [{ id: 'M0', title: 'Beat list first', when: 'writing a chapter', text: '- write beats first' }] });
  // Without a digest: the reply text alone, as the first version read it.
  assert.deepEqual(buildDecisionState('lesson.applied', { request: 'r', reply: 'p', lessons: [{ text: 't' }] }).reply, { request: 'r', text: 'p' });
  // The largest turn: every part at its bound, sixteen lessons and eight working rules.
  const big = { request: 'R'.repeat(900), firstSteps: Array.from({ length: 9 }, () => 'S'.repeat(400)), skipped: '(99 more steps)', lastSteps: Array.from({ length: 20 }, () => 'T'.repeat(400)), wrote: 'P'.repeat(3000), excerpts: Array.from({ length: 5 }, () => ({ path: 'p'.repeat(400), text: 'X'.repeat(2000) })), ended: 'stopped', reply: 'Y'.repeat(3000) };
  const largest = buildDecisionState('lesson.applied', { digest: big, lessons: Array.from({ length: 20 }, () => ({ kind: 'preference', text: 'L'.repeat(900) })), methods: Array.from({ length: 12 }, () => ({ title: 'T'.repeat(200), when: 'W'.repeat(400), text: 'B'.repeat(2000) })) });
  assert.equal(largest.lessons.rules.length, USE_LESSON_LIMIT); assert.equal(largest.lessons.methods.length, USE_METHOD_LIMIT); assert.equal(largest.reply.firstSteps.length, 6); assert.equal(largest.reply.lastSteps.length, 14); assert.equal(largest.reply.written.length, 3);
  const policy = deriveDecisionPolicy('lesson.applied'), sent = minimizeDecisionState(largest, { maxChars: policy.maxStateChars });
  const chars = value => typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.values(value).reduce((sum, item) => sum + chars(item), 0) : 0;
  assert.equal(chars(sent), chars(largest), 'nothing is cut by the kernel: the state fits by construction'); assert.ok(chars(largest) <= policy.maxStateChars);
  assert.deepEqual(sent.lessons.rules.at(-1).id, `L${USE_LESSON_LIMIT - 1}`);
});

test('the state ceiling: the two D1 points read more than the old 10000 characters, and the points that never did keep their size', () => {
  assert.equal(STATE_CHARS_CEILING, 24000);
  assert.equal(deriveDecisionPolicy('turn.route').maxStateChars, 16000); assert.equal(deriveDecisionPolicy('lesson.applied').maxStateChars, 20000);
  // gene.consolidate was declared 24000 and always cut to 10000 by the ceiling its measurements were made under; it stays at that.
  assert.equal(deriveDecisionPolicy('gene.consolidate').maxStateChars, 10000);
  for (const point of ['mind.judge', 'work.coverage', 'memory.filter']) assert.equal(deriveDecisionPolicy(point).maxStateChars, 10000, point);
  const long = { turn: { message: 'x'.repeat(2400) }, background: { active: 'no', work: [] }, project: { title: 't', goal: 'g' }, rulebook: { lessons: Array.from({ length: 12 }, (_, index) => ({ id: `L${index}`, text: 'y'.repeat(240) })), methods: Array.from({ length: 8 }, (_, index) => ({ id: `M${index}`, title: 't'.repeat(60), when: 'w'.repeat(160), text: 'z'.repeat(500) })) } };
  const size = value => JSON.stringify(value ?? {}).length;
  assert.ok(size(minimizeDecisionState(long, { maxChars: 6000 }).rulebook) < size(long.rulebook), 'at the old 6000 the rulebook was cut');
  assert.equal(size(minimizeDecisionState(long, { maxChars: deriveDecisionPolicy('turn.route').maxStateChars }).rulebook), size(long.rulebook), 'at the new bound the longest message and every rule fit');
});
