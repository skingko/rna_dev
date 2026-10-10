import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { createAskUserTool, validateUserQuestions, validateUserAnswers } from '../src/user-interaction.mjs';
import { InitiativeCoordinator, validateInitiativeDecision } from '../src/initiative.mjs';
const questions = [{ id: 'scope', question: '选择这次整理的范围', options: [{ id: 'one', label: '单个文件' }, { id: 'all', label: '整个项目' }] }];
const answers = [{ id: 'scope', selected: ['one'], custom: '保留现有注释' }];
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 32000, maxOutputTokens: 1000 };
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('questions and answers enforce stable choices, bounds and supplemental text without accepting permission metadata', () => {
  const normalized = validateUserQuestions({ questions }); assert.equal(normalized[0].allowCustom, true); assert.deepEqual(validateUserAnswers(normalized, answers), answers);
  for (const input of [{ questions: [] }, { questions, metadata: { kind: 'permission' } }, { questions: [questions[0], questions[0]] }, { questions: [{ ...questions[0], options: [questions[0].options[0], questions[0].options[0]] }] }]) assert.throws(() => validateUserQuestions(input), { code: 'invalid_interaction' });
  for (const input of [[], [{ id: 'other', selected: ['one'] }], [{ id: 'scope', selected: ['missing'] }], [{ id: 'scope', selected: ['one', 'all'] }], [{ id: 'scope', selected: [] }], [{ ...answers[0], grant: true }]]) assert.throws(() => validateUserAnswers(normalized, input), { code: 'invalid_answer' });
  assert.deepEqual(validateUserAnswers(validateUserQuestions({ questions: [{ id: 'detail', question: '补充背景' }] }), [{ id: 'detail', selected: [], custom: '  实际背景  ' }]), [{ id: 'detail', selected: [], custom: '实际背景' }]);
});

test('SDK asks through the current tool call and continues the same task only after the accepted answer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-ask-sdk-')), asked = hold(), answer = hold(); let requests = 0;
  const tool = createAskUserTool({ ask: input => { assert.equal(input.toolCallId, 'q1'); asked.resolve(); return answer.promise; } });
  const session = await createSession({ cwd: dir, stateDir: join(dir, 'state'), model, tools: [tool], provider: async function* (input) {
    requests++;
    if (requests === 1) yield { type: 'tool_call', id: 'q1', name: 'ask_user', arguments: { questions } };
    else { const result = JSON.parse(input.messages.find(message => message.role === 'toolResult').content[0].text); assert.equal(result.status, 'answered'); assert.deepEqual(result.answers, answers); assert.equal(result.permissionChanged, false); yield { type: 'text_delta', delta: '按选择继续当前任务' }; }
    yield { type: 'done', stopReason: requests === 1 ? 'toolUse' : 'stop' };
  } });
  t.after(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true }); });
  const running = session.prompt('整理项目'); await asked.promise; assert.equal(requests, 1); answer.resolve({ status: 'answered', answers }); await running; assert.equal(requests, 2);
});

test('interrupted ask has no uncertain side effect and safely resumes its original call after reopening', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-ask-resume-')), entered = hold(), late = hold(), events = []; let requests = 0, answered = false, asks = 0;
  const tools = [createAskUserTool({ ask: ({ toolCallId }) => { assert.equal(toolCallId, 'original-question'); asks++; entered.resolve(); return answered ? { status: 'answered', answers } : late.promise; } })];
  const options = { sessionId: 'ask-session', cwd: dir, stateDir: join(dir, 'state'), model, tools, onEvent: event => events.push(event), provider: async function* () { requests++; if (requests === 1) yield { type: 'tool_call', id: 'original-question', name: 'ask_user', arguments: { questions } }; else yield { type: 'text_delta', delta: '已接续' }; yield { type: 'done' }; } };
  const session = await createSession(options); const running = session.prompt('继续准备'); await entered.promise; await session.abort(); await running;
  const snapshot = session.snapshot(); assert.equal(snapshot.recovery.uncertainTools.length, 0); assert.equal(snapshot.recovery.pendingTools, 1); assert.equal(requests, 1); assert.ok(events.some(event => event.interactionInterrupted === true && !event.uncertain)); await session.dispose();
  answered = true; const reopened = await createSession({ ...options, sessionFile: snapshot.sessionFile });
  t.after(async () => { await reopened.dispose(); await rm(dir, { recursive: true, force: true }); });
  await reopened.resume(); assert.equal(asks, 2); assert.equal(requests, 2); assert.equal(reopened.snapshot().recovery.pendingTools, 0); late.resolve({ status: 'cancelled' });
});

test('unavailable answer surface fails explicitly and cancellation never becomes approval', async () => {
  await assert.rejects(createAskUserTool().execute('q', { questions }), { code: 'interaction_unavailable' });
  const result = await createAskUserTool({ ask: () => ({ status: 'cancelled' }) }).execute('q', { questions });
  assert.deepEqual(JSON.parse(result.content[0].text), { status: 'cancelled', answers: [], permissionChanged: false });
});

test('proactive ask uses communication gates, has no work reserve or self-generated evidence, and deduplicates delivery', async () => {
  let clock = 1000, delivered = 0, requests = 0;
  const proposed = { action: 'ask', reason: 'A concrete choice blocks the current plan.', evidenceIds: ['fact'], content: '选择下一步', nextReviewAfterMs: 60000, questions };
  const coordinator = new InitiativeCoordinator({ project: { id: 'p' }, model, now: () => clock, policy: { cooldownMs: 0 }, handlers: { ask: () => { delivered++; return { summary: 'Question delivered, pending user answer.', usage: { totalTokens: 0 } }; } }, provider: async function* () { requests++; yield { type: 'text_delta', delta: JSON.stringify(proposed) }; yield { type: 'usage', usage: { totalTokens: 13 } }; yield { type: 'done' }; } });
  await coordinator.observe({ id: 'fact', type: 'user_message', summary: 'The plan has two valid alternatives.' }); await coordinator.tick({ presence: { typing: true } }); assert.equal(delivered, 0);
  await coordinator.tick(); await coordinator.idle(); assert.equal(delivered, 1); assert.equal(coordinator.snapshot().events.length, 1); assert.equal(coordinator.snapshot().usedTokens, 13); assert.equal(coordinator.snapshot().reservedTokens, 0);
  clock = coordinator.snapshot().nextReviewAt; await coordinator.tick(); await coordinator.idle(); assert.equal(requests, 2); assert.equal(delivered, 1); await coordinator.close();
  assert.throws(() => validateInitiativeDecision({ ...proposed, permissionRequest: { workspace: 'execute', background: 'inherit', reason: 'Needed' } }, { events: [{ id: 'fact' }], availableActions: ['ask'] }), { code: 'invalid_decision' });
});
