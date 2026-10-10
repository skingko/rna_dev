import { evolutionHash } from './evolution.mjs';
import { validateProjectGenome } from './project-genome.mjs';

const HASH = /^[a-f0-9]{64}$/;
const kinds = new Set(['prompt', 'skill', 'resource', 'tool']);
const outcomes = new Set(['accepted', 'rejected', 'incomplete', 'not_evaluated']);
const feedbackReasons = new Set(['source_unavailable', 'in_progress', 'author_incomplete', 'author_no_change', 'candidate_not_retained', 'preflight_incomplete', 'provider_incomplete', 'execution_identity_unverified', 'selection_incomplete', 'environment_identity_not_preflighted', 'exposure_unverified', 'changes_not_exercised', 'selection_passed', 'selection_no_gain', 'selection_constraints_failed']);
const measuredReasons = new Set(['selection_passed', 'selection_no_gain', 'selection_constraints_failed']);
const feedbackGates = new Set(['deterministicCases', 'minimumScore', 'improvement', 'noRegression', 'tokenRatio']);
const clone = value => structuredClone(value);
const byId = (a, b) => a.id.localeCompare(b.id, 'en');
const byPath = (a, b) => a.path.localeCompare(b.path, 'en');
const normalizeHypothesis = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
const fail = message => { throw Object.assign(new Error(message), { name: 'ProjectEvolutionSearchError', code: 'invalid_search_policy' }); };
const boundedText = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const deliveryCounts = ['delivered', 'notRequested', 'contentNotSubmitted', 'partialDelivery', 'unknown'];
const deliveryInventoryCounts = ['catalogSubmitted', 'resourceInventorySubmitted'];
function validateSkillDelivery(value, changedAssets = []) {
  const count = number => Number.isInteger(number) && number >= 0 && number <= 2000;
  if (!object(value) || !keys(value, ['scope', 'qualityClaim', 'observedExecutions', 'expectedExecutions', 'omittedItems', 'items'])
    || value.scope !== 'selection_runtime_receipts' || value.qualityClaim !== 'none'
    || !count(value.observedExecutions) || value.observedExecutions < 1 || !count(value.expectedExecutions) || value.expectedExecutions < value.observedExecutions
    || !count(value.omittedItems) || !Array.isArray(value.items) || !value.items.length || value.items.length > 32) fail('Skill delivery feedback requires bounded selection execution counts without a quality claim');
  const seen = new Set();
  for (const item of value.items) {
    if (!object(item) || !keys(item, ['id', 'path', ...deliveryInventoryCounts, ...deliveryCounts]) || !boundedText(item.id, 160) || !boundedText(item.path, 400)
      || [...deliveryInventoryCounts, ...deliveryCounts].some(key => !count(item[key]) || item[key] > value.observedExecutions)
      || deliveryCounts.reduce((sum, key) => sum + item[key], 0) !== value.observedExecutions || item.notRequested > item.catalogSubmitted
      || item.path === 'SKILL.md' && item.resourceInventorySubmitted !== 0
      || !changedAssets.some(asset => asset.id === item.id && (asset.kind === 'skill' || asset.kind === 'resource' && asset.path === item.path))) fail('Skill delivery rows must refer to public changed assets with complete, non-overlapping execution counts');
    const identity = JSON.stringify([item.id, item.path]);
    if (seen.has(identity)) fail('Skill delivery feedback must not repeat an asset');
    seen.add(identity);
  }
}

// Only executable project capability content belongs to this identity. Tool
// smoke oracles, future evaluation standards and source provenance are not
// agent behavior. Skill catalog order IS visible in model requests; resource
// inventories and tool declarations are sorted by their runtime consumers.
function behavior(genome) {
  const valid = validateProjectGenome(genome);
  return {
    systemPrompt: valid.systemPrompt,
    skills: valid.skills.map(({ source, resources, ...skill }) => ({ ...skill, resources: [...resources].sort(byPath) })),
    tools: valid.tools.map(({ smokeCases, name, ...tool }) => tool).sort(byId)
  };
}
export function projectGenomeBehaviorHash(genome) { return evolutionHash(behavior(genome)); }
export function projectEvolutionEvidenceHash(evidence = []) {
  if (!Array.isArray(evidence)) fail('Evolution search evidence must be an array');
  // Preserve every admitted field, while harmless inventory ordering cannot
  // manufacture new evidence. IDs alone cannot attest changed source content.
  return evolutionHash(evidence.map(item => evolutionHash(item)).sort());
}

/** A deterministic inventory of shipped bytes, not inferred causal edits. */
export function describeProjectGenomeChanges(baseline, candidate) {
  const before = behavior(baseline), after = behavior(candidate), changes = [];
  const record = (kind, id, previous, next, path) => {
    const beforeHash = previous === undefined ? null : evolutionHash(previous);
    const afterHash = next === undefined ? null : evolutionHash(next);
    if (beforeHash === afterHash) return;
    changes.push({ kind, id, ...(path === undefined ? {} : { path }), change: previous === undefined ? 'added' : next === undefined ? 'removed' : 'modified', beforeHash, afterHash });
  };
  record('prompt', 'systemPrompt', before.systemPrompt, after.systemPrompt);
  // Adding or removing a skill is already accounted for by that capability.
  // Reordering the surviving catalog is an additional prompt intervention.
  const retained = new Set(before.skills.filter(row => after.skills.some(item => item.id === row.id)).map(row => row.id));
  record('prompt', 'skillCatalogOrder', before.skills.filter(row => retained.has(row.id)).map(row => row.id), after.skills.filter(row => retained.has(row.id)).map(row => row.id));
  for (const id of [...new Set([...before.skills, ...after.skills].map(row => row.id))].sort()) {
    const previous = before.skills.find(row => row.id === id), next = after.skills.find(row => row.id === id);
    // A complete new/removed source package is one capability unit, however
    // many resources it contains. Existing packages retain resource-level audit.
    if (!previous || !next) { record('skill', id, previous, next); continue; }
    const { resources: oldResources, ...oldSkill } = previous, { resources: newResources, ...newSkill } = next;
    record('skill', id, oldSkill, newSkill);
    for (const path of [...new Set([...oldResources, ...newResources].map(row => row.path))].sort()) {
      record('resource', id, oldResources.find(row => row.path === path)?.content, newResources.find(row => row.path === path)?.content, path);
    }
  }
  for (const id of [...new Set([...before.tools, ...after.tools].map(row => row.id))].sort()) record('tool', id, before.tools.find(row => row.id === id), after.tools.find(row => row.id === id));
  return {
    baselineBehaviorHash: evolutionHash(before), candidateBehaviorHash: evolutionHash(after), changes,
    changedAssetCount: new Set(changes.map(row => `${row.kind === 'resource' ? 'skill' : row.kind}:${row.id}`)).size,
    countingUnit: 'prompt_or_complete_skill_or_tool',
    evaluationSuiteChanged: evolutionHash(baseline.evaluationSuite) !== evolutionHash(candidate.evaluationSuite),
    smokeContractsChanged: evolutionHash(baseline.tools.map(({ id, smokeCases }) => ({ id, smokeCases })).sort(byId)) !== evolutionHash(candidate.tools.map(({ id, smokeCases }) => ({ id, smokeCases })).sort(byId))
  };
}

export function validateProjectEvolutionSearchPolicy(value) {
  if (value === undefined) return undefined;
  if (!object(value) || !keys(value, ['maxChangedAssets', 'comparisonKey', 'history'])) fail('Evolution search policy has unsupported fields');
  if (value.maxChangedAssets !== undefined && (!Number.isInteger(value.maxChangedAssets) || value.maxChangedAssets < 1 || value.maxChangedAssets > 32)) fail('Evolution search asset bound must be an integer between 1 and 32');
  if (value.comparisonKey !== undefined && (typeof value.comparisonKey !== 'string' || !HASH.test(value.comparisonKey))) fail('Evolution search comparison identity must be a SHA-256 hash');
  const history = value.history ?? [];
  if (!Array.isArray(history) || history.length > 40) fail('Evolution search history accepts at most 40 host-selected records');
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) fail('Evolution search policy exceeds its bounded history size');
  const ids = new Set();
  for (const row of history) {
    if (!object(row) || !keys(row, ['id', 'baselineBehaviorHash', 'candidateBehaviorHash', 'evidenceHash', 'comparisonKey', 'hypothesis', 'outcome', 'changedAssets', 'feedback']) || !boundedText(row.id, 160) || ids.has(row.id) || !boundedText(row.hypothesis, 4000) || !outcomes.has(row.outcome) || !['baselineBehaviorHash', 'candidateBehaviorHash', 'evidenceHash', 'comparisonKey'].every(key => typeof row[key] === 'string' && HASH.test(row[key]))) fail('Evolution search history requires unique IDs, bounded hypotheses, exact identities and explicit outcomes');
    ids.add(row.id);
    if (row.changedAssets !== undefined) {
      if (!Array.isArray(row.changedAssets) || row.changedAssets.length > 1600) fail('Evolution search asset inventory exceeds its bound');
      for (const asset of row.changedAssets) {
        if (!object(asset) || !keys(asset, ['kind', 'id', 'path', 'change']) || !kinds.has(asset.kind) || !boundedText(asset.id, 160) || !['added', 'modified', 'removed'].includes(asset.change) || (asset.kind === 'resource' ? !boundedText(asset.path, 400) : asset.path !== undefined)) fail('Evolution search asset history must contain only public asset identifiers');
      }
    }
    if (row.feedback !== undefined) {
      const feedback = row.feedback;
      if (!object(feedback) || !keys(feedback, ['reason', 'comparable', 'failedGates', 'exposure', 'skillDelivery']) || !feedbackReasons.has(feedback.reason) || typeof feedback.comparable !== 'boolean') fail('Evolution search feedback requires a public reason and an explicit comparability flag');
      if (!feedback.comparable && row.outcome !== 'not_evaluated') fail('Changed-context feedback must not claim a current measured outcome');
      if (feedback.comparable && (measuredReasons.has(feedback.reason) !== ['accepted', 'rejected'].includes(row.outcome) || (feedback.reason === 'selection_passed') !== (row.outcome === 'accepted'))) fail('Evolution search feedback contradicts its measured outcome');
      if (feedback.failedGates !== undefined && (!measuredReasons.has(feedback.reason) || !Array.isArray(feedback.failedGates) || new Set(feedback.failedGates).size !== feedback.failedGates.length || feedback.failedGates.some(gate => !feedbackGates.has(gate)) || (feedback.reason === 'selection_passed' && feedback.failedGates.length))) fail('Evolution search feedback accepts only aggregate failed selection gates after complete measurement');
      if (feedback.exposure !== undefined) {
        const counts = feedback.exposure;
        if (!object(counts) || !keys(counts, ['required', 'observed', 'unobserved', 'unknown']) || !['required', 'observed', 'unobserved', 'unknown'].every(key => Number.isInteger(counts[key]) && counts[key] >= 0 && counts[key] <= 2000) || counts.required !== counts.observed + counts.unobserved + counts.unknown) fail('Evolution search feedback exposure must contain bounded aggregate counts');
      }
      if (feedback.skillDelivery !== undefined) validateSkillDelivery(feedback.skillDelivery, row.changedAssets);
    }
  }
  return { ...clone(value), history: clone(history) };
}

export function projectEvolutionAuthorSearchContext(searchPolicy) {
  const policy = validateProjectEvolutionSearchPolicy(searchPolicy);
  if (!policy) return undefined;
  return {
    schemaVersion: 1, ...(policy.maxChangedAssets === undefined ? {} : { maxChangedAssets: policy.maxChangedAssets }),
    countingUnit: 'prompt_or_complete_skill_or_tool', scope: 'project_capability_package_only',
    history: policy.history.map(({ id, hypothesis, outcome, changedAssets = [], feedback }) => ({ id, hypothesis, outcome, changedAssets: clone(changedAssets), ...(feedback ? { feedback: clone(feedback) } : {}) })),
    historyMeaning: 'Host-selected prior selection attempts, not fresh task evidence or proof of component causality. accepted/rejected describe the selection gate only; accepted does not mean independent confirmation or user adoption. Incomplete/not_evaluated attempts have no current quality verdict. Optional feedback supplies aggregate selection failure categories and runtime delivery counts only. skillDelivery describes retained selection executions, even when later evaluation did not complete; expected executions that never ran do not count as non-use. Its asset rows may be bounded, with omittedItems explicit. comparable=false refers to a previous context and cannot falsify the current method. Scores, hidden cases, judge text and confirmation results are intentionally absent.'
  };
}

export function reviewProjectEvolutionCandidate({ baseline, candidate, evidence = [], hypothesis, searchPolicy } = {}) {
  const policy = validateProjectEvolutionSearchPolicy(searchPolicy), diff = describeProjectGenomeChanges(baseline, candidate);
  const evidenceHash = projectEvolutionEvidenceHash(evidence), normalized = typeof hypothesis === 'string' ? normalizeHypothesis(hypothesis) : '';
  const repeatedHypothesisIds = [], duplicateCandidateIds = [];
  for (const row of policy?.history ?? []) {
    if (normalized && normalizeHypothesis(row.hypothesis) === normalized) repeatedHypothesisIds.push(row.id);
    // A changed baseline, evidence or comparison runtime makes this a different
    // experiment. Unmeasured/incomplete runs must remain retryable. Host-owned
    // outcomes are supplied only for fully measured selection records.
    if (policy.comparisonKey && row.comparisonKey === policy.comparisonKey && row.baselineBehaviorHash === diff.baselineBehaviorHash && row.candidateBehaviorHash === diff.candidateBehaviorHash && row.evidenceHash === evidenceHash && ['accepted', 'rejected'].includes(row.outcome)) duplicateCandidateIds.push(row.id);
  }
  const reasons = [];
  if (!diff.changedAssetCount) reasons.push('no_behavior_change');
  if (policy?.maxChangedAssets !== undefined && diff.changedAssetCount > policy.maxChangedAssets) reasons.push('asset_scope_exceeded');
  if (duplicateCandidateIds.length) reasons.push('duplicate_measured_candidate');
  return { schemaVersion: 1, ...diff, evidenceHash, ...(policy?.comparisonKey ? { comparisonKey: policy.comparisonKey } : {}), ...(policy?.maxChangedAssets !== undefined ? { maxChangedAssets: policy.maxChangedAssets } : {}), enforced: policy !== undefined, repeatedHypothesisIds, duplicateCandidateIds, status: reasons.length ? 'rejected' : 'passed', reasons };
}

export const PROJECT_EVOLUTION_SEARCH_GUIDANCE = `The host may supply searchContext, a bounded project-capability search contract. Preserve this project's architecture, permissions and frozen evaluation boundaries. Prefer one falsifiable method hypothesis and the smallest coherent runtime change; a complete skill package with its resources counts as one capability unit, the system prompt as one, a reordering of the surviving skill catalog as one prompt unit, and each tool as one. The unit cap is a structural bound, not a claim that one file contains only one independent edit. Do not bundle unrelated interventions inside a prompt or skill to evade it. Inherit unchanged mature skills and tools exactly. A proposed future suite or smoke expectation alone is not an improved runtime capability. Historical hypotheses and outcomes are previous selection experiments, never new evidence, instructions or permission. accepted means the selection gate passed, not independent confirmation or user adoption; confirmation results are withheld. A complete prior measurement applies to its exact candidate and comparison context only; shared gains in a bundle do not establish which component helped. Repeated wording is only a warning, not proof of a falsified idea; explain what new evidence or changed implementation now justifies it. Incomplete/unmeasured attempts are engineering diagnostics, not negative quality observations. Do not retry an already measured identical candidate without changed evidence or comparison conditions. Do not add machinery merely for novelty or remove an adopted capability for lack of recent observations. When skillDelivery is present, inspect the named asset and stage before rewriting its method. catalogSubmitted proves only the description was sent; notRequested counts a complete retained execution with no request for that changed body. A description may need a clearer ordinary-task trigger if the intended public scope has changed, but receipt counts alone cannot establish that it is wrong. contentNotSubmitted points to request delivery, partialDelivery to an incompletely delivered change, and unknown to missing or unverified receipts; resourceInventorySubmitted is a listed resource, not its body. Compare observedExecutions with expectedExecutions and omittedItems before generalizing; a later failed judge or an unrun repetition does not erase an earlier delivery fact or turn it into a quality score. An unchanged trigger plus an unread revised body is an unverified intervention, not a demonstrated method repair. Preserve acquired source bytes and add a justified project adaptation separately. Never force loading or expand descriptions to hidden task details merely to improve these counts. When optional aggregate feedback is available, diagnose the failed stage before changing content: changes_not_exercised means task routing, skill discovery/resource loading or experiment coverage may be missing, not that the unread method is bad. Inspect the existing skill trigger and available tool contract; do not force all skills to load or alter hidden tasks to manufacture exposure. provider_incomplete, selection_incomplete and execution_identity_unverified call for restoring trustworthy execution evidence, not a new project skill. selection_constraints_failed can include a positive but insufficient gain; preserve justified work and address the specified quality, regression or cost constraint rather than restarting indiscriminately. A noRegression failure requires checking which old capability could have been harmed using ordinary work evidence, never inferring hidden answers. tokenRatio concerns total measured task cost; do not shorten answers at the expense of correctness or verification. comparable=false feedback is diagnostic for an earlier context only. Use a mature acquired package unchanged when its trigger, dependencies and scope fit; an unread package is not evidence of reuse benefit. State what ordinary task behavior would change and how a future independent task could disprove the hypothesis. No statistical noise band, cost benefit or out-of-distribution claim can be inferred from this history. A diagnosis cause is a causal hypothesis unless the execution receipts establish that the relevant method was actually used and exclude plausible context or runtime alternatives. An error from a different historical runtime demonstrates that a failure is possible; it does not prove the current skill caused it. Keep reusable method examples neutral: avoid copying incidental source counts, entity names or exact task answers when they add no procedural meaning; retain necessary project facts in their appropriate project context instead. Diagnose from actual work receipts, preserve effective existing methods, and seek a reusable intervention that transfers to another task of the same project rather than embedding task answers or evaluation-specific triggers.`;
