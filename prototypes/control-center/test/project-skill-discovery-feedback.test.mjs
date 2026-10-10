import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describeEvolutionSkillDelivery } from '../project-skill-discovery-feedback.mjs';
import { describeEvolutionSearchOutcome, createEvolutionSearchContext, createEvolutionSearchPolicy } from '../project-evolution-search.mjs';
import { evolutionHash } from '../../../packages/sdk/src/evolution.mjs';
import { validateProjectGenome } from '../../../packages/sdk/src/project-genome.mjs';
import { createProjectEvaluationExposurePlan, observeProjectEvaluationExposure } from '../../../packages/sdk/src/project-evaluation-exposure.mjs';
import { createProjectEvaluationPartitionPlan } from '../../../packages/sdk/src/project-evaluation-partitions.mjs';
import { createProjectEvaluationRepeatPlan } from '../../../packages/sdk/src/project-evaluation-repeats.mjs';
import { formatSkillContent } from '../../../packages/sdk/src/genome-skill-content.mjs';
import { projectEvolutionAuthorSearchContext } from '../../../packages/sdk/src/project-evolution-search.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

const hash = 'a'.repeat(64), frozenAt = '2026-09-28T00:00:00.000Z';
function fixture({ resources = false, repeats = false } = {}) {
  const baseline = validateProjectGenome(projectGenomeFixture()), candidate = structuredClone(baseline);
  candidate.skills[0].instructions += '\nInspect a decisive claim.\nCross-check its scope.\nKeep a meaningful limitation.';
  if (resources) candidate.skills[0].resources[0].content += '\nCheck the supporting source and its scope.';
  const plan = createProjectEvaluationExposurePlan({ baseline, candidate });
  const partitions = createProjectEvaluationPartitionPlan({ suite: baseline.evaluationSuite, frozenAt });
  const repeatPlan = repeats ? createProjectEvaluationRepeatPlan({ suite: baseline.evaluationSuite, partitionPlan: partitions, baselineHash: plan.baselineHash, modelHash: hash, evaluationRuntimeHash: hash, seed: hash, frozenAt }) : undefined;
  const version = { id: 'candidate-retained', simulated: false, state: 'failed', baselineHash: plan.baselineHash, bundle: { hash: plan.candidateHash, genome: candidate },
    modelHash: hash, evaluationRuntimeHash: hash, evaluationExecution: { manifestHash: hash }, evaluationPartitions: partitions,
    ...(repeatPlan ? { evaluationRepeatPlan: repeatPlan } : {}), proposal: { hypothesis: 'Use current source scope when reporting.' },
    evaluation: { simulated: false, stage: 'deterministic_case', baselineHash: plan.baselineHash, candidateHash: plan.candidateHash, suiteHash: partitions.suiteHash,
      evaluationRuntimeHash: hash, evaluationExecution: { manifestHash: hash }, ...(repeatPlan ? { repeatPlan } : {}), details: [], selection: { cases: 0, complete: false } } };
  const record = ({ calls = [], toolResults = [], submittedToolResults = [], contextExposed = true, receiptsComplete = true, index = 0 } = {}) => {
    const receipt = observeProjectEvaluationExposure({ plan, genome: candidate, side: 'candidate', contextExposed, receiptsComplete, execution: { calls, toolResults, submittedToolResults } });
    const slot = repeatPlan?.trials[index];
    version.evaluation.details.push({ ...(slot ? { id: slot.id, caseId: slot.caseId, repeatIndex: slot.repeatIndex } : { id: baseline.evaluationSuite.cases[index].id }), partition: 'selection', candidate: { exposure: receipt } });
    return receipt;
  };
  const read = ({ path = 'SKILL.md', offset, limit, id = 'read-one' } = {}) => {
    const skill = candidate.skills[0], raw = path === 'SKILL.md' ? skill.instructions : skill.resources.find(row => row.path === path).content;
    const call = { id, name: 'skill_load', arguments: { id: skill.id, ...(path === 'SKILL.md' ? {} : { path }), ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) } };
    const receipt = { toolCallId: id, toolName: 'skill_load', isError: false, output: JSON.stringify(formatSkillContent({ id: skill.id, path, raw, offset, limit, resources: skill.resources })) };
    return { call, receipt };
  };
  return { baseline, candidate, plan, version, record, read };
}
const summarize = f => describeEvolutionSkillDelivery(f.version, f.baseline);

test('a retained unscored selection retains catalog/non-request facts without claiming all planned cases ran', () => {
  const f = fixture(); f.record();
  const value = summarize(f);
  assert.deepEqual(value, { scope: 'selection_runtime_receipts', qualityClaim: 'none', observedExecutions: 1, expectedExecutions: 3, omittedItems: 0,
    items: [{ id: 'evidence_review', path: 'SKILL.md', catalogSubmitted: 1, resourceInventorySubmitted: 0, delivered: 0, notRequested: 1, contentNotSubmitted: 0, partialDelivery: 0, unknown: 0 }] });
  const result = describeEvolutionSearchOutcome(f.version, f.baseline);
  assert.equal(result.measured, false); assert.equal(result.outcome, 'incomplete'); assert.equal(result.reason, 'selection_incomplete'); assert.deepEqual(result.skillDelivery, value);
});

test('provider failure after a retained execution preserves delivery without becoming a quality failure', () => {
  const f = fixture(); f.record(); f.version.error = { code: 'provider_error' };
  const result = describeEvolutionSearchOutcome(f.version, f.baseline);
  assert.equal(result.reason, 'provider_incomplete'); assert.equal(result.measured, false); assert.equal(result.skillDelivery.items[0].notRequested, 1);
});

test('submitted skill bytes count as delivery, not successful method use', () => {
  const f = fixture(), read = f.read(); f.record({ calls: [read.call], toolResults: [read.receipt], submittedToolResults: [read.receipt] });
  const value = summarize(f); assert.equal(value.items[0].delivered, 1); assert.equal(value.qualityClaim, 'none'); assert.equal(value.items[0].notRequested, 0);
});

test('successful tool read without a later model request is a delivery interruption', () => {
  const f = fixture(), read = f.read(); f.record({ calls: [read.call], toolResults: [read.receipt] });
  const item = summarize(f).items[0]; assert.equal(item.contentNotSubmitted, 1); assert.equal(item.notRequested, 0); assert.equal(item.delivered, 0);
});

test('a page overlapping only part of the changed method is not a complete delivery', () => {
  const f = fixture(), read = f.read({ offset: 1, limit: 1 }); f.record({ calls: [read.call], toolResults: [read.receipt], submittedToolResults: [read.receipt] });
  const item = summarize(f).items[0]; assert.equal(item.partialDelivery, 1); assert.equal(item.delivered, 0); assert.equal(item.unknown, 0);
});

test('loading SKILL.md reveals a resource inventory while an unread resource body remains unrequested', () => {
  const f = fixture({ resources: true }), read = f.read(); f.record({ calls: [read.call], toolResults: [read.receipt], submittedToolResults: [read.receipt] });
  const [body, resource] = summarize(f).items;
  assert.equal(body.delivered, 1); assert.equal(body.resourceInventorySubmitted, 0);
  assert.equal(resource.path, 'references/guide.md'); assert.equal(resource.resourceInventorySubmitted, 1); assert.equal(resource.notRequested, 1); assert.equal(resource.delivered, 0);
});

test('missing and mismatched tool receipts remain unknown rather than non-use', () => {
  for (const mismatched of [false, true]) {
    const f = fixture(), read = f.read(); const bad = { ...read.receipt, output: '{}' };
    f.record({ calls: [read.call], toolResults: mismatched ? [bad] : [], submittedToolResults: mismatched ? [bad] : [] });
    const item = summarize(f).items[0]; assert.equal(item.unknown, 1); assert.equal(item.notRequested, 0);
  }
});

test('incomplete inventories or unattested catalog context do not assert that a method was unrequested', () => {
  for (const flags of [{ receiptsComplete: false }, { contextExposed: false }]) {
    const f = fixture(); f.record(flags); const item = summarize(f).items[0];
    assert.equal(item.unknown, 1); assert.equal(item.notRequested, 0); assert.equal(item.catalogSubmitted, flags.contextExposed === false ? 0 : 1);
  }
});

test('mixed selection executions retain their denominators without reading scores or task content', () => {
  const f = fixture(), read = f.read(); f.record(); f.record({ index: 1, calls: [read.call], toolResults: [read.receipt], submittedToolResults: [read.receipt] });
  const value = summarize(f); assert.equal(value.observedExecutions, 2); assert.equal(value.expectedExecutions, 3);
  assert.equal(value.items[0].delivered, 1); assert.equal(value.items[0].notRequested, 1);
  f.version.evaluation.details[0].candidate.answer = 'private-answer'; f.version.evaluation.details[0].candidateScore = .98;
  assert.deepEqual(summarize(f), value); assert.doesNotMatch(JSON.stringify(value), /case_|private-answer|Score|criteria|hypothesis/);
});

test('confirmation-only receipts and judge fields never enter discovery feedback', () => {
  const f = fixture(); f.record(); const confirmation = structuredClone(f.version.evaluation.details[0]);
  confirmation.id = 'private-confirmation'; confirmation.partition = 'confirmation'; confirmation.judge = 'private-answer';
  f.version.evaluation.details.push(confirmation); assert.equal(summarize(f).observedExecutions, 1);
  f.version.evaluation.details.shift(); assert.equal(summarize(f), undefined);
});

test('deleted, revoked, mismatched and ambiguous histories fail closed for engineering feedback', () => {
  const mutations = [v => { v.sourceDeleted = true; }, v => { v.contextRevoked = true; }, v => { v.simulated = true; },
    v => { v.evaluation.candidateHash = 'b'.repeat(64); }, v => { v.evaluation.evaluationRuntimeHash = 'b'.repeat(64); },
    v => { v.evaluation.evaluationExecution.manifestHash = 'b'.repeat(64); }, v => { v.evaluation.suiteHash = 'b'.repeat(64); },
    v => { v.evaluation.details.push(structuredClone(v.evaluation.details[0])); }, v => { v.evaluation.details[0].id = 'unexpected-selection'; },
    v => { v.evaluation.details[0].candidate.exposure.planHash = 'b'.repeat(64); }, v => { v.evaluation.details[0].candidate.exposure.genomeHash = 'b'.repeat(64); },
    v => { v.evaluation.details[0].candidate.exposure.changes[0].contentHash = 'b'.repeat(64); }];
  for (const mutate of mutations) {
    const f = fixture(); f.record(); f.version = structuredClone(f.version); mutate(f.version); assert.equal(summarize(f), undefined, mutate.toString());
  }
});

test('a separately frozen repetition plan binds trial ids and distinguishes unrun repetitions', () => {
  const f = fixture({ repeats: true }); f.record();
  const value = summarize(f); assert.equal(value.observedExecutions, 1); assert.equal(value.expectedExecutions, 6); assert.equal(value.items[0].notRequested, 1);
  assert.equal(describeEvolutionSearchOutcome(f.version, f.baseline).measured, false);
  delete f.version.evaluationRepeatPlan; assert.equal(summarize(f), undefined);
});

test('repeated receipt cannot self-author its allocation or change the pinned trial binding', () => {
  for (const mutate of [v => { v.evaluation.details[0].caseId = 'case_2'; }, v => { v.evaluation.details[0].repeatIndex = 2; }, v => { v.modelHash = 'b'.repeat(64); }, v => { delete v.evaluation.repeatPlan; }]) {
    const f = fixture({ repeats: true }); f.record(); f.version = structuredClone(f.version); mutate(f.version); assert.equal(summarize(f), undefined);
  }
});

test('bounded asset inventory explicitly reports omission without fabricating extra observed executions', () => {
  const f = fixture({ resources: true });
  for (let index = 0; index < 3; index++) f.candidate.skills.push({ id: `method_${index}`, name: `Method ${index}`, description: 'A specific project method.', instructions: 'Use the appropriate project inputs.',
    resources: Array.from({ length: 10 }, (_, item) => ({ path: `references/new-${item}.md`, content: 'A reusable method.' })) });
  const plan = createProjectEvaluationExposurePlan({ baseline: f.baseline, candidate: f.candidate });
  f.version.bundle.hash = plan.candidateHash; f.version.evaluation.candidateHash = plan.candidateHash;
  f.version.evaluation.details.push({ id: 'case_1', partition: 'selection', candidate: { exposure: observeProjectEvaluationExposure({ plan, genome: f.candidate, side: 'candidate', contextExposed: true, receiptsComplete: true, execution: { calls: [], toolResults: [], submittedToolResults: [] } }) } });
  const value = summarize(f); assert.equal(value.items.length, 32); assert.equal(value.omittedItems, 3); assert.equal(value.observedExecutions, 1);
});

test('retained unscored discovery facts reach the bounded author history while its current quality verdict remains absent', () => {
  const f = fixture(); f.record(); const context = createEvolutionSearchContext({ baseline: f.baseline, evidence: [], modelHash: hash, evaluationRuntimeHash: hash, evaluationExecution: f.version.evaluationExecution, evaluationPartitions: f.version.evaluationPartitions });
  f.version.searchContext = context;
  const result = createEvolutionSearchPolicy({ versions: [f.version] }, { baseline: f.baseline, context });
  assert.equal(result.summary.measured, 0); assert.equal(result.policy.maxChangedAssets, 4);
  const input = projectEvolutionAuthorSearchContext(result.policy); assert.equal(input.history[0].outcome, 'incomplete'); assert.equal(input.history[0].feedback.skillDelivery.items[0].notRequested, 1);
  assert.doesNotMatch(JSON.stringify(input), /case_1|case_2|baselineScore|candidateScore|private-answer/);
});

// The recorded experiment is a local QA file (qa/ is not part of the repository): without it this test is skipped.
test('the immutable phase6c failed experiment yields only the already-recorded delivery facts, not a revised outcome', { skip: !existsSync(new URL('../qa/phase6c-repeat-live-20260928.json', import.meta.url)) && 'needs the local QA record (qa/phase6c-repeat-live-20260928.json)' }, async () => {
  const bytes = await readFile(new URL('../qa/phase6c-repeat-live-20260928.json', import.meta.url), 'utf8'), report = JSON.parse(bytes);
  const baseline = validateProjectGenome(report.fixture.baseline), candidate = report.author.proposal.genome, e = report.evaluation;
  const version = { id: 'historical-isolated-test', state: 'failed', simulated: false, baselineHash: e.baselineHash, bundle: { hash: e.candidateHash, genome: candidate },
    modelHash: report.repeatPlan.modelHash, evaluationRuntimeHash: e.evaluationRuntimeHash, evaluationExecution: e.evaluationExecution,
    evaluationPartitions: report.partitionPlan, evaluationRepeatPlan: report.repeatPlan, evaluation: e };
  const value = describeEvolutionSkillDelivery(version, baseline);
  assert.equal(value.observedExecutions, 1); assert.equal(value.expectedExecutions, 2); assert.equal(value.items[0].id, 'artifact_review'); assert.equal(value.items[0].notRequested, 1);
  assert.equal(e.evaluationComplete, false); assert.equal(describeEvolutionSearchOutcome(version, baseline).measured, false);
  assert.equal(await readFile(new URL('../qa/phase6c-repeat-live-20260928.json', import.meta.url), 'utf8'), bytes);
});
