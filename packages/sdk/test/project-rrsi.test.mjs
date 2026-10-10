import test from 'node:test';
import assert from 'node:assert/strict';
import { rrsiEditBudget, rrsiConfig, systemPromptSections, projectComponentRegistry, diffProjectComponents, tagCandidateEdits, summarizeRrsiHistory, rrsiStallFlag, rrsiExploration, rrsiAuthorDirectives, rrsiCriticPrecheck, runRrsiCritic,
  calibrateRrsiNoiseBand, rrsiSelect, rrsiBlendedScore, rrsiPrescreen, runRrsiTieredEvaluation, rrsiSmokeCaseIds, rrsiSplit, rrsiChangelogEntry, rrsiHypothesisKey, RRSI_COMPONENTS } from '../src/index.mjs';
import { validateHostTemplatePlan, skillScreenTemplate, candidatePrescoreTemplate, createDecisionKernel, minimizeDecisionState } from '../src/decision-kernel.mjs';
import { projectGenomeFixture } from './fixtures/project-genome-fixture.mjs';

test('annealed edit budget matches the RRSI cosine schedule and never drops below one', () => {
  assert.deepEqual(Array.from({ length: 8 }, (_, t) => rrsiEditBudget(t, 8, 1, 4)), [4, 4, 4, 4, 3, 2, 2, 2]);
  assert.equal(rrsiEditBudget(99, 8, 1, 4), 1); assert.equal(rrsiEditBudget(0, 0, 1, 4), 4);
  assert.equal(rrsiConfig({ wReal: -1, beta1: 7, bogus: 3 }).wReal, 0.8); assert.equal(rrsiConfig({ beta1: 7 }).beta1, 7);
});

test('component registry addresses system sections, skills, tools, MCP, rhythm, communication and the evaluation standard', () => {
  const genome = projectGenomeFixture(); genome.systemPrompt = 'Intro text.\n## Research method\nVerify sources.\n## Output\nBe brief.';
  const project = { assignments: { mcpServerIds: ['browser'] }, rhythm: { control: 'auto' }, initiative: { notificationMuted: false, minRelevance: 0.6 } };
  const rows = projectComponentRegistry({ genome, project });
  assert.deepEqual(systemPromptSections(genome.systemPrompt).map(row => row.id), ['core', 'research-method', 'output']);
  for (const component of RRSI_COMPONENTS) assert.ok(rows.some(row => row.component === component), component);
  const edited = structuredClone(genome); edited.systemPrompt = edited.systemPrompt.replace('Be brief.', 'Lead with the conclusion.'); edited.skills[0].instructions += '\nNew rule.';
  const edits = diffProjectComponents(rows, projectComponentRegistry({ genome: edited, project: { ...project, assignments: { mcpServerIds: [] } } }));
  assert.deepEqual(edits.map(row => `${row.key}:${row.change}`).sort(), ['mcp_assignment:browser:removed', 'skill:' + genome.skills[0].id + ':modified', 'system_section:output:modified'].sort());
  const tagged = tagCandidateEdits({ edits, hypothesis: 'Conclusion-first answers reduce corrections', changes: ['output section: lead with conclusion'] });
  assert.equal(tagged.length, 3); assert.ok(tagged.every(row => row.hypothesis && row.hypothesisKey && row.editId));
  assert.equal(tagged.find(row => row.key === 'system_section:output').diff.note, 'output section: lead with conclusion');
});

test('history summaries exclude unmeasured failures, keep falsified hypotheses and compute the prune set', () => {
  const h = (t, key, verdict, deltaS, hypothesis = `h-${key}`) => { const component = key.split(':')[0]; return { t, editId: 'E1', key, component, verdict, deltaS, hypothesis, hypothesisKey: rrsiHypothesisKey(component, hypothesis) }; };
  const records = [h(0, 'skill:a', 'rejected', -0.02), h(1, 'system_section:core', 'accepted', 0.05), h(2, 'tool_description:t', 'critic_rejected', null), h(3, 'rhythm:project', 'infra_failed', null), h(4, 'skill:a', 'rejected', 0)];
  const summary = summarizeRrsiHistory(records, { t: 5, nPrune: 4 });
  assert.deepEqual(summary.tried, ['skill', 'system_section']);
  assert.ok(summary.untried.includes('tool_description') && summary.untried.includes('rhythm'));
  assert.deepEqual(summary.falsified.map(row => row.key), ['skill:a']);
  assert.deepEqual(summary.pruneSet.map(row => row.key), ['skill:a']);
  assert.equal(summary.attempted.tool_description, 1);
  // An adopted-then-rolled-back edit is falsified and leaves the accepted set.
  const rolled = summarizeRrsiHistory([...records, h(6, 'system_section:core', 'trial_rolled_back', null, 'h-system_section:core')], { t: 6 });
  assert.ok(rolled.falsified.some(row => row.key === 'system_section:core')); assert.equal((rolled.accepted.system_section ?? []).length, 0);
});

test('stall flag redirects the proposer to untried components and the critic enforces it', () => {
  assert.equal(rrsiStallFlag([0.5, 0.51, 0.51, 0.515], 3, 0.02), 1); assert.equal(rrsiStallFlag([0.5, 0.6], 3, 0.02), 0);
  const exploration = rrsiExploration({ stall: 1, tried: ['skill', 'system_section'] });
  assert.equal(exploration.required, true); assert.ok(exploration.untried.includes('rhythm'));
  const edits = tagCandidateEdits({ edits: [{ key: 'skill:a', component: 'skill', id: 'a', label: 'a', change: 'modified', beforeHash: 'x', afterHash: 'y' }], hypothesis: 'x' });
  assert.ok(rrsiCriticPrecheck({ edits, exploration }).reasons.some(row => row.code === 'exploration_required'));
  const directives = rrsiAuthorDirectives({ records: [], trajectory: [0.5, 0.5, 0.5, 0.5], config: rrsiConfig({ T: 4 }) });
  assert.equal(directives.budget, 4); assert.equal(directives.exploration.required, true); assert.match(directives.text, /Edit budget/);
});

test('critic precheck rejects leakage, credentials, budget overflow and falsified re-proposals; repair is bounded to one', async () => {
  const suite = projectGenomeFixture().evaluationSuite, edit = (key, hypothesis = 'more careful') => tagCandidateEdits({ edits: [{ key, component: key.split(':')[0], id: key.split(':')[1], label: key, change: 'modified', beforeHash: 'a', afterHash: 'b' }], hypothesis })[0];
  const leak = rrsiCriticPrecheck({ edits: [edit('skill:a')], addedText: `When asked about ${suite.cases[0].id} answer X`, evaluationSuite: suite });
  assert.ok(leak.reasons.some(row => row.code === 'case_leakage'));
  assert.equal(rrsiCriticPrecheck({ edits: [edit('skill:a')], addedText: 'api_key = "abcdefghijk"' }).repairable, false);
  assert.ok(rrsiCriticPrecheck({ edits: [edit('skill:a'), edit('skill:b')], budget: 1 }).reasons.some(row => row.code === 'budget_exceeded'));
  const falsified = [{ hypothesisKey: edit('skill:a').hypothesisKey }];
  assert.ok(rrsiCriticPrecheck({ edits: [edit('skill:a')], falsified }).reasons.some(row => row.code === 'falsified_hypothesis'));
  let repairs = 0;
  const rejected = await runRrsiCritic({ candidate: { n: 0 }, precheck: () => ({ verdict: 'reject', reasons: [{ code: 'x', message: 'x' }], repairable: true }), repair: async value => { repairs++; return { n: value.n + 1 }; } });
  assert.equal(rejected.verdict, 'reject'); assert.equal(repairs, 1); assert.equal(rejected.rounds.length, 2);
  const fixed = await runRrsiCritic({ candidate: { ok: false }, precheck: value => value.ok ? { verdict: 'accept', reasons: [], repairable: false } : { verdict: 'reject', reasons: [{ code: 'x', message: 'x' }], repairable: true }, repair: async () => ({ ok: true }) });
  assert.equal(fixed.verdict, 'accept'); assert.equal(fixed.repairs, 1);
});

test('noise band, cost rule, floor and the blended real/JEV score follow Algorithm 2', () => {
  const band = calibrateRrsiNoiseBand({ baselineScores: [0.70, 0.74, 0.72] });
  assert.equal(band.method, 'repeated_baseline_evaluations'); assert.ok(band.delta > 0.05 && band.delta < 0.07);
  assert.equal(calibrateRrsiNoiseBand({ caseScores: [0.5, 0.9, 0.7, 0.8] }).method, 'bootstrap_over_cases');
  assert.equal(calibrateRrsiNoiseBand({}).delta, 0.01);
  const incumbent = { S: 0.7, C: 1000 };
  assert.equal(rrsiSelect({ candidate: { S: 0.6, C: 1000 }, incumbent, sStar: 0.7, delta: 0.02 }).admissible, false);
  assert.equal(rrsiSelect({ candidate: { S: 0.8, C: 1100 }, incumbent, sStar: 0.7, delta: 0.02 }).admissible, true);
  assert.match(rrsiSelect({ candidate: { S: 0.72, C: 3000 }, incumbent, sStar: 0.7, delta: 0.05 }).reason, /cost_rule_failed/);
  assert.equal(rrsiSelect({ candidate: { S: 0.71, C: 900 }, incumbent, sStar: 0.7, delta: 0.05 }).admissible, true);
  assert.equal(rrsiSelect({ candidate: { S: 0.7, C: 1000, components: ['skill'] }, incumbent, delta: 0.05, incumbentCounts: {} }).novelty, 1);
  assert.deepEqual(rrsiBlendedScore({ real: 0.8, jev: 0.4, realCases: 1 }).score, null);
  assert.equal(rrsiBlendedScore({ real: 0.8, jev: 0.4, realCases: 3 }).score, 0.72);
  assert.equal(rrsiBlendedScore({ real: 0.8, realCases: 3 }).score, 0.8);
  assert.deepEqual(rrsiPrescreen({ better: false, source: 'judge' }).evaluate, false);
  assert.deepEqual(rrsiPrescreen({ better: false, source: 'fallback' }).evaluate, true);
});

test('tiered evaluation stops at the first failing tier and never spends later tiers', async () => {
  const calls = [];
  const run = name => async () => { calls.push(name); return { passed: name !== 'smoke', reason: name === 'smoke' ? 'regressed' : undefined }; };
  const result = await runRrsiTieredEvaluation({ critic: run('critic'), smoke: run('smoke'), full: run('full') });
  assert.equal(result.passed, false); assert.equal(result.stoppedAt, 'smoke'); assert.deepEqual(calls, ['critic', 'smoke']);
  assert.deepEqual(result.tiers.map(row => `${row.tier}:${row.status}`), ['critic:passed', 'prescreen:skipped', 'smoke:failed']);
  const ok = await runRrsiTieredEvaluation({ critic: run('critic'), full: run('full') }); assert.equal(ok.passed, true);
  assert.deepEqual(rrsiSmokeCaseIds({ cases: [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }, { id: 'c' }, { id: 'd', weight: 2 }] }, { preferred: ['c'] }), ['c', 'b', 'd']);
  const splits = Array.from({ length: 400 }, (_, i) => rrsiSplit(`case-${i}`)); const held = splits.filter(row => row === 'heldout').length;
  assert.ok(held > 60 && held < 140); assert.equal(rrsiSplit('case-1'), rrsiSplit('case-1'));
  assert.match(rrsiChangelogEntry({ verdict: 'trial_adopted', component: 'skill', hypothesis: '先给结论', deltaS: 0.04, change: 'modified', id: 'x' }).title, /^Rna 学到了：先给结论/);
});

test('skill.screen and candidate.prescore are versioned host templates answered through the kernel', async () => {
  const candidates = [{ name: 'news-digest', description: 'Daily digest' }, { name: 'find-skills', description: 'Meta discovery' }];
  const plan = skillScreenTemplate({ taskTypes: ['research', 'recurring'], candidates });
  assert.deepEqual(Object.keys(validateHostTemplatePlan(plan).questions), ['fit_0', 'fit_1', 'overall_fit']);
  assert.throws(() => validateHostTemplatePlan({ ...plan, questions: { ...plan.questions, memory_need: plan.questions.fit_0 } }), /invalid_assessment_plan/);
  assert.throws(() => validateHostTemplatePlan({ ...plan, questions: { overall_fit: plan.questions.overall_fit } }), /invalid_assessment_plan/);
  assert.deepEqual(Object.keys(validateHostTemplatePlan(candidatePrescoreTemplate()).questions), ['candidate_better', 'expected_gain']);
  const state = minimizeDecisionState({ task: { title: 'Digest', taskTypes: 'research, recurring' }, candidates: candidates.map(row => ({ ...row, body: 'SECRET BODY' })) });
  assert.equal(state.candidates.length, 2); assert.equal(state.candidates[0].body, undefined); assert.equal(state.task.taskTypes, 'research, recurring');
  const kernel = createDecisionKernel({ backend: 'llm', requireCredential: false, mode: 'active', judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'boolean' ? { noul: id === 'fit_0' ? 0.97 : 0.02, confidence: 0.95 } : { score: 2, confidence: 0.95 }])) }) });
  const result = await kernel.decide({ point: 'skill.screen', scope: { projectId: 'p' }, state, assessmentPlan: plan, fallback: {} });
  assert.equal(result.source, 'judge'); assert.equal(result.answers.fit_0.probability, 0.97); assert.equal(result.answers.fit_1.probability, 0.02);
  kernel.close();
});
