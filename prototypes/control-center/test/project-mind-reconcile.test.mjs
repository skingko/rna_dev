import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { DecisionService } from '../decision-service.mjs';
import { createServer } from '../server.mjs';
import { readStateFile } from '../state-shards.mjs';
import { ProjectMindService, migrateMind, conversationPassages, reconcileCandidates, latestEvidenceAt, addAgenda, addLesson, mindSource } from '../project-mind.mjs';
import { createDecisionKernel } from '../../../packages/sdk/src/decision-kernel.mjs';
import { mindReconcileTemplate, lintDecisionTemplate, validateSpecTemplate } from '../../../packages/sdk/src/decision-templates.mjs';

// Reconciliation is judge-only: fake TypeSafe / fake LLM judge, never a paid call.
delete process.env.TYPESAFE_API_KEY;
// Items as the 0.26.1 migration seeded them in the research project (real texts).
const MIGRATED = {
  openQuestions: ['用户期望通过什么渠道获取实时 Ai 新闻（浏览器检索能力、公开 RSS、厂商官方源，还是人工提供链接）？当前无任何检索 MCP 工具。', '报告的时间基准与输出目录约定是什么（按 UTC 还是北京时间归档、目录名格式）？用户尚未指定。', '用户对来源可信度的最低门槛是什么（只收一手来源，还是允许知名二手媒体转载）？', '推送目标渠道是什么（邮件、Slack/飞书群、Telegram、内部 AgentX 类平台、或仅落盘为文件由用户自行查看）？'],
  milestones: [{ id: 'm3', title: '建立历史归档与增量去重机制', description: '确定按日期归档目录结构与去重/更新规则，使多日连续运行可复用且可回溯。', status: 'pending' }],
};
// Conversation excerpts from the same project (what already settled them).
const HISTORY = [
  ['user', '每天北京时间 9 点跑一次调研，报告放 reports/日期 目录，只收一手来源，二手媒体只能进监测区'],
  ['assistant', '今日报告已交付并通过字段校验。reports/2026-09-26/daily.md 人读日报，按北京时间归档；来源：一手 RSS/sitemap/论文 + 二手 Readhub 分层；可信度三级标签 primary-verified / primary-limited / secondary-unverified。'],
  ['delivered', '跨日去重索引（里程碑「历史归档与增量去重」核心机制）已建成、实跑并全分支实测：scripts/build_dedupe_index.py 聚合 dedupeKey，按日期归档可回溯。'],
];
// Fake judge: answers from the item text in state (A<n> → mind.items[n]).
const settings = { blocking: .2 };
const verdictFor = (text = '') => /历史归档/.test(text) ? { answered: .97 } : /时间基准/.test(text) ? { answered: .95 } : /来源可信度/.test(text) ? { answered: .92 } : /实时 Ai 新闻/.test(text) ? { superseded: .93 } : { answered: .1, superseded: .1, blocking: settings.blocking };
const answer = (id, state) => { const match = /^(answered|superseded|needs_user_input_now)_([0-9])$/.exec(id), item = state.mind.items[Number(match[2])], verdict = verdictFor(item.text); return match[1] === 'needs_user_input_now' ? verdict.blocking ?? .5 : verdict[match[1]] ?? .05; };
function fakeJev() {
  const requests = [];
  const fetch = async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: answer(id, body.state) }])), usage: { input_tokens: 900, output_tokens: 10 } })); };
  return { fetch, requests };
}
function setup(t, { judge = 'typesafe', blocking = .2, models = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-reconcile-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture', models: [{ id: 'fast', contextWindow: 32000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.mutate(state => { state.settings.realTokenBudget = null; state.configuration.decisionKernel = judge === 'llm' ? { fastModel: { providerId: provider.id, modelId: 'fast' } } : {}; });
  if (judge === 'typesafe') store.configurationService.writeSecret('judge:jev', { apiKey: 'TEST-ONLY' });
  const { project, session } = store.createProject({ name: 'Ai 应用调研项目', workspace: directory });
  const at = Date.parse('2026-09-26T01:00:00Z');
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id), s = state.sessions.find(row => row.id === session.id);
    Object.assign(p, { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' }, ...structuredClone(MIGRATED) }); s.simulated = false;
    HISTORY.forEach(([role, text], index) => s.items.push({ id: `h${index}`, kind: role === 'user' ? 'user' : 'assistant', ...(role === 'delivered' ? { source: 'initiative' } : { final: true }), text, createdAt: new Date(at + index * 60000).toISOString(), simulated: false })); });
  const jev = fakeJev(), llm = [];
  const llmJudge = async ({ state, questions }) => { llm.push(Object.keys(questions)); return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: answer(id, state) }])) }; };
  const now = { value: Date.parse('2026-09-29T02:00:00Z') };
  const decisions = new DecisionService(store, { now: () => now.value, kernelFactory: options => createDecisionKernel({ ...options, fetch: jev.fetch, ...(options.backend === 'llm' ? { judge: llmJudge } : {}) }) });
  settings.blocking = blocking; const interactions = new UserInteractionService(store), options = [];
  const model = async function* (request) { options.push(request.purpose); yield { type: 'text_delta', delta: JSON.stringify(request.purpose === 'mind-lesson' ? { write: true, kind: 'constraint', text: '推送方式：仅落盘为文件，每天 9 点前放好', scope: 'project' } : { options: [{ label: '仅落盘为文件' }, { label: '推送到飞书群', description: '需要配置机器人' }] }) }; yield { type: 'usage', usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0 } }; yield { type: 'done', stopReason: 'stop' }; };
  if (models) store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fast', reasoning: 'off' } });
  const mind = new ProjectMindService(store, { decisions, interactions, provider: models ? model : null, now: () => now.value, sweepIntervalMs: 0 });
  store.mutate(state => migrateMind(state.projects.find(row => row.id === project.id), { now: now.value }));
  t.after(async () => { await mind.close(); interactions.close(); rmSync(directory, { recursive: true, force: true }); });
  const agenda = () => store.state.projects.find(row => row.id === project.id).mind.agenda;
  return { store, mind, decisions, interactions, options, jev, llm, project, session, agenda, now, byText: pattern => agenda().find(row => pattern.test(row.text)) };
}

test('reconcile template: answered / superseded for agenda and commitments, needs_user_input_now for agenda and lessons, lint-clean, one request per four items', () => {
  const plan = mindReconcileTemplate({ items: [{ kind: 'awaiting_user' }, { kind: 'intention' }, { kind: 'commitment_user_request' }, { kind: 'lesson_preference' }, { kind: 'idea' }] });
  assert.deepEqual(Object.keys(plan.questions), ['answered_0', 'superseded_0', 'needs_user_input_now_0', 'answered_1', 'superseded_1', 'needs_user_input_now_1', 'answered_2', 'superseded_2', 'needs_user_input_now_3']);
  assert.match(plan.questions.needs_user_input_now_1.instructions, /keep pursuing, change, finish or drop/);
  assert.match(plan.questions.needs_user_input_now_3.instructions, /confirm or correct the learned lesson/);
  assert.deepEqual(lintDecisionTemplate(plan), []); assert.ok(validateSpecTemplate(plan));
});

test('dry-run previews, apply closes answered/superseded items with reasons and evidence, keeps open ones with a blocking verdict; idempotent', async t => {
  const app = setup(t);
  assert.equal(app.agenda().filter(row => row.status === 'open').length, 5);
  const preview = await app.mind.reconcile(app.project.id, { dryRun: true });
  assert.equal(preview.available, true); assert.equal(preview.backend, 'typesafe'); assert.equal(app.jev.requests.length, 2, 'five items → two requests');
  const action = pattern => preview.items.find(row => pattern.test(row.text)).action;
  assert.equal(action(/历史归档/), 'done'); assert.equal(action(/时间基准/), 'done'); assert.equal(action(/来源可信度/), 'done'); assert.equal(action(/实时 Ai 新闻/), 'dropped'); assert.equal(action(/推送目标渠道/), 'keep');
  assert.equal(preview.items.find(row => /推送目标渠道/.test(row.text)).blocking, false);
  assert.ok(app.agenda().every(row => row.status === 'open' && row.blocking === undefined), 'dry-run writes nothing');
  assert.ok(app.jev.requests.every(body => body.state.mind.items.every(item => item.passages.length >= 1)), 'passages ride in state');
  const applied = await app.mind.reconcile(app.project.id);
  assert.equal(applied.closed, 4); assert.equal(applied.kept, 1);
  const archive = app.byText(/历史归档/);
  assert.equal(archive.status, 'done'); assert.equal(archive.resolvedBy.kind, 'reconcile'); assert.equal(archive.resolvedBy.sessionId, app.session.id); assert.equal(archive.resolvedBy.itemId, 'h2');
  // The reason never quotes the conversation (review D2-2): the passage is in the evidence entry, linked to its message.
  assert.equal(archive.reason, '对话中已有答复或结果'); assert.ok(archive.evidence.at(-1).excerpt); assert.equal(archive.evidence.at(-1).itemId, 'h2');
  assert.equal(app.byText(/实时 Ai 新闻/).status, 'dropped'); assert.equal(app.byText(/实时 Ai 新闻/).reason, '已被后续工作取代');
  const open = app.byText(/推送目标渠道/);
  assert.equal(open.status, 'open'); assert.equal(open.blocking, false); assert.ok(open.reconcileCheckedAt);
  const mind = app.store.state.projects.find(row => row.id === app.project.id).mind;
  assert.ok(mind.health.reconciledAt); assert.deepEqual({ closed: mind.reconcile.closed, kept: mind.reconcile.kept, backend: mind.reconcile.backend }, { closed: 4, kept: 1, backend: 'typesafe' });
  // Idempotent: nothing new → no candidates, no requests. New evidence → only the open item is rechecked.
  const requests = app.jev.requests.length;
  assert.equal((await app.mind.reconcile(app.project.id)).judged, 0); assert.equal(app.jev.requests.length, requests);
  app.now.value += 60000; app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).items.push({ id: randomUUID(), kind: 'user', text: '推送就放在对话里，不用邮件', createdAt: new Date(app.now.value).toISOString(), simulated: false }); });
  const again = await app.mind.reconcile(app.project.id);
  assert.equal(again.judged, 1); assert.equal(app.jev.requests.length, requests + 1);
  // Sweep health refresh keeps reconciledAt.
  app.mind.sweep(); assert.ok(app.store.state.projects.find(row => row.id === app.project.id).mind.health.reconciledAt);
});

test('judge order: fast-model judge when no TypeSafe key (thresholds raised); no judge leaves every item untouched', async t => {
  const llm = setup(t, { judge: 'llm' });
  const result = await llm.mind.reconcile(llm.project.id);
  assert.equal(result.backend, 'llm'); assert.ok(llm.llm.length >= 1); assert.equal(llm.jev.requests.length, 0);
  assert.equal(llm.byText(/历史归档/).status, 'done', '0.97 clears the raised high stake');
  assert.equal(llm.byText(/来源可信度/).status, 'open', '0.92 does not clear high + 0.1 for the LLM judge');
  const none = setup(t, { judge: 'none' });
  const before = structuredClone(none.agenda());
  const skipped = await none.mind.reconcile(none.project.id);
  assert.deepEqual({ available: skipped.available, reason: skipped.reason }, { available: false, reason: 'no_judge' });
  assert.deepEqual(none.agenda(), before); assert.equal(none.jev.requests.length, 0);
  none.mind.sweep(); assert.equal(none.store.state.projects.find(row => row.id === none.project.id).mind.health.reconciledAt, undefined, 'no automatic run without a judge');
});

test('automatic run once after migration (sweep), and the HTTP route with dryRun', async t => {
  const app = setup(t);
  app.mind.sweep(); await app.mind.idle();
  assert.equal(app.byText(/历史归档/).status, 'done', 'sweep reconciled automatically');
  const requests = app.jev.requests.length; app.mind.sweep(); await app.mind.idle();
  assert.equal(app.jev.requests.length, requests, 'no repeat within the interval');
  const directory = mkdtempSync(join(tmpdir(), 'rna-reconcile-api-'));
  const server = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const { project } = server.store.createProject({ name: 'API', workspace: directory });
  const call = async body => { const response = await fetch(`http://127.0.0.1:${server.server.address().port}/api/v2/projects/${project.id}/mind/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const dry = await call({ dryRun: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.dryRun, true); assert.ok(Number.isSafeInteger(dry.body.revision));
  assert.equal((await call({ dryRun: 'yes' })).status, 400);
});

test('a still-blocking question becomes a real question card (drafted options + free text) in the latest conversation; answering closes it and records the decision', async t => {
  const app = setup(t, { blocking: .95, models: true });
  await app.mind.reconcile(app.project.id); await app.mind.idle();
  const row = app.byText(/推送目标渠道/);
  assert.equal(row.status, 'open'); assert.equal(row.blocking, true); assert.equal(row.interaction.sessionId, app.session.id);
  assert.deepEqual(app.options.filter(purpose => purpose === 'mind-options'), ['mind-options'], 'options drafted once by the small model');
  const card = app.store.state.sessions.find(entry => entry.id === app.session.id).items.find(item => item.interaction?.id === row.interaction.interactionId);
  assert.equal(card.interaction.source, 'initiative'); assert.equal(card.interaction.questions[0].allowCustom, true);
  assert.deepEqual(card.interaction.questions[0].options.map(option => option.label), ['仅落盘为文件', '推送到飞书群']);
  assert.equal(row.interaction.itemId, card.id);
  // No duplicate card on later sweeps.
  app.mind.sweep(); await app.mind.idle();
  assert.equal(app.store.state.sessions.find(entry => entry.id === app.session.id).items.filter(item => item.kind === 'question').length, 1);
  app.interactions.answer(app.session.id, card.interaction.id, { requestId: 'r1', answers: [{ id: 'answer', selected: ['o1'], custom: '每天 9 点前放好' }] });
  await new Promise(resolve => setImmediate(resolve)); await app.mind.idle();
  const closed = app.byText(/推送目标渠道/);
  assert.equal(closed.status, 'done'); assert.equal(closed.resolvedBy.kind, 'answer'); assert.equal(closed.answer, '仅落盘为文件；每天 9 点前放好'); assert.equal(closed.blocking, undefined);
  const lessons = app.store.state.projects.find(entry => entry.id === app.project.id).mind.lessons;
  assert.ok(lessons.some(lesson => lesson.status === 'active' && /仅落盘为文件/.test(lesson.text)), 'answer recorded as a decision');
  // Non-blocking questions never get a card.
  const quiet = setup(t, { blocking: .1, models: true });
  await quiet.mind.reconcile(quiet.project.id); await quiet.mind.idle();
  assert.equal(quiet.byText(/推送目标渠道/).blocking, false); assert.equal(quiet.byText(/推送目标渠道/).interaction, undefined);
});

test('HTTP answer endpoint (no card: recorded in the latest conversation) and drop with a reason', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-answer-api-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { project, session } = app.store.createProject({ name: 'Answer API', workspace: directory });
  app.store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.simulated = false; p.openQuestions = ['目标平台是桌面还是移动端？', '要不要排行榜？']; state.sessions.find(row => row.id === session.id).simulated = false; migrateMind(p); });
  const [first, second] = app.store.state.projects.find(row => row.id === project.id).mind.agenda;
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2/projects/${project.id}/mind/agenda`;
  const call = async (method, path, body) => { const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const answered = await call('POST', `/${first.id}/answer`, { text: '只做桌面浏览器' });
  assert.equal(answered.status, 200); assert.equal(answered.body.entry.status, 'done'); assert.equal(answered.body.entry.answer, '只做桌面浏览器'); assert.equal(answered.body.entry.resolvedBy.kind, 'answer');
  const message = app.store.state.sessions.find(row => row.id === session.id).items.find(item => item.id === answered.body.entry.resolvedBy.itemId);
  assert.equal(message.source, 'mind-answer'); assert.match(message.text, /只做桌面浏览器/);
  assert.equal((await call('POST', `/${first.id}/answer`, { text: 'again' })).status, 409);
  assert.equal((await call('POST', `/${second.id}/answer`, { text: '' })).status, 400);
  const dropped = await call('PATCH', `/${second.id}`, { status: 'dropped', reason: '不做排行榜' });
  assert.equal(dropped.body.entry.status, 'dropped'); assert.equal(dropped.body.entry.reason, '不做排行榜'); assert.equal(dropped.body.entry.resolvedBy.kind, 'user');
});

test('dry-run over a read-only copy of production state: every migrated open item is a candidate; nothing is written', async t => {
  const file = process.env.RNA_MIND_PRODUCTION_STATE ?? decodeURIComponent(new URL('../../../../../../prototypes/control-center/.state/state.json', import.meta.url).pathname);
  if (!existsSync(file)) return t.diagnostic('production state not present');
  const state = structuredClone(readStateFile(file).state), now = Date.now();
  for (const project of state.projects.filter(row => !row.archivedAt && row.simulated !== true)) {
    if (!project.mind) migrateMind(project, { now });
    const passages = conversationPassages(state, project.id), candidates = reconcileCandidates(project, latestEvidenceAt(state, project.id), { now, force: true });
    // Migration seeds agenda items, commitments and lessons; the open, pending and unconfirmed ones are all candidates.
    const { agenda, commitments = [], lessons = [] } = project.mind;
    const migrated = [...agenda.filter(row => row.status === 'open'), ...commitments.filter(row => row.status === 'pending'), ...lessons.filter(row => row.status === 'active' && !row.confirmedAt && !row.interaction)].filter(row => row.source?.kind === 'migration').length;
    assert.ok(candidates.filter(row => row.row.source?.kind === 'migration').length === Math.min(migrated, 16));
    if (migrated) assert.ok(passages.length > 0);
  }
});

test('plans and learned lessons the judge says need the user become question cards; answers finish, drop, confirm, revoke or rewrite them', async t => {
  const app = setup(t, { blocking: .95 });
  const at = Date.parse('2026-09-26T00:30:00Z');
  app.store.mutate(state => { const mind = state.projects.find(row => row.id === app.project.id).mind;
    addAgenda(mind, { kind: 'intention', text: '开篇100章：完成第一卷正文', source: mindSource('model') }, { now: at });
    addAgenda(mind, { kind: 'todo', text: '整理人物关系图', source: mindSource('model') }, { now: at });
    addLesson(mind, { kind: 'preference', text: '每章结尾都要留悬念钩子', source: mindSource('model') }, { now: at });
    addLesson(mind, { kind: 'pitfall', text: '人名不要用生僻字', source: mindSource('model') }, { now: at }); });
  await app.mind.reconcile(app.project.id, { force: true }); await app.mind.idle();
  const mind = () => app.store.state.projects.find(row => row.id === app.project.id).mind;
  const plan = () => mind().agenda.find(row => /开篇100章/.test(row.text)), todo = () => mind().agenda.find(row => /人物关系图/.test(row.text));
  const hook = () => mind().lessons.find(row => /悬念钩子/.test(row.text) || /每章结尾/.test(row.text)), names = () => mind().lessons.find(row => /生僻字/.test(row.text));
  for (const row of [plan(), todo()]) { assert.equal(row.blocking, true); assert.ok(row.interaction, 'plan asked in the conversation'); }
  for (const row of [hook(), names()]) { assert.equal(row.needsConfirmation, true); assert.ok(row.interaction, 'lesson asked in the conversation'); }
  const cards = app.store.state.sessions.find(row => row.id === app.session.id).items.filter(item => item.kind === 'question');
  const cardOf = row => cards.find(item => item.interaction.id === row.interaction.interactionId).interaction;
  assert.deepEqual(cardOf(plan()).questions[0].options.map(option => option.id), ['keep', 'done', 'drop']);
  assert.deepEqual(cardOf(hook()).questions[0].options.map(option => option.id), ['confirm', 'revoke']);
  assert.match(cardOf(hook()).questions[0].question, /偏好：「每章结尾都要留悬念钩子」/);
  const reply = (row, answer) => app.interactions.answer(app.session.id, row.interaction.interactionId, { requestId: randomUUID(), answers: [{ id: 'answer', ...answer }] });
  reply(plan(), { selected: ['keep'], custom: '先写到 30 章再评估' }); reply(todo(), { selected: ['drop'] });
  reply(hook(), { selected: [], custom: '每章结尾留钩子，但卷末可以收束' }); reply(names(), { selected: ['revoke'] });
  await new Promise(resolve => setImmediate(resolve)); app.mind.sweep(); await app.mind.idle();
  assert.equal(plan().status, 'open'); assert.equal(plan().answer, '先写到 30 章再评估'); assert.ok(plan().interaction.settledAt); assert.equal(plan().blocking, undefined);
  assert.equal(todo().status, 'dropped');
  assert.equal(hook().text, '每章结尾留钩子，但卷末可以收束'); assert.ok(hook().confirmedAt); assert.equal(hook().source.kind, 'user'); assert.equal(hook().needsConfirmation, undefined);
  assert.equal(names().status, 'retired'); assert.equal(names().retiredReason, 'user_revoked');
  // Settled items are not asked again, and confirmed lessons leave reconciliation.
  app.mind.sweep(); await app.mind.idle();
  assert.equal(app.store.state.sessions.find(row => row.id === app.session.id).items.filter(item => item.kind === 'question').length, cards.length);
  assert.ok(!reconcileCandidates(app.store.state.projects.find(row => row.id === app.project.id), Date.now(), { force: true }).some(entry => entry.row.id === hook().id));
});
