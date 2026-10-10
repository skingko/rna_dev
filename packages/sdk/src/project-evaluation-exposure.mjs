import { createHash } from 'node:crypto';
import { evolutionHash } from './evolution.mjs';
import { validateProjectGenome } from './project-genome.mjs';
import { formatSkillContent } from './genome-skill-content.mjs';

export const PROJECT_EVALUATION_EXPOSURE_METHOD = 'host-intervention-exposure-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const contentHash = value => value === undefined ? null : typeof value === 'string' ? hash(value) : evolutionHash(value);
const variant = value => ({ present: value !== undefined, hash: contentHash(value) });
const ordered = (before, after) => [...new Set([...before, ...after])].sort();

// A conservative envelope, not a semantic diff. Covering this entire interval
// proves all changed bytes were delivered. Partial overlap proves neither that
// a particular edit was seen nor that it influenced the answer.
function changedSpans(before, after) {
  if (before === undefined || after === undefined) return [before, after].map(text => text === undefined ? null : { start: 0, end: text.length, scope: 'entire_added_or_removed_content' });
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return [before, after].map(text => {
    const end = text.length - suffix;
    // A deletion leaves no new bytes to read. Only delivery of the entire
    // remaining content can establish which version was available to the model.
    return end === prefix ? { start: 0, end: text.length, scope: 'entire_remaining_content_after_deletion' } : { start: prefix, end, scope: 'changed_region_envelope' };
  });
}

/** Host-only inventory of changes. It contains identities/hashes, not private
 * evaluation expectations or skill bodies. Never put this report in a prompt. */
export function createProjectEvaluationExposurePlan({ baseline, candidate } = {}) {
  const before = validateProjectGenome(baseline), after = validateProjectGenome(candidate), changes = [];
  const add = (kind, target, mode, a, b, extra = {}) => {
    if (contentHash(a) === contentHash(b)) return;
    const sides = [variant(a), variant(b)];
    if (mode === 'skill_content') changedSpans(a, b).forEach((span, i) => { if (span) sides[i].span = span; });
    changes.push({ id: `${kind}:${target}`, kind, target, mode, change: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified', baseline: sides[0], candidate: sides[1], ...extra });
  };
  add('system_prompt', 'systemPrompt', 'request_context', before.systemPrompt, after.systemPrompt);
  add('skill_catalog_order', 'skills', 'request_context', before.skills.map(s => s.id), after.skills.map(s => s.id));
  for (const id of ordered(before.skills.map(s => s.id), after.skills.map(s => s.id))) {
    const a = before.skills.find(s => s.id === id), b = after.skills.find(s => s.id === id), metadata = s => s && ({ id: s.id, name: s.name, description: s.description });
    add('skill_catalog', id, 'request_context', metadata(a), metadata(b));
    add('skill_instructions', id, 'skill_content', a?.instructions, b?.instructions, { skillId: id, path: 'SKILL.md' });
    for (const path of ordered((a?.resources ?? []).map(r => r.path), (b?.resources ?? []).map(r => r.path))) add('skill_resource', `${id}/${path}`, 'skill_content', a?.resources.find(r => r.path === path)?.content, b?.resources.find(r => r.path === path)?.content, { skillId: id, path });
    add('skill_source', id, 'host_metadata', a?.source, b?.source);
  }
  // prepareContext sorts tool declarations by name; authored array order is not
  // a model-visible intervention in the current SDK.
  add('tool_catalog_order', 'tools', 'host_metadata', before.tools.map(t => t.id), after.tools.map(t => t.id));
  for (const id of ordered(before.tools.map(t => t.id), after.tools.map(t => t.id))) {
    const a = before.tools.find(t => t.id === id), b = after.tools.find(t => t.id === id), declaration = t => t && ({ name: t.id, description: t.description, parameters: t.parameters });
    add('tool_declaration', id, 'request_context', declaration(a), declaration(b), { toolId: id });
    add('tool_script', id, 'tool_execution', a?.script, b?.script, { toolId: id });
    add('tool_permission', id, 'tool_execution', a?.permission, b?.permission, { toolId: id });
    add('tool_label', id, 'host_metadata', a?.name, b?.name);
    add('tool_smoke_cases', id, 'host_validation', a?.smokeCases, b?.smokeCases);
  }
  add('evaluation_suite', 'evaluationSuite', 'future_evaluation_standard', before.evaluationSuite, after.evaluationSuite);
  const plan = { schemaVersion: 1, method: PROJECT_EVALUATION_EXPOSURE_METHOD, baselineHash: evolutionHash(before), candidateHash: evolutionHash(after), changes };
  return freeze({ ...plan, planHash: evolutionHash(plan) });
}

function validatePlan(plan, genome, side) {
  if (!['baseline', 'candidate'].includes(side) || !plan || plan.schemaVersion !== 1 || plan.method !== PROJECT_EVALUATION_EXPOSURE_METHOD || !Array.isArray(plan.changes)) throw new TypeError('Invalid project evaluation exposure plan or side');
  const { planHash, ...body } = plan;
  if (planHash !== evolutionHash(body)) throw new TypeError('Project evaluation exposure plan hash mismatch');
  const valid = validateProjectGenome(genome);
  if (evolutionHash(valid) !== plan[`${side}Hash`]) throw new TypeError('Exposure genome differs from its frozen plan');
  return valid;
}

function resultText(result) {
  if (typeof result?.output === 'string') return result.output;
  if (Array.isArray(result?.content)) return result.content.filter(row => row.type === 'text').map(row => row.text).join('');
  return undefined;
}
function unionRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end); else merged.push({ ...range });
  }
  return merged;
}
function verifySkillRead(skill, call, receipt) {
  if (receipt.isError !== false || receipt.validationReceipt || receipt.uncertain === true) return null;
  const args = call.arguments, path = args?.path ?? 'SKILL.md', raw = path === 'SKILL.md' ? skill.instructions : skill.resources.find(row => row.path === path)?.content;
  if (!args || args.id !== skill.id || raw === undefined || Object.keys(args).some(key => !['id', 'path', 'offset', 'limit'].includes(key))) return null;
  let expected, actual;
  try { expected = formatSkillContent({ id: skill.id, path, raw, offset: args.offset, limit: args.limit, resources: skill.resources }); actual = JSON.parse(resultText(receipt)); } catch { return null; }
  if (evolutionHash(actual) !== evolutionHash(expected)) return null;
  const lines = raw.split('\n'), start = lines.slice(0, Math.min(expected.offset, lines.length)).reduce((total, line, index) => total + line.length + (index < lines.length - 1 ? 1 : 0), 0);
  return { path, contentHash: expected.contentHash, start, end: Math.min(raw.length, start + expected.content.length), emptyBodyDelivered: raw.length === 0 && expected.offset === 0, resources: expected.resources ?? [] };
}

/** Observe only SDK/host-owned calls and tool receipts. Caller must not pass
 * model-authored JSON or transcript text as host receipts. `contextExposed`
 * means the ordinary runCase request (system prompt, catalog, tool schemas) was
 * submitted; it does NOT mean attention, comprehension, or compliance.
 * `receiptsComplete` is explicit because error snapshots/old reports may omit
 * calls. Their absence must remain unknown. This API never changes quality gates.
 */
export function observeProjectEvaluationExposure({ plan, genome, side, execution = {}, contextExposed = false, receiptsComplete = false } = {}) {
  const valid = validatePlan(plan, genome, side);
  if (typeof contextExposed !== 'boolean' || typeof receiptsComplete !== 'boolean') throw new TypeError('Exposure context/completeness flags must be booleans');
  const calls = Array.isArray(execution.calls) ? execution.calls : [], results = Array.isArray(execution.toolResults) ? execution.toolResults : [];
  const submitted = Array.isArray(execution.submittedToolResults) ? execution.submittedToolResults : [];
  const deliveryAttested = Array.isArray(execution.submittedToolResults);
  const complete = receiptsComplete && Array.isArray(execution.calls) && Array.isArray(execution.toolResults);
  const callCounts = new Map(), resultCounts = new Map();
  for (const call of calls) callCounts.set(call?.id, (callCounts.get(call?.id) ?? 0) + 1);
  for (const result of results) resultCounts.set(result?.toolCallId, (resultCounts.get(result?.toolCallId) ?? 0) + 1);
  const paired = calls.map(call => {
    const matching = results.filter(result => result.toolCallId === call.id), result = matching[0];
    const unique = typeof call.id === 'string' && call.id.length > 0 && callCounts.get(call.id) === 1 && resultCounts.get(call.id) === 1 && result?.toolName === call.name;
    return { call, result: unique ? result : null, ambiguous: !unique };
  });
  const changes = plan.changes.map(change => {
    const binding = change[side], base = { id: change.id, kind: change.kind, target: change.target, mode: change.mode, change: change.change, planned: true, present: binding.present, contentHash: binding.hash };
    if (['host_metadata', 'host_validation', 'future_evaluation_standard'].includes(change.mode)) return { ...base, status: 'not_applicable', reason: change.mode === 'future_evaluation_standard' ? 'candidate_standards_do_not_replace_frozen_comparison' : 'outside_task_model_exposure' };
    if (!binding.present) return { ...base, status: 'not_applicable', reason: 'capability_absent_on_this_side' };
    if (change.mode === 'request_context') return { ...base, status: contextExposed ? 'observed' : 'unknown', reason: contextExposed ? 'included_in_submitted_context' : 'request_context_not_attested' };
    if (change.mode === 'tool_execution') {
      const relevant = paired.filter(row => row.call.name === change.toolId), successes = relevant.filter(row => row.result && row.result.isError === false && !row.result.validationReceipt && row.result.uncertain !== true);
      const rejected = relevant.filter(row => row.result?.isError === true && row.result.validationReceipt?.source === 'sdk_argument_validation' && row.result.validationReceipt?.neverExecuted === true);
      const ambiguous = relevant.some(row => !successes.includes(row) && !rejected.includes(row)) || results.some(row => row.toolName === change.toolId && !calls.some(call => call.id === row.toolCallId));
      return { ...base, status: successes.length ? 'observed' : ambiguous || !complete ? 'unknown' : 'unobserved', reason: successes.length ? change.kind === 'tool_permission' ? 'tool_completed_under_declared_permission_not_boundary_verification' : 'host_successful_tool_completion' : ambiguous ? 'tool_execution_not_proven' : !complete ? 'receipt_inventory_incomplete' : rejected.length ? 'arguments_rejected_before_execution' : 'no_tool_execution_observed', callIds: successes.map(row => row.call.id), attemptedCalls: relevant.length, validationRejectedCalls: rejected.length };
    }
    const skill = valid.skills.find(row => row.id === change.skillId), raw = change.path === 'SKILL.md' ? skill.instructions : skill.resources.find(row => row.path === change.path).content;
    const relevant = paired.filter(row => row.call.name === 'skill_load' && row.call.arguments?.id === change.skillId && (row.call.arguments.path ?? 'SKILL.md') === change.path);
    const readDelivered = row => {
      const hostRead = row.result && verifySkillRead(skill, row.call, row.result);
      if (!hostRead) return null;
      // Completion alone is not delivery: cancellation can occur before the
      // follow-up request. Verify the bytes in an actual subsequent request too.
      return submitted.some(receipt => receipt.toolCallId === row.call.id && receipt.toolName === row.call.name && verifySkillRead(skill, row.call, receipt)) ? hostRead : null;
    };
    const reads = relevant.map(row => ({ ...row, read: readDelivered(row) })).filter(row => row.read);
    const ranges = unionRanges(reads.map(row => ({ start: row.read.start, end: row.read.end }))), span = binding.span;
    const covered = raw.length === 0 ? reads.some(row => row.read.emptyBodyDelivered) : ranges.some(range => range.start <= span.start && range.end >= span.end);
    const overlaps = ranges.some(range => range.start < span.end && range.end > span.start);
    const rejected = relevant.filter(row => row.result?.isError === true && row.result.validationReceipt?.source === 'sdk_argument_validation' && row.result.validationReceipt?.neverExecuted === true);
    const undelivered = relevant.filter(row => row.result && verifySkillRead(skill, row.call, row.result) && !readDelivered(row));
    const uncertain = relevant.some(row => !reads.some(read => read.call === row.call) && !rejected.includes(row) && !(deliveryAttested && undelivered.includes(row))) || results.some(row => row.toolName === 'skill_load' && !calls.some(call => call.id === row.toolCallId));
    const inventoryObserved = change.path !== 'SKILL.md' && paired.some(row => {
      if (row.call.name !== 'skill_load' || row.call.arguments?.id !== skill.id || (row.call.arguments.path ?? 'SKILL.md') !== 'SKILL.md' || !row.result) return false;
      const read = readDelivered(row);
      return read?.resources.some(resource => resource.path === change.path && resource.contentHash === binding.hash);
    });
    return { ...base, status: covered ? 'observed' : uncertain || !complete || overlaps ? 'unknown' : 'unobserved', reason: covered ? 'verified_content_covers_change' : uncertain ? 'skill_receipt_missing_mismatched_or_truncated' : !complete ? 'receipt_inventory_incomplete' : overlaps ? 'only_partial_change_region_delivered' : undelivered.length ? 'tool_content_not_in_submitted_request' : 'changed_content_not_delivered', callIds: reads.map(row => row.call.id), attemptedCalls: relevant.length, inventoryObserved, coverage: { unit: 'utf16_code_units', target: clone(span), ranges, deliveredUnits: ranges.reduce((total, range) => total + range.end - range.start, 0), totalUnits: raw.length, completeBody: raw.length === 0 ? covered : ranges.some(range => range.start === 0 && range.end === raw.length) } };
  });
  const counts = Object.fromEntries(['observed', 'unobserved', 'unknown', 'not_applicable'].map(status => [status, changes.filter(row => row.status === status).length]));
  return freeze({ schemaVersion: 1, method: PROJECT_EVALUATION_EXPOSURE_METHOD, planHash: plan.planHash, genomeHash: plan[`${side}Hash`], side, contextExposed, receiptsComplete: complete, planned: changes.length, counts, changes,
    limits: ['Host evidence of submitted context or delivered tool content only; attention and compliance are not observable.', 'Unobserved changes do not establish that a method is poor or irrelevant.', 'Score differences do not establish causality; task coverage, changed components, and sampling can confound comparisons.', 'Partial or truncated receipts remain unknown; no extra skill loads or model requests are introduced.'] });
}

/** Summaries retain per-case variation. Never stitch skill pages from unrelated
 * model executions together, or promote a partial experiment into full coverage. */
export function summarizeProjectEvaluationExposure({ plan, cases = [], expectedCaseIds = [] } = {}) {
  if (!plan || plan.planHash !== evolutionHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash')))) throw new TypeError('Invalid exposure summary plan');
  if (!Array.isArray(cases) || !Array.isArray(expectedCaseIds) || new Set(cases.map(row => row.id)).size !== cases.length || new Set(expectedCaseIds).size !== expectedCaseIds.length) throw new TypeError('Exposure case identities must be unique');
  const ids = [...new Set([...expectedCaseIds, ...cases.map(row => row.id)])];
  const result = { schemaVersion: 1, method: PROJECT_EVALUATION_EXPOSURE_METHOD, plan: clone(plan), expectedCases: ids.length, observedCases: cases.filter(row => row.baseline?.exposure || row.candidate?.exposure).length };
  for (const side of ['baseline', 'candidate']) {
    const changes = plan.changes.map(change => {
      const observations = ids.map(caseId => {
        const exposure = cases.find(row => row.id === caseId)?.[side]?.exposure;
        if (exposure && (exposure.planHash !== plan.planHash || exposure.side !== side || exposure.genomeHash !== plan[`${side}Hash`])) throw new TypeError('Exposure summary receipt binding mismatch');
        const row = exposure?.changes.find(item => item.id === change.id);
        return { caseId, status: row?.status ?? 'unknown', reason: row?.reason ?? 'case_exposure_not_observed' };
      });
      const outsideRuntime = !change[side].present || ['host_metadata', 'host_validation', 'future_evaluation_standard'].includes(change.mode);
      const status = outsideRuntime ? 'not_applicable' : observations.some(row => row.status === 'observed') ? 'observed' : observations.length && observations.every(row => row.status === 'not_applicable') ? 'not_applicable' : observations.length && observations.every(row => ['unobserved', 'not_applicable'].includes(row.status)) ? 'unobserved' : 'unknown';
      return { id: change.id, kind: change.kind, target: change.target, mode: change.mode, change: change.change, status, observations };
    });
    result[side] = { counts: Object.fromEntries(['observed', 'unobserved', 'unknown', 'not_applicable'].map(status => [status, changes.filter(row => row.status === status).length])), changes };
  }
  result.causalClaim = 'none'; result.qualityGateChanged = false;
  return freeze(result);
}
