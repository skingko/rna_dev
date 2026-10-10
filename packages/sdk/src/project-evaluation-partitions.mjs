import { evolutionHash as digest } from './evolution.mjs';
import { validateToolArguments } from './capabilities.mjs';

export class ProjectEvaluationPartitionError extends Error {
  constructor(message, code = 'invalid_evaluation_partition') { super(message); this.name = 'ProjectEvaluationPartitionError'; this.code = code; }
}
const fail = (message, code) => { throw new ProjectEvaluationPartitionError(message, code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => structuredClone(value);
const bounded = (value, max = 160) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const HASH = /^[a-f0-9]{64}$/;
const validHash = value => typeof value === 'string' && HASH.test(value);
const validId = value => typeof value === 'string' && ID.test(value);
const PARTITIONS = ['development', 'selection', 'confirmation'];
const STAGES = ['author', 'preflight', 'deterministic', 'paired', 'confirmation'];
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'estimatedTokens'];
const usage = () => Object.fromEntries(USAGE_FIELDS.map(key => [key, 0]));
// A changed oracle, weight or case label does not make an exposed task fresh.
const taskHash = row => digest({ input: row.input ?? null, workspaceFiles: row.workspace?.files ?? null, clock: row.clock ?? null });
function deepFreeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
function keys(value, allowed, required = allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('Unexpected or missing evaluation partition fields');
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Evaluation partition timestamps must be canonical UTC dates');
  return value;
}
function json(value) { try { validateToolArguments(true, value); } catch { fail('Evaluation partitions require lossless JSON values'); } }
const method = {
  id: 'project-partitions-v1', version: 1,
  order: ['selection', 'confirmation'],
  developmentUse: 'author_diagnostics_only',
  confirmationAdmission: 'selection_gates_passed',
  confirmationReuse: 'one_candidate_once',
  confirmationRequiredWhenPresent: true,
  missingConfirmation: 'not_applicable',
  independenceClaim: 'host_reviewed_provenance_not_statistical_proof',
};
/** Policy identity only. It provides no permissions and creates no held-out data. */
export const PROJECT_EVALUATION_PARTITION_METHOD = deepFreeze({ ...method, hash: digest(method) });

function checkedSuite(suite) {
  if (!record(suite) || !Array.isArray(suite.cases) || !suite.cases.length || suite.cases.length > 12) fail('Partition plans require 1..12 frozen cases');
  json(suite);
  const ids = new Set();
  for (const row of suite.cases) {
    if (!record(row) || !validId(row.id) || ids.has(row.id)) fail('Partition plans require unique valid case IDs');
    ids.add(row.id);
  }
  return suite;
}
function assignmentsFor(suite, input) {
  if (input === undefined) return suite.cases.map(row => ({ caseId: row.id, partition: 'selection', taskFamily: 'unclassified' }));
  if (!Array.isArray(input) || input.length !== suite.cases.length) fail('Explicit partitions must assign every frozen case exactly once');
  const byId = new Map();
  for (const row of input) {
    keys(row, ['caseId', 'partition', 'taskFamily'], ['caseId', 'partition']);
    if (!validId(row.caseId) || byId.has(row.caseId) || !PARTITIONS.includes(row.partition) || row.taskFamily !== undefined && !bounded(row.taskFamily, 80)) fail('Invalid case partition or task family');
    byId.set(row.caseId, { caseId: row.caseId, partition: row.partition, taskFamily: row.taskFamily ?? 'unclassified' });
  }
  const result = suite.cases.map(row => byId.get(row.id));
  if (result.some(row => !row) || !result.some(row => row.partition === 'selection')) fail('Every case must be known and at least one selection case is required');
  // A renamed case or a changed weight is not an independent example. This is
  // an exact-duplicate guard; semantic near-duplicate review remains host work.
  const partitionsByContent = new Map();
  for (let index = 0; index < result.length; index++) {
    const hash = taskHash(suite.cases[index]), partition = result[index].partition;
    if (partitionsByContent.has(hash) && partitionsByContent.get(hash) !== partition) fail('The same task cannot cross development, selection and confirmation partitions');
    partitionsByContent.set(hash, partition);
  }
  return result;
}
function provenanceFor(value, cases, frozenAt) {
  if (!cases.length) { if (value !== undefined) fail('Confirmation provenance requires confirmation cases'); return null; }
  keys(value, ['datasetId', 'version', 'sourceHash', 'reviewId', 'reviewedAt', 'authorship', 'exposure']);
  if (!bounded(value.datasetId) || !bounded(value.version, 100) || !bounded(value.reviewId) || !validHash(value.sourceHash) || value.sourceHash !== digest(cases) || value.authorship !== 'independent_host_review' || value.exposure !== 'withheld') fail('Confirmation needs matching independently reviewed, withheld host data');
  timestamp(value.reviewedAt);
  if (value.reviewedAt > frozenAt) fail('Confirmation review must precede the frozen experiment plan');
  return clone(value);
}

/** Call from the trusted host before authoring and persist before dispatch.
 * Candidate content must never supply assignments or provenance. Legacy suites
 * remain selection-only: hidden author inputs are not proof of independence.
 * Provenance is an auditable host assertion, not a cryptographic certification.
 */
export function createProjectEvaluationPartitionPlan({ suite, assignments, confirmationProvenance, frozenAt = new Date().toISOString() } = {}) {
  checkedSuite(suite); timestamp(frozenAt);
  const rows = assignmentsFor(suite, assignments), confirmationCases = suite.cases.filter((_, index) => rows[index].partition === 'confirmation');
  const provenance = provenanceFor(confirmationProvenance, confirmationCases, frozenAt);
  const taskHashes = confirmationCases.map(taskHash).sort();
  if (new Set(taskHashes).size !== taskHashes.length) fail('Confirmation cases must contain distinct tasks');
  const value = {
    schemaVersion: 1, method: PROJECT_EVALUATION_PARTITION_METHOD, frozenAt,
    suiteHash: digest(suite),
    assignments: rows.map((row, index) => ({ ...row, caseHash: digest(suite.cases[index]) })),
    confirmation: { status: confirmationCases.length ? 'available' : 'not_applicable', reason: confirmationCases.length ? 'host_reviewed_withheld_cases' : 'independent_confirmation_not_supplied', dataHash: confirmationCases.length ? digest(taskHashes) : null, taskHashes, provenance },
  };
  return deepFreeze({ ...value, planHash: digest(value) });
}

/** Restore against the complete original suite; changing criteria, fixture,
 * allocation, partition, time, or provenance invalidates the identity. */
export function validateProjectEvaluationPartitionPlan(plan, suite) {
  keys(plan, ['schemaVersion', 'method', 'frozenAt', 'suiteHash', 'assignments', 'confirmation', 'planHash']);
  json(plan);
  if (plan.schemaVersion !== 1 || digest(plan.method) !== digest(PROJECT_EVALUATION_PARTITION_METHOD) || !Array.isArray(plan.assignments)) fail('Unknown evaluation partition method');
  for (const row of plan.assignments) keys(row, ['caseId', 'partition', 'taskFamily', 'caseHash']);
  keys(plan.confirmation, ['status', 'reason', 'dataHash', 'taskHashes', 'provenance']);
  const restored = createProjectEvaluationPartitionPlan({ suite, assignments: plan.assignments.map(({ caseHash, ...row }) => row), confirmationProvenance: plan.confirmation.provenance ?? undefined, frozenAt: plan.frozenAt });
  if (digest(plan) !== digest(restored)) fail('The evaluation partition plan does not match its frozen contents');
  return restored;
}

/** Returns cloned case bodies only to an evaluator/development reader. Never
 * send selection or confirmation bodies to candidate authors or their tools. */
export function projectEvaluationPartitionCases(plan, suite, partition) {
  if (!PARTITIONS.includes(partition)) fail('Unknown evaluation partition');
  const checked = validateProjectEvaluationPartitionPlan(plan, suite);
  const ids = new Set(checked.assignments.filter(row => row.partition === partition).map(row => row.caseId));
  return clone(suite.cases.filter(row => ids.has(row.id)));
}

/** Public status has counts and declared coverage, never private case IDs,
 * inputs, expected values, provenance paths, or a fabricated passed result. */
export function projectEvaluationPartitionSummary(plan) {
  keys(plan, ['schemaVersion', 'method', 'frozenAt', 'suiteHash', 'assignments', 'confirmation', 'planHash']);
  json(plan);
  const { planHash, ...value } = plan;
  if (plan.schemaVersion !== 1 || planHash !== digest(value) || digest(plan.method) !== digest(PROJECT_EVALUATION_PARTITION_METHOD) || !validHash(plan.suiteHash) || !Array.isArray(plan.assignments) || !plan.assignments.length || plan.assignments.length > 12) fail('Invalid evaluation partition identity');
  timestamp(plan.frozenAt);
  const seen = new Set();
  for (const row of plan.assignments) {
    keys(row, ['caseId', 'partition', 'taskFamily', 'caseHash']);
    if (!validId(row.caseId) || seen.has(row.caseId) || !PARTITIONS.includes(row.partition) || !bounded(row.taskFamily, 80) || !validHash(row.caseHash)) fail('Invalid evaluation partition assignments');
    seen.add(row.caseId);
  }
  keys(plan.confirmation, ['status', 'reason', 'dataHash', 'taskHashes', 'provenance']);
  const counts = Object.fromEntries(PARTITIONS.map(partition => [partition, plan.assignments.filter(row => row.partition === partition).length]));
  const taskHashes = plan.confirmation.taskHashes;
  if (!Array.isArray(taskHashes) || taskHashes.length !== counts.confirmation || taskHashes.some(hash => !validHash(hash)) || new Set(taskHashes).size !== taskHashes.length || digest(taskHashes) !== digest([...taskHashes].sort())) fail('Invalid confirmation task inventory');
  if (!counts.selection || counts.confirmation && (plan.confirmation.status !== 'available' || plan.confirmation.reason !== 'host_reviewed_withheld_cases' || plan.confirmation.dataHash !== digest(taskHashes) || !record(plan.confirmation.provenance)) || !counts.confirmation && (plan.confirmation.status !== 'not_applicable' || plan.confirmation.reason !== 'independent_confirmation_not_supplied' || plan.confirmation.dataHash !== null || plan.confirmation.provenance !== null)) fail('Confirmation availability must match the frozen case assignments');
  if (counts.confirmation) {
    const provenance = plan.confirmation.provenance;
    keys(provenance, ['datasetId', 'version', 'sourceHash', 'reviewId', 'reviewedAt', 'authorship', 'exposure']);
    if (!bounded(provenance.datasetId) || !bounded(provenance.version, 100) || !bounded(provenance.reviewId) || !validHash(provenance.sourceHash) || provenance.authorship !== 'independent_host_review' || provenance.exposure !== 'withheld') fail('Invalid confirmation review identity');
    timestamp(provenance.reviewedAt);
    if (provenance.reviewedAt > plan.frozenAt) fail('Confirmation review must precede the frozen experiment plan');
  }
  const taskFamilies = [...new Set(plan.assignments.map(row => row.taskFamily))].sort().map(taskFamily => ({ taskFamily, ...Object.fromEntries(PARTITIONS.map(partition => [partition, plan.assignments.filter(row => row.partition === partition && row.taskFamily === taskFamily).length])) }));
  return deepFreeze({ methodId: plan.method.id, planHash, counts, taskFamilies, confirmation: { status: plan.confirmation.status, reason: plan.confirmation.reason, passed: null }, statisticalClaim: 'none' });
}

const CLAIM_FIELDS = ['schemaVersion', 'planHash', 'suiteHash', 'candidateHash', 'confirmationDataHash', 'confirmationTaskHashes', 'claimedAt', 'status', 'claimHash'];
const SETTLEMENT_FIELDS = ['settledAt', 'resultHash', 'reason', 'settlementHash'];
function checkedClaim(claim) {
  if (!record(claim)) fail('A durable confirmation claim is required');
  const settled = claim.status !== 'claimed';
  keys(claim, [...CLAIM_FIELDS, ...(settled ? SETTLEMENT_FIELDS : [])]); json(claim);
  if (claim.schemaVersion !== 1 || !['claimed', 'passed', 'failed', 'interrupted'].includes(claim.status) || ['planHash', 'suiteHash', 'candidateHash', 'confirmationDataHash', 'claimHash'].some(key => !validHash(claim[key]))) fail('Invalid confirmation claim identity');
  if (!Array.isArray(claim.confirmationTaskHashes) || !claim.confirmationTaskHashes.length || claim.confirmationTaskHashes.length > 12 || claim.confirmationTaskHashes.some(hash => !validHash(hash)) || new Set(claim.confirmationTaskHashes).size !== claim.confirmationTaskHashes.length || digest(claim.confirmationTaskHashes) !== claim.confirmationDataHash || digest([...claim.confirmationTaskHashes].sort()) !== claim.confirmationDataHash) fail('Invalid confirmation claim task inventory');
  timestamp(claim.claimedAt);
  const original = Object.fromEntries(CLAIM_FIELDS.filter(key => key !== 'claimHash').map(key => [key, key === 'status' ? 'claimed' : claim[key]]));
  if (digest(original) !== claim.claimHash) fail('Confirmation claim does not match its original reservation');
  if (settled) {
    timestamp(claim.settledAt);
    if (claim.settledAt < claim.claimedAt || claim.resultHash !== null && !validHash(claim.resultHash) || claim.reason !== null && !bounded(claim.reason, 160) || claim.status === 'passed' && !validHash(claim.resultHash)) fail('Invalid confirmation settlement');
    const { settlementHash, ...contents } = claim;
    if (digest(contents) !== settlementHash) fail('Confirmation settlement does not match its contents');
  }
  return claim;
}

/** Validate a serialized reservation/settlement and optionally bind it to the
 * evaluator's already-validated frozen plan and candidate. This does not prove
 * the host committed it; asynchronous durable admission remains host-owned. */
export function validateProjectEvaluationConfirmationClaim(claim, { plan, candidateHash } = {}) {
  checkedClaim(claim);
  if (plan !== undefined) {
    projectEvaluationPartitionSummary(plan);
    if (claim.planHash !== plan.planHash || claim.suiteHash !== plan.suiteHash || claim.confirmationDataHash !== plan.confirmation.dataHash || digest(claim.confirmationTaskHashes) !== digest(plan.confirmation.taskHashes) || claim.claimedAt < plan.frozenAt) fail('Confirmation claim does not belong to the frozen plan', 'evaluation_confirmation_claim_invalid');
  }
  if (candidateHash !== undefined && (!validHash(candidateHash) || claim.candidateHash !== candidateHash)) fail('Confirmation claim belongs to another candidate', 'evaluation_confirmation_claim_invalid');
  return deepFreeze(clone(claim));
}

/** Reserve once, and persist the returned record before the first confirmation
 * request. The host serializes this transaction and retains all prior claims.
 * Reconstructing a plan or renaming/reweighting cases cannot reuse these same
 * confirmation tasks. Semantic paraphrase/near-duplicate review is still a host
 * obligation. No claim (including an interrupted one) is eligible for replay.
 */
export function createProjectEvaluationConfirmationClaim({ plan, candidateHash, existingClaims = [], claimedAt = new Date().toISOString() } = {}) {
  projectEvaluationPartitionSummary(plan); timestamp(claimedAt);
  if (plan.confirmation.status !== 'available') fail('This plan has no independent confirmation cases', 'evaluation_confirmation_unavailable');
  if (!validHash(candidateHash) || claimedAt < plan.frozenAt || !Array.isArray(existingClaims) || existingClaims.length > 100000) fail('Confirmation reservation needs a valid candidate identity and bounded claim history');
  for (const claim of existingClaims) {
    checkedClaim(claim);
    if (claim.confirmationTaskHashes.some(hash => plan.confirmation.taskHashes.includes(hash))) fail('Confirmation data was already consumed by an earlier candidate reservation', 'evaluation_confirmation_consumed');
  }
  const value = { schemaVersion: 1, planHash: plan.planHash, suiteHash: plan.suiteHash, candidateHash, confirmationDataHash: plan.confirmation.dataHash, confirmationTaskHashes: clone(plan.confirmation.taskHashes), claimedAt, status: 'claimed' };
  return deepFreeze({ ...value, claimHash: digest(value) });
}

/** Attach a host-observed outcome without releasing the consumed data. This
 * pure receipt helper does not judge results; a passed result requires a bound
 * evaluation result hash. Terminal history is immutable, including failures.
 */
export function settleProjectEvaluationConfirmationClaim(claim, { status, settledAt = new Date().toISOString(), resultHash = null, reason = null } = {}) {
  checkedClaim(claim); timestamp(settledAt);
  if (!['passed', 'failed', 'interrupted'].includes(status) || settledAt < claim.claimedAt || resultHash !== null && !validHash(resultHash) || reason !== null && !bounded(reason, 160) || status === 'passed' && !validHash(resultHash)) fail('Confirmation settlement needs a terminal outcome, time and valid result identity');
  const original = Object.fromEntries(CLAIM_FIELDS.map(key => [key, key === 'status' ? 'claimed' : claim[key]]));
  const value = { ...original, status, settledAt, resultHash, reason };
  const result = { ...value, settlementHash: digest(value) };
  if (claim.status !== 'claimed' && digest(claim) !== digest(result)) fail('A settled confirmation receipt cannot be rewritten', 'evaluation_confirmation_settled');
  return deepFreeze(result);
}

/** Phase accounting is descriptive, not a success gate. Host stages distinguish
 * a failed contract/evaluation from a successfully completed provider request.
 * Request token usage is counted once; check stages have no invented bill.
 */
export function createProjectEvaluationPhaseLedger({ requests = [], stages = [], plan } = {}) {
  if (!Array.isArray(requests) || requests.length > 10000 || !Array.isArray(stages) || stages.length > 1000) fail('Evaluation phase accounting must be bounded');
  const rows = Object.fromEntries(STAGES.map(phase => [phase, { phase, status: 'not_started', reasons: [], requests: 0, completedRequests: 0, startedRequests: 0, usage: usage() }]));
  const byId = new Map();
  if (plan) projectEvaluationPartitionSummary(plan);
  const partitionByCase = new Map((plan?.assignments ?? []).map(row => [row.caseId, row.partition]));
  const unmatched = { requests: 0, usage: usage() };
  for (const request of requests) {
    if (!record(request) || !bounded(request.id) || !bounded(request.phase)) fail('Metered requests need a stable ID and bounded phase');
    json(request);
    if (byId.has(request.id)) {
      if (digest(byId.get(request.id)) !== digest(request)) fail('Conflicting usage receipts share a request ID');
      continue;
    }
    byId.set(request.id, request);
    const match = /^(baseline|candidate|judge):([^:]+)$/.exec(request.phase);
    const phase = /^(proposal|script-repair):/.test(request.phase) ? 'author' : match ? partitionByCase.get(match[2]) === 'confirmation' ? 'confirmation' : 'paired' : STAGES.includes(request.phase) ? request.phase : null;
    const target = phase ? rows[phase] : unmatched;
    target.requests++;
    if (phase) { if (request.completed === true) target.completedRequests++; if (request.requestStarted !== false) target.startedRequests++; }
    if (!record(request.usage)) fail('Metered requests need explicit usage');
    for (const field of USAGE_FIELDS) {
      const amount = request.usage[field] ?? 0;
      if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(amount)) fail('Metered usage must contain nonnegative safe integers');
      target.usage[field] += amount;
      if (!Number.isSafeInteger(target.usage[field])) fail('Aggregate metered usage exceeds its safe integer bound');
    }
  }
  const stageSeen = new Set();
  for (const stage of stages) {
    keys(stage, ['phase', 'status', 'reason'], ['phase', 'status']);
    if (!STAGES.includes(stage.phase) || stageSeen.has(stage.phase) || !['not_started', 'running', 'passed', 'failed', 'interrupted', 'skipped', 'not_applicable'].includes(stage.status) || stage.reason !== undefined && !bounded(stage.reason, 160)) fail('Invalid or duplicate host evaluation phase result');
    stageSeen.add(stage.phase);
    if (stage.phase === 'confirmation' && plan?.confirmation.status === 'not_applicable' && !['not_started', 'skipped', 'not_applicable'].includes(stage.status)) fail('A missing confirmation set cannot receive an execution outcome');
    rows[stage.phase].status = stage.status;
    if (stage.reason !== undefined) rows[stage.phase].reasons.push(stage.reason);
  }
  for (const row of Object.values(rows)) if (row.requests && !stageSeen.has(row.phase)) row.status = 'observed_requests';
  if (plan?.confirmation.status === 'not_applicable' && !stageSeen.has('confirmation')) { rows.confirmation.status = 'not_applicable'; rows.confirmation.reasons.push(plan.confirmation.reason); }
  const totals = usage();
  for (const row of [...Object.values(rows), unmatched]) for (const field of USAGE_FIELDS) { totals[field] += row.usage[field]; if (!Number.isSafeInteger(totals[field])) fail('Aggregate metered usage exceeds its safe integer bound'); }
  return deepFreeze({ schemaVersion: 1, phases: Object.values(rows), unmatched, requestCount: byId.size, usage: totals, qualityClaim: 'none' });
}
