import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { InitiativeCoordinator, decideInitiative, validateInitiativeDecision, getInitiativeDecisionSchema, getInitiativePromptSchema, initiativeDecisionSchema } from '../src/initiative.mjs';
import { initiativeScheduleActionSchema, initiativeScheduleActionSchemaV2, initiativeScheduleActionSchemaFor, initiativeScheduleGuidance, initiativeScheduleGuidanceV2, initiativeScheduleGuidanceFor, ongoingCollaborationPrompt, scheduleBasisField } from '../src/initiative-schedule.mjs';

// W2 (design2 §7): the planner's schedule guidance and the optional `basis` of a schedule update, behind the host's
// schedulePromptVersion. v1 (the default) is today's prompt byte for byte; v2 adds one paragraph and declares `basis`.
// No model is called: explicit deterministic providers.
const sha = text => createHash('sha256').update(text).digest('hex');
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 1000 };
const evidence = { id: 'message:user-1', type: 'user_message', summary: 'From now on put the sources section first.' };
const project = { id: 'fixture', actionContracts: { schedule: { schemaVersion: 1, enabled: true, destinationSessionIds: ['session-a'] } }, scheduleContext: { schedules: [], cancelled: [], destinations: [{ sessionId: 'session-a' }] } };
const update = { operation: 'update', id: 'daily-report', expectedRevision: 3, task: 'Write the daily report. Put the sources section first.' };
const decision = payload => ({ action: 'schedule', reason: 'The user asked for a lasting change of the report layout.', evidenceIds: [evidence.id], content: 'Update the task.', nextReviewAfterMs: 1000, schedule: structuredClone(payload) });
const context = { project, events: [evidence], availableActions: ['schedule'] };
const provider = (output, seen = []) => async function* (request) { seen.push(request); yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 23 } }; yield { type: 'done', stopReason: 'stop' }; };

// SHA-256 of the pre-W2 texts, computed from the repository at 0.68.0 (packages/sdk/src/initiative-schedule.mjs).
const V1_GUIDANCE_SHA = 'ecf754c562b96c671d35600a84496aa1ff99a241997ef70a04bd17ae6dc300b7';
const V1_PROMPT_SHA = '5f520054561cf7ee745dd45078be75f297aae906b734ce9a0e84e66778f0bdc3';
const V1_SCHEMA_SHA = '6fe9577242e759fa4881d491ae36b608ec85eb0556641954624ce00c22cc0016';

test('v1 is the pre-W2 guidance, prompt and schedule schema, byte for byte', () => {
  assert.equal(sha(initiativeScheduleGuidance), V1_GUIDANCE_SHA);
  assert.equal(sha(initiativeScheduleGuidanceFor('v1')), V1_GUIDANCE_SHA);
  assert.equal(sha(initiativeScheduleGuidanceFor(undefined)), V1_GUIDANCE_SHA);
  assert.equal(sha(initiativeScheduleGuidanceFor('anything else')), V1_GUIDANCE_SHA);
  assert.equal(sha(JSON.stringify(initiativeScheduleActionSchema)), V1_SCHEMA_SHA);
  assert.equal(sha(JSON.stringify(initiativeScheduleActionSchemaFor('v1'))), V1_SCHEMA_SHA);
  const schema = { type: 'object', properties: { schedule: initiativeScheduleActionSchema } };
  assert.equal(sha(ongoingCollaborationPrompt(schema)), V1_PROMPT_SHA);
  assert.equal(sha(ongoingCollaborationPrompt(schema, { schedulePromptVersion: 'v1' })), V1_PROMPT_SHA);
  assert.equal(JSON.stringify(getInitiativeDecisionSchema(context).properties.schedule), JSON.stringify(initiativeScheduleActionSchema));
  assert.equal(JSON.stringify(getInitiativePromptSchema(context).properties.schedule), JSON.stringify(initiativeScheduleActionSchema));
});

test('v2 adds the standing-instruction paragraph after the matching-responsibility sentence and nothing else', () => {
  const marker = 'Update an existing matching responsibility instead of creating a duplicate.';
  const [head, tail] = initiativeScheduleGuidance.split(marker);
  assert.ok(initiativeScheduleGuidanceV2.startsWith(`${head}${marker} A schedule's task is the standing instruction that every future run receives`));
  assert.ok(initiativeScheduleGuidanceV2.endsWith(tail));
  const paragraph = initiativeScheduleGuidanceV2.slice(head.length + marker.length + 1, initiativeScheduleGuidanceV2.length - tail.length);
  for (const phrase of ['not a log, a progress note or a place for what you learned', 'quote the user\'s words in schedule.basis', 'a method or tool you built yourself', 'handle them with work, share or a project plan item', 'keep the rest verbatim', 'never justify a change by what earlier changes did']) assert.ok(paragraph.includes(phrase), phrase);
  assert.equal(initiativeScheduleGuidanceV2.length, initiativeScheduleGuidance.length + paragraph.length + 1);
  assert.equal(initiativeScheduleGuidanceFor('v2'), initiativeScheduleGuidanceV2);
  // The paragraph is English, with no interpolated state.
  assert.doesNotMatch(paragraph, /[㐀-鿿]/);
  assert.match(ongoingCollaborationPrompt({}, { schedulePromptVersion: 'v2' }), /standing instruction that every future run receives/);
  assert.doesNotMatch(ongoingCollaborationPrompt({}), /standing instruction that every future run receives/);
});

test('basis is an optional field of a schedule update, at most 1000 characters; every other key is still refused', () => {
  const branch = schema => schema.oneOf.find(row => row.properties.operation.const === 'update');
  assert.equal(branch(initiativeScheduleActionSchema).properties.basis, undefined);
  assert.deepEqual(branch(initiativeScheduleActionSchemaV2).properties.basis, scheduleBasisField);
  assert.equal(scheduleBasisField.maxLength, 1000);
  assert.ok(!branch(initiativeScheduleActionSchemaV2).required.includes('basis'));
  const withBasis = { ...update, basis: 'From now on put the sources section first.' };
  // Validation accepts it whichever version the prompt carried (a flipped setting never invalidates a decision).
  assert.deepEqual(validateInitiativeDecision(decision(withBasis), context), decision(withBasis));
  assert.deepEqual(validateInitiativeDecision(decision(update), context), decision(update));
  for (const payload of [{ ...update, basis: '' }, { ...update, basis: '   ' }, { ...update, basis: 'x'.repeat(1001) }, { ...update, basis: 7 },
    { ...update, note: 'unknown key' }, { operation: 'delete', id: 'daily-report', expectedRevision: 3, basis: 'x' },
    { operation: 'create', purposeKey: 'daily-report', title: 'Report', task: 'Report.', rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, destinationSessionId: 'session-a', basis: 'x' }]) {
    assert.throws(() => validateInitiativeDecision(decision(payload), context), { code: 'invalid_decision' }, JSON.stringify(payload).slice(0, 80));
  }
  assert.deepEqual(validateInitiativeDecision(decision({ ...update, basis: 'x'.repeat(1000) }), context).schedule.basis.length, 1000);
  // A basis alone is not a change.
  assert.throws(() => validateInitiativeDecision(decision({ operation: 'update', id: 'daily-report', expectedRevision: 3, basis: 'words' }), context), { code: 'invalid_decision' });
  assert.equal(JSON.stringify(getInitiativeDecisionSchema()), JSON.stringify(initiativeDecisionSchema));
});

test('the decision prompt shows the paragraph and the basis field only under v2', async () => {
  for (const version of [undefined, 'v1', 'v2']) {
    const seen = [];
    const result = await decideInitiative({ ...context, model, schedulePromptVersion: version, provider: provider(decision(update), seen) });
    assert.equal(result.status, 'decided');
    const prompt = seen[0].systemPrompt, advertised = JSON.parse(prompt.split('matching this schema: ').at(-1));
    const updateBranch = advertised.properties.schedule.oneOf.find(row => row.properties.operation.const === 'update');
    if (version === 'v2') {
      assert.match(prompt, /standing instruction that every future run receives/);
      assert.deepEqual(updateBranch.properties.basis, scheduleBasisField);
      assert.deepEqual(advertised, getInitiativePromptSchema({ ...context, schedulePromptVersion: 'v2' }));
    } else {
      assert.doesNotMatch(prompt, /standing instruction that every future run receives/);
      assert.equal(updateBranch.properties.basis, undefined);
      assert.deepEqual(advertised, getInitiativeDecisionSchema(context));
      assert.ok(prompt.includes(initiativeScheduleGuidance));
    }
  }
});

test('the coordinator reads the version at every decision, so a changed setting reaches the next request', async () => {
  let version = 'v1';
  const seen = [], coordinator = new InitiativeCoordinator({ project, model, schedulePromptVersion: () => version, provider: provider({ action: 'wait', reason: 'Nothing useful now.', evidenceIds: [], content: '', nextReviewAfterMs: 1000 }, seen), handlers: { schedule: () => ({ summary: 'saved', usage: { totalTokens: 0 } }) } });
  await coordinator.observe(evidence); await coordinator.tick();
  version = 'v2'; await coordinator.observe({ ...evidence, id: 'message:user-2', summary: 'Another message.' }); await coordinator.tick();
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[0].systemPrompt, /standing instruction that every future run receives/);
  assert.match(seen[1].systemPrompt, /standing instruction that every future run receives/);
  await coordinator.close();
  assert.throws(() => new InitiativeCoordinator({ project, model, schedulePromptVersion: 'v3' }), { code: 'invalid_policy' });
});
