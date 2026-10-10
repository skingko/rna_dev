import test from 'node:test';
import assert from 'node:assert/strict';
import { geneConsolidateTemplate, combineGeneConsolidate, mindStaleTemplate, combineMindStale, lintDecisionTemplate, validateSpecTemplate, GENE_PLACE_LIMIT, GENE_CONTRADICTS_LIMIT, MIND_STALE_LIMIT, DECISION_THRESHOLDS, stakeThreshold } from '../src/decision-templates.mjs';
import { buildDecisionState, MIND_ROW_SOURCES, MIND_ROW_SOURCE_CHARS } from '../src/decision-state.mjs';
import { minimizeDecisionState, validateHostTemplatePlan } from '../src/decision-kernel.mjs';

// C4 (reference alignment §1.3 D/F rows, §2.2 C4): the questions the revocation work asks JEV.
//   gene.consolidate v2: placement also asks, per rule, whether the new content REVERSES it (`contradicts_<n>`); a second
//   stage asks of the rules found reversed whether the new content is only a special case of them (`narrower_<n>`).
//   mind.judge `stale_<n>`: after a revocation, which notes, plan items and lessons still lean on what was withdrawn.
// Wording and thresholds come from labelled probes (docs/research/gene-contradicts-probe-20261005.md,
// docs/research/revocation-stale-probe-20261005.md); these tests keep the plans valid for the kernel and the combiners honest.
const yes = probability => ({ type: 'boolean', probability });

test('placement among every rule in force, with the reversal questions, stays inside the kernel plan of 20 questions', () => {
  for (const existing of [1, 6, 13, GENE_CONTRADICTS_LIMIT, GENE_PLACE_LIMIT]) {
    const plan = geneConsolidateTemplate({ existing, contradicts: true });
    assert.doesNotThrow(() => validateHostTemplatePlan(plan), `${existing} rules`);
    assert.ok(Object.keys(plan.questions).length <= 20);
    assert.equal(Object.keys(plan.questions).filter(id => id.startsWith('contradicts_')).length, Math.min(existing, GENE_CONTRADICTS_LIMIT), 'one reversal question per rule, up to what the plan can hold');
    assert.deepEqual(lintDecisionTemplate(plan, { point: 'gene.consolidate' }), [], `${existing} rules lint clean`);
  }
  const second = geneConsolidateTemplate({ existing: 8, narrower: [2, 5] });
  assert.doesNotThrow(() => validateHostTemplatePlan(second));
  assert.deepEqual(Object.keys(second.questions).filter(id => id.startsWith('narrower_')), ['narrower_2', 'narrower_5'], 'the second stage asks only about the rules found reversed');
  assert.deepEqual(lintDecisionTemplate(second, { point: 'gene.consolidate' }), []);
  assert.deepEqual(Object.keys(geneConsolidateTemplate({ existing: 4 }).questions), ['overlap', 'adds'], 'without the option the plan is what it was');
  assert.ok(validateSpecTemplate(geneConsolidateTemplate({ existing: 3, contradicts: true })));
});

test('the reversal verdict: a rule is reversed only at the confident line; the keys appear only when the plan asked', () => {
  const t = DECISION_THRESHOLDS.points['gene.consolidate'], line = stakeThreshold(t.contradicts);
  assert.equal(t.contradicts, 'high', 'reversing a rule retires it without asking: the high stake');
  const answers = { overlap: { type: 'choice', choice: 'rule_1', probabilities: { rule_1: .95, none: .05 } }, adds: yes(.9), contradicts_0: yes(.2), contradicts_1: yes(.96), contradicts_2: yes(line - .01), contradicts_3: yes(line) };
  assert.deepEqual(combineGeneConsolidate(answers, { existing: 4 }), { action: 'revise', index: 1, contradicts: [1, 3] }, 'at the line, not below it');
  const plain = { overlap: answers.overlap, adds: answers.adds };
  assert.deepEqual(combineGeneConsolidate(plain, { existing: 4 }), { action: 'revise', index: 1 }, 'no contradicts key when the plan did not ask: callers that never asked read what they read before');
  assert.deepEqual(combineGeneConsolidate({ overlap: { type: 'choice', choice: 'none', probabilities: { none: .9, rule_0: .1 } }, adds: yes(.5), contradicts_0: yes(.99) }, { existing: 2 }), { action: 'add', index: null, contradicts: [0] });
  // A rule beyond the list is not one.
  assert.deepEqual(combineGeneConsolidate({ overlap: answers.overlap, contradicts_5: yes(.99) }, { existing: 2 }).contradicts, []);
});

test('the special-case verdict (second stage) is read at the low line: it only ever spares a rule', () => {
  const t = DECISION_THRESHOLDS.points['gene.consolidate'];
  assert.equal(t.narrower, 'low', 'a wrong "special case" only keeps a rule; a wrong "total reversal" loses one');
  const stage = { overlap: { type: 'choice', choice: 'none', probabilities: { none: .8 } }, narrower_0: yes(stakeThreshold('low') + .02), narrower_2: yes(stakeThreshold('low') - .05) };
  assert.deepEqual(combineGeneConsolidate(stage, { existing: 3 }).narrower, [0]);
});

test('stale questions: ids are positional, the plan is valid and lint clean for each kind, and the state carries only what the judge needs', () => {
  for (const kind of ['lesson', 'tool', 'source']) {
    const plan = mindStaleTemplate({ kind, rows: 5 });
    assert.deepEqual(Object.keys(plan.questions), ['stale_0', 'stale_1', 'stale_2', 'stale_3', 'stale_4'], kind);
    assert.doesNotThrow(() => validateHostTemplatePlan(plan), kind);
    assert.deepEqual(lintDecisionTemplate(plan, { point: 'mind.judge' }), [], `${kind} lint clean`);
  }
  assert.equal(mindStaleTemplate({ kind: 'lesson', rows: 40 }).questions.stale_11 !== undefined && mindStaleTemplate({ kind: 'lesson', rows: 40 }).questions.stale_12 === undefined, true, `at most ${MIND_STALE_LIMIT} rows a call`);
  assert.equal(mindStaleTemplate({ kind: 'lesson', rows: 0 }), null);
  assert.equal(mindStaleTemplate({ kind: 'nonsense', rows: 3 }), null);
  const state = buildDecisionState('mind.judge', { rows: [{ kind: 'note', text: '日报要简洁', sources: ['写简洁点', '谢谢'] }, { kind: 'plan', text: '先搜索再写' }], revoked: '写作前先搜索', tools: { withdrawn: ['web_search: search the web'], available: ['project_read', 'prose_check'] } }, { now: 0 });
  assert.deepEqual(Object.keys(state.mind), ['rows', 'revoked', 'tools'], 'no empty lesson, commitment or evidence lists beside the rows');
  assert.deepEqual(state.mind.rows.map(row => row.id), ['N0', 'N1']);
  assert.deepEqual(state.mind.rows[0].sources, ['写简洁点', '谢谢']);
  assert.deepEqual(state.mind.tools.withdrawn, ['web_search: search the web']);
  assert.ok(minimizeDecisionState(state, { maxChars: 10000 }).mind.rows.length === 2, 'the kernel forwards the root');
  const wide = buildDecisionState('mind.judge', { rows: Array.from({ length: 30 }, (_, index) => ({ kind: 'note', text: `n${index}` })) }, { now: 0 });
  assert.equal(wide.mind.rows.length, 12);
  // The sources of a note are the messages of the whole batch it was written from (up to 8): the state shows what the caller chose,
  // up to the hard bounds, so the one message of the batch that said it is not cut away.
  const batch = buildDecisionState('mind.judge', { rows: [{ kind: 'note', text: 'n', sources: Array.from({ length: 12 }, (_, index) => `m${index} ${'x'.repeat(700)}`) }] }, { now: 0 });
  assert.equal(batch.mind.rows[0].sources.length, MIND_ROW_SOURCES); assert.equal(MIND_ROW_SOURCES, 8, 'a batch holds up to eight messages');
  assert.ok(batch.mind.rows[0].sources.every(text => text.length <= MIND_ROW_SOURCE_CHARS) && batch.mind.rows[0].sources[7].startsWith('m7 '), 'every message, each bounded');
});

test('stale verdicts: a confident yes marks a restating or tool-dependent row; a note is stale on a confident NO to "still supported"', () => {
  const t = DECISION_THRESHOLDS.points['mind.judge'];
  for (const key of ['staleLesson', 'staleTool', 'staleSource']) assert.equal(t[key], 'medium', `${key}: labelled probe, no false positive up to the line`);
  const line = stakeThreshold('medium');
  const answers = { stale_0: yes(.95), stale_1: yes(.3), stale_2: yes(line - .02), stale_3: yes(line) };
  assert.deepEqual(combineMindStale(answers, { kind: 'lesson', rows: 4 }), { stale: [0, 3] });
  assert.deepEqual(combineMindStale(answers, { kind: 'tool', rows: 4 }), { stale: [0, 3] });
  // Source: the question is whether the remaining messages still say the note, so stale is the confident no.
  const supported = { stale_0: yes(.05), stale_1: yes(.9), stale_2: yes(1 - line + .02), stale_3: yes(1 - line) };
  assert.deepEqual(combineMindStale(supported, { kind: 'source', rows: 4 }), { stale: [0, 3] });
  assert.deepEqual(combineMindStale({}, { kind: 'lesson', rows: 3 }), { stale: [] }, 'no answer marks nothing');
});
