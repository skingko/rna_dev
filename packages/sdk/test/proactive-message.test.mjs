import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { proactiveMessageViolations, normalizedMessageKey, stripHandoff, messageSimilarity, extractHandoff, lowerReach, quietReach, REACH_TIERS } from '../src/proactive-message.mjs';
import { decideInitiative, getInitiativeDecisionSchema, validateInitiativeDecision, InitiativeCoordinator } from '../src/initiative.mjs';
import { createDecisionKernel, deliveryReachTemplate, validateHostTemplatePlan, decisionVerdict } from '../src/decision-kernel.mjs';

const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'e1', type: 'user_message', summary: 'Check the second input case', at: 1 };
const share = (content, extra = {}) => ({ action: 'share', reason: 'Checked evidence', evidenceIds: ['e1'], content, nextReviewAfterMs: 60000, ...extra });
const scripted = (outputs, seen = []) => async function* (request) { seen.push(request); const next = outputs.shift(); yield { type: 'text_delta', delta: JSON.stringify(next) }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; };
const optedIn = { actionContracts: { share: { messageContract: 1, reach: { enabled: true, tiers: ['digest', 'inbox', 'inline'] } } } };

test('the host only suppresses exact (normalized) repeats; content quality is left to the judge', () => {
  const codes = (text, recent = []) => proactiveMessageViolations(text, { recent }).map(row => row.code);
  // No host regex rules: identifiers, paths and short status lines are the judge's call (a coding user may need the path).
  for (const text of ['See action:3f2a9c1e-77aa-4b1b-9a0e-1234567890ab for details', '失败的测试在 /Users/someone/project/src/parser.test.ts:42。', 'Still working on it.']) assert.deepEqual(codes(text), []);
  const recent = [{ text: '第二种输入没有兼容示例；检查已经完成。' }];
  assert.deepEqual(codes('第二种输入没有兼容示例 检查已经完成！', recent), ['near_duplicate'], 'punctuation and spacing do not make a new message');
  assert.deepEqual(codes('第二种输入没有兼容示例，检查已经完成了', recent), [], 'any wording change is left to the judge');
  assert.equal(normalizedMessageKey('A-b c'), normalizedMessageKey('ab C'));
  assert.equal(stripHandoff('结果：三个测试失败。\n交接：修复 parser，下一步重跑'), '结果：三个测试失败。');
  assert.ok(messageSimilarity('abc def', 'ABC-DEF') === 1 && messageSimilarity('', 'x') === 0);
});

test('handoff line extraction takes the last explicit handoff and returns one bounded line', () => {
  assert.equal(extractHandoff('Checked it.\n交接：核对了说明，第二种输入仍缺示例，下一步补写示例'), '核对了说明，第二种输入仍缺示例，下一步补写示例');
  assert.equal(extractHandoff('HANDOFF: old\nmore\nFINAL: "Fixed notes 2 and 4, tests pass. Next: push."'), 'Fixed notes 2 and 4, tests pass. Next: push.');
  assert.equal(extractHandoff('no handoff here'), null);
  assert.ok(extractHandoff(`交接：${'x'.repeat(900)}`).length <= 400);
});

test('the handoff marker is HANDOFF: for new workers and 交接： from older runs; both are read and stripped alike', () => {
  const body = 'Three tests fail in parser.';
  for (const marker of ['HANDOFF: ', 'HANDOFF：', '交接：', '交接: ']) {
    const text = `${body}\n${marker}Fixed the parser, next rerun the suite`;
    assert.equal(extractHandoff(text), 'Fixed the parser, next rerun the suite', marker);
    assert.equal(stripHandoff(text), body, marker);
  }
  assert.equal(extractHandoff('交接：older line\nHANDOFF: newest line'), 'newest line', 'the last explicit line wins across markers');
});

test('reach tiers are ordered; lowering never escalates; quiet tiers do not interrupt', () => {
  assert.deepEqual(REACH_TIERS, ['digest', 'inbox', 'inline', 'notify']);
  assert.equal(lowerReach('notify', 'inbox'), 'inbox'); assert.equal(lowerReach('inbox', 'notify'), 'inbox');
  assert.ok(quietReach('inbox') && quietReach('digest') && !quietReach('inline') && !quietReach(undefined));
});

test('legacy hosts keep prompt and schema; opted-in hosts get the contract, the 24h digest rule and urgency', async () => {
  const legacy = getInitiativeDecisionSchema({ project: {}, availableActions: ['share'] });
  assert.equal(legacy.properties.urgency, undefined);
  assert.throws(() => validateInitiativeDecision(share('Finding', { urgency: 'inbox' }), { events: [event], availableActions: ['share'], project: {} }), { code: 'invalid_decision' });
  const schema = getInitiativeDecisionSchema({ project: optedIn, availableActions: ['share'] });
  assert.deepEqual(schema.properties.urgency.enum, ['digest', 'inbox', 'inline']);
  assert.throws(() => validateInitiativeDecision(share('Finding', { urgency: 'notify' }), { events: [event], availableActions: ['share'], project: optedIn }), { code: 'invalid_decision' }, 'notify needs the host to list it');
  const seen = [];
  await decideInitiative({ model, events: [event], availableActions: ['share'], project: {}, provider: scripted([share('A finding')], seen) });
  await decideInitiative({ model, events: [event], availableActions: ['share'], project: optedIn, provider: scripted([share('A finding', { urgency: 'inbox' })], seen) });
  assert.doesNotMatch(seen[0].systemPrompt, /sentLast24h/);
  assert.match(seen[1].systemPrompt, /Result first/); assert.match(seen[1].systemPrompt, /sentLast24h/); assert.match(seen[1].systemPrompt, /least intrusive/);
});

test('a contract violation gets exactly one repair round, even with maxAttempts 1; a second violation fails the decision', async () => {
  const check = decision => /turn:/.test(decision.content) ? [{ code: 'internal_id', repair: 'Describe it in plain words.', source: 'jev' }] : proactiveMessageViolations(decision.content, { recent: [{ text: 'The parser fails on empty files; reproduced twice.' }] });
  const seen = [];
  const repaired = await decideInitiative({ model, events: [event], availableActions: ['share'], project: optedIn, messageCheck: check, provider: scripted([share('See turn:3f2a9c1e-77aa-4b1b for the finding'), share('The second input case has no example, so compatibility is untested.')], seen) });
  assert.equal(repaired.status, 'decided'); assert.equal(repaired.messageRepairs, 1); assert.equal(seen.length, 2);
  assert.match(JSON.stringify(seen[1].messages.at(-1)), /internal_id/);
  await assert.rejects(decideInitiative({ model, events: [event], availableActions: ['share'], project: optedIn, messageCheck: check, provider: scripted([share('The parser fails on empty files, reproduced twice.'), share('The parser fails on empty files; reproduced twice!')]) }),
    error => error.code === 'message_contract' && error.initiativeFailure.code === 'message_contract' && error.messageViolations.includes('near_duplicate'));
  const waited = await decideInitiative({ model, events: [event], availableActions: ['share'], project: optedIn, messageCheck: () => { throw new Error('wait decisions are not message-checked'); }, provider: scripted([{ action: 'wait', reason: 'Nothing new', evidenceIds: [], content: '', nextReviewAfterMs: 60000 }]) });
  assert.equal(waited.decision.action, 'wait');
});

test('inbox-tier shares bypass typing, mute and cooldown and do not start the cooldown; handoffs replace transcripts in receipts', async () => {
  const delivered = [];
  const state = { schemaVersion: 1, revision: 1, events: [event], seenEventIds: ['e1'], decisionRevision: 1, nextReviewAt: Number.MAX_SAFE_INTEGER, lastSharedAt: null, usedTokens: 0, reservedTokens: 0, actions: [
    { id: 'quiet', action: 'share', urgency: 'inbox', status: 'queued', content: 'Filed quietly', reason: 'r', evidenceIds: ['e1'], revision: 1, nextReviewAfterMs: 1000, createdAt: 1 },
    { id: 'loud', action: 'share', status: 'queued', content: 'Needs the conversation', reason: 'r', evidenceIds: ['e1'], revision: 1, nextReviewAfterMs: 1000, createdAt: 1 }] };
  const c = new InitiativeCoordinator({ model, state, policy: { notificationMuted: true, cooldownMs: 3600000 }, provider: scripted([{ action: 'wait', reason: 'Nothing new', evidenceIds: [], content: '', nextReviewAfterMs: 60000 }]),
    handlers: { share: async action => { delivered.push(action.id); return { summary: 'filed', reach: action.urgency ?? 'inline', usage: { totalTokens: 0 } }; },
      work: async () => ({ summary: 'Long worker transcript '.repeat(200), handoff: '核对了说明\n第二种输入仍缺示例，下一步补写示例', usage: { totalTokens: 0 } }) } });
  await c.tick({ presence: { typing: true } }); await c.idle();
  await c.tick({ presence: { typing: true } }); await c.idle();
  const saved = c.snapshot();
  assert.deepEqual(delivered, ['quiet']);
  assert.equal(saved.actions.find(row => row.id === 'quiet').deliveredReach, 'inbox');
  assert.equal(saved.lastSharedAt, null, 'a quiet delivery does not start the conversational cooldown');
  assert.equal(saved.actions.find(row => row.id === 'loud').deferredReason, 'notification_muted');
  // A completed work receipt is new evidence and cancels queued shares, so run it after.
  c.state.actions.push({ id: 'w1', action: 'work', status: 'queued', content: 'Inspect', reason: 'r', evidenceIds: ['e1'], revision: 1, nextReviewAfterMs: 1000, createdAt: 1 });
  await c.tick({ presence: {} }); await c.idle();
  const work = c.snapshot().actions.find(row => row.id === 'w1');
  assert.equal(work.handoff, '核对了说明 第二种输入仍缺示例，下一步补写示例');
  let input;
  c.provider = async function* (request) { input = JSON.parse(request.messages.at(-1).content[0].text); yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', reason: 'Nothing new', evidenceIds: [], content: '', nextReviewAfterMs: 60000 }) }; yield { type: 'done', stopReason: 'stop' }; };
  await c.observe({ id: 'e2', type: 'user_message', summary: 'Anything else?' }); await c.tick({ presence: {} }); await c.idle();
  const receipt = input.recentActions.find(row => row.actionId === 'w1');
  assert.equal(receipt.handoff, work.handoff); assert.equal(receipt.resultSummary, undefined);
  await c.close(); await delay(1);
});

test('delivery.reach host template offers only tiers at or below the capped request', async () => {
  assert.equal(deliveryReachTemplate({ maxTier: 'digest' }), null);
  const plan = validateHostTemplatePlan(deliveryReachTemplate({ maxTier: 'inline' }));
  assert.deepEqual(Object.keys(plan.questions.reach_tier.criteria), ['digest', 'inbox', 'inline', 'unknown']);
  assert.throws(() => validateHostTemplatePlan({ ...deliveryReachTemplate({ maxTier: 'inline' }), template: 'chat.route' }));
  assert.throws(() => validateHostTemplatePlan({ ...deliveryReachTemplate({ maxTier: 'inline' }), questions: { reach_tier: { type: 'choice', instructions: 'x', criteria: { inline: 'a', loudest: 'b', unknown: 'c' } } } }));
  const kernel = createDecisionKernel({ apiKey: 'synthetic-test-credential', mode: 'active', fetch: async () => new Response(JSON.stringify({ answers: { reach_tier: { choice: 'inbox', probabilities: { digest: .02, inbox: .93, inline: .04, unknown: .01 }, confidence: .95 } }, usage: { input_tokens: 30, output_tokens: 4 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
  const result = await kernel.decide({ point: 'delivery.reach', scope: { projectId: 'p', revision: 'reach:a1' }, state: { message: 'A finding' }, signals: { dueSchedule: true, severeFailure: true }, assessmentPlan: deliveryReachTemplate({ maxTier: 'inline' }), fallback: { tier: 'inline' } });
  assert.equal(result.source, 'judge', 'project review signals do not route a delivery score to the main model');
  assert.equal(decisionVerdict(result.answers.reach_tier, result.policy), 'inbox');
  kernel.close();
});
