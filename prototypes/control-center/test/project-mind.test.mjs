import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { DecisionService } from '../decision-service.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createServer } from '../server.mjs';
import { readStateFile } from '../state-shards.mjs';
import { mineProjectSignals } from '../project-interaction-signals.mjs';
import { ProjectMindService, migrateMind, mindCounts, publicMind, addLesson, ensureMind, bm25Rank, heuristicCapture, agentPromises, patchMindEntry, MIND_LIMITS } from '../project-mind.mjs';
import { createDecisionKernel } from '../../../packages/sdk/src/decision-kernel.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { buildRequest } from '../../../packages/sdk/src/providers.mjs';

// Fake JEV and fake model providers only: no network, no paid calls.
process.env.TYPESAFE_API_KEY = 'TEST-ONLY-JEV-KEY';
function fakeJev(pick = {}) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const value = typeof pick === 'function' ? pick(id, question) : pick[id];
      if (question.type === 'noul') return [id, { type: 'noul', noul: value ?? .5 }];
      const keys = Object.keys(question.criteria), chosen = value ?? keys.at(-1);
      return [id, { type: 'choice', choice: chosen, probabilities: Object.fromEntries(keys.map(key => [key, key === chosen ? .96 : .04 / (keys.length - 1)])), confidence: .96 }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 10 } }));
  };
  return { fetch, requests };
}
// Fake small model: answers by system prompt; records every request.
function fakeModel(answers = {}) {
  const calls = [];
  const provider = async function* (request) {
    calls.push({ purpose: request.purpose, system: request.systemPrompt, input: JSON.parse(request.messages[0].content[0].text), maxOutputTokens: request.model.maxOutputTokens });
    const kind = /You classify/.test(request.systemPrompt) ? 'capture' : /learned lessons/.test(request.systemPrompt) ? 'lesson' : 'notes';
    const queue = answers[kind], next = Array.isArray(queue) ? queue.shift() : queue, value = typeof next === 'function' ? next(calls.at(-1).input) : next;
    yield { type: 'text_delta', delta: JSON.stringify(value ?? {}) };
    yield { type: 'usage', usage: { input: 40, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 52 } };
    yield { type: 'done', stopReason: 'stop' };
  };
  return { provider, calls };
}
function setup(t, { models = false, fast = false, jev = null, modes = {}, answers = {}, clock = Date.parse('2026-09-29T08:00:00Z') } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-mind-')), store = new Store(join(directory, 'state.json'));
  let providerId = null;
  if (models || fast) {
    const provider = store.configurationService.provider(null, { name: 'mind fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key', models: [{ id: 'main', contextWindow: 128000, maxOutputTokens: 8192, reasoning: ['off'] }, { id: 'fast', contextWindow: 32000, maxOutputTokens: 2048, reasoning: ['off'] }] });
    providerId = provider.id;
    store.configurationService.update({ defaultModel: { providerId, modelId: 'main', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  }
  store.mutate(state => { state.configuration.decisionKernel = { diagnostic: true, backend: 'typesafe', mode: jev ? 'active' : 'off', modes, ...(fast ? { fastModel: { providerId, modelId: 'fast' } } : {}) }; state.settings.realTokenBudget = null; });
  const { project, session } = store.createProject({ name: 'Ink jump game', description: 'three.js ink-wash jumping game', workspace: directory });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); state.sessions.find(row => row.id === session.id).simulated = false; });
  const judge = jev ? fakeJev(jev) : null;
  const now = { value: clock };
  const decisions = new DecisionService(store, { now: () => now.value, kernelFactory: options => createDecisionKernel({ ...options, fetch: judge?.fetch ?? (async () => { throw new Error('JEV must not be called'); }) }) });
  const model = fakeModel(answers);
  const mind = new ProjectMindService(store, { decisions, provider: model.provider, now: () => now.value, sweepIntervalMs: 0, notesIntervalMs: 0 });
  t.after(async () => { await mind.close(); decisions.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const sessionOf = () => store.state.sessions.find(row => row.id === session.id);
  // One conversation turn (user message + optional assistant reply) written through mutate().
  const turn = (text, { reply, status = 'completed' } = {}) => {
    const ids = { turnId: randomUUID(), userItemId: randomUUID(), replyId: randomUUID() }, at = new Date(now.value).toISOString();
    store.mutate(state => { const s = state.sessions.find(row => row.id === session.id);
      s.turns.push({ id: ids.turnId, status, userItemId: ids.userItemId, createdAt: at, ...(status === 'running' ? {} : { completedAt: at }), modelConfig: { execution: 'rna' }, simulated: false });
      s.items.push({ id: ids.userItemId, turnId: ids.turnId, kind: 'user', text, createdAt: at, simulated: false });
      if (reply) s.items.push({ id: ids.replyId, turnId: ids.turnId, kind: 'assistant', text: reply, final: true, simulated: false, createdAt: at }); });
    return ids;
  };
  const input = ids => mind.captureInput(sessionOf(), sessionOf().items.find(row => row.id === ids.userItemId));
  return { store, mind, decisions, judge, model, project, session, current, sessionOf, turn, input, now, providerId };
}
const lessons = app => app.current().mind.lessons;
const active = app => lessons(app).filter(row => row.status === 'active');

test('capture rides the turn.route fan-out: one JEV request carries route + capture; a judged standing rule auto-applies as a lesson, not as a request owed', async t => {
  const app = setup(t, { jev: { is_correction: .04, is_standing_preference: .96, is_approval: .03, has_pending_request: .93, requests_self_improvement: .05, durable_vs_one_off: 'durable', target_of_feedback: 'out_0', needs_memory: .9, clarify_needed: .1 }, modes: { 'turn.route': 'active' } });
  app.turn('做一个跳一跳原型', { reply: '原型已完成，场景使用了水墨纸张底色。' });
  const ids = app.turn('以后每次改完都先截图自查，跑完构建再告诉我结果');
  const captureInput = app.input(ids);
  assert.equal(captureInput.outputs.length, 1);
  const route = await app.decisions.route({ project: app.current(), sessionId: app.session.id, turnId: ids.turnId, userMessage: '以后每次改完都先截图自查，跑完构建再告诉我结果', memory: true, capture: captureInput });
  assert.equal(app.judge.requests.length, 1, 'one request for routing and capture');
  const questions = Object.keys(app.judge.requests[0].questions);
  for (const id of ['needs_memory', 'is_correction', 'is_standing_preference', 'is_approval', 'has_pending_request', 'requests_self_improvement', 'durable_vs_one_off', 'target_of_feedback']) assert.ok(questions.includes(id), id);
  assert.deepEqual(route.capture, { isCorrection: false, isPreference: true, isApproval: false, pendingRequest: true, selfImprovement: false, durable: 'durable', target: { kind: 'output', index: 0 } });
  await app.mind.capture({ sessionId: app.session.id, turnId: ids.turnId, route, input: captureInput });
  const item = app.sessionOf().items.find(row => row.id === ids.userItemId);
  assert.equal(item.capture.source, 'jev'); assert.equal(item.capture.preference, true); assert.equal(item.capture.target.itemId, captureInput.outputs[0].itemId);
  assert.equal(app.current().mind.commitments.length, 0, 'a judged standing rule is kept as a lesson, not owed as a request within hours');
  assert.equal(active(app).length, 1, 'durable preference becomes an active lesson (no model: verbatim)'); assert.equal(active(app)[0].source.kind, 'preference'); assert.equal(active(app)[0].evidence[0].itemId, ids.userItemId);
  assert.equal(app.judge.requests.length, 1, 'capture adds no JEV request');
  // Resumed turns are never captured twice.
  await app.mind.capture({ sessionId: app.session.id, turnId: ids.turnId, route, input: captureInput });
  assert.equal(app.current().mind.commitments.length, 0); assert.equal(active(app).length, 1);
  // Shadow mode records only: capture falls back.
  const shadow = setup(t, { jev: { is_standing_preference: .96 }, modes: { 'turn.route': 'shadow' } });
  const s = shadow.turn('hi there');
  assert.equal((await shadow.decisions.route({ project: shadow.current(), sessionId: shadow.session.id, turnId: s.turnId, userMessage: 'hi there', memory: true, capture: shadow.input(s) })).capture, undefined);
});

test('fallbacks: fast-model classification when JEV is unavailable, regex heuristics otherwise; the regex is only a weak feature', async t => {
  const plain = setup(t);
  plain.turn('写日报', { reply: '日报如下：……交付物详单：a.md、b.md' });
  const preference = plain.turn('后续交付内容不要写交付物详单之类，只需要直接交付 daily.md 的内容即可');
  await plain.mind.capture({ sessionId: plain.session.id, turnId: preference.turnId });
  assert.equal(plain.sessionOf().items.find(row => row.id === preference.userItemId).capture.source, 'heuristic');
  assert.equal(active(plain).length, 1); assert.equal(active(plain)[0].kind, 'constraint'); assert.match(active(plain)[0].text, /交付物详单/);
  const correction = plain.turn('场景仍然单一，都是一个平面');
  await plain.mind.capture({ sessionId: plain.session.id, turnId: correction.turnId });
  assert.equal(plain.sessionOf().items.find(row => row.id === correction.userItemId).capture.correction, true);
  assert.equal(active(plain).length, 1, 'a correction without any model writes no lesson (never raw text as a rule)');
  assert.equal(plain.model.calls.length, 0);

  const fast = setup(t, { fast: true, answers: { capture: { is_correction: true, is_standing_preference: false, is_approval: false, has_pending_request: false, requests_self_improvement: false, durable: 'durable', target: 'out_0' },
    lesson: { write: true, kind: 'pitfall', text: '场景需要有高低起伏的多层平台，避免所有平台处于同一平面', scope: 'project', taskTypes: ['creative'], until: null, duplicateOf: null, supersedes: [] } } });
  fast.turn('做关卡', { reply: '关卡做好了，平台都放在地面上。' });
  const ids = fast.turn('都是一个平面，看着很怪');
  await fast.mind.capture({ sessionId: fast.session.id, turnId: ids.turnId });
  const capture = fast.sessionOf().items.find(row => row.id === ids.userItemId).capture;
  assert.equal(capture.source, 'fast_model'); assert.equal(capture.correction, true);
  assert.deepEqual(fast.model.calls.map(row => row.purpose), ['mind-capture', 'mind-lesson']);
  assert.ok(fast.model.calls.every(row => row.maxOutputTokens <= 400), 'tiny budgets');
  assert.equal(active(fast)[0].kind, 'pitfall'); assert.equal(active(fast)[0].writer, 'model'); assert.equal(active(fast)[0].source.kind, 'correction'); assert.deepEqual(active(fast)[0].taskTypes, ['creative']);
  assert.ok(fast.store.state.realUsage.reportedTokens + fast.store.state.realUsage.estimatedTokens >= 52, 'metered against the real budget');
  // Weak regex feature for uncaptured history; the capture wins when present.
  const signals = mineProjectSignals(plain.store.state, plain.project.id, { now: plain.now.value + 1000 });
  assert.equal(signals.filter(row => row.kind === 'user_correction').length, 1);
  assert.match(signals.find(row => row.kind === 'user_correction').detail.via, /^capture:/);
  assert.deepEqual(heuristicCapture('太棒了，就是这个', { hasPrevious: true }).isApproval, true);
});

test('lesson writer: dedup (model and JEV same_as_existing), automatic supersede, expiry, capacity', async t => {
  const answers = { lesson: [
    { write: true, kind: 'preference', text: '报告控制在 300 字以内，第一句给结论', scope: 'user', taskTypes: [], duplicateOf: null, supersedes: [] },
    input => ({ write: true, kind: 'preference', text: '报告简短，先说结论', scope: 'user', duplicateOf: input.existingLessons[0]?.id ?? null, supersedes: [] }),
    input => ({ write: true, kind: 'preference', text: '报告控制在 150 字以内，第一句给结论', scope: 'user', duplicateOf: null, supersedes: [input.existingLessons[0].id] }),
  ] };
  const app = setup(t, { models: true, answers });
  app.turn('写个报告', { reply: '报告：……（800 字）' });
  for (const text of ['以后报告不要超过 300 字，先说结论', '记住报告要简短，结论先行', '以后报告要控制在 150 字以内，结论先行']) { const ids = app.turn(text, { reply: '好的' }); await app.mind.capture({ sessionId: app.session.id, turnId: ids.turnId }); }
  const all = lessons(app);
  assert.equal(all.length, 2, JSON.stringify(all.map(row => [row.text, row.status, row.source.kind])));
  const [old, next] = all;
  assert.equal(old.status, 'superseded'); assert.equal(old.supersededBy, next.id); assert.equal(old.evidence.length, 2, 'duplicate merged as evidence'); assert.equal(old.confirmations, 1);
  assert.equal(next.status, 'active'); assert.equal(next.scope, 'user');
  // Revocable: PATCH re-activates, DELETE of the superseding lesson retires the link.
  app.store.mutate(state => patchMindEntry(state.projects.find(row => row.id === app.project.id), 'lessons', old.id, { status: 'retired' }));
  assert.equal(lessons(app)[0].retiredReason, 'user');
  // JEV mind.judge overrides a writer that saw no duplicate.
  const judged = setup(t, { models: true, jev: id => /^same_0$/.test(id) ? .95 : /^contradicts_/.test(id) ? .05 : .5, modes: { 'mind.judge': 'active' }, answers: { lesson: [{ write: true, kind: 'constraint', text: '不要在消息里写文件哈希', scope: 'project' }, { write: true, kind: 'constraint', text: '消息中不要出现提交哈希', scope: 'project', duplicateOf: null }] } });
  judged.turn('写进展', { reply: '已提交 3f2a9c1' });
  for (const text of ['以后不要写哈希', '以后消息里别放提交哈希']) { const ids = judged.turn(text, { reply: 'ok' }); await judged.mind.capture({ sessionId: judged.session.id, turnId: ids.turnId }); }
  assert.equal(lessons(judged).length, 1); assert.equal(lessons(judged)[0].evidence.length, 2);
  assert.ok(judged.judge.requests.some(body => Object.keys(body.questions).includes('same_0')));
  // Expiry via `until` (sweep) and bounded active lessons.
  app.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === app.project.id)); addLesson(mind, { kind: 'pitfall', text: '本周 API 限流，批量请求要间隔', until: new Date(app.now.value + 3600000).toISOString() }); });
  assert.equal(mindCounts(app.current(), { now: app.now.value }).lessons, 2);
  app.now.value += 2 * 3600000; app.mind.sweep();
  const expired = lessons(app).find(row => row.text.startsWith('本周'));
  assert.equal(expired.status, 'retired'); assert.equal(expired.retiredReason, 'expired');
  app.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === app.project.id)); for (let index = 0; index < MIND_LIMITS.activeLessons + 5; index++) addLesson(mind, { kind: 'pitfall', text: `lesson ${index}` }); });
  assert.equal(active(app).length, MIND_LIMITS.activeLessons); assert.ok(lessons(app).length <= MIND_LIMITS.storedLessons);
  assert.deepEqual(bm25Rank([{ id: 'a', text: '报告简短' }, { id: 'b', text: '平台高低起伏' }], '报告要短一点')[0].id, 'a');
});

test('commitments: pending request (no due moment until the evidence or the fallback clock), agent promise (turn.settled), failed turn, resolution by later turn / JEV / user', async t => {
  const app = setup(t);
  const request = app.turn('跑完全部测试后告诉我结果', { reply: '开始运行。' });
  await app.mind.capture({ sessionId: app.session.id, turnId: request.turnId });
  const pending = () => app.current().mind.commitments.filter(row => row.status === 'pending');
  assert.equal(pending().length, 1);
  assert.equal(mindCounts(app.current(), { now: app.now.value }).overdueCommitments, 0);
  // D4: no due moment at creation. With no judge acting, the fallback clock (4 h after its window started) sets one, in the sweep.
  assert.equal(pending()[0].overdueAt, undefined);
  app.now.value += 5 * 3600000; app.mind.sweep();
  assert.equal(mindCounts(app.current(), { now: app.now.value }).overdueCommitments, 1); assert.equal(pending()[0].dueBy, 'default');
  assert.equal(publicMind(app.current(), { now: app.now.value }).commitments[0].overdue, true);
  const failed = app.turn('部署到预览环境', { status: 'failed' });
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).items.push({ id: randomUUID(), turnId: failed.turnId, kind: 'notice', source: 'runtime-error', text: 'Rna 执行未完成。', simulated: false }); });
  await app.mind.afterTurn({ sessionId: app.session.id, turnId: failed.turnId });
  const failedRow = app.current().mind.commitments.find(row => row.trigger === 'failed_turn');
  assert.equal(failedRow.status, 'pending'); assert.equal(failedRow.reason, 'Rna 执行未完成。');
  const promise = app.turn('继续', { reply: '已经部署成功。稍后我会补充移动端的适配测试。' });
  // MIND-4: the promise is turn.settled's verdict (with the sentence that states it), not a wording rule over the reply.
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === promise.turnId).settledVerdict = { finished: null, complete: null, waiting: false, deferred: null, promise: true, promiseText: '稍后我会补充移动端的适配测试。' }; });
  await app.mind.afterTurn({ sessionId: app.session.id, turnId: promise.turnId });
  assert.equal(app.current().mind.commitments.find(row => row.id === failedRow.id).status, 'resolved', 'a later completed turn settles the failed one');
  assert.equal(app.current().mind.commitments.find(row => row.id === failedRow.id).resolvedBy.turnId, promise.turnId);
  const agent = app.current().mind.commitments.find(row => row.trigger === 'agent_promise');
  assert.match(agent.request, /移动端/);
  const narration = app.turn('检查一下', { reply: '我会先检查文件。稍后我会再看一遍。' });   // wording the retired rule would have read as a promise
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === narration.turnId).settledVerdict = { finished: null, complete: null, waiting: false, deferred: null, promise: false }; });
  await app.mind.afterTurn({ sessionId: app.session.id, turnId: narration.turnId });
  assert.equal(app.current().mind.commitments.filter(row => row.trigger === 'agent_promise').length, 1, 'no verdict, no promise: wording alone opens nothing');
  // JEV commitment_resolved_by_evidence on a later turn.
  app.store.mutate(state => { state.configuration.decisionKernel = { backend: 'typesafe', mode: 'active', modes: { 'mind.judge': 'active' } }; });
  const jev = fakeJev(id => id.startsWith('resolved_') ? .95 : .5);
  app.decisions.kernelFactory = options => createDecisionKernel({ ...options, fetch: jev.fetch }); app.decisions.kernelRevision = null;
  const report = app.turn('结果如何？', { reply: '全部 212 个测试通过，移动端适配测试也已补充。' });
  await app.mind.afterTurn({ sessionId: app.session.id, turnId: report.turnId });
  assert.equal(jev.requests.length, 1);
  const byJev = app.current().mind.commitments.filter(row => row.resolvedBy?.kind === 'jev');
  assert.equal(byJev.length, 2); assert.equal(pending().length, 0);
  // Explicit `resolves` from an action, and user dismissal.
  const extra = app.turn('明天提醒我检查一下音效', { reply: '好' });
  await app.mind.capture({ sessionId: app.session.id, turnId: extra.turnId });
  const [open] = pending();
  assert.deepEqual(app.mind.resolve(app.project.id, [open.id], { kind: 'action', actionId: 'a1' }), [open.id]);
  assert.equal(pending().length, 0);
});

test('context injection: lessons ride the tail once per turn, prefix bytes stay stable, uses are accounted', async t => {
  const app = setup(t);
  app.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === app.project.id)); addLesson(mind, { kind: 'constraint', text: '不要写交付物详单', scope: 'project' }); addLesson(mind, { kind: 'pitfall', text: '水墨材质要检查透明度排序', scope: 'project' }); addLesson(mind, { kind: 'preference', text: '回复用中文', scope: 'user' }); });
  const first = app.turn('调整一下水墨材质的透明度');
  const update = await app.mind.foregroundContext({ sessionId: app.session.id, turnId: first.turnId, prompt: '调整一下水墨材质的透明度' });
  // MIND-6: three blocks — standing rules (byte-stable while they do not change), notes, and this turn's part.
  assert.deepEqual(update.map(row => [row.key, row.source, row.empty]), [['project-mind-rules', 'host-project-mind', false], ['project-mind-notes', 'host-project-mind', true], ['project-mind-turn', 'host-project-mind', false]]);
  const [rules, , turnBlock] = update.map(row => JSON.parse(row.text));
  assert.deepEqual(rules.rules.map(row => row.text).sort(), ['不要写交付物详单', '回复用中文'].sort()); assert.match(rules.instruction, /project-mind-rules/);
  assert.deepEqual(turnBlock.relevantLessons.map(row => row.text), ['水墨材质要检查透明度排序']);
  const firstTurn = app.sessionOf().turns.find(row => row.id === first.turnId);
  assert.equal(firstTurn.mindContext.lessonIds.length, 3); assert.ok(lessons(app).every(row => row.uses.recalled === 0), 'D1: putting a lesson in context counts nothing; the end of the turn judges what it did about it');
  // RuntimeController adds it once, after the route hints, at the tail.
  const controller = Object.create(RuntimeController.prototype);
  Object.assign(controller, { store: { state: { sessions: [{ id: 's', items: [] }] } }, admitSteering: async () => {} });
  const context = { sessionId: 's', routeHints: { hints: ['h'], note: 'n' }, mindContext: Promise.resolve(update) };
  assert.deepEqual((await controller.prepareRequest(context, { snapshot: { messages: [] } })).contextUpdates.map(row => row.key), ['turn-route-hints', 'project-mind-rules', 'project-mind-turn'], 'an empty block is not sent to a conversation that never had it');
  assert.equal(await controller.prepareRequest(context, { snapshot: { messages: [] } }), undefined, 'sent once');
  // MIND-7: a correction after a turn with lessons in context moves no lesson's counters (that turn was never judged:
  // nothing counts); only lesson.applied's confident answers do (afterReply).
  app.store.mutate(state => { const s = state.sessions.find(row => row.id === app.session.id); s.items.push({ id: randomUUID(), turnId: first.turnId, kind: 'assistant', text: '已调整。', final: true, simulated: false }); });
  const correction = app.turn('不对，透明度还是有问题');
  await app.mind.capture({ sessionId: app.session.id, turnId: correction.turnId });
  assert.ok(lessons(app).every(row => row.uses.contradicted === 0 && row.uses.applied === 0 && row.status === 'active' && !row.usedAt), JSON.stringify(lessons(app).map(row => row.uses)));
  // SDK session: the mind context is appended after the user message; the system prompt,
  // tools and every earlier wire byte are unchanged when lessons change between turns.
  const directory = await mkdtemp(join(tmpdir(), 'rna-mind-prefix-')), requests = [];
  t.after(() => rm(directory, { recursive: true, force: true }));
  const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxOutputTokens: 1000 };
  let turnId = first.turnId;
  const session = await createSession({ sessionId: 'mind-prefix', projectId: 'project', stateDir: join(directory, 'state'), cwd: directory, model, autoCompaction: false, systemPrompt: 'Stable host instructions.',
    beforeRequest: async () => { const value = await app.mind.foregroundContext({ sessionId: app.session.id, turnId, prompt: '透明度' }); const updates = (value ?? []).filter(row => !row.empty).map(({ empty: _empty, ...row }) => row); return updates.length ? { contextUpdates: updates } : undefined; },
    provider: async function* (request) { requests.push(structuredClone({ systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools })); yield { type: 'text_delta', delta: 'done' }; yield { type: 'usage', usage: { totalTokens: 5 } }; yield { type: 'done', stopReason: 'stop' }; } });
  t.after(() => session.dispose());
  await session.prompt('第一轮');
  app.store.mutate(state => { addLesson(ensureMind(state.projects.find(row => row.id === app.project.id)), { kind: 'pitfall', text: '透明度排序先按深度', scope: 'project' }); });
  turnId = correction.turnId; await session.prompt('第二轮');
  const wire = value => buildRequest({ model, ...value }).body;
  const [one, two] = requests.map(wire);
  assert.equal(requests[0].systemPrompt, requests[1].systemPrompt); assert.deepEqual(requests[0].tools, requests[1].tools);
  assert.ok(!requests[1].systemPrompt.includes('透明度排序先按深度'), 'never in the cached prefix');
  const bytes = body => Buffer.from(body.messages.map(row => JSON.stringify(row)).join('\n'));
  assert.deepEqual(bytes(two).subarray(0, bytes(one).length - 1), bytes(one).subarray(0, bytes(one).length - 1));
  const lastUser = requests[1].messages.findLastIndex(row => row.role === 'user' && JSON.stringify(row.content).includes('第二轮')), mindIndex = requests[1].messages.findLastIndex(row => JSON.stringify(row).includes('透明度排序先按深度'));
  assert.ok(mindIndex > lastUser, 'mind context follows the current user message');
});

// MIND-6 (spec p1 compaction §G): the standing rules are byte-identical from turn to turn while they do not change —
// using a lesson (recall, applied/contradicted accounting, feedback) is `usedAt`, never `updatedAt`, and never
// reorders them; rank moves only on writing, user confirmation, user edits or repeated evidence.
test('rules text stays byte-identical across turns when nothing changes; use is usedAt, not updatedAt', async t => {
  const app = setup(t);
  app.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === app.project.id)); addLesson(mind, { kind: 'constraint', text: '不要写交付物详单', scope: 'project' }); addLesson(mind, { kind: 'preference', text: '回复用中文', scope: 'user' }); });
  const rulesOf = updates => updates.find(row => row.key === 'project-mind-rules').text;
  const first = app.turn('第一轮', { reply: '好的。' });
  const one = await app.mind.foregroundContext({ sessionId: app.session.id, turnId: first.turnId, prompt: '第一轮' });
  const updatedBefore = lessons(app).map(row => row.updatedAt);
  app.now.value += 3600000;
  // lesson.applied's confident "followed" is the use (counted once, when it is judged).
  app.decisions.lessonApplied = async (_project, input) => ({ lessons: input.lessons.map(() => ({ use: 'followed' })), methods: [], ledgerId: 'la-1' });
  await app.mind.afterReply({ sessionId: app.session.id, turnId: first.turnId });
  assert.ok(lessons(app).every(row => row.uses.applied === 1 && row.uses.recalled === 1 && row.usedAt === new Date(app.now.value).toISOString()), 'accounting writes usedAt');
  assert.deepEqual(lessons(app).map(row => row.updatedAt), updatedBefore, 'updatedAt untouched by use');
  assert.equal(await app.mind.afterReply({ sessionId: app.session.id, turnId: first.turnId }), null, 'a turn is judged once');
  const second = app.turn('继续');
  await app.mind.capture({ sessionId: app.session.id, turnId: second.turnId });
  assert.ok(lessons(app).every(row => row.uses.applied === 1), 'the next message counts nothing again');
  const two = await app.mind.foregroundContext({ sessionId: app.session.id, turnId: second.turnId, prompt: '继续' });
  assert.equal(rulesOf(two), rulesOf(one), 'the rules block is byte-identical');
  // A vote on a reply rates the reply, not a lesson: no counter, usedAt or updatedAt moves (MIND-7).
  const used = lessons(app).map(row => [row.uses, row.usedAt]);
  const reply = app.sessionOf().items.find(row => row.kind === 'assistant');
  app.mind.feedback(app.session.id, reply.id, { vote: 'up' });
  app.mind.feedback(app.session.id, reply.id, { vote: 'down' });
  assert.deepEqual(lessons(app).map(row => row.updatedAt), updatedBefore);
  assert.deepEqual(lessons(app).map(row => [row.uses, row.usedAt]), used);
});

test('standing rules rank by when they were written, confirmed or edited; overflow reaches the JEV filter without a keyword prefilter', async t => {
  const { selectLessons } = await import('../project-mind.mjs');
  const at = minutes => new Date(Date.parse('2026-09-01T00:00:00Z') + minutes * 60000).toISOString();
  const rule = (id, minutes, extra = {}) => ({ id, kind: 'preference', text: `规则 ${id}`, scope: 'project', status: 'active', createdAt: at(minutes), updatedAt: at(minutes), uses: {}, evidence: [], ...extra });
  const rows = Array.from({ length: 12 }, (_, index) => rule(`r${index}`, index));
  rows[0].confirmedAt = at(100); rows[1].editedAt = at(101); rows[2].usedAt = at(500); rows[3].updatedAt = at(600);
  const project = { mind: { lessons: [...rows, { id: 'p1', kind: 'pitfall', text: '透明度排序', scope: 'project', status: 'active', createdAt: at(1), updatedAt: at(1), uses: {}, evidence: [] }] } };
  const { always, candidates } = selectLessons(project, '完全无关的消息', { now: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(always.length, 10);
  assert.ok(always.some(row => row.id === 'r0') && always.some(row => row.id === 'r1'), 'confirmed and edited rules rank up');
  assert.ok(!always.some(row => row.id === 'r2') && !always.some(row => row.id === 'r3'), 'use and bookkeeping do not');
  assert.deepEqual(always.map(row => row.id), [...always].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(row => row.id), 'listed in creation order');
  assert.deepEqual(candidates.slice(0, 2).map(row => row.id).sort(), ['r2', 'r3'], 'the overflow rules come first among candidates, with no keyword match needed');
  assert.ok(!candidates.some(row => row.id === 'p1'), 'other lessons still need a keyword match');
  // A user edit sets editedAt (and moves that lesson's rank).
  const edited = setup(t);
  edited.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === edited.project.id)); addLesson(mind, { kind: 'preference', text: '标题用短句', scope: 'project' }); });
  const id = lessons(edited)[0].id;
  edited.store.mutate(state => patchMindEntry(state.projects.find(row => row.id === edited.project.id), 'lessons', id, { text: '标题用短句，不超过十个字' }, { now: edited.now.value + 1000 }));
  assert.equal(lessons(edited)[0].editedAt, new Date(edited.now.value + 1000).toISOString());
});

// MC-5: context keys never reach the model. Every mind block names itself, and an emptied turn block still lists its
// parts — a bare {} could not be matched to the copy with the finished plan it replaces.
test('each mind block names itself, and an emptied turn block says there is nothing now', async () => {
  const { mindContextUpdates, MIND_CONTEXT_KEYS } = await import('../project-mind.mjs');
  const full = mindContextUpdates({ rules: [{ id: 'r', kind: 'preference', scope: 'project', text: '回复用中文' }], relevant: [{ id: 'p', kind: 'pitfall', scope: 'project', text: '先备份' }], plan: { doing: [{ id: 'd', text: '写第三章' }], next: [] } });
  assert.deepEqual(full.map(row => JSON.parse(row.text).block), Object.values(MIND_CONTEXT_KEYS));
  assert.match(JSON.parse(full[0].text).instruction, /named by its `block` field/);
  assert.deepEqual(JSON.parse(full[2].text).plan, { doing: [{ id: 'd', text: '写第三章' }], next: [] });
  const cleared = mindContextUpdates({ rules: [], relevant: [], commitments: [], plan: { doing: [], next: [] } });
  assert.deepEqual(JSON.parse(cleared[2].text), { block: 'project-mind-turn', relevantLessons: [], commitments: [], plan: { doing: [], next: [] } });
  assert.deepEqual(cleared.map(row => row.empty), [true, true, true], 'still empty: sent only to replace a copy the conversation holds');
});

// MC-3: overflowing standing rules share the JEV judge's 12 slots with the BM25 hits instead of crowding them out; the
// no-JEV fallback and the background view (the first six) hold both.
test('many overflowing standing rules leave the relevant pitfalls their place among the candidates', async () => {
  const { selectLessons, mindBackgroundView } = await import('../project-mind.mjs');
  const at = minutes => new Date(Date.parse('2026-09-01T00:00:00Z') + minutes * 60000).toISOString();
  const lesson = (id, kind, text, minutes) => ({ id, kind, text, scope: 'project', status: 'active', createdAt: at(minutes), updatedAt: at(minutes), uses: {}, evidence: [] });
  const preferences = Array.from({ length: 25 }, (_, index) => lesson(`pref-${index}`, 'preference', `Prefer concise replies, style rule number ${index}`, index));
  const pitfalls = [0, 1, 2].map(index => lesson(`pit-${index}`, 'pitfall', `Before a database migration deploy, back up the schema (step ${index})`, 100 + index));
  const project = { name: 'Ops', mind: { lessons: [...preferences, ...pitfalls] } };
  const now = Date.parse('2026-10-01T00:00:00Z'), { candidates, relevantLimit } = selectLessons(project, 'deploy the database migration', { now });
  assert.ok(candidates.length <= 12, `at most the judge's window (${candidates.length})`);
  const ids = candidates.map(row => row.id);
  assert.ok(pitfalls.every(row => ids.indexOf(row.id) >= 0 && ids.indexOf(row.id) < relevantLimit), `the pitfalls are in the first ${relevantLimit}: ${ids.join(',')}`);
  assert.ok(ids.slice(0, relevantLimit).some(id => id.startsWith('pref-')), 'overflowing rules are there too');
  assert.equal(ids[0].startsWith('pref-'), true, 'a standing rule first (kept unless the judge says it does not apply)');
  const view = mindBackgroundView(project, { now, query: 'deploy the database migration' });
  assert.deepEqual(pitfalls.map(row => view.lessons.some(entry => entry.id === row.id)), [true, true, true], 'the background view keeps them');
  // Without overflow nothing changes: the BM25 hits, in score order.
  const small = { mind: { lessons: [...preferences.slice(0, 5), ...pitfalls] } };
  assert.deepEqual(selectLessons(small, 'deploy the database migration', { now }).candidates.map(row => row.id).sort(), ['pit-0', 'pit-1', 'pit-2']);
});

test('HTTP: feedback API, mind GET/PATCH/DELETE, summary counts and the project.mind SSE event', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-mind-api-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { project, session } = app.store.createProject({ name: 'Mind API', workspace: directory });
  const itemId = randomUUID(), turnId = randomUUID(), userId = randomUUID();
  app.store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.simulated = false; const s = state.sessions.find(row => row.id === session.id); s.simulated = false;
    s.turns.push({ id: turnId, status: 'completed', userItemId: userId, createdAt: new Date().toISOString(), modelConfig: { execution: 'rna' } }); s.items.push({ id: userId, turnId, kind: 'user', text: '写日报' }, { id: itemId, turnId, kind: 'assistant', text: '日报……', final: true, simulated: false }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body) => { const response = await fetch(`${origin}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  // Index SSE channel: capture project.mind events.
  const frames = [], channel = app.apiV2.hub.channel(''); channel.clients.add({ write: text => frames.push(text), close() {} }); app.apiV2.hub.diffIndex();
  const voted = await call('POST', `/api/v2/sessions/${session.id}/items/${itemId}/feedback`, { vote: 'down', comment: '太啰嗦了，不要列交付物详单' });
  assert.equal(voted.status, 200); assert.deepEqual(Object.keys(voted.body.feedback).sort(), ['at', 'comment', 'vote']);
  assert.equal(app.store.state.sessions.find(row => row.id === session.id).items.find(row => row.id === itemId).feedback.vote, 'down');
  assert.equal(mineProjectSignals(app.store.state, project.id).find(row => row.kind === 'user_correction')?.detail.via, 'feedback', '👎 feeds the evolution signal miner');
  await app.mind.idle();
  const mind = await call('GET', `/api/v2/projects/${project.id}/mind`);
  assert.equal(mind.status, 200); assert.equal(mind.body.lessons.length, 1); assert.equal(mind.body.lessons[0].source.kind, 'feedback'); assert.equal(mind.body.counts.lessons, 1);
  assert.equal((await call('POST', `/api/v2/sessions/${session.id}/items/${itemId}/feedback`, { vote: 'sideways' })).status, 400);
  assert.equal((await call('POST', `/api/v2/sessions/${session.id}/items/${userId}/feedback`, { vote: 'up' })).status, 400);
  assert.equal((await call('POST', `/api/v2/sessions/${session.id}/items/${itemId}/feedback`, { vote: null })).body.feedback, null);
  const lessonId = mind.body.lessons[0].id, entry = `/api/v2/projects/${project.id}/mind/lessons/${lessonId}`;
  assert.equal((await call('PATCH', entry, { text: '回复简短，不列交付物详单', scope: 'user' })).body.entry.scope, 'user');
  assert.equal((await call('PATCH', entry, { uses: 3 })).status, 400);
  assert.equal((await call('PATCH', entry, { status: 'retired' })).body.entry.status, 'retired');
  const summary = (await call('GET', `/api/v2/projects/${project.id}`)).body;
  assert.equal(summary.mind, undefined, 'mind is a heavy field'); assert.equal(summary.counts.lessons, 0);
  for (const key of ['openAgenda', 'pendingCommitments', 'overdueCommitments']) assert.equal(summary.counts[key], 0);
  assert.equal((await call('DELETE', entry)).status, 200); assert.equal((await call('DELETE', entry)).status, 404);
  assert.equal((await call('PATCH', `/api/v2/projects/${project.id}/mind/lessons/${lessonId}`, { status: 'active' })).status, 404);
  app.apiV2.hub.diffIndex();
  let events = frames.filter(text => text.startsWith('id:') && text.includes('event: project.mind'));
  assert.ok(events.length >= 1); let data = JSON.parse(events.at(-1).split('data: ')[1]);
  assert.equal(data.projectId, project.id); assert.equal(data.counts.lessons, 0); assert.ok(Number.isSafeInteger(data.revision)); assert.ok(data.changed.includes('lessons'));
  // User-authored entries (K3): POST lessons/agenda/notes/commitments; generic text/until/status edits.
  const base = `/api/v2/projects/${project.id}/mind`; frames.length = 0;
  const agenda = await call('POST', `${base}/agenda`, { text: '给跳跃加粒子墨迹', kind: 'idea' });
  assert.equal(agenda.status, 201); assert.equal(agenda.body.entry.status, 'open'); assert.equal(agenda.body.entry.source.kind, 'user');
  assert.equal((await call('POST', `${base}/lessons`, { text: '先截图再交付', kind: 'success_habit', scope: 'project' })).body.entry.kind, 'success_habit');
  assert.equal((await call('POST', `${base}/notes`, { text: '用户主要在晚上试玩', list: 'facts' })).body.entry.list, 'facts');
  assert.equal((await call('POST', `${base}/notes`, { text: '用户主要在晚上试玩', list: 'facts' })).status, 409);
  const commitment = (await call('POST', `${base}/commitments`, { text: '周五前给出试玩版' })).body.entry;
  assert.equal(commitment.trigger, 'user_request');
  const until = '2026-10-10T00:00:00.000Z';
  assert.equal((await call('PATCH', `${base}/commitments/${commitment.id}`, { until })).body.entry.overdueAt, until);
  assert.equal((await call('PATCH', `${base}/commitments/${commitment.id}`, { status: 'dismissed' })).body.entry.status, 'dismissed');
  assert.equal((await call('PATCH', `${base}/agenda/${agenda.body.entry.id}`, { status: 'done' })).body.entry.status, 'done');
  assert.equal((await call('POST', `${base}/threads`, { text: 'x' })).status, 404, 'threads are created by the narrator');
  assert.equal((await call('POST', `${base}/lessons`, { text: 'x', kind: 'rule' })).status, 400);
  app.apiV2.hub.diffIndex();
  events = frames.filter(text => text.includes('event: project.mind')).map(text => JSON.parse(text.split('data: ')[1])); data = events.at(-1);
  assert.deepEqual([...new Set(events.flatMap(row => row.changed))].sort(), ['agenda', 'commitments', 'lessons', 'notes']); assert.equal(data.counts.lessons, 1); assert.equal(data.counts.openAgenda, 0);
});

// Trimmed copy of production project shapes (2026-09-28): frozen openQuestions,
// pending milestones, and facts that stored raw user messages.
const PRODUCTION_SHAPE = { id: 'p-shape', name: 'Ai 应用调研项目', simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' }, commitments: [],
  openQuestions: ['用户期望通过什么渠道获取实时 Ai 新闻？', '推送目标渠道是什么？'],
  milestones: [{ id: 'm1', title: '确立每日调研工作流与报告模板', description: '定义数据来源优先级。', acceptanceCriteria: ['交付手册'], status: 'pending' }, { id: 'm2', title: '已完成的里程碑', status: 'done' }],
  facts: [{ id: 'f1', text: '搜索最近一周有哪些新模型发布，以及榜单评分，做简单分析', source: 'conversation', confidence: 1, createdAt: '2026-09-27T22:57:21.749Z', simulated: false },
    { id: 'f2', text: '后续交付内容不要写交付物详单之类，只需要直接交付 daily.md 的内容即可', source: 'conversation', confidence: 1, createdAt: '2026-09-28T01:00:00.000Z', simulated: false },
    { id: 'f3', text: '以后都用北京时间归档', source: 'model-project-initialization', simulated: false }] };
test('migration seeds agenda/lessons once with provenance (production shapes; read-only production state when present)', async t => {
  const project = structuredClone(PRODUCTION_SHAPE);
  const counts = migrateMind(project, { now: Date.parse('2026-09-29T00:00:00Z') });
  assert.deepEqual(counts, { agenda: 3, lessons: 1 });
  assert.deepEqual(project.mind.agenda.map(row => [row.kind, row.source.from]), [['intention', 'milestones'], ['awaiting_user', 'openQuestions'], ['awaiting_user', 'openQuestions']]);
  assert.equal(project.mind.lessons[0].kind, 'constraint'); assert.equal(project.mind.lessons[0].source.kind, 'migration'); assert.equal(project.mind.lessons[0].evidence[0].factId, 'f2');
  assert.equal(migrateMind(project), null, 'idempotent'); assert.deepEqual(project.openQuestions, PRODUCTION_SHAPE.openQuestions, 'legacy fields untouched');
  // Store + service: migration runs through mutate() for ready projects.
  const app = setup(t);
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id); delete p.mind; p.openQuestions = ['目标平台是桌面还是移动端？']; });
  app.mind.sweep();
  assert.equal(app.current().mind.agenda[0].text, '目标平台是桌面还是移动端？'); assert.equal(app.current().mind.health.learning, 'paused');
  // Read-only production state (never written): every real project migrates within bounds.
  const file = process.env.RNA_MIND_PRODUCTION_STATE ?? decodeURIComponent(new URL('../../../../../../prototypes/control-center/.state/state.json', import.meta.url).pathname);
  if (!existsSync(file)) return t.diagnostic('production state not present; shape fixture only');
  const loaded = readStateFile(file);
  for (const real of structuredClone(loaded.state.projects)) {
    const result = migrateMind(real);
    assert.ok(real.mind.agenda.filter(row => row.status === 'open').length <= MIND_LIMITS.openAgenda);
    if (real.openQuestions?.length && result) assert.ok(result.agenda >= 1);
  }
});

test('catch-up settles unreported turns; an answered open question closes its agenda; a delivery reporting completion settles a commitment', async t => {
  const app = setup(t);
  app.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === app.project.id)); mind.agenda.push({ id: 'q1', kind: 'awaiting_user', text: '目标平台是桌面浏览器、移动端网页还是两者兼顾？', status: 'open', createdAt: new Date(app.now.value).toISOString(), updatedAt: new Date(app.now.value).toISOString(), source: { kind: 'migration' }, evidence: [] }); });
  const answer = app.turn('目标平台就是桌面浏览器，移动端先不考虑', { reply: '明白。' });
  await app.mind.capture({ sessionId: app.session.id, turnId: answer.turnId });
  const question = app.current().mind.agenda.find(row => row.id === 'q1');
  assert.equal(question.status, 'done'); assert.equal(question.resolvedBy.kind, 'capture'); assert.match(question.evidence.at(-1).excerpt, /桌面浏览器/);
  const failed = app.turn('报告字段以现实为准，更新 README；模板暂不同步', { status: 'failed' });
  await app.mind.catchUp(app.project.id, { since: 0 });
  assert.ok(app.sessionOf().turns.every(row => row.mindSettledAt), 'every terminal turn settled once');
  const row = app.current().mind.commitments.find(entry => entry.trigger === 'failed_turn' && entry.source.turnId === failed.turnId);
  assert.equal(row.status, 'pending');
  const deliver = (text, offset) => app.store.mutate(state => { state.sessions.find(entry => entry.id === app.session.id).items.push({ id: randomUUID(), kind: 'assistant', source: 'initiative', simulated: false, createdAt: new Date(app.now.value + offset).toISOString(), text }); });
  deliver('进展：还在看 README。', 60000); await app.mind.catchUp(app.project.id, { since: 0 });
  assert.equal(app.current().mind.commitments.find(entry => entry.id === row.id).status, 'pending', 'a status update without completion does not settle');
  deliver('已按你的决定执行：字段说明以实际报告为准并已更新 README，模板保持不变。', 120000); await app.mind.catchUp(app.project.id, { since: 0 });
  const settled = app.current().mind.commitments.find(entry => entry.id === row.id);
  assert.equal(settled.status, 'resolved'); assert.equal(settled.resolvedBy.kind, 'delivery');
});

test('notes: JEV notes.worth skips the notes model call for a batch with nothing new about the user; a confident yes (or no judge) makes it', async t => {
  const skip = setup(t, { models: true, fast: true, jev: { has_notes: .05 }, answers: { notes: { facts: ['never used'] } } });
  skip.turn('把第三章再改短一点'); skip.now.value += 60000;
  assert.equal(await skip.mind.updateNotes(skip.project.id), false);
  assert.equal(skip.model.calls.filter(row => row.purpose === 'mind-notes').length, 0, 'no notes call');
  assert.ok(skip.current().mind.notes.checkedAt, 'the batch is marked checked, so it is not judged again');
  assert.equal(skip.judge.requests.at(-1).questions.has_notes.type, 'noul');
  const keep = setup(t, { models: true, fast: true, jev: { has_notes: .95 }, answers: { notes: { facts: ['高中语文老师，晚上看稿'] } } });
  keep.turn('我是高中语文老师，晚上才有空看稿'); keep.now.value += 60000;
  await keep.mind.updateNotes(keep.project.id);
  assert.equal(keep.model.calls.filter(row => row.purpose === 'mind-notes').length, 1);
  assert.deepEqual(keep.current().mind.notes.facts.map(row => row.text), ['高中语文老师，晚上看稿']);
});

test('lesson.applied: the reply\'s followed lessons are its used ones; the first time a lesson from the user\'s feedback is followed, the reply carries one quiet note', async t => {
  const app = setup(t, { models: true, fast: true });
  let lessonId;
  app.store.mutate(state => { const project = state.projects.find(row => row.id === app.project.id); lessonId = addLesson(ensureMind(project), { text: '先给结论，再展开依据', kind: 'preference', source: { kind: 'feedback' } }, { now: app.now.value }).id; });
  const ids = app.turn('分析一下关卡难度', { reply: '结论：第三关太难。依据：……' });
  app.store.mutate(state => { const s = state.sessions.find(row => row.id === app.session.id); s.turns.find(row => row.id === ids.turnId).mindContext = { lessonIds: [lessonId], at: new Date(app.now.value).toISOString() }; });
  let asked;
  app.decisions.lessonApplied = async (_project, input) => { asked = input; return { lessons: [{ use: 'followed' }], methods: [], ledgerId: 'la-1' }; };
  const outcome = await app.mind.afterReply({ sessionId: app.session.id, turnId: ids.turnId });
  assert.deepEqual(outcome, { followed: [lessonId], noted: lessonId });
  // The judge reads the shared turn digest (the request, the steps, the end of the reply), not the reply alone.
  assert.match(asked.digest.reply, /结论：第三关太难/); assert.match(asked.digest.request, /分析一下关卡难度/); assert.equal(asked.lessons[0].text, '先给结论，再展开依据');
  const session = app.sessionOf(), reply = session.items.find(row => row.id === ids.replyId);
  assert.deepEqual(reply.lessonNote, { lessonId, text: '先给结论，再展开依据' });
  assert.deepEqual(session.turns.find(row => row.id === ids.turnId).mindContext.followed, [lessonId]);
  assert.ok(lessons(app).find(row => row.id === lessonId).firstFollowedAt);
  const again = app.turn('再看第四关', { reply: '结论：第四关合适。' });
  app.store.mutate(state => { const s = state.sessions.find(row => row.id === app.session.id); s.turns.find(row => row.id === again.turnId).mindContext = { lessonIds: [lessonId] }; });
  assert.deepEqual(await app.mind.afterReply({ sessionId: app.session.id, turnId: again.turnId }), { followed: [lessonId], noted: null }, 'the note is shown once per lesson');
  assert.equal(app.sessionOf().items.find(row => row.id === again.replyId).lessonNote, undefined);
});

test('open questions the agent waited on for a day are asked once, in one card, when the user is here; "先跳过" keeps them open and never asks again', async t => {
  const { UserInteractionService } = await import('../user-interaction-service.mjs');
  const app = setup(t);
  app.mind.interactions = new UserInteractionService(app.store);
  t.after(() => app.mind.interactions.close?.());
  const day = 86400000, ids = ['q-platform', 'q-channel', 'q-zone', 'q-fresh', 'q-blocking'];
  app.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === app.project.id));
    const row = (id, text, ageMs, extra = {}) => ({ id, kind: 'awaiting_user', text, status: 'open', createdAt: new Date(app.now.value - ageMs).toISOString(), updatedAt: new Date(app.now.value - ageMs).toISOString(), source: { kind: 'migration' }, evidence: [], ...extra });
    mind.agenda.push(row(ids[0], '目标平台是桌面浏览器还是移动端？', 3 * day), row(ids[1], '推送到哪个渠道？', 2 * day), row(ids[2], '时区按 UTC 还是北京时间？', 2 * day, { blocking: false }), row(ids[3], '关卡数量目标？', 3600000), row(ids[4], '是否允许付费素材？', 4 * day, { blocking: true }));
  });
  const first = await app.mind.askOpenQuestions(app.project.id);
  assert.equal(typeof first, 'string', 'the card id');
  const cards = () => app.sessionOf().items.filter(item => item.kind === 'question' && item.interaction?.source === 'initiative');
  assert.equal(cards().length, 1); const card = cards()[0].interaction; assert.equal(card.id, first);
  assert.deepEqual(card.questions.map(question => question.id), ids.slice(0, 3), 'three stale, non-blocking questions in one card; the fresh one and the blocking one (asked on its own path) stay out');
  assert.ok(card.questions.every(question => question.options[0].id === 'skip' && question.allowCustom));
  const agenda = id => app.current().mind.agenda.find(row => row.id === id);
  assert.equal(agenda(ids[0]).interaction.questionId, ids[0]); assert.equal(agenda(ids[3]).interaction, undefined);
  assert.equal(await app.mind.askOpenQuestions(app.project.id), null, 'asked once');
  app.mind.interactions.answer(app.session.id, card.id, { requestId: 'r1', answers: [{ id: ids[0], selected: [], custom: '桌面浏览器' }, { id: ids[1], selected: ['skip'] }, { id: ids[2], selected: [], custom: 'UTC' }] });
  app.mind.settleAnswered(); await app.mind.idle();
  assert.equal(agenda(ids[0]).status, 'done'); assert.equal(agenda(ids[0]).answer, '桌面浏览器'); assert.equal(agenda(ids[0]).resolvedBy.kind, 'answer');
  assert.equal(agenda(ids[1]).status, 'open'); assert.ok(agenda(ids[1]).skippedAt); assert.equal(agenda(ids[1]).blocking, false); assert.ok(agenda(ids[1]).interaction.settledAt);
  assert.equal(agenda(ids[2]).status, 'done'); assert.equal(agenda(ids[2]).answer, 'UTC');
  app.mind.asked.clear();
  assert.equal(await app.mind.askOpenQuestions(app.project.id), null, 'a skipped question is never asked again; the fresh one is still too young');
  assert.equal(cards().length, 1);
  // A day later the young question is stale too: it is asked on its own; the skipped one still is not.
  app.now.value += 2 * day;
  const second = await app.mind.askOpenQuestions(app.project.id);
  assert.equal(typeof second, 'string'); assert.deepEqual(cards().at(-1).interaction.questions.map(question => question.id), [ids[3]]);
});

test('a correction labels the previous turn\'s in-turn judgments: "on track" before a correction was a missed drift; before approval it was right', async t => {
  const app = setup(t);
  const labels = []; app.mind.decisions.labelDecision = (id, label) => { labels.push([id, label]); return true; };
  const first = app.turn('写第一章', { reply: '第一章写好了。' });
  app.store.mutate(state => { const turn = state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === first.turnId); turn.judgments = [{ point: 'turn.drift', ledgerId: 'd1', drifting: false }, { point: 'turn.drift', ledgerId: 'd2', drifting: true }]; });
  const correction = app.turn('不对，你写的和我要的完全不是一回事', { reply: '抱歉。' });
  await app.mind.capture({ sessionId: app.session.id, turnId: correction.turnId });
  assert.deepEqual([...labels].sort(), [['d1', 'drift_missed'], ['d2', 'drift_confirmed']]);
  labels.length = 0;
  app.store.mutate(state => { const turn = state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === correction.turnId); turn.judgments = [{ point: 'turn.drift', ledgerId: 'd3', drifting: false }]; });
  const fine = app.turn('好的，继续', { reply: '继续。' });
  await app.mind.capture({ sessionId: app.session.id, turnId: fine.turnId });
  assert.deepEqual(labels, [['d3', 'drift_clear']]);
});

test('the never_applied card: a lesson the judge saw go against the turn in eight turns and never followed is put to the user once; the counters alone, a rule that did not apply and a rule followed ask nothing', async t => {
  const app = setup(t);
  const offers = []; app.mind.invitations = { offerLesson: (sessionId, fields) => { offers.push({ sessionId, ...fields }); return { id: `inv-${offers.length}` }; } };
  const ids = ['l-never', 'l-used', 'l-young', 'l-confirmed', 'l-unjudged', 'l-irrelevant', 'l-contradicted'];
  app.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === app.project.id)), at = new Date(app.now.value).toISOString();
    const row = (id, text, uses, extra = {}) => ({ id, kind: 'pitfall', text, scope: 'project', status: 'active', createdAt: at, updatedAt: at, source: { kind: 'correction' }, evidence: [], uses, ...extra });
    // `wentAgainst`: the judge's own count of confident misses (D1); `recalled` / `applied` from before it are not what the card reads.
    mind.lessons.push(row('l-never', '关卡多了要分页。', { recalled: 7, applied: 0, contradicted: 0, wentAgainst: 7 }), row('l-used', '写前先核对设定集。', { recalled: 20, applied: 4, contradicted: 0, wentAgainst: 7 }), row('l-young', '音频改动要实际运行确认。', { recalled: 3, applied: 0, contradicted: 0, wentAgainst: 2 }),
      row('l-confirmed', '先给结论。', { recalled: 15, applied: 0, contradicted: 0, wentAgainst: 7 }, { confirmedAt: at }), row('l-unjudged', '截图前先等动画结束。', { recalled: 30, applied: 0, contradicted: 0 }), row('l-irrelevant', '导出前先清缓存。', { recalled: 12, applied: 0, contradicted: 0, wentAgainst: 7 }),
      // The user once contradicted it (an older release counted that): not asked whether to keep it, as before D1.
      row('l-contradicted', '加载界面要有进度条。', { recalled: 9, applied: 0, contradicted: 1, wentAgainst: 7 }));
  });
  const lesson = id => app.current().mind.lessons.find(row => row.id === id);
  // MIND-7: the counters alone ask nothing (a lesson nobody judged was not seen ignored).
  app.mind.sweep(); await app.mind.idle();
  assert.equal(offers.length, 0); assert.ok(ids.every(id => lesson(id).needsConfirmation === undefined));
  // One turn: every lesson was in its context; the judge saw them go against it, except one the turn had nothing to do with.
  const turn = app.turn('加一关', { reply: '加好了。' });
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === turn.turnId).mindContext = { lessonIds: ids }; });
  app.decisions.lessonApplied = async (_project, input) => ({ lessons: input.lessons.map(row => ({ use: row.text === '导出前先清缓存。' ? 'not_relevant' : row.text === '截图前先等动画结束。' ? 'unsure' : 'went_against' })), methods: [], ledgerId: 'la-1' });
  const outcome = await app.mind.afterReply({ sessionId: app.session.id, turnId: turn.turnId });
  assert.deepEqual(outcome.asked, ['l-never'], 'only the lesson with a confident eighth miss and no follow: not the one followed before, the young one, the one the user confirmed or contradicted');
  await app.mind.idle();
  assert.deepEqual(offers.map(row => [row.lessonId, row.reason]), [['l-never', 'never_applied']]);
  assert.equal(lesson('l-never').interaction.via, 'invitation'); assert.equal(lesson('l-never').status, 'active', 'asked, never retired');
  assert.equal(lesson('l-never').uses.wentAgainst, 8); assert.equal(lesson('l-never').uses.recalled, 8, 'recalled counts the turns the rule was relevant');
  assert.equal(lesson('l-irrelevant').uses.wentAgainst, 7, 'a rule the turn had nothing to do with counts nothing'); assert.equal(lesson('l-irrelevant').uses.recalled, 12);
  assert.equal(lesson('l-unjudged').uses.recalled, 30, 'an unsure answer changes nothing');
  assert.ok(['l-used', 'l-young', 'l-confirmed', 'l-unjudged', 'l-irrelevant', 'l-contradicted'].every(id => lesson(id).needsConfirmation === undefined && lesson(id).status === 'active'));
  app.mind.sweep(); await app.mind.idle();
  assert.equal(offers.length, 1, 'asked once');
  // A lesson an earlier release already marked never_applied still gets its card, once (never retired silently).
  app.store.mutate(state => { Object.assign(ensureMind(state.projects.find(row => row.id === app.project.id)).lessons.find(row => row.id === 'l-used'), { needsConfirmation: true, confirmReason: 'never_applied', neverAppliedAskedAt: new Date(app.now.value).toISOString() }); });
  app.mind.sweep(); await app.mind.idle();
  assert.deepEqual(offers.map(row => row.lessonId), ['l-never', 'l-used']);
});

test('a correction also labels a skipped question (ask.necessity) and the lesson.applied verdict of the previous turn', async t => {
  const app = setup(t);
  const labels = []; app.mind.decisions.labelDecision = (id, label) => { labels.push([id, label]); return true; };
  const first = app.turn('写第一章', { reply: '按“第X章 标题”的格式写好了。' });
  app.store.mutate(state => { const turn = state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === first.turnId); turn.judgments = [{ point: 'ask.necessity', ledgerId: 'nec-1', skipped: 'default' }]; turn.mindContext = { lessonIds: ['l1'], followed: ['l1'], appliedLedgerId: 'la-1' }; });
  const correction = app.turn('不对，标题格式我要的不是这个', { reply: '好的。' });
  await app.mind.capture({ sessionId: app.session.id, turnId: correction.turnId });
  assert.deepEqual([...labels].sort(), [['la-1', 'applied_wrong'], ['nec-1', 'necessity_missed']]);
  labels.length = 0;
  app.store.mutate(state => { const turn = state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === correction.turnId); turn.judgments = [{ point: 'ask.necessity', ledgerId: 'nec-2', skipped: 'known' }]; turn.mindContext = { lessonIds: ['l1'], followed: [], appliedLedgerId: 'la-2' }; });
  const fine = app.turn('好的，继续', { reply: '继续。' });
  await app.mind.capture({ sessionId: app.session.id, turnId: fine.turnId });
  assert.deepEqual(labels, [['nec-2', 'necessity_right']], 'nothing followed: the lesson.applied verdict has no label');
});

test('a lesson that sharpens an older one (JEV refines) takes its place instead of standing beside it', async t => {
  const answers = { lesson: [
    { write: true, kind: 'preference', text: '行文避免数字化的生硬表达，如“看了两秒”', scope: 'project', taskTypes: [], duplicateOf: null, supersedes: [] },
    { write: true, kind: 'preference', text: '数字化表达要看语境：生硬的量化要改，人名和自然口语里的数字保留', scope: 'project', taskTypes: [], duplicateOf: null, supersedes: [] },
  ] };
  const app = setup(t, { models: true, answers });
  const judged = [];
  app.mind.decisions = { mindJudge: async (_project, input) => { judged.push(input); return { same: [], contradicts: [], refines: input.candidate?.includes('看语境') ? [0] : [], applies: [], notApplies: [], resolved: [], ledgerId: null }; } };
  app.turn('写一章', { reply: '第一章……' });
  for (const text of ['以后不要写“看了两秒”这种数字化表达', '记住以后数字化表达要看语境，人名里的数字别改']) { const ids = app.turn(text, { reply: '好的' }); await app.mind.capture({ sessionId: app.session.id, turnId: ids.turnId }); }
  const all = lessons(app), [old, next] = all;
  assert.equal(all.length, 2); assert.equal(judged.length, 1, 'the second lesson was judged against the first');
  assert.equal(old.status, 'superseded'); assert.equal(old.supersededBy, next.id); assert.equal(next.status, 'active');
});

test('lessons already kept meet the older ones once: a repeat folds into the older lesson, a sharper one replaces it', async t => {
  const { lessonToConsolidate } = await import('../project-mind.mjs');
  const app = setup(t, { models: true, answers: {} });
  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  app.store.mutate(state => {
    const project = state.projects.find(row => row.id === app.project.id); project.mind ??= {}; project.mind.lessons = [
      { id: 'a', kind: 'preference', text: '第一章凸显核心吸引点，之后每 2-3 章再现一部分吸引元素', status: 'active', scope: 'project', createdAt: at(30), updatedAt: at(30), evidence: [{ quote: 'a' }] },
      { id: 'b', kind: 'success_habit', text: '第一章集中凸显核心吸引点，之后每隔 2-3 章让吸引元素以新形式再现', status: 'active', scope: 'project', createdAt: at(20), updatedAt: at(20), evidence: [{ quote: 'b' }] },
      { id: 'c', kind: 'preference', text: '行文避免数字化的生硬表达', status: 'active', scope: 'project', createdAt: at(15), updatedAt: at(15), evidence: [] },
      { id: 'd', kind: 'preference', text: '数字化表达要看语境：生硬量化要改，人名和口语里的数字保留', status: 'active', scope: 'project', createdAt: at(10), updatedAt: at(10), evidence: [] },
    ];
  });
  const lessonsNow = () => app.store.state.projects.find(row => row.id === app.project.id).mind.lessons;
  app.mind.decisions = { enabled: () => true, mindJudge: async (_project, { candidate, lessons }) => {
    const index = text => lessons.findIndex(row => row.text.includes(text));
    if (candidate.includes('看语境')) return { same: [], contradicts: [], refines: [index('数字化')].filter(i => i >= 0), applies: [], notApplies: [], resolved: [] };
    if (candidate.includes('以新形式再现')) return { same: [index('每 2-3 章再现')].filter(i => i >= 0), contradicts: [], refines: [], applies: [], notApplies: [], resolved: [] };
    return { same: [], contradicts: [], refines: [], applies: [], notApplies: [], resolved: [] };
  } };
  assert.equal(lessonToConsolidate(app.store.state.projects.find(row => row.id === app.project.id)).id, 'd', 'newest first');
  assert.deepEqual(await app.mind.consolidateLesson(app.project.id, 'd'), { superseded: ['c'] });
  assert.deepEqual(await app.mind.consolidateLesson(app.project.id, 'b'), { folded: 'b', into: 'a' });
  const rows = Object.fromEntries(lessonsNow().map(row => [row.id, row]));
  assert.deepEqual([rows.a.status, rows.b.status, rows.c.status, rows.d.status], ['active', 'superseded', 'superseded', 'active']);
  assert.equal(rows.b.supersededBy, 'a'); assert.equal(rows.a.confirmations, 1); assert.equal(rows.a.evidence.length, 2); assert.equal(rows.c.supersededBy, 'd');
  assert.equal(lessonToConsolidate(app.store.state.projects.find(row => row.id === app.project.id)), null, 'each compared once (the oldest has nothing older)');
});
