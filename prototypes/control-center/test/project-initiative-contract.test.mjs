import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { decideInitiative } from '../../../packages/sdk/src/initiative.mjs';

const model = { protocol: 'openai', providerId: 'local-fixture', modelId: 'fixture', maxOutputTokens: 2048 };
const evidence = { id: 'checked-project-tool-result', type: 'research_result', summary: 'An actually executed project tool produced overlapping platforms; an isolated candidate could repair its generator.' };
function snapshot({ learning = true, enabled = true, trial = null, emergency = false, archived = false } = {}) {
  const project = { rhythm: { control: 'manual' }, id: 'p', workspace: tmpdir(), name: 'Game project', description: 'Build a game prototype', initialization: { status: 'ready' }, decisionMode: 'rna-model', simulated: false, archivedAt: archived ? new Date().toISOString() : null, initiative: { enabled }, evolution: { enabled: learning }, activeVersionId: 'v1', trialVersionId: trial, versions: [{ id: 'v1', bundle: { hash: 'fixture', genome: { skills: [], tools: [] } } }] };
  return ProjectInitiativeController.prototype.snapshot.call({ interactions: {}, store: { state: { sessions: [], emergency } } }, project);
}
function provider(action, inspect = () => {}) {
  return async function* (request) {
    const input = JSON.parse(request.messages[0].content[0].text); inspect(input, request);
    yield { type: 'text_delta', delta: JSON.stringify({ action, reason: action === 'wait' ? 'Evidence is insufficient for another justified experiment.' : 'New checked evidence supports work within the declared host boundary.', evidenceIds: action === 'wait' ? [] : [evidence.id], content: action === 'wait' ? '' : 'Investigate the checked defect and evaluate an isolated candidate without altering the user workspace.', nextReviewAfterMs: 60000 }) };
    yield { type: 'usage', usage: { totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' };
  };
}

// The contracts as the model reads them: the leading hostActionContracts plus their changing state sent at the end.
// Nested conditions (PDL-5: work.permissions.effective, share.reach.*) merge into the contract they belong to.
const deepMerge = (target, source) => { for (const [key, value] of Object.entries(source)) { if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) deepMerge(target[key], value); else target[key] = value; } return target; };
const seenContracts = input => { const merged = structuredClone(input.hostActionContracts); for (const [name, fields] of Object.entries(input.hostConditions ?? {})) if (name !== 'about' && merged[name]) deepMerge(merged[name], fields); return merged; };
test('host action contracts reach the decision request without a Goal or new command, while wait remains a valid choice', async () => {
  const project = snapshot(), before = structuredClone(project);
  for (const action of ['work', 'learn', 'share', 'wait']) {
    const result = await decideInitiative({ project, events: [evidence], availableActions: ['work', 'learn', 'share'], presence: { typing: true, activeTurn: true, quiet: true }, policy: { notificationMuted: true }, model, provider: provider(action, (input, request) => {
      assert.equal(input.project.goal, undefined); assert.equal(input.project.actionContracts, undefined); assert.deepEqual(seenContracts(input), project.actionContracts); assert.deepEqual(input.availableActions, ['wait', 'work', 'learn', 'share']); assert.equal(seenContracts(input).learn.enabled, true); assert.equal(seenContracts(input).work.enabled, true);
      assert.match(seenContracts(input).work.scope, /assigned read tools/); assert.match(seenContracts(input).learn.effects, /does not edit the user workspace, adopt/); assert.match(seenContracts(input).share.effects, /Typing, quiet periods, mute and cooldown/); assert.match(request.systemPrompt, /new user command or Goal is not a prerequisite/); assert.match(request.systemPrompt, /host-authored declarations/);
      assert.equal(seenContracts(input).ask.enabled, true); assert.match(seenContracts(input).ask.scope, /permissionRequest/); assert.match(seenContracts(input).ask.effects, /Ordinary answers never grant permissions/); assert.match(seenContracts(input).ask.effects, /fixed allow\/deny choices/); assert.deepEqual(seenContracts(input).ask.pending, []);
    }) });
    assert.equal(result.decision.action, action);
  }
  assert.deepEqual(project, before);
});

test('learning disablement, trial and project pauses revoke the relevant declared authorization', async () => {
  const learningOff = snapshot({ learning: false }); assert.equal(learningOff.actionContracts.learn.enabled, false); assert.equal(learningOff.actionContracts.work.enabled, true); assert.equal(learningOff.actionContracts.share.enabled, true);
  assert.equal(snapshot({ trial: 'candidate' }).actionContracts.learn.enabled, false);
  for (const state of [{ enabled: false }, { emergency: true }, { archived: true }]) { const contracts = snapshot(state).actionContracts; for (const action of ['work', 'learn', 'share', 'ask']) assert.equal(contracts[action].enabled, false); assert.equal(contracts.wait.enabled, true); }
  const deferred = await ProjectInitiativeController.prototype.learn.call({ project: () => ({ evolution: { enabled: false } }), startJob: () => assert.fail('Disabled learning cannot start a job') }, { projectId: 'p' }, {}, { evidence: [evidence] }); assert.equal(deferred.reason, 'learning_paused');
});

test('generic SDK uses supplied host action semantics without granting readonly or isolated behavior by assumption', async () => {
  const contracts = { work: { enabled: true, scope: 'Host-authorized writes to a disposable staging area only.' }, learn: { enabled: false, scope: 'This host has no isolated learner.' } };
  const result = await decideInitiative({ project: { id: 'custom-host', actionContracts: contracts }, events: [evidence], availableActions: ['work'], model, provider: provider('work', (input, request) => { assert.deepEqual(seenContracts(input), contracts); assert.match(request.systemPrompt, /Do not assume generic work is read-only, or that learn is isolated/); assert.match(request.systemPrompt, /Respect disabled actions, project constraints and explicit pauses/); assert.deepEqual(request.tools, []); assert.ok(!input.availableActions.includes('learn')); }) });
  assert.equal(result.decision.action, 'work'); assert.equal(contracts.learn.enabled, false);
});

test('recording an observation supplies unresolved evidence without fabricating prior action receipts or forcing learning', async () => {
  const observed = { ...evidence, summary: 'Recorded subprocess result: maxJumpDistance=0.5, but the generated platforms have maxGap=1. No investigation or candidate evaluation has been performed.' }, recentActions = [];
  for (const action of ['learn', 'wait']) {
    const result = await decideInitiative({ project: snapshot(), events: [observed], recentActions, availableActions: ['work', 'learn', 'share'], model, provider: provider(action, (input, request) => {
      assert.deepEqual(input.recentActions, []); assert.deepEqual(input.events, [{ ...observed, id: 'E1' }]);
      assert.match(request.systemPrompt, /recorded, observed or previously seen does not mean investigated, shared, evaluated or resolved/);
      assert.match(request.systemPrompt, /Only an actual successful receipt for the corresponding action and evidence/);
      assert.match(request.systemPrompt, /Wait decisions and open questions do not consume or resolve evidence/);
      assert.match(request.systemPrompt, /If recentActions is empty, do not invent/);
    }) });
    assert.equal(result.decision.action, action);
  }
  assert.deepEqual(recentActions, []);
});
