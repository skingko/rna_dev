import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { decideInitiative, getInitiativeDecisionSchema, validateInitiativeDecision } from '../src/initiative.mjs';
import { projectGenomeFixture } from './fixtures/project-genome-fixture.mjs';

const plan = { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Does new project evidence require the collaborator to review an unresolved compatibility issue?', criteria: { true: 'A new failing compatibility receipt or unanswered project decision needs attention.', false: 'The same issue is already resolved or the next registered delivery is not due.' } } } };
const decision = { action: 'wait', content: '', reason: 'No new unresolved compatibility evidence', evidenceIds: [], nextReviewAfterMs: 60000, judgmentPolicy: plan };
const model = { protocol: 'openai', providerId: 'fixture', modelId: 'main-model', maxOutputTokens: 8192 };
const project = { id: 'p', actionContracts: { judgment: { enabled: true, requiresAssessment: true, revision: null } } };
const provider = (value, done = true, inspect = () => {}) => async function* (request) { inspect(request); yield { type: 'text_delta', delta: JSON.stringify(value) }; if (done) yield { type: 'done', stopReason: 'stop' }; };

test('main initiative response authors options in its existing request and retains strict source completion', async () => {
  let calls = 0;
  // The authoring guidance travels with the wake that accepts a plan (hostConditions.judgment.planAuthoring), not in the system prompt.
  const result = await decideInitiative({ project, model, provider: provider(decision, true, request => { calls++; const authoring = JSON.parse(request.messages[0].content[0].text).hostConditions.judgment.planAuthoring; assert.match(authoring.guidance, /scorer, not a writer/); assert.match(authoring.guidance, /candidate descriptions/); assert.doesNotMatch(request.systemPrompt, /scorer, not a writer/); }) });
  assert.equal(calls, 1); assert.deepEqual(result.decision.judgmentPolicy, plan);
  await assert.rejects(decideInitiative({ project, model, maxAttempts: 1, provider: provider(decision, false) }), /completed main-model response/);
});
test('a wake without the judgment contract ignores a plan the model wrote anyway instead of failing the decision', async () => {
  // The host offers the plan for authoring only when it is missing, stale or a week old; a model that keeps sending one
  // out of habit must not turn every such wake into invalid_decision.
  const bare = { id: 'p', actionContracts: {} };
  assert.equal(getInitiativeDecisionSchema({ project: bare }).properties.judgmentPolicy, undefined);
  const result = await decideInitiative({ project: bare, model, provider: provider(decision, true, request => assert.doesNotMatch(request.systemPrompt, /scorer, not a writer/)) });
  assert.equal(result.status, 'decided'); assert.equal(result.decision.action, 'wait'); assert.equal(result.decision.judgmentPolicy, undefined);
});
test('only enabled host contracts can accept options and missing required authoring cannot silently pass', () => {
  assert.ok(getInitiativeDecisionSchema({ project }).required.includes('judgmentPolicy'));
  assert.throws(() => validateInitiativeDecision(decision), /judgmentPolicy/);
  const missing = { ...decision }; delete missing.judgmentPolicy;
  assert.throws(() => validateInitiativeDecision(missing, { project }), /judgmentPolicy/);
  const extra = structuredClone(decision); extra.judgmentPolicy.questions.next_step = { type: 'text', instructions: 'Write a plan' };
  assert.throws(() => validateInitiativeDecision(extra, { project }));
});
test('bootstrap creates bounded judgment criteria with the same model artifact, independently from quality evaluation', async () => {
  let calls = 0;
  const artifact = { overview: 'Compatibility audit', focus: 'Check supported input variants', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture(), judgmentPolicy: plan };
  const result = await bootstrapProject({ title: 'Compatibility audit', judgmentPolicyContext: { enabled: true }, model, provider: provider(artifact, true, request => { calls++; assert.match(request.systemPrompt, /auxiliary JEV model is a scorer/); }) });
  assert.equal(calls, 1); assert.deepEqual(result.judgmentPolicy, plan); assert.ok(result.genome.evaluationSuite.cases.length >= 3);
});
