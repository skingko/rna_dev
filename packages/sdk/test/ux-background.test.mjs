import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, decideInitiative, validateInitiativeDecision, getInitiativeDecisionSchema, initiativeDecisionSchema } from '../src/initiative.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';

// UX audit 2026-10-03 (F14/F34/F89, F12): a work/share decision names its task for the user in its own `title`, and a
// delivery's outcome is kept as a host code, so neither the instruction to the worker nor the receipt written for the
// model has to be shown to the user.
const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'e1', type: 'user_message', summary: '把第 1 到 30 章按新标准重写。' };
const base = { action: 'work', reason: 'The user asked for a rewrite.', evidenceIds: ['e1'], content: '目标＝推进用户「重写 1-30 章」主线（前景已完成 ch1-10 后停手），本轮 bounded 交付 1 章。用 project_history 读失败动作 007c353e。', nextReviewAfterMs: 60000 };
const reply = output => async function* () { yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; };
const decide = (output, availableActions = ['work', 'share']) => decideInitiative({ model, events: [event], availableActions, provider: reply(output) });

test('the decision contract requires a title for work and share; a provider that still leaves it out is not rejected (F34/F89)', async () => {
  assert.equal(initiativeDecisionSchema.properties.title.type, 'string');
  assert.match(initiativeDecisionSchema.properties.title.description, /^Required for work and share/);
  assert.ok(!initiativeDecisionSchema.required.includes('title'), 'wait, learn and ask have no title');
  const branch = initiativeDecisionSchema.allOf[0].oneOf.find(row => row.properties?.action?.enum?.includes('work'));
  assert.deepEqual(branch.properties.action.enum, ['work', 'share']); assert.deepEqual(branch.required, ['title']);
  assert.deepEqual(getInitiativeDecisionSchema().properties.title, initiativeDecisionSchema.properties.title);
  // The published schema asks for it; learn needs none.
  assert.throws(() => validateToolArguments(initiativeDecisionSchema, base));
  const titled = { ...base, title: '重写第 11 章' }, learn = { ...base, action: 'learn' };
  assert.deepEqual(validateToolArguments(initiativeDecisionSchema, titled), titled); assert.deepEqual(validateToolArguments(initiativeDecisionSchema, learn), learn);
  // Validation admits a decision without one: the host then names the task from its instruction.
  assert.deepEqual(validateInitiativeDecision(titled, { events: [event], availableActions: ['work'] }), titled);
  assert.deepEqual(validateInitiativeDecision(base, { events: [event], availableActions: ['work'] }), base);
  assert.throws(() => validateInitiativeDecision({ ...base, content: ' ' }, { events: [event], availableActions: ['work'] }), { code: 'invalid_decision' }, 'the other requirements stand');
  // The output contract in the prompt names it too.
  let prompt = '';
  await decideInitiative({ model, events: [event], availableActions: ['work', 'share'], provider: async function* (request) { prompt = request.systemPrompt; yield* reply(titled)(request); } });
  assert.match(prompt, /nextReviewAfterMs; work and share also include title\./);
  assert.deepEqual(JSON.parse(prompt.split('matching this schema: ').at(-1)).allOf[0].oneOf.find(row => row.required?.includes('title')).properties.action.enum, ['work', 'share']);
});

test('a title is cleaned into one line for the user; one that is unusable or on another action is dropped, never failing the decision', async () => {
  const cases = [
    [{ title: '  重写第 11 章\n（按 E1 的标准） ' }, '重写第 11 章 （按 的标准）'.replace(/\s+/g, ' ')],
    [{ title: '把'.repeat(200) }, `${'把'.repeat(79)}…`],
    [{ title: 'E1' }, undefined],
    [{ title: 42 }, undefined],
    [{ title: '   ' }, undefined],
    [{}, undefined]
  ];
  for (const [extra, expected] of cases) {
    const result = await decide({ ...base, ...extra });
    assert.equal(result.status, 'decided');
    assert.equal(result.decision.title, expected, JSON.stringify(extra));
    assert.equal(Object.hasOwn(result.decision, 'title'), expected !== undefined);
  }
  const shared = await decide({ ...base, action: 'share', content: '第 11 章已按新标准重写完。', title: '第 11 章重写完了' });
  assert.equal(shared.decision.title, '第 11 章重写完了');
  const waited = await decide({ ...base, action: 'wait', content: '', title: '等用户回复' });
  assert.equal(Object.hasOwn(waited.decision, 'title'), false, 'only work and share are named for the user');
});

test('the admitted action keeps its title; a delivery keeps the host outcome code beside the model-facing summary', async () => {
  const outputs = [{ ...base, title: '重写第 11 章' }, { ...base, action: 'share', content: '第 11 章重写完了。', title: '第 11 章重写完了', evidenceIds: ['e1'] }];
  let calls = 0, outcome = 'held';
  const coordinator = new InitiativeCoordinator({ model, provider: async function* (request) { yield* reply(outputs[Math.min(calls++, outputs.length - 1)])(request); }, policy: { cooldownMs: 0 },
    handlers: { work: async () => ({ summary: 'Rewrote chapter 11.', usage: { totalTokens: 1 } }), share: async () => ({ summary: 'Held in its conversation thread (away). Do not resend it.', reach: 'inbox', outcome, usage: { totalTokens: 0 } }) } });
  try {
    await coordinator.observe(event); await coordinator.tick(); await coordinator.idle();
    const work = coordinator.snapshot().actions.find(row => row.action === 'work');
    assert.equal(work.title, '重写第 11 章'); assert.equal(work.deliveryOutcome, undefined, 'only deliveries carry an outcome');
    await coordinator.observe({ id: 'e2', type: 'user_message', summary: '好的' }); await coordinator.tick(); await coordinator.idle();
    const share = coordinator.snapshot().actions.find(row => row.action === 'share');
    assert.equal(share.status, 'completed'); assert.equal(share.deliveryOutcome, 'held'); assert.equal(share.title, '第 11 章重写完了');
    assert.match(share.resultSummary, /^Held in its conversation thread/, 'the model keeps its own receipt');
  } finally { await coordinator.close(); }
  // Anything but a short host code is not kept.
  for (const bad of ['Held in thread', 'x'.repeat(41), 7]) {
    outcome = bad; calls = 1;
    const other = new InitiativeCoordinator({ model, provider: async function* (request) { yield* reply(outputs[1])(request); }, handlers: { share: async () => ({ summary: 'ok', outcome, usage: { totalTokens: 0 } }) } });
    try { await other.observe(event); await other.tick(); await other.idle(); assert.equal(other.snapshot().actions[0].deliveryOutcome, undefined, String(bad)); } finally { await other.close(); }
  }
});
