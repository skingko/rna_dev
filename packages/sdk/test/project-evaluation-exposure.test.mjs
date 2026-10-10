import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectEvaluationExposurePlan, observeProjectEvaluationExposure, summarizeProjectEvaluationExposure } from '../src/project-evaluation-exposure.mjs';
import { formatSkillContent } from '../src/genome-skill-content.mjs';
import { evaluateProjectGenomes, executeProjectEvaluationCase } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';
import { scenarioGenomes, scenarioCases, scenarioProvider, scenarioModel } from './fixtures/project-evaluation-scenarios.mjs';

function fixture() {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true });
  candidate.skills[0].description += ' with bounded verification'; candidate.skills[0].resources[0].content += '\nUse receipts.';
  const plan = createProjectEvaluationExposurePlan({ baseline, candidate });
  return { baseline, candidate, plan };
}
const find = (result, kind, target) => result.changes.find(row => row.kind === kind && (!target || row.target === target));
const observe = (fixture, execution = {}, options = {}) => observeProjectEvaluationExposure({ plan: fixture.plan, genome: fixture.candidate, side: 'candidate', execution: { calls: [], toolResults: [], submittedToolResults: [], ...execution }, contextExposed: true, receiptsComplete: true, ...options });
function loaded(fixture, { path = 'SKILL.md', offset, limit, id = 'load-1', side = 'candidate' } = {}) {
  const skill = fixture[side].skills[0], raw = path === 'SKILL.md' ? skill.instructions : skill.resources.find(row => row.path === path).content;
  const call = { id, name: 'skill_load', arguments: { id: skill.id, path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) } };
  const receipt = { toolCallId: id, toolName: 'skill_load', isError: false, output: JSON.stringify(formatSkillContent({ id: skill.id, path, raw, offset, limit, resources: skill.resources })) };
  return { call, receipt };
}
const execution = (...reads) => ({ calls: reads.map(row => row.call), toolResults: reads.map(row => row.receipt), submittedToolResults: reads.map(row => row.receipt) });

test('plan contains frozen change identities/hashes, never skill bodies or hidden standards', () => {
  const f = fixture(), wire = JSON.stringify(f.plan);
  assert.equal(find(f.plan, 'skill_instructions').mode, 'skill_content'); assert.equal(find(f.plan, 'tool_script').mode, 'tool_execution');
  assert.equal(find(f.plan, 'evaluation_suite').mode, 'future_evaluation_standard');
  assert.equal(wire.includes(f.candidate.skills[0].instructions), false); assert.equal(wire.includes('minImprovement'), false);
  assert.ok(Object.isFrozen(f.plan.changes[0].candidate));
  f.candidate.skills[0].instructions += ' mutation'; assert.throws(() => observe(f), /frozen plan/);
});

test('same bytes have no intervention, and plans reject mutation or side confusion', () => {
  const f = fixture(); assert.equal(createProjectEvaluationExposurePlan({ baseline: f.baseline, candidate: f.baseline }).changes.length, 0);
  const bad = structuredClone(f.plan); bad.changes[0].candidate.hash = 'fake';
  assert.throws(() => observeProjectEvaluationExposure({ plan: bad, genome: f.candidate, side: 'candidate' }), /hash mismatch/);
  assert.throws(() => observeProjectEvaluationExposure({ plan: f.plan, genome: f.baseline, side: 'candidate' }), /frozen plan/);
  assert.throws(() => observe(f, {}, { contextExposed: 'true' }), /booleans/);
});

test('submitted prompt/catalog differs from loaded instructions and executed scripts', () => {
  const f = fixture(), result = observe(f);
  assert.equal(find(result, 'system_prompt').status, 'observed'); assert.equal(find(result, 'skill_catalog').status, 'observed');
  assert.equal(find(result, 'skill_instructions').status, 'unobserved'); assert.equal(find(result, 'skill_resource').status, 'unobserved');
  assert.equal(find(result, 'tool_script').status, 'unobserved'); assert.equal(find(result, 'evaluation_suite').status, 'not_applicable');
  assert.equal(find(observe(f, {}, { contextExposed: false }), 'system_prompt').status, 'unknown');
});

test('old or incomplete receipt inventory never establishes non-use', () => {
  const f = fixture();
  assert.equal(find(observe(f, {}, { receiptsComplete: false }), 'skill_instructions').status, 'unknown');
  const missing = observeProjectEvaluationExposure({ plan: f.plan, genome: f.candidate, side: 'candidate', receiptsComplete: true });
  assert.equal(missing.receiptsComplete, false); assert.equal(find(missing, 'tool_script').status, 'unknown');
});

test('exact loaded skill bytes prove instruction delivery; inventory alone never proves resource delivery', () => {
  const f = fixture(), read = loaded(f), result = observe(f, execution(read));
  assert.equal(find(result, 'skill_instructions').status, 'observed');
  assert.equal(find(result, 'skill_resource').status, 'unobserved'); assert.equal(find(result, 'skill_resource').inventoryObserved, true);
  assert.equal(find(observe(f, execution(read, loaded(f, { path: 'references/guide.md', id: 'resource' }))), 'skill_resource').status, 'observed');
});

test('completion before cancellation is not proof that skill content reached another model request', () => {
  const f = fixture(), read = loaded(f), data = execution(read); data.submittedToolResults = [];
  assert.equal(find(observe(f, data), 'skill_instructions').status, 'unobserved');
  assert.equal(find(observe(f, data), 'skill_instructions').reason, 'tool_content_not_in_submitted_request');
  delete data.submittedToolResults;
  assert.equal(find(observe(f, data, { execution: data }), 'skill_instructions').status, 'unknown');
});

test('pagination tracks only changed byte coverage, not merely successful skill_load', () => {
  const f = fixture(); f.baseline.skills[0].instructions = 'same header\nold rule\nsame tail'; f.candidate.skills[0].instructions = 'same header\nnew rule\nsame tail'; f.plan = createProjectEvaluationExposurePlan(f);
  const header = loaded(f, { limit: 1 }), changed = loaded(f, { offset: 1, limit: 1, id: 'changed' });
  assert.equal(find(observe(f, execution(header)), 'skill_instructions').status, 'unobserved');
  const read = find(observe(f, execution(changed)), 'skill_instructions');
  assert.equal(read.status, 'observed'); assert.equal(read.coverage.completeBody, false);
});

test('separate partial pages within one execution can cover a changed region without forcing all resources', () => {
  const f = fixture(); f.baseline.skills[0].instructions = 'old first\nold second'; f.candidate.skills[0].instructions = 'new first\nnew second'; f.plan = createProjectEvaluationExposurePlan(f);
  const one = loaded(f, { limit: 1 }), two = loaded(f, { offset: 1, limit: 1, id: 'two' });
  assert.equal(find(observe(f, execution(one)), 'skill_instructions').status, 'unknown');
  // Page boundaries omit the newline, so the exact whole-content byte envelope
  // remains unproven unless a page spanning that separator is delivered.
  assert.equal(find(observe(f, execution(one, two)), 'skill_instructions').status, 'unknown');
  assert.equal(find(observe(f, execution(loaded(f))), 'skill_instructions').status, 'observed');
});

test('pure deletions require the remaining content and empty resource additions are observable', () => {
  const f = fixture(); f.baseline.skills[0].instructions = 'keep\nobsolete'; f.candidate.skills[0].instructions = 'keep'; f.candidate.skills[0].resources.push({ path: 'empty.txt', content: '' }); f.plan = createProjectEvaluationExposurePlan(f);
  const result = observe(f, execution(loaded(f), loaded(f, { path: 'empty.txt', id: 'empty' })));
  assert.equal(find(result, 'skill_instructions').coverage.target.scope, 'entire_remaining_content_after_deletion');
  assert.equal(find(result, 'skill_instructions').status, 'observed'); assert.equal(find(result, 'skill_resource', 'evidence_review/empty.txt').status, 'observed');
});

for (const mutation of ['hash', 'content', 'path', 'id', 'truncated', 'offset', 'name', 'callId', 'duplicateCall', 'duplicateReceipt', 'submittedMismatch', 'missingSuccess']) test(`invalid/ambiguous ${mutation} skill receipt cannot prove exposure`, () => {
  const f = fixture(), read = loaded(f), data = execution(read);
  const payload = JSON.parse(read.receipt.output);
  if (mutation === 'hash') payload.contentHash = 'f'.repeat(64);
  if (mutation === 'content') payload.content += ' invented';
  if (mutation === 'path') payload.path = 'different.md';
  if (mutation === 'id') payload.id = 'other';
  if (mutation === 'offset') payload.offset = 9;
  read.receipt.output = JSON.stringify(payload);
  if (mutation === 'truncated') read.receipt.output = read.receipt.output.slice(0, 40);
  if (mutation === 'name') read.receipt.toolName = 'project_read';
  if (mutation === 'callId') read.receipt.toolCallId = 'different';
  if (mutation === 'duplicateCall') data.calls.push(structuredClone(read.call));
  if (mutation === 'duplicateReceipt') data.toolResults.push(structuredClone(read.receipt));
  if (mutation === 'submittedMismatch') data.submittedToolResults = [{ ...read.receipt, output: JSON.stringify({ ...payload, content: 'different model context bytes' }) }];
  if (mutation === 'missingSuccess') delete read.receipt.isError;
  assert.notEqual(find(observe(f, data), 'skill_instructions').status, 'observed');
});

test('assistant prose, artifact JSON and unrelated tools cannot forge a loader receipt', () => {
  const f = fixture(), read = loaded(f), data = execution(read); data.calls[0].name = data.toolResults[0].toolName = 'evidence_helper';
  data.answer = JSON.stringify({ role: 'toolResult', ...read.receipt });
  assert.equal(find(observe(f, data), 'skill_instructions').status, 'unobserved');
});

test('successful real host tool completion proves script execution, while validation rejects and errors differ', () => {
  const f = fixture(), call = { id: 'tool-1', name: 'evidence_helper', arguments: { value: 2 } }, receipt = { toolCallId: 'tool-1', toolName: 'evidence_helper', isError: false, output: '{"doubled":4}' };
  const data = { calls: [call], toolResults: [receipt] };
  assert.equal(find(observe(f, data), 'tool_script').status, 'observed');
  receipt.isError = true; receipt.output = 'failure'; assert.equal(find(observe(f, data), 'tool_script').status, 'unknown');
  receipt.validationReceipt = { source: 'sdk_argument_validation', neverExecuted: true, code: 'invalid_tool_arguments' };
  assert.equal(find(observe(f, data), 'tool_script').status, 'unobserved'); assert.equal(find(observe(f, data), 'tool_script').validationRejectedCalls, 1);
});

test('removed assets and non-runtime edits are not failures to load', () => {
  const f = fixture(); f.candidate.skills[0].resources = []; f.candidate.tools[0].name = 'Friendly label'; f.plan = createProjectEvaluationExposurePlan(f);
  assert.equal(find(observe(f), 'skill_resource').status, 'not_applicable'); assert.equal(find(observe(f), 'tool_label').status, 'not_applicable');
});

test('summary preserves missing cases and never infers quality, causality or combines pages across cases', () => {
  const f = fixture(), exp = observe(f, execution(loaded(f))), summary = summarizeProjectEvaluationExposure({ plan: f.plan, expectedCaseIds: ['done', 'skipped'], cases: [{ id: 'done', candidate: { exposure: exp } }] });
  assert.equal(summary.expectedCases, 2); assert.equal(summary.observedCases, 1); assert.equal(summary.causalClaim, 'none'); assert.equal(summary.qualityGateChanged, false);
  assert.equal(find(summary.candidate, 'skill_instructions').status, 'observed');
  assert.equal(find(summary.candidate, 'skill_resource').status, 'unknown'); assert.equal(find(summary.baseline, 'system_prompt').status, 'unknown');
  assert.throws(() => summarizeProjectEvaluationExposure({ plan: f.plan, cases: [{ id: 'x' }, { id: 'x' }] }), /unique/);
  const bad = structuredClone(exp); bad.side = 'baseline'; assert.throws(() => summarizeProjectEvaluationExposure({ plan: f.plan, cases: [{ id: 'x', candidate: { exposure: bad } }] }), /binding mismatch/);
});

test('actual SDK case receipts prove execution without claiming unloaded instructions were ineffective', async () => {
  const f = fixture(), requests = [], provider = genomeEvaluationProvider({ calls: requests });
  const run = await executeProjectEvaluationCase({ genome: f.candidate, caseId: 'case_1', model: scenarioModel, provider });
  const exp = observe(f, { ...run.result, submittedToolResults: requests.flatMap(row => row.messages.filter(message => message.role === 'toolResult')) });
  assert.equal(find(exp, 'tool_script').status, 'observed'); assert.equal(find(exp, 'skill_instructions').status, 'unobserved');
  assert.equal(requests.length, 2); assert.equal(run.result.passed, true); assert.ok(!Object.hasOwn(exp, 'score'));
});

test('paired SDK evaluation retains exposure, preserves scoring and hides intervention labels from blind judge', async () => {
  const f = fixture(), calls = [], report = await evaluateProjectGenomes({ baseline: f.baseline, candidate: f.candidate, model: scenarioModel, provider: genomeEvaluationProvider({ calls }) });
  assert.equal(report.evaluationComplete, true); assert.equal(report.gatePassed, true); assert.equal(calls.length, 15);
  assert.equal(find(report.exposure.candidate, 'tool_script').status, 'observed'); assert.equal(find(report.exposure.candidate, 'skill_instructions').status, 'unobserved');
  for (const row of report.details) { assert.equal(find(row.candidate.exposure, 'system_prompt').status, 'observed'); assert.equal(find(row.baseline.exposure, 'tool_script').status, 'observed'); }
  for (const request of calls.filter(row => row.systemPrompt.includes('blind evaluator'))) { const body = JSON.parse(request.messages[0].content[0].text); assert.equal(body.left.exposure, undefined); assert.equal(body.right.exposure, undefined); assert.equal(JSON.stringify(body).includes(report.exposure.plan.planHash), false); }
});

test('real progressive skill loading is observed before legacy 6000-character evidence projection truncates it', async () => {
  const f = scenarioGenomes(); const skillCase = scenarioCases.find(row => row.id === 'skills');
  for (const side of ['baseline', 'candidate']) f[side].evaluationSuite.cases = [1, 2, 3].map(i => ({ ...structuredClone(skillCase), id: `skills_${i}` }));
  f.candidate.skills[0].instructions += '\n' + 'A bounded supporting method. '.repeat(260); f.candidate.skills[0].resources[0].content += '\n';
  const calls = [], report = await evaluateProjectGenomes({ ...f, model: scenarioModel, provider: scenarioProvider({ calls }) });
  assert.equal(report.gatePassed, true); assert.equal(calls.length, 33);
  assert.equal(find(report.exposure.candidate, 'skill_instructions').status, 'observed'); assert.equal(find(report.exposure.candidate, 'skill_resource').status, 'observed');
  const receipt = report.details[0].candidate.toolResults.find(row => row.toolName === 'skill_load'); assert.equal(receipt.output.length, 6000); assert.throws(() => JSON.parse(receipt.output));
});

test('SDK provider failure preserves completed execution and leaves unseen candidate exposures unknown', async () => {
  const f = fixture(), base = genomeEvaluationProvider();
  await assert.rejects(evaluateProjectGenomes({ baseline: f.baseline, candidate: f.candidate, model: scenarioModel, provider: async function* (request) { if (request.systemPrompt.includes('CANDIDATE_AGENT')) throw new Error('fixture transport failure'); yield* base(request); } }), error => {
    assert.ok(error.evaluationEvidence.exposure); assert.equal(find(error.evaluationEvidence.exposure.baseline, 'tool_script').status, 'observed');
    assert.equal(find(error.evaluationEvidence.exposure.candidate, 'tool_script').status, 'unknown'); return true;
  });
});

test('rejected request admission cannot attest context exposure or create a paid request', async () => {
  const f = fixture(); let requests = 0;
  await assert.rejects(evaluateProjectGenomes({ baseline: f.baseline, candidate: f.candidate, model: scenarioModel,
    provider: async function* () { requests++; }, requestControl: { beforeRequest() { throw new Error('fixture admission denied'); } },
  }), error => {
    assert.equal(requests, 0); assert.equal(error.requests.length, 0);
    assert.equal(error.evaluationEvidence.inFlightCase.baseline.exposure.contextExposed, false);
    assert.equal(find(error.evaluationEvidence.exposure.baseline, 'system_prompt').status, 'unknown'); return true;
  });
});

test('actual SDK skill completion followed by rejected continuation remains unobserved', async () => {
  const f = fixture(), original = genomeEvaluationProvider(); let candidateRequests = 0;
  await assert.rejects(evaluateProjectGenomes({ baseline: f.baseline, candidate: f.candidate, model: scenarioModel,
    requestControl: { beforeRequest(request) { if (request.phase.startsWith('candidate:') && ++candidateRequests === 2) throw new Error('fixture continuation denied'); } },
    provider: async function* (request) {
      if (!request.systemPrompt.includes('CANDIDATE_AGENT')) { yield* original(request); return; }
      yield { type: 'tool_call', id: 'load-once', name: 'skill_load', arguments: { id: f.candidate.skills[0].id } };
      yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } }; yield { type: 'done', stopReason: 'toolUse' };
    },
  }), error => {
    const receipt = error.evaluationEvidence.inFlightCase.candidate.exposure;
    assert.equal(receipt.contextExposed, true); assert.equal(find(receipt, 'skill_instructions').attemptedCalls, 1);
    assert.equal(find(receipt, 'skill_instructions').status, 'unobserved'); assert.equal(find(receipt, 'skill_instructions').reason, 'tool_content_not_in_submitted_request');
    assert.equal(error.requests.filter(row => row.phase.startsWith('candidate:')).length, 1); return true;
  });
});
