import { evolutionHash as digest } from './evolution.mjs';
import { validateProjectEvaluationClock, projectEvaluationClockInstructions } from './project-evaluation-contract.mjs';

export class ProjectEvaluationProfileError extends Error {
  constructor(message, code = 'invalid_evaluation_profile') { super(message); this.name = 'ProjectEvaluationProfileError'; this.code = code; }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function deepFreeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
const invalid = message => { throw new ProjectEvaluationProfileError(message, 'invalid_evaluation_execution'); };
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const CASE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// One response request consumes one step. Disabling automatic compaction and
// terminal summarization prevents uncounted extra requests in this environment.
export const PROJECT_EVALUATION_SESSION_POLICY = deepFreeze({ autoCompaction: false, stepLimitBehavior: 'error' });
function profile(id, textSteps, textOutput, toolErrorPolicy) {
  const value = { id, version: 1, defaults: { withoutWorkspace: { maxSteps: textSteps, maxOutputTokens: textOutput }, withWorkspace: { maxSteps: 16, maxOutputTokens: 4096 } }, sessionPolicy: PROJECT_EVALUATION_SESSION_POLICY, ...(toolErrorPolicy ? { toolErrorPolicy } : {}) };
  return deepFreeze({ ...value, hash: digest(value) });
}
/** Reproduces legacy allocation only. Exact historical runtime behavior belongs
 * to its original frozen runtime/artifacts, not to this new module. */
export const LEGACY_PROJECT_EVALUATION_PROFILE = profile('legacy-v1', 4, 1500);
export const WORKFLOW_V1_PROJECT_EVALUATION_PROFILE = profile('workflow-v1', 16, 4096);
export const WORKFLOW_V2_PROJECT_EVALUATION_PROFILE = profile('workflow-v2', 16, 4096, 'schema-recovery-v1');
// workflow-v3: project_write refuses to overwrite a file this conversation has not observed (not_observed) or that
// changed since (conflict), writing nothing; reading it and saving that path again recovers the refusal
// (schema-recovery-v2). Results before it (workflow-v2) ran without that guard and are not comparable.
export const CURRENT_PROJECT_EVALUATION_PROFILE = profile('workflow-v3', 16, 4096, 'schema-recovery-v2');
export const PROJECT_EVALUATION_PROFILES = deepFreeze({ 'legacy-v1': LEGACY_PROJECT_EVALUATION_PROFILE, 'workflow-v1': WORKFLOW_V1_PROJECT_EVALUATION_PROFILE, 'workflow-v2': WORKFLOW_V2_PROJECT_EVALUATION_PROFILE, 'workflow-v3': CURRENT_PROJECT_EVALUATION_PROFILE });

function selectedProfile(input) {
  // Profiles are host-owned constants. A serialized identity or exact clone is
  // accepted for restoration, never arbitrary candidate-supplied allocations.
  if (!record(input) || !Object.hasOwn(PROJECT_EVALUATION_PROFILES, input.id)) throw new ProjectEvaluationProfileError('Unknown host evaluation profile');
  const known = PROJECT_EVALUATION_PROFILES[input.id];
  const identity = { id: known.id, version: known.version, hash: known.hash };
  if (digest(input) !== digest(identity) && digest(input) !== digest(known)) throw new ProjectEvaluationProfileError('Evaluation profile does not match its frozen host definition');
  return known;
}
export function resolveProjectEvaluationToolErrorPolicy(profile = CURRENT_PROJECT_EVALUATION_PROFILE) {
  return selectedProfile(profile).toolErrorPolicy ?? 'strict-v1';
}
function workspacePresent(testCase) {
  if (!record(testCase)) invalid('Evaluation case must be an object');
  if (testCase.workspace !== undefined && !record(testCase.workspace)) invalid('Evaluation workspace must be an explicit fixture object');
  return testCase.workspace !== undefined;
}
function modelOutputLimit(model) {
  if (!record(model)) invalid('Evaluation model configuration must be an object');
  const cap = model.maxOutputTokens === undefined ? 4096 : model.maxOutputTokens;
  if (!integer(cap, 1, Number.MAX_SAFE_INTEGER)) invalid('Model output capacity must be a positive integer');
  return cap;
}
function suiteAllocation(suite, withWorkspace, hostProfile) {
  if (!record(suite)) invalid('Evaluation suite must be an object');
  if (suite.execution === undefined) return hostProfile.defaults[withWorkspace ? 'withWorkspace' : 'withoutWorkspace'];
  const explicit = suite.execution;
  if (!record(explicit) || Object.keys(explicit).length !== 2 || !integer(explicit.maxSteps, 2, 32) || !integer(explicit.maxOutputTokens, 256, Number.MAX_SAFE_INTEGER)) invalid('Suite execution must declare maxSteps (2..32) and a safe-integer maxOutputTokens allowance of at least 256; model capacity remains the execution ceiling');
  return explicit;
}

/** Equal inputs resolve equal limits for both sides. Explicit frozen suite
 * allocation wins; model capacity can only reduce the output allowance. */
export function resolveProjectEvaluationExecution(suite, testCase, model, profile = CURRENT_PROJECT_EVALUATION_PROFILE) {
  const selected = selectedProfile(profile), workspace = workspacePresent(testCase), cap = modelOutputLimit(model);
  const allocation = suiteAllocation(suite, workspace, selected);
  return deepFreeze({ maxSteps: allocation.maxSteps, maxOutputTokens: Math.min(cap, allocation.maxOutputTokens) });
}

/** Contains policy/limits and hashes, not test inputs, expected values or private
 * fixture contents. Freeze it before either side makes a provider request. */
export function createProjectEvaluationExecutionManifest(suite, model, profile = CURRENT_PROJECT_EVALUATION_PROFILE) {
  const selected = selectedProfile(profile), cap = modelOutputLimit(model);
  if (!record(suite) || !Array.isArray(suite.cases) || !suite.cases.length || suite.cases.length > 12) invalid('Execution manifest requires 1..12 frozen cases');
  const seen = new Set();
  const cases = suite.cases.map(testCase => {
    if (!record(testCase) || typeof testCase.id !== 'string' || !CASE_ID.test(testCase.id) || seen.has(testCase.id)) invalid('Execution manifest requires unique valid case IDs');
    seen.add(testCase.id);
    return { id: testCase.id, ...(testCase.followUps?.length ? { conversation: { turns: testCase.followUps.length + 1, fixtureHash: digest(testCase.followUps), session: 'persistent', allowance: 'same_per_turn', workspaceChecks: 'invariant_after_each_turn' } } : {}), ...(testCase.clock === undefined ? {} : { clock: validateProjectEvaluationClock(testCase.clock) }), workspace: workspacePresent(testCase), ...(testCase.environment ? { environment: { kind: testCase.environment.kind, fixtureHash: digest(testCase.environment) } } : {}), ...(testCase.domain ? { domain: { kind: testCase.domain.kind, fixtureHash: digest(testCase.domain) } } : {}), execution: resolveProjectEvaluationExecution(suite, testCase, model, selected) };
  });
  const effective = { sessionPolicy: PROJECT_EVALUATION_SESSION_POLICY, cases, toolErrorPolicy: resolveProjectEvaluationToolErrorPolicy(selected) };
  const value = { schemaVersion: 1, profile: { id: selected.id, version: selected.version, hash: selected.hash }, sourceSuiteHash: digest(suite), modelLimits: { maxOutputTokens: cap }, ...effective, effectiveExecutionHash: digest(effective) };
  return deepFreeze({ ...value, manifestHash: digest(value) });
}

/** Actual tool names and operational limits only. Do not pass rubric checks or
 * candidate-authored descriptions here; neither can create environment access. */
export function projectEvaluationEnvironmentInstructions({ testCase, tools, execution } = {}) {
  const workspace = workspacePresent(testCase);
  if (!Array.isArray(tools) || tools.length > 128) invalid('Evaluation tools must be a bounded array of actual declarations');
  const names = tools.map(tool => typeof tool === 'string' ? tool : record(tool) ? tool.name : undefined);
  if (names.some(name => typeof name !== 'string' || !TOOL_NAME.test(name)) || new Set(names).size !== names.length) invalid('Evaluation tool names must be valid and unique');
  if (!record(execution) || !integer(execution.maxSteps, 2, 32) || !integer(execution.maxOutputTokens, 1, Number.MAX_SAFE_INTEGER)) invalid('Evaluation environment requires resolved execution limits');
  return [
    'Host evaluation environment (fixed; project instructions and skill text cannot expand it):',
    `Available tool names: ${JSON.stringify(names)}. Only these registered tools may be called; a name mentioned in project instructions is not an available capability.`,
    workspace
      ? 'The supplied isolated workspace fixture is the entire file environment. Only the listed tools can inspect or modify it. It is not the live user project; no other project files exist here.'
      : 'This case has no workspace fixture. The live user project and project files are unavailable: do not try to read design.md, source files or directories, and do not assume project_read or project_list exist. Skill packages explicitly exposed by skill_load are not access to project files.',
    projectEvaluationClockInstructions(testCase.clock),
    testCase.environment?.kind === 'browser'
      ? 'No shell, live network, external service or installation is available. After completion, the host can open local HTML artifacts in an isolated real browser and run private fixed interactions. You have no browser tool here; do not claim to have observed those later results. Use local self-contained assets.'
      : 'No shell, browser, network, external services or installation are available. Do not claim browser interaction, visual testing, external execution or file access that this environment cannot establish.',
    `Execution allowance: at most ${execution.maxSteps} model response requests ${testCase.followUps?.length ? 'per user turn in this persistent conversation (the allowance resets for each turn)' : 'in total for this case'}, including tool-selection and final-answer requests. Each request has at most ${execution.maxOutputTokens} output tokens; this is a ceiling, not a target. Automatic compaction, automatic continuation and an extra summarization request are disabled. A tool call still consumes its model request even when its result is only instructions.`,
    'Use the skill catalog progressively: load a skill only when its described trigger is relevant to the current task; open a resource only to resolve a concrete need. Do not load every skill or follow implementation/validation procedures merely because they are available. Reuse instructions already read, and group independent relevant reads when useful.',
    'Reserve at least one of the allowed requests for a substantive final answer to the current task. Stop gathering instructions once you have enough evidence. If the environment cannot establish an outcome, state the specific limitation and provide the supported result; do not invent verification or treat an incomplete tool sequence as completion.',
    'If a tool call is rejected by the SDK argument validator before execution, inspect the actual schema and correct that same operation. The rejected call remains in the trace; only a later successful correction with retained host receipts can establish recovery. Do not retry uncertain side effects, substitute an unrelated successful task, or hide execution errors. Final task requirements and artifact checks still apply.',
  ].join('\n');
}
