import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionCoordinator, proposeEvolution, validateEvolutionProposal } from '../src/evolution.mjs';
import { ProviderError } from '../src/providers.mjs';
const project = { id: 'project-one', title: 'Normalize customer tags' };
const baseline = { versionId: 'v1', projectId: project.id, strategy: 'exact-match', skills: [{ id: 'normalization', instructions: 'Compare incoming tag text directly.' }], assignments: { skillIds: ['normalization'], toolIds: ['read_tags'], mcpServerIds: [] } };
const cases = [ { id: 'case1', input: 'alpha', expected: 'alpha' }, { id: 'case2', input: ' Beta ', expected: 'beta' }, { id: 'case3', input: 'GAMMA', expected: 'gamma' } ];
const evidence = [{ id: 'failure1', summary: 'Tags with accidental spaces or case differences fail matching.' }];
const proposal = () => ({ summary: 'Normalize customer tags', hypothesis: 'Spaces and letter case are accidental differences', strategy: 'normalize-case-whitespace', skillUpdates: [{ skillId: 'normalization', instructions: 'Trim surrounding whitespace and casefold before comparing tags.', reason: 'Failures show accidental formatting differences.' }], expectedImprovement: 'Previously missed equivalent tags match', riskNotes: ['Check whether any tags are intentionally case-sensitive'] });
function evaluator(log = []) { return async ({ version, testCase, side }) => { log.push({ side, versionId: version.versionId, testCase }); const actual = version.strategy === 'normalize-case-whitespace' ? testCase.input.trim().toLowerCase() : testCase.input; const passed = actual === testCase.expected; return { score: passed ? 1 : 0, passed, safetyPassed: version.assignments.toolIds.length === 1 && version.assignments.toolIds[0] === 'read_tags', evidence: { actual, expected: testCase.expected, check: 'strict-equality' }, usage: { totalTokens: 10 } }; }; }
function options(extra = {}) { return { project, baseline, cases, evaluatorId: 'tag-normalization-fixture@1', evaluate: evaluator(), propose: async () => ({ proposal: proposal(), usage: { totalTokens: 20 } }), ...extra }; }
test('project evolution executes paired real host cases and emits ready without activating', async () => {
  const log = [], events = [], saves = [];
  const evolution = new EvolutionCoordinator(options({ evaluate: evaluator(log), onEvent: event => events.push(event), saveState: async state => saves.push(state) }));
  const candidate = await evolution.runCycle({ evidence });
  assert.equal(log.length, 6); assert.equal(candidate.status, 'ready'); assert.equal(candidate.evaluation.gate.baselineScore, 1 / 3); assert.equal(candidate.evaluation.gate.candidateScore, 1); assert.equal(candidate.evaluation.scope, 'configured_cases_only'); assert.equal(candidate.evaluation.statisticalClaim, 'none');
  for (const testCase of cases) assert.equal(log.filter(run => run.testCase.id === testCase.id).length, 2);
  assert.equal(evolution.currentVersion().versionId, 'v1'); assert.equal(evolution.snapshot().trialVersionId, null); assert.equal(evolution.snapshot().usedTokens, 80); assert.equal(events.length, 1); assert.equal(events[0].type, 'evolution_candidate_ready'); assert.equal(saves.at(-1).candidates[0].status, 'ready');
  const same = await evolution.runCycle({ evidence }); assert.equal(same.id, candidate.id); assert.equal(log.length, 6); await evolution.close();
});
test('host explicitly trials, promotes and rolls back immutable project version snapshots', async () => {
  const original = structuredClone(baseline); const evolution = new EvolutionCoordinator(options({ baseline: original })); original.strategy = 'tampered externally';
  const candidate = await evolution.runCycle({ evidence }); assert.equal(evolution.currentVersion().strategy, 'exact-match');
  const trial = await evolution.trial(candidate.id); assert.equal(trial.strategy, 'normalize-case-whitespace'); assert.equal(evolution.currentVersion().strategy, 'exact-match');
  await evolution.rollback(); assert.equal(evolution.snapshot().trialVersionId, null);
  await evolution.promote(candidate.id); assert.equal(evolution.currentVersion().strategy, 'normalize-case-whitespace');
  await evolution.rollback(); assert.equal(evolution.currentVersion().versionId, 'v1'); assert.deepEqual(evolution.currentVersion().assignments, baseline.assignments); await evolution.close();
});
test('candidate cannot add skills, tools, MCP servers, or fake evaluation scores', async () => {
  const expanded = proposal(); expanded.skillUpdates[0].skillId = 'invented'; assert.throws(() => validateEvolutionProposal(expanded, baseline), { code: 'capability_expansion' });
  for (const extra of [{ assignments: { toolIds: ['shell_exec'] } }, { score: 1 }, { mcpServers: ['new-server'] }]) assert.throws(() => validateEvolutionProposal({ ...proposal(), ...extra }, baseline), { code: 'invalid_proposal' });
  const evolution = new EvolutionCoordinator(options({ propose: async () => ({ proposal: expanded }) })); await assert.rejects(evolution.runCycle({ evidence }), { code: 'capability_expansion' }); assert.equal(evolution.currentVersion().versionId, 'v1'); await evolution.close();
});
test('average gain with a single case regression cannot become ready', async () => {
  const changed = structuredClone(cases); changed[0] = { id: 'case1', input: 'CaseSensitive', expected: 'CaseSensitive' };
  const evolution = new EvolutionCoordinator(options({ cases: changed })); const candidate = await evolution.runCycle({ evidence });
  assert.equal(candidate.status, 'rejected'); assert.ok(candidate.evaluation.gate.candidateScore > candidate.evaluation.gate.baselineScore); assert.ok(candidate.evaluation.gate.failures.includes('case_regression')); assert.ok(candidate.evaluation.gate.failures.includes('failed_acceptance')); await assert.rejects(evolution.promote(candidate.id), { code: 'not_ready' }); await evolution.close();
});
test('missing evaluator, low budget, incomplete evidence and safety failure never fabricate readiness', async () => {
  const missing = new EvolutionCoordinator(options({ evaluate: undefined })); assert.equal((await missing.runCycle({ evidence })).reason, 'host_evaluator_required'); assert.equal(missing.snapshot().candidates[0].status, 'proposed'); await missing.close();
  const poor = new EvolutionCoordinator(options({ policy: { tokenBudget: 1 } })); await assert.rejects(poor.runCycle({ evidence }), { code: 'budget_exhausted' }); assert.equal(poor.snapshot().candidates[0].status, 'failed'); await poor.close();
  const invalid = new EvolutionCoordinator(options({ evaluate: async () => ({ score: 1, passed: true, safetyPassed: true }) })); await assert.rejects(invalid.runCycle({ evidence }), { code: 'invalid_evaluation' }); assert.notEqual(invalid.snapshot().candidates[0].status, 'ready'); await invalid.close();
  const baseEvaluator = evaluator(); const unsafe = new EvolutionCoordinator(options({ evaluate: async args => ({ ...await baseEvaluator(args), safetyPassed: args.side === 'baseline' }) })); assert.ok((await unsafe.runCycle({ evidence })).evaluation.gate.failures.includes('safety_regression')); await unsafe.close();
});
test('evaluation binds frozen cases and rejects candidates after baseline changes', async () => {
  const inputCases = structuredClone(cases); const evolution = new EvolutionCoordinator(options({ cases: inputCases })); inputCases[0].expected = 'tampered';
  const first = await evolution.proposeCandidate({ evidence }); const second = await evolution.proposeCandidate({ evidence: [{ id: 'second', summary: 'Independent failure evidence' }] });
  const evaluated = await evolution.evaluateCandidate(first.id); assert.equal(evaluated.status, 'ready'); await evolution.promote(first.id);
  await assert.rejects(evolution.evaluateCandidate(second.id), { code: 'stale_baseline' }); await evolution.close();
});
test('restart detects interrupted evaluation and does not auto-replay cases', async () => {
  const evolution = new EvolutionCoordinator(options()); const candidate = await evolution.proposeCandidate({ evidence }); const snapshot = evolution.snapshot();
  snapshot.candidates[0].status = 'evaluating'; snapshot.reservedTokens = 100; await evolution.close();
  let called = false; const restored = new EvolutionCoordinator(options({ state: snapshot, evaluate: async () => { called = true; } })); assert.equal(restored.snapshot().candidates[0].id, candidate.id); assert.equal(restored.snapshot().candidates[0].status, 'interrupted'); assert.equal(restored.snapshot().usedTokens, 120); assert.equal(called, false); await assert.rejects(restored.promote(candidate.id), { code: 'not_ready' }); await restored.close();
  assert.throws(() => new EvolutionCoordinator(options({ project: { id: 'foreign' }, state: snapshot })), { code: 'invalid_state' });
});
test('configured provider produces strict inert proposal; demo does not simulate success', async () => {
  let called = false;
  const result = await proposeEvolution({ project, baseline, evidence, model: { protocol: 'openai', modelId: 'fixture', maxOutputTokens: 8192 }, provider: async function* (args) { called = true; assert.deepEqual(args.tools, []); assert.equal(args.model.maxOutputTokens, 4096); yield { type: 'text_delta', delta: JSON.stringify(proposal()) }; yield { type: 'usage', usage: { totalTokens: 12 } }; yield { type: 'done', stopReason: 'stop' }; } });
  assert.equal(called, true); assert.equal(result.status, 'proposed'); assert.equal(result.usage.totalTokens, 12);
  assert.equal((await proposeEvolution({ project, baseline, model: { protocol: 'demo', modelId: 'demo' } })).status, 'blocked');
});
test('evolution proposal cumulative usage frames settle the final request receipt once without evaluating or activating', async () => {
  let calls = 0, evaluations = 0;
  const evolution = new EvolutionCoordinator(options({ propose: undefined, model: { protocol: 'openai', modelId: 'fixture' }, policy: { proposalBudgetTokens: 100 }, evaluate: async () => { evaluations++; }, provider: async function* () {
    calls++; yield { type: 'usage', usage: { input: 10, output: 1, totalTokens: 11 } };
    yield { type: 'text_delta', delta: JSON.stringify(proposal()) };
    yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } };
    yield { type: 'done', stopReason: 'stop' };
  } }));
  try {
    const candidate = await evolution.proposeCandidate({ evidence });
    assert.equal(calls, 1); assert.equal(evaluations, 0); assert.equal(candidate.status, 'proposed');
    assert.equal(evolution.snapshot().usedTokens, 13); assert.equal(evolution.snapshot().reservedTokens, 0);
    assert.equal(evolution.currentVersion().versionId, baseline.versionId); assert.equal(evolution.snapshot().trialVersionId, null);
  } finally { await evolution.close(); }
});
test('evolution failed proposal preserves a cumulative receipt once while missing or explicitly unreported usage stays conservative', async () => {
  for (const receipt of ['reported', 'missing', 'unreported', 'unobserved-claimed']) {
    let calls = 0;
    const provider = async function* () {
      calls++;
      if (receipt === 'reported') {
        yield { type: 'usage', usage: { input: 10, output: 1, totalTokens: 11 } };
        yield { type: 'text_delta', delta: JSON.stringify(proposal()) };
        yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } };
      }
      throw Object.assign(new ProviderError('Explicit terminal provider fixture', { code: 'provider_termination', providerFinishReason: 'content_filter' }), receipt === 'unreported' ? { usage: { totalTokens: 0 }, usageReported: false } : receipt === 'unobserved-claimed' ? { usage: { totalTokens: 0 }, usageReported: true } : {});
    };
    const evolution = new EvolutionCoordinator(options({ propose: undefined, model: { protocol: 'openai', modelId: 'fixture' }, provider, policy: { proposalBudgetTokens: 100 } }));
    try {
      await assert.rejects(evolution.proposeCandidate({ evidence }), error => {
        assert.equal(error.code, 'provider_termination');
        assert.equal(error.usageReported, receipt === 'reported');
        if (receipt === 'reported') assert.deepEqual(error.usage, { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13 });
        return true;
      });
      const state = evolution.snapshot(); assert.equal(calls, 1); assert.equal(state.candidates[0].status, 'failed');
      assert.equal(state.usedTokens, receipt === 'reported' ? 13 : 100); assert.equal(state.reservedTokens, 0);
      assert.equal(state.candidates[0].proposal, undefined); assert.equal(state.events.length, 0); assert.equal(evolution.currentVersion().versionId, baseline.versionId);
    } finally { await evolution.close(); }
  }
});
test('abort and evaluation timeout never publish incomplete candidates as ready', async () => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const evolution = new EvolutionCoordinator(options({ evaluate: async () => { began(); return new Promise(() => {}); } }));
  const controller = new AbortController(); const running = evolution.runCycle({ evidence, signal: controller.signal }); await started; controller.abort();
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(evolution.snapshot().candidates[0].status, 'interrupted'); assert.equal(evolution.snapshot().events.length, 0); await evolution.close();
  const timed = new EvolutionCoordinator(options({ policy: { timeoutMs: 20 }, evaluate: async () => new Promise(() => {}) })); await assert.rejects(timed.runCycle({ evidence }), { code: 'evaluation_timeout' }); assert.equal(timed.snapshot().candidates[0].status, 'failed'); await timed.close();
});
