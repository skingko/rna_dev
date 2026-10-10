import test from 'node:test';
import { UsageLedger } from '../usage-cache-service.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { DecisionService } from '../decision-service.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';
import { readStateFile } from '../state-shards.mjs';
import { recordDelivery } from '../proactive-delivery.mjs';
import { EffortCapture } from '../internal-reasoning.mjs';
import { narratorReplayable, EffortReplay } from '../benchmark/internal-effort-replay.mjs';
import { narrate, applyNarration, welcomeBackDue, composeWelcomeBack, applyWelcomeBack, threadReactions, textHash } from '../proactive-narrator.mjs';
import { pacingSignals, pacingThreshold, pacingDecision, candidateValue, advanceWake, applyWorkOutcome, wakeTier, wakeFloor, cacheWakeAllowed, conversationTimeline, longestUnrepliedChain, WAKE_LADDER, ACTIVE_WINDOW_MS } from '../proactive-pacing.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const local = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
async function until(check, label = 'condition') { const deadline = Date.now() + 12000; while (Date.now() < deadline) { if (check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
const wait = async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'No other task', evidenceIds: [], nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done', stopReason: 'stop' }; };
const high = { new_information: .95, continues_open_thread_or_commitment: .9, relevant_now: .95, time_sensitive: .9, needs_user_decision: .9, already_reported: .02 };

// The user's daytime rhythm: 15 messages over three days between 10:00 and 18:00 local.
const daytimeMessages = () => Array.from({ length: 15 }, (_, index) => ({ id: `u${index}`, kind: 'user', text: `白天的消息 ${index}`, createdAt: new Date(local(24 + Math.floor(index / 5), 10 + (index % 5) * 2)).toISOString() }));

async function fixture(t, { now = () => Date.now(), decisionService, initiative = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-narrator-'));
  const store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Narrator fixture', description: 'A generic project', workspace: directory, initiative: { cooldownMs: 0, ...initiative } });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }; target.initiative.tokenBudget = 200000; state.settings.realTokenBudget = null; });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, feedbackCheckIntervalMs: 0, decisionProvider: wait, ...(decisionService ? { decisionService } : {}), now });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  await until(() => controller.contexts.size === 1, 'initiative context');
  const current = () => store.state.projects.find(row => row.id === project.id);
  const share = (id, content, extra = {}) => { const context = controller.contexts.get(project.id); return controller.share(context, { id, intentKey: id, revision: context.coordinator.state.revision, content, evidenceIds: [], reason: 'fixture finding', ...extra }, { signal: new AbortController().signal }); };
  return { directory, store, controller, project, session, current, share, context: () => controller.contexts.get(project.id), messages: () => store.state.sessions.find(row => row.id === session.id).items.filter(item => item.source === 'initiative'), mind: () => current().mind ?? {} };
}

/** A fake JEV judge (the only quality/value authority; no host text rules). */
const judge = ({ value = () => null, check = () => [] } = {}) => ({ calls: [], enabled: point => point === 'message.value' || point === 'message.check', review: async () => ({ review: true }),
  async messageValue(_project, input) { this.calls.push(['value', input]); return value(input.text, input); }, async messageCheck(_project, input) { this.calls.push(['check', input]); return check(input.text, input); } });

// ---------------------------------------------------------- no heuristics

test('the agent text is delivered exactly as written: no stripping, truncation, file reading or opener rules on the host', async () => {
  const now = Date.parse('2026-09-28T10:00:00Z'), project = { id: 'p', inbox: [], mind: {} }, session = { id: 's', items: [] };
  const text = ['补一条：夜间构建有 2 个测试失败。', '', '| 文件 | 失败 |', '|---|---|', '| src/parser.test.ts:42 | 空文件时抛错 |', '| src/lexer.test.ts:17 | 超时 |', '', `提交 9f86d081884c7d659a2feaa0c55ad015 之后出现；日志在 /Users/me/app/reports/build.log。${'细节。'.repeat(200)}`].join('\n');
  const plan = await narrate({ project, sessions: [session], candidate: { kind: 'share', text, evidenceIds: ['e1'] }, now });
  assert.equal(plan.outcome, 'send'); assert.equal(plan.text, text, 'byte-for-byte: the judge, not the host, decides whether paths or tables belong');
  assert.equal(plan.valueSource, 'pacing', 'no judge backend: pacing alone');
  assert.deepEqual(Object.keys(plan.probabilities), [], 'no host estimates stand in for the judge');
  const source = readFileSync(new URL('../proactive-narrator.mjs', import.meta.url), 'utf8') + readFileSync(new URL('../proactive-pacing.mjs', import.meta.url), 'utf8');
  for (const gone of ['stripOpener', 'sanitize', 'condense', 'MESSAGE_BUDGET', 'deliverableFile', 'readFile', 'statusReport', 'codeProbabilities', 'overlap(', 'coverage(', 'DELIVER:']) assert.ok(!source.includes(gone), `${gone} is gone`);
});

test('duplicates: an exact (normalized) repeat is dropped deterministically; a paraphrase only when the judge says already told', async t => {
  const now = Date.parse('2026-09-24T15:09:00Z'), project = { id: 'p', inbox: [], mind: {} }, session = { id: 's', items: [] };
  const first = await narrate({ project, sessions: [session], candidate: { kind: 'share', text: '写入权限还没生效：解锁写入那条消息失败了，所以仍只能只读。', evidenceIds: ['message:1'] }, now });
  session.items.push({ id: 'i1', kind: 'assistant', source: 'initiative', text: first.text, createdAt: new Date(now).toISOString(), initiative: { kind: 'insight' } });
  applyNarration(project, first, { itemId: 'i1', sessionId: 's', now });
  assert.equal(project.mind.findings[0].textHash, textHash(first.text));
  const exact = await narrate({ project, sessions: [session], candidate: { kind: 'share', text: '写入权限还没生效 解锁写入那条消息失败了 所以仍只能只读！', evidenceIds: ['message:2'] }, now: now + 60000 });
  assert.deepEqual([exact.outcome, exact.reasons], ['drop', ['exact_duplicate']]);
  const paraphrase = '我确认了卡住的原因：你让我直接开始开发的那条消息没有执行成功，系统里我依然只能读取文件。';
  const unjudged = await narrate({ project, sessions: [session], candidate: { kind: 'share', text: paraphrase, evidenceIds: ['message:3'] }, now: now + 16 * 60000 });
  assert.notEqual(unjudged.reasons[0], 'already_reported', 'without a judge nothing is guessed from wording');
  const told = judge({ value: (_text, input) => ({ probabilities: { new_information: .05, already_reported: .93 }, alreadyReported: true, threadIndex: input.threads.length ? 0 : undefined, ledgerId: 'v1' }) });
  const judged = await narrate({ project, sessions: [session], decisions: told, candidate: { kind: 'share', text: paraphrase, evidenceIds: ['message:3'] }, now: now + 16 * 60000, projectKind: { title: 'Game', taskTypes: ['coding'] } });
  assert.deepEqual([judged.outcome, judged.reasons, judged.valueSource], ['drop', ['already_reported'], 'jev'], 'already told → dropped, not filed');
  const [, input] = told.calls[0];
  assert.equal(input.findings[0].summary, first.text); assert.equal(input.threads[0].messages[0], first.text); assert.deepEqual(input.project.taskTypes, ['coding']);
});

test('threads: structural attachment (schedule, resolves, evidence) or the judge continues_thread choice; never text matching', async t => {
  const now = Date.parse('2026-09-28T10:00:00Z'), project = { id: 'p', inbox: [], mind: { commitments: [{ id: 'c1', request: '修第二关', status: 'pending' }] } }, session = { id: 's', items: [] };
  const deliver = async (candidate, decisions) => { const plan = await narrate({ project, sessions: [session], candidate, decisions, now }); const id = `i${session.items.length}`; session.items.push({ id, kind: 'assistant', source: 'initiative', text: plan.text, createdAt: new Date(now).toISOString() }); applyNarration(project, plan, { itemId: id, sessionId: 's', now }); return plan; };
  const a = await deliver({ kind: 'share', text: '第二关修好了。', evidenceIds: ['e1'], resolves: ['c1'] });
  assert.deepEqual([a.via, a.thread.kind, a.thread.ref.commitmentId], ['resolves', 'commitment', 'c1']);
  const b = await deliver({ kind: 'share', text: '回归用例也补了。', evidenceIds: ['e1', 'e2'] });
  assert.deepEqual([b.via, b.thread.id], ['evidence', a.thread.id]);
  const c = await deliver({ kind: 'share', text: '第二关修好了，另外加了回归。', evidenceIds: ['e9'] });
  assert.equal(c.via, 'new_topic', 'similar wording alone never joins a thread');
  const picker = judge({ value: (_text, input) => ({ probabilities: {}, threadIndex: input.threads.findIndex(row => row.title === a.thread.title) }) });
  const d = await deliver({ kind: 'share', text: '跨关切换的平台也检查过了。', evidenceIds: ['e10'] }, picker);
  assert.deepEqual([d.via, d.thread.id], ['judge', a.thread.id]);
  assert.ok(picker.calls[0][1].threads.length >= 2);
});

test('a muted thread never delivers, and its held items are not summarized', async t => {
  const f = await fixture(t, { decisionService: judge({ value: (_text, input) => ({ probabilities: {}, threadIndex: input.threads.length ? 0 : undefined }) }) });
  assert.equal((await f.share('m1', '依赖升级后构建时间从两分钟涨到了六分钟，主要花在类型检查上。')).reach, 'inline');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.threads[0].status = 'muted'; });
  const muted = await f.share('m2', '类型检查缓存没有命中，关掉增量后更慢。');
  assert.deepEqual([muted.superseded, muted.reason], [true, 'thread_muted']);
  assert.equal(f.messages().length, 1);
  f.store.mutate(state => { const thread = state.projects.find(row => row.id === f.project.id).mind.threads[0]; thread.held = [{ id: 'h', text: 'held while muted', value: .9, reasons: ['away'], createdAt: new Date().toISOString(), finding: { summary: 'x', evidenceIds: [] } }]; });
  assert.deepEqual(welcomeBackDue(f.current(), { present: true, night: false, typing: false }), []);
});

test('a message held for a resolved thread the judge continues reopens it, so the welcome-back carries it (system review F5(b))', async () => {
  const now = local(28, 15), at = ms => new Date(now - ms).toISOString(), text = '第二关的回归用例也补上了。';
  const thread = { id: 't1', title: '第二关', kind: 'topic', status: 'resolved', resolvedAt: at(HOUR), resolvedBy: 'user_reply', messageItemIds: ['i0'], messageSessions: {}, lastMessageAt: at(2 * HOUR), lastSummary: null, held: [], reactions: {}, createdAt: at(3 * HOUR), updatedAt: at(HOUR) };
  const project = { id: 'p', inbox: [], mind: { threads: [thread] } }, session = { id: 's', items: [{ id: 'u0', kind: 'user', text: '先修第二关。', createdAt: at(5 * HOUR) }, { id: 'i0', kind: 'assistant', source: 'initiative', text: '第二关修好了。', createdAt: at(2 * HOUR) }] };
  const picker = judge({ value: () => ({ probabilities: { new_information: .9, continues_open_thread_or_commitment: .8, relevant_now: .9, time_sensitive: .1 }, threadIndex: 0 }) });
  const plan = await narrate({ project, sessions: [session], candidate: { kind: 'share', text, evidenceIds: ['e2'], actionId: 'a1' }, decisions: picker, now });
  assert.deepEqual([plan.outcome, plan.via, plan.thread.id], ['hold', 'judge', 't1'], 'the user is away: held, on the thread the judge continues');
  applyNarration(project, plan, { now });
  assert.deepEqual([thread.status, thread.resolvedAt, thread.held.map(row => row.text)], ['open', undefined, [text]], 'reopened, the held message in it');
  assert.deepEqual(welcomeBackDue(project, { present: true, night: false, typing: false }).map(row => [row.threadId, row.text]), [['t1', text]], 'delivered when the user is back, never lost');
});

test('night: non-urgent findings wait in their thread and arrive once as a structured welcome-back message; the urgent ones the judge flags go out', async t => {
  let clock = local(28, 3);
  const f = await fixture(t, { now: () => clock, decisionService: judge({ value: text => ({ probabilities: { time_sensitive: /502/.test(text) ? .95 : .1, new_information: .9 } }) }) });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push(...daytimeMessages()); });
  const held = await f.share('n1', '难度曲线已落地：第 4 关起平台逐步收窄，第 28 关收敛到最小尺寸。');
  assert.match(held.summary, /^Held in its conversation thread \(night\)/); assert.equal(held.reach, 'inbox');
  assert.equal((await f.share('n2', '帧时间实测完成：真实显卡下平均 8 毫秒，最差 12 毫秒。')).reach, 'inbox');
  assert.equal(f.messages().length, 0, 'nothing interrupts the night');
  const urgent = await f.share('n3', '发布后首页返回 502，需要你今天内决定是否回滚。');
  assert.equal(urgent.reach, 'inline', 'the judge said time-sensitive'); assert.equal(f.messages().length, 1);
  clock = local(28, 9, 30);
  f.store.presences.set(f.project.id, { receiptId: 'r', sessionId: f.session.id, typing: false, visible: true, at: new Date(clock).toISOString(), expiresAt: new Date(clock + 10000).toISOString() });
  f.controller.deliveryUpkeep(f.context()); f.controller.deliveryUpkeep(f.context());
  const welcome = f.messages().filter(item => item.initiative.kind === 'welcome_back');
  assert.equal(welcome.length, 1);
  const { topics, overflowCount, threadIds } = welcome[0].initiative;
  assert.equal(overflowCount, 0); assert.deepEqual(topics.map(topic => topic.threadId), threadIds);
  assert.deepEqual(topics.map(topic => topic.text).sort(), ['帧时间实测完成：真实显卡下平均 8 毫秒，最差 12 毫秒。', '难度曲线已落地：第 4 关起平台逐步收窄，第 28 关收敛到最小尺寸。'].sort(), 'each topic carries the held message as written');
  assert.ok(topics.every(topic => welcome[0].text.includes(topic.text)), 'text mirrors topics for older clients');
  assert.ok(f.mind().threads.every(row => !row.held.length)); assert.equal(f.mind().findings.length, 3);
  const entry = f.current().inbox.find(row => row.itemId === welcome[0].id);
  assert.deepEqual(entry.threadIds, threadIds); assert.deepEqual([entry.pacing.outcome, entry.pacing.reasons], ['send', ['welcome_back']]);
});

test('the unreplied chain raises the bar and resets as soon as the user replies', () => {
  const now = Date.parse('2026-09-28T10:00:00Z'), project = { id: 'p', inbox: [], mind: {} };
  const items = [{ id: 'u', kind: 'user', text: '开始吧', createdAt: new Date(now - 12 * HOUR).toISOString() }];
  const presence = { visible: true };
  const bar = () => pacingThreshold(pacingSignals(project, [{ id: 's', items }], { now, presence })).threshold;
  const thresholds = [bar()];
  for (let index = 0; index < 4; index++) { items.push({ id: `p${index}`, kind: 'assistant', source: 'initiative', text: `finding ${index}`, createdAt: new Date(now - (10 - 2 * index) * HOUR).toISOString(), initiative: { kind: 'insight' } }); thresholds.push(bar()); }
  assert.deepEqual(thresholds.map(value => Math.round(value * 100)), [45, 45, 52, 59, 66], 'one unanswered message is normal; then each adds to the bar');
  const signals = pacingSignals(project, [{ id: 's', items }], { now, presence });
  assert.equal(signals.unrepliedChain, 4);
  // An ordinary finding now waits (inbox), a clearly valuable one still goes out.
  const ordinary = candidateValue({ new_information: .8, continues_open_thread_or_commitment: .3, relevant_now: .55, time_sensitive: .25, needs_user_decision: .15, already_reported: 0 });
  assert.equal(pacingDecision({ value: ordinary, threshold: thresholds.at(-1), signals }).outcome, 'inbox');
  assert.equal(pacingDecision({ value: candidateValue(high), threshold: thresholds.at(-1), signals }).outcome, 'send');
  items.push({ id: 'reply', kind: 'user', text: '好的，继续', createdAt: new Date(now - 10 * 60000).toISOString() });
  assert.equal(pacingSignals(project, [{ id: 's', items }], { now }).unrepliedChain, 0);
  assert.ok(bar() <= .45 && bar() < thresholds.at(-1), 'the reply resets the chain penalty');
  // Reading time: a message sent minutes ago and not yet answered raises the bar for the next one.
  const quiet = [{ id: 'u', kind: 'user', text: '开始吧', createdAt: new Date(now - 3 * HOUR).toISOString() }, { id: 'p9', kind: 'assistant', source: 'initiative', text: 'x', createdAt: new Date(now - 5 * 60000).toISOString(), initiative: { kind: 'insight' } }];
  assert.ok(pacingThreshold(pacingSignals(project, [{ id: 's', items: quiet }], { now })).factors.some(row => row.name === 'reading_time' && row.delta === .1));
});

test('anti-ratchet: quiet wakes plus unshared valuable findings lower the bar until one goes out', () => {
  const now = Date.parse('2026-09-28T10:00:00Z'), items = [{ id: 'u', kind: 'user', text: 'hi', createdAt: new Date(now - 3 * HOUR).toISOString() }];
  const project = { id: 'p', inbox: [], mind: { threads: [], pacing: { wake: { quietWakes: 0 } } } };
  const value = .42, base = pacingThreshold(pacingSignals(project, [{ id: 's', items }], { now })).threshold;
  assert.equal(pacingDecision({ value, threshold: base, signals: { night: false, away: false } }).outcome, 'inbox');
  project.mind.pacing.wake.quietWakes = 12;
  project.mind.threads.push({ id: 't1', status: 'open', title: 'a', held: [{ id: 'h1', value: .5, reasons: ['below_threshold_band'], text: 'x' }, { id: 'h2', value: .45, reasons: ['below_threshold_band'], text: 'y' }] });
  const released = pacingThreshold(pacingSignals(project, [{ id: 's', items }], { now }));
  assert.ok(released.factors.some(row => row.name === 'anti_ratchet' && row.delta < 0));
  assert.ok(released.threshold <= value, `${released.threshold} should release a ${value} finding`);
  assert.equal(pacingDecision({ value, threshold: released.threshold, signals: { night: false, away: false } }).outcome, 'send');
  // Items held only because the user was away do not count: they wait for the welcome-back summary.
  project.mind.threads[0].held = [{ id: 'h3', value: .9, reasons: ['away'], text: 'z' }]; project.mind.pacing.wake.quietWakes = 0;
  assert.equal(pacingThreshold(pacingSignals(project, [{ id: 's', items }], { now })).threshold, base);
});

test('no fixed caps: a burst of high-value findings is delivered in full, however many there are', async t => {
  const f = await fixture(t, { decisionService: { enabled: point => point === 'message.value', review: async () => ({ review: true }), messageValue: async () => ({ probabilities: high, alreadyReported: false }) } });
  const topics = ['登录接口', '支付回调', '图片上传', '搜索索引', '邮件队列', '缓存集群', '日志采集', '定时备份', '权限校验', '导出报表'];
  for (const [index, topic] of topics.entries()) {
    const result = await f.share(`b${index}`, `${topic}${['在新版本上全部失败', '回调签名校验不通过', '上传后文件大小为零', '索引重建卡在一半', '队列积压超过十万', '节点内存持续告警', '采集进程反复重启', '昨晚的备份没有生成', '管理员也被拒绝访问', '导出的金额全是零'][index]}，需要你决定是否回滚？`);
    assert.equal(result.reach, 'inline', `burst item ${index} was held back: ${JSON.stringify(result)}`);
  }
  assert.equal(f.messages().length, topics.length);
  assert.ok(f.mind().pacing.unrepliedChain >= 9 && f.mind().pacing.threshold > .45, 'the chain raised the bar, yet high value still clears it');
  const source = ['proactive-narrator.mjs', 'proactive-pacing.mjs'].map(file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(source, /max(?:Messages|Shares|PerDay)|per[_ ]?day[_ ]?(?:cap|limit)|dailyCap|DAILY_LIMIT/i);
});

test('wake cadence: only a visible outcome resets, empty wakes back off on the full ladder, failures step down; event_only is a floor with open work', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  let wake = advanceWake({}, 'thought', { now }); assert.deepEqual([wake.level, wake.ticksAtLevel], [0, 1]);
  wake = advanceWake(wake, 'thought', { now }); assert.equal(wake.level, 1);
  wake = advanceWake(wake, 'failed', { now }); assert.equal(wake.level, 2, 'a failure descends at once');
  for (let index = 0; index < 12; index++) wake = advanceWake(wake, 'thought', { now });
  // B3: no THOUGHT_CAP. A paid wait rests on the full ladder like a cheap JEV deferral (before, paid waits rested at 4 h
  // while deferrals descended to 8 h: the paid ones were the more frequent).
  assert.equal(wake.level, WAKE_LADDER.length - 1); assert.equal(Date.parse(wake.nextAt) - now, WAKE_LADDER.at(-1), 'paid waits rest at the bottom of the ladder');
  assert.equal(Date.parse(advanceWake(wake, 'deferred', { now }).nextAt) - now, WAKE_LADDER.at(-1), 'as deferrals do');
  assert.equal(wake.quietWakes, 14, 'every paid wait is a quiet wake');
  // quietWakes counts paid main-model waits only (Headlong counts spontaneous model wakes): a JEV deferral dwells and descends, quietly.
  const deferred = advanceWake(advanceWake({ quietWakes: 3 }, 'deferred', { now }), 'deferred', { now });
  assert.deepEqual([deferred.level, deferred.ticksAtLevel, deferred.quietWakes], [1, 0, 3]);
  // C2, option C (Headlong monolith/step:357-373, 582-586): admitting a decision resets nothing. The row says `pending` and
  // names the action; the ladder moves when the action's outcome does.
  const rested = wake;
  wake = advanceWake(rested, 'work', { now, tokens: 1200, latencyMs: 900, actionId: 'a1' });
  assert.deepEqual([wake.level, wake.ticksAtLevel, wake.quietWakes, wake.lastOutcome, Date.parse(wake.nextAt) - now], [rested.level, rested.ticksAtLevel, rested.quietWakes, 'work', WAKE_LADDER.at(-1)], 'admitting work leaves the ladder where it was');
  assert.deepEqual(wake.history.at(-1), { at: new Date(now).toISOString(), outcome: 'work', floor: false, pending: true, tokens: 1200, latencyMs: 900, actionId: 'a1' });
  // A visible outcome resets it (and says when the last one was); nothing visible, or an undo, is a thought; a failure descends at once.
  const visible = applyWorkOutcome(wake, { to: 'visible', at: now - 60000, actionId: 'a1' }, { now });
  assert.deepEqual([visible.level, visible.ticksAtLevel, visible.quietWakes, Date.parse(visible.nextAt) - now, visible.lastVisibleAt, visible.lastVisibleActionId], [0, 0, 0, WAKE_LADDER[0], new Date(now - 60000).toISOString(), 'a1']);
  const mid = { level: 2, ticksAtLevel: 0, quietWakes: 3 };
  let step = applyWorkOutcome(mid, { to: 'none', at: now }, { now });
  assert.deepEqual([step.level, step.ticksAtLevel, step.quietWakes], [2, 1, 4], 'nothing visible: a paid thought dwells');
  step = applyWorkOutcome(step, { to: 'undone', at: now }, { now });
  assert.deepEqual([step.level, step.ticksAtLevel, step.quietWakes, Date.parse(step.nextAt) - now], [3, 0, 5, WAKE_LADDER[3]], 'an undo counts the same, and a second thought descends');
  assert.deepEqual([applyWorkOutcome(mid, { to: 'failed', at: now }, { now }).level, applyWorkOutcome(mid, { to: 'failed', at: now }, { now }).ticksAtLevel], [3, 0], 'a failure descends at once');
  assert.equal(applyWorkOutcome(mid, { to: 'pending', at: now }, { now }), mid, 'pending moves nothing');
  assert.equal(applyWorkOutcome(mid, { to: 'none', at: now, neutral: true }, { now }), mid, 'a cancellation the user or a restart caused is not an empty wake (review): the ladder and the quiet count stay');
  // The wake mix: the tier is computed from facts, never judged; every other wake is the think tier.
  assert.deepEqual(wakeTier({}), { tier: 'think', facts: [] });
  assert.deepEqual(wakeTier({ conversationOutcome: true, overdueCommitment: true, openCommitment: true }), { tier: 'request', facts: ['conversation_outcome', 'open_commitment', 'overdue_commitment'] });
  assert.deepEqual(wakeTier({ proactiveReply: true }), { tier: 'request', facts: ['proactive_reply'] });
  assert.deepEqual(wakeTier({ failureReview: true, answeredCard: true }).facts, ['failure_review', 'answered_card']);
  assert.equal(advanceWake({}, 'thought', { now, tier: wakeTier({ openCommitment: true }) }).history.at(-1).tier, 'request');
  assert.deepEqual(advanceWake({}, 'thought', { now, tier: wakeTier({}) }).history.at(-1), { at: new Date(now).toISOString(), outcome: 'thought', floor: false, tier: 'think' }, 'a row records the tier only; nothing reads it');
  const rhythm = { initiative: { eligible: false, reason: 'awaiting_evidence' } };
  assert.equal(wakeFloor({ mind: {} }, rhythm, { now }).eligible, false, 'nothing open: event_only stays a full stop');
  const open = { mind: { agenda: [{ id: 'a', kind: 'todo', text: 'tune level 3', status: 'open' }], pacing: { wake: { lastAt: new Date(now - HOUR).toISOString(), level: 1 } } } };
  assert.equal(wakeFloor(open, rhythm, { now }).eligible, true);
  open.mind.pacing.wake = advanceWake(open.mind.pacing.wake, 'thought', { now });
  assert.equal(wakeFloor(open, rhythm, { now }).eligible, false); assert.equal(wakeFloor(open, rhythm, { now: now + 4 * HOUR }).eligible, true);
  assert.equal(wakeFloor(open, { initiative: { eligible: false, reason: 'project_complete' } }, { now: now + DAY }).eligible, false);
  // J2 cache-aligned early wake is a pacing input: active phase yes, night or deep backoff no.
  assert.equal(cacheWakeAllowed(open, { initiative: { eligible: false, reason: 'review_interval' } }, { now }), true);
  assert.equal(cacheWakeAllowed({ mind: { ...open.mind, pacing: { ...open.mind.pacing, night: true } } }, { initiative: { eligible: true } }, { now }), false);
  assert.equal(cacheWakeAllowed({ mind: { pacing: { wake: { level: 4 } } } }, { initiative: { eligible: true } }, { now }), false);
  // C2: "recent real work" is the latest VISIBLE outcome, not a decision the host merely admitted (the old lastOutcome 'work').
  const quiet = { mind: { pacing: { wake: { level: 0, lastOutcome: 'work' } } } }, shown = lastVisibleAt => ({ mind: { pacing: { wake: { level: 0, lastOutcome: 'thought', lastVisibleAt } } } }), early = { initiative: { eligible: false, reason: 'review_interval' } };
  assert.equal(cacheWakeAllowed(quiet, early, { now }), false, 'an admitted work decision alone is not an active phase');
  assert.equal(cacheWakeAllowed(shown(new Date(now - ACTIVE_WINDOW_MS / 2).toISOString()), early, { now }), true, 'a visible outcome in the active window is');
  assert.equal(cacheWakeAllowed(shown(new Date(now - ACTIVE_WINDOW_MS - 60000).toISOString()), early, { now }), false, 'one long ago is not');
});

const WORKER = '夜间构建：2 个测试失败，都在解析器。\n- src/parser.test.ts:42 空文件时抛出 TypeError\n- src/lexer.test.ts:17 大文件超时\n最可能的原因是昨天合并的流式读取改动。\n交接：夜间构建检查完成，失败在 parser/lexer，下一步修空文件分支';
async function scheduleFixture(t, { taskTypes = ['coding'], title = '夜间构建健康', task = '每天 08:00 跑全部测试并告诉我哪些失败、在哪、可能原因。', worker = WORKER, check = () => [], revise = null, present = [{ path: 'reports/build.log', description: '完整测试日志' }], ledger = false, effort = false, applyEffort = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-narrator-schedule-')), store = new Store(join(dir, 'state.json'));
  if (ledger) store.usageLedger = new UsageLedger({});
  // `effort`: a GLM-like model (levels, default unknown) with the opt-in capture on; the judge records a lighter choice.
  const provider = store.configurationService.provider(null, { name: 'Isolated schedule fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: effort ? ['low', 'high', 'max'] : ['off'], ...(effort ? { compat: { thinkingFormat: 'zai' } } : {}) }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: effort ? 'max' : 'off' }, memory: { autoRecall: false, autoStore: false }, ...(effort ? { internalReasoning: { capture: true } } : {}) });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: title, description: title, workspace: dir });
  const origin = Date.parse('2026-09-26T00:00:00Z'), now = origin + HOUR;
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id); Object.assign(target, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', taskTypes, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } }); target.initiative.cooldownMs = 0; target.initiative.tokenBudget = null;
    target.schedules = [createProjectSchedule({ id: 'nightly', title, task, destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: origin })];
    target.mind = { lessons: [{ id: 'l1', kind: 'preference', status: 'active', text: '失败只列文件和行号，不要贴整段日志' }], agenda: [], commitments: [], threads: [], findings: [] };
    state.settings.realTokenBudget = null;
  });
  mkdirSync(join(dir, 'reports'), { recursive: true }); writeFileSync(join(dir, 'reports', 'build.log'), 'FAIL src/parser.test.ts:42');
  const judged = judge({ check }), revisions = [];
  // `applyEffort`: the verdict is applied (it routes the call), so its outcome is labelled; `judged.effortLabels` keeps the labels.
  judged.effortLabels = [];
  if (effort) Object.assign(judged, { effortMayApply: () => applyEffort, labelEffort: (...args) => { judged.effortLabels.push(args); return true; }, internalEffort: async (_project, { purpose, plan }) => ({ effort: plan.allowed[0], depth: 'light', source: 'jev', ledgerId: `l-${purpose}`, applied: applyEffort }) });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => now, workMaxSteps: 3, decisionProvider: wait, decisionService: judged,
    narratorProvider: revise ? async function* (request) { revisions.push(request); yield { type: 'text_delta', delta: revise }; yield { type: 'usage', usage: { totalTokens: 7 } }; yield { type: 'done', stopReason: 'stop' }; } : null,
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      if (present && !request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'present-1', name: 'project_present', arguments: { files: [...present, { path: '../outside.txt', description: 'x' }] } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      yield { type: 'text_delta', delta: worker }; yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
    } }) });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const delivered = () => store.state.sessions.flatMap(row => row.items.filter(item => item.scheduleOccurrenceKey));
  await until(() => delivered().length === 1, 'scheduled delivery');
  // `now`: the fixture's clock. Captured rows carry it, so they are read on it too, not on the wall clock (rows dated
  // 2026-09-26 fell out of the 14-day capture retention once the real date passed 2026-10-10).
  return { store, project, delivered, judged, revisions, now: () => now, job: () => store.state.projects.find(row => row.id === project.id).jobs[0] };
}

test('scheduled delivery (coding): the worker final response is the message, file references the user needs are kept, files come from project_present', async t => {
  const app = await scheduleFixture(t);
  const [message] = app.delivered();
  assert.equal(message.text, WORKER.split('\n交接：')[0], 'only the host-protocol handoff line is removed');
  assert.match(message.text, /src\/parser\.test\.ts:42/);
  assert.deepEqual(message.initiative.deliverables, [{ path: 'reports/build.log', name: 'build.log', description: '完整测试日志' }], 'a path outside the workspace is rejected');
  const [, check] = app.judged.calls.find(row => row[0] === 'check');
  assert.deepEqual(check.kind.taskTypes.includes('coding'), true); assert.match(check.kind.deliverable, /哪些失败/);
  assert.match(app.job().instruction, /delivered to the user as written/); assert.match(app.job().instruction, /project_present/);
  assert.equal(message.initiative.narrated.revision, undefined);
});

test('scheduled delivery: a judge-flagged message gets exactly one self-revision by the agent, with the flags, the deliverable and the user lessons', async t => {
  const revised = '2 个测试失败：src/parser.test.ts:42（空文件抛错）和 src/lexer.test.ts:17（大文件超时），可能由昨天的流式读取改动引起。';
  const app = await scheduleFixture(t, { check: text => text === revised ? [] : ['describes_instead_of_delivering'], revise: revised, ledger: true });
  const [message] = app.delivered();
  assert.equal(message.text, revised);
  assert.deepEqual(app.store.usageLedger.rows.filter(row => row.purpose === 'narrator').map(row => row.input), [0], 'metered as its own purpose (it used to count as a decision)');
  // The revision is checked again (its live pass rate) and records the effort it ran at (this fixture model has no levels).
  assert.deepEqual(message.initiative.narrated.revision, { codes: ['describes_instead_of_delivering'], revised: true, recheck: [], reasoning: { effective: 'off', source: 'chat-off' } });
  assert.equal(app.revisions.length, 1); assert.ok(app.revisions[0].estimatedInputTokens > 0);
  const prompt = JSON.stringify(app.revisions[0].messages);
  assert.match(prompt, /describes_instead_of_delivering/); assert.match(prompt, /哪些失败/); assert.match(prompt, /不要贴整段日志/);
});

test('scheduled delivery: with the capture on, a rewrite is kept with what it was given and what came of it (the Stage B replay reads it)', async t => {
  const revised = '2 个测试失败：src/parser.test.ts:42（空文件抛错）和 src/lexer.test.ts:17（大文件超时）。';
  const app = await scheduleFixture(t, { check: text => text === revised ? [] : ['describes_instead_of_delivering'], revise: revised, effort: true });
  const capture = new EffortCapture({ stateFile: app.store.file, now: app.now });
  await until(() => capture.calls('narrator').some(row => row.outcome && row.verdict), 'captured rewrite');
  const [row] = capture.calls('narrator');
  assert.equal(app.revisions[0].model.reasoning, 'max', 'shadow: today\'s effort is sent');
  assert.equal(row.request.text, WORKER.split('\n交接：')[0]); assert.deepEqual(row.request.violations.map(item => item.code), ['describes_instead_of_delivering']);
  assert.match(row.request.deliverable, /哪些失败/); assert.match(row.request.lessons[0].text, /不要贴整段日志/);
  assert.equal(row.verdict.effort, 'low'); assert.equal(row.sent, 'max'); assert.equal(row.call.rule, 'deep'); assert.ok(Number.isSafeInteger(row.outputCap) && row.outputCap > 0);
  assert.deepEqual({ status: row.outcome.status, recheck: row.outcome.recheck, result: row.outcome.result, stopReason: row.outcome.stopReason, tokens: row.outcome.tokens }, { status: 'revised', recheck: [], result: 'revised', stopReason: 'stop', tokens: 7 });
  assert.ok(narratorReplayable(row));
});

test('scheduled delivery: a routed rewrite\'s effort label read from the message recheck is the system\'s own judgment (source self), not an outcome', async t => {
  const revised = '2 个测试失败：src/parser.test.ts:42（空文件抛错）和 src/lexer.test.ts:17（大文件超时）。';
  const app = await scheduleFixture(t, { check: text => text === revised ? [] : ['describes_instead_of_delivering'], revise: revised, effort: true, applyEffort: true });
  const [message] = app.delivered();
  assert.equal(message.text, revised); assert.deepEqual(message.initiative.narrated.revision.recheck, []);
  assert.equal(app.revisions[0].model.reasoning, 'low', 'the verdict routed the rewrite');
  assert.deepEqual(app.judged.effortLabels.filter(([id]) => id === 'l-narrator'), [['l-narrator', 'adequate', { source: 'self' }]]);
});

test('scheduled delivery: a revision the recheck could not judge is recorded as unchecked, never as a pass (review EFF-7)', async t => {
  const revised = '2 个测试失败：src/parser.test.ts:42（空文件抛错）和 src/lexer.test.ts:17（大文件超时）。';
  // No verdict on the revision (judge in shadow, no answer, budget elapsed): the check answers null to a caller that asks.
  const app = await scheduleFixture(t, { check: (text, input) => text === revised ? input.verdict ? null : [] : ['describes_instead_of_delivering'], revise: revised, effort: true });
  const [message] = app.delivered();
  assert.equal(message.text, revised);
  assert.equal(message.initiative.narrated.revision.recheck, null, 'unchecked, not clean');
  const capture = new EffortCapture({ stateFile: app.store.file, now: app.now });
  await until(() => capture.calls('narrator').some(row => row.outcome && row.verdict), 'captured rewrite');
  const [row] = capture.calls('narrator');
  assert.equal(row.outcome.recheck, null);
  assert.equal(new EffortReplay(app.store, { now: app.now }).narratorRecord(row).recorded.passed, null, 'the replay baseline reads it as unchecked');
});

test('scheduled delivery (design): a creative project deliverable is the presented file with the agent own words', async t => {
  const worker = '海报第二稿完成：主色换成墨绿，标题改为竖排，按你说的去掉了渐变。\n交接：第二稿完成，下一步等反馈';
  const app = await scheduleFixture(t, { taskTypes: ['design', 'creative'], title: '每周海报迭代', task: '每周一给我一版新的海报设计稿。', worker, present: [{ path: 'reports/build.log', description: '第二稿导出文件' }] });
  const [message] = app.delivered();
  assert.equal(message.text, '海报第二稿完成：主色换成墨绿，标题改为竖排，按你说的去掉了渐变。');
  assert.equal(message.initiative.deliverables[0].description, '第二稿导出文件');
  const [, check] = app.judged.calls.find(row => row[0] === 'check');
  assert.deepEqual(check.kind.taskTypes.slice(0, 2), ['design', 'creative']);
});

// F1: a long report (9K characters, live ones ran 7–8K) reached the user with its middle cut out and a model-facing marker.
const longReport = (size, middle = '中段要点：第三个数据源的结论与前两个相反，需要你决定采用哪一个。') => {
  const filler = index => `第 ${index} 段：这一段记录当天的观察和数据，保持原样交付给用户阅读，不做任何删减或改写。`;
  const head = [], tail = [];
  for (let index = 1; head.join('\n').length < size / 2; index++) head.push(filler(index));
  for (let index = 1; tail.join('\n').length < size / 2; index++) tail.push(filler(1000 + index));
  return [...head, middle, ...tail].join('\n');
};
test('scheduled delivery (F1): a 9K-character final response reaches the user whole; only later decisions read the excerpt', async t => {
  const report = longReport(9000);
  assert.ok(report.length > 9000);
  const app = await scheduleFixture(t, { worker: `${report}\n交接：日报完成，下一步等明天的数据`, present: null });
  const [message] = app.delivered();
  assert.equal(message.text, report, 'the whole report, without the handoff line');
  assert.match(message.text, /中段要点/); assert.doesNotMatch(message.text, /project_history|middle omitted/);
  const actions = app.store.state.projects.find(row => row.id === app.project.id).initiativeRuntime.sdkState.actions;
  const work = actions.find(row => row.action === 'work' && row.hostSchedule);
  assert.ok(work.resultSummary.length <= 6000 && work.resultSummary.includes('project_history'), 'later decisions keep reading the bounded excerpt');
  const share = actions.find(row => row.action === 'share' && row.hostSchedule);
  assert.ok(share.content.endsWith(report), 'the delivery action carries the whole result when it fits');
  const { inbox } = app.store.state.projects.find(row => row.id === app.project.id);
  assert.equal(inbox.find(row => row.scheduled).text, report);
  await until(() => app.job().deliveryText === undefined, 'the full text leaves the job once the occurrence is delivered');
});

test('scheduled delivery (F1): the self-revision gets the whole message; one longer than the reviser window is delivered as written', async t => {
  const report = longReport(9000), revised = `${report}\n（已核对）`;
  const app = await scheduleFixture(t, { worker: report, present: null, check: text => text === revised ? [] : ['internal_id'], revise: revised });
  assert.equal(app.revisions.length, 1);
  const prompt = JSON.stringify(app.revisions[0].messages);
  assert.ok(prompt.includes(JSON.stringify(report).slice(1, -1)), 'the reviser reads the full text, middle included');
  assert.equal(app.delivered()[0].text, revised);

  const huge = longReport(30000);
  const long = await scheduleFixture(t, { worker: huge, present: null, check: () => ['internal_id'], revise: 'a shorter rewrite' });
  assert.equal(long.revisions.length, 0, 'never revised from a cut copy');
  assert.equal(long.delivered()[0].text, huge);
  assert.deepEqual(long.delivered()[0].initiative.narrated.revision, { codes: ['internal_id'], revised: false });
  const share = long.store.state.projects.find(row => row.id === long.project.id).initiativeRuntime.sdkState.actions.find(row => row.action === 'share' && row.hostSchedule);
  assert.ok(share.content.length <= 16000 && share.content.includes('project_history'), 'a result beyond the SDK content limit leaves the excerpt on the action, never on the message');
});

test('scheduled delivery (F1): a result kept before the full text was (only the excerpt) never shows the model-facing marker', () => {
  const excerpt = 'Opening paragraph.\n[… middle omitted; project_history can read the original …]\nClosing paragraph.';
  const as = language => ProjectInitiativeController.prototype.userFacingExcerpt.call({ store: { state: { settings: { interfaceLanguage: language } } } }, excerpt);
  assert.equal(as('en'), 'Opening paragraph.\n\n(Part of the middle could not be kept.)\n\nClosing paragraph.');
  assert.equal(as('zh'), 'Opening paragraph.\n\n（中间有一部分没能保留下来。）\n\nClosing paragraph.');
  assert.equal(ProjectInitiativeController.prototype.userFacingExcerpt.call({ store: { state: {} } }, 'whole text'), 'whole text');
});

test('an older settings-UI save with seven point switches is migrated too, so mind.judge and the other built-in points are active', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-narrator-judge7-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  // The exact shape found in a real 0.26 state (written by the settings UI of an older release).
  store.mutate(state => { state.configuration.decisionKernel = { backend: 'typesafe', mode: 'active', modes: Object.fromEntries(['initiative.review', 'evolution.review', 'chat.preflight', 'chat.route', 'delivery.reach', 'skill.screen', 'candidate.prescore'].map(point => [point, 'active'])) }; });
  store.configurationService.secrets['judge:jev'] = 'fixture-key';
  const service = new DecisionService(store), saved = store.state.configuration.decisionKernel;
  assert.deepEqual([saved.mode, saved.modes, saved.backend, saved.settingsVersion], [undefined, undefined, undefined, 2]);
  for (const point of ['mind.judge', 'memory.filter', 'message.value', 'message.check', 'initiative.gate', 'turn.route']) assert.equal(service.enabled(point), true, point);
});
test('judge backends are built in: every point active with TypeSafe, else the fast model as LLM judge; old UI switches are migrated away', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-narrator-judge-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fast', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fast', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  // A config saved by the old settings UI: global off, per-point switches, an explicit backend and a separate judge model.
  store.mutate(state => { state.configuration.decisionKernel = { backend: 'typesafe', mode: 'off', modes: Object.fromEntries(['initiative.review', 'initiative.gate', 'evolution.review', 'chat.preflight', 'chat.route', 'turn.route', 'delivery.reach', 'message.check', 'message.value'].map(point => [point, 'off'])), llmModel: { providerId: provider.id, modelId: 'fast' } }; });
  const service = new DecisionService(store);
  const saved = store.state.configuration.decisionKernel;
  assert.deepEqual([saved.mode, saved.modes, saved.backend, saved.llmModel, saved.fastModel?.modelId, saved.settingsVersion], [undefined, undefined, undefined, undefined, 'fast', 2]);
  const config = service.config();
  assert.equal(config.backend, 'llm', 'no TypeSafe key: the fast model judges through the same templates');
  for (const point of ['message.value', 'message.check', 'delivery.reach', 'turn.route', 'initiative.gate', 'mind.judge']) assert.equal(service.enabled(point), true, point); assert.equal(service.enabled('tool.risk'), false, 'retired: full access is never re-asked');
  assert.equal(service.enabled('chat.route'), false, 'legacy points superseded by turn.route stay off');
  service.update({ apiKey: 'fixture-key' });
  assert.equal(service.config().backend, 'typesafe', 'TypeSafe first when a key exists');
  const view = service.public();
  assert.deepEqual(view.settings.editable, ['apiKey', 'fastModel', 'autoModel']); assert.equal(view.diagnosticOverride, null);
  assert.ok(view.points.every(row => row.optIn === undefined));
  store.mutate(state => { state.configuration.decisionKernel = {}; }); store.configurationService.secrets['judge:jev'] = undefined; delete store.configurationService.secrets['judge:jev'];
  const none = new DecisionService(store); assert.equal(none.enabled('message.value'), false, 'no backend: pacing only');
  process.env.RNA_JEV_MODES = 'message.value=off'; t.after(() => { delete process.env.RNA_JEV_MODES; });
  store.mutate(state => { state.configuration.decisionKernel = { fastModel: { providerId: provider.id, modelId: 'fast' } }; });
  assert.equal(none.enabled('message.check'), true); assert.equal(none.enabled('message.value'), false, 'diagnostic env override only');
  await service.close(); await none.close();
});

test('metrics: K2 proactive keys merge into the one project metrics endpoint as { value, previous, series, sample }', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-narrator-metrics-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { project, session } = app.store.createProject({ name: 'Metrics', workspace: directory });
  const now = Date.now(), at = offset => new Date(now - offset).toISOString();
  app.store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id), items = state.sessions.find(row => row.id === session.id).items;
    items.push({ id: 'p1', kind: 'assistant', source: 'initiative', text: '构建修好了', createdAt: at(5 * HOUR), initiative: { kind: 'insight' } }, { id: 'p2', kind: 'assistant', source: 'initiative', text: '测试也补上了', createdAt: at(4 * HOUR), initiative: { kind: 'insight' }, feedback: { vote: 'up' } }, { id: 'u1', kind: 'user', text: '现在进展怎么样了？', createdAt: at(HOUR) });
    for (const [index, outcome] of ['replied', 'ignored', 'dismissed'].entries()) Object.assign(recordDelivery(target, { actionId: `a${index}`, tier: 'inline', text: `m${index}`, now: now - 6 * HOUR }), { feedback: { outcome, at: at(5 * HOUR) } });
    target.mind = { commitments: [{ id: 'c1', request: 'fix build', status: 'resolved', createdAt: at(10 * HOUR), resolvedAt: at(8 * HOUR) }, { id: 'c2', request: 'add tests', status: 'resolved', createdAt: at(10 * HOUR), resolvedAt: at(4 * HOUR) }], threads: [], findings: [],
      pacing: { decisions: [{ at: at(3 * HOUR), outcome: 'hold', value: .5 }], wake: { history: [{ at: at(2 * HOUR), outcome: 'work', tokens: 3000, latencyMs: 2000 }, { at: at(HOUR), outcome: 'failed', tokens: 1000, latencyMs: 1000 }] } } };
  });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/projects/${project.id}/metrics?window=7d`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.providers.proactive, '../proactive-metrics.mjs'); assert.equal(body.owners.proactive, 'k2'); assert.equal(body.proactive.owner, 'k2');
  for (const key of ['usefulShareRate', 'ignoreRate', 'dismissRate', 'longestUnrepliedChain', 'commitmentResolutionP50Ms', 'commitmentResolutionP90Ms', 'awayOrNightShare', 'exactRepeatRate', 'falseSilence', 'falseSilenceRate', 'tokensPerWake', 'latencyMsPerWake', 'invalidWakeRate']) {
    assert.deepEqual(Object.keys(body.metrics[key]).sort(), ['previous', 'sample', 'series', 'value'], key);
    assert.equal(body.metrics[key].series.length, 7, key); assert.deepEqual(Object.keys(body.metrics[key].series[0]).sort(), ['date', 'sample', 'value'], key);
  }
  assert.equal(body.metrics.usefulShareRate.value, .5, 'replied + 👍 over settled + votes'); assert.equal(body.metrics.usefulShareRate.sample, 4);
  assert.equal(body.metrics.longestUnrepliedChain.value, 2);
  assert.deepEqual([body.metrics.commitmentResolutionP50Ms.value, body.metrics.commitmentResolutionP90Ms.value], [2 * HOUR, 6 * HOUR]);
  assert.deepEqual([body.metrics.falseSilence.value, body.metrics.falseSilenceRate.value], [1, 1], 'asked for progress while a valuable finding was held');
  assert.deepEqual([body.metrics.tokensPerWake.value, body.metrics.latencyMsPerWake.value, body.metrics.invalidWakeRate.value], [2000, 1500, .5]);
  assert.equal(body.metrics.narratorHeld.value, 1); assert.ok(body.proactive.narrator);
  assert.ok(body.metrics.correctionsPerTurn, 'learning keys (K4) stay in the same object');
  assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/projects/${project.id}/metrics?window=2d`)).status, 400);
});

// ------------------------------------------------ replay of real messages

const PRODUCTION_STATE = '/Users/me/Documents/独立开发项目/Pi_agent/prototypes/control-center/.state/state.json';
test('replay (read-only production state, no judge): pacing alone keeps the night quiet and the unreplied chain short; the text is never altered', { skip: !existsSync(PRODUCTION_STATE) && 'no local production state' }, async () => {
  const { state } = readStateFile(PRODUCTION_STATE);
  const projectId = '251ded93-1e75-48f4-957c-e8e8592ea65a', sessions = state.sessions.filter(row => row.projectId === projectId);
  const history = sessions.flatMap(row => row.items.filter(item => item.kind === 'user' && !item.sourceDeleted));
  const originals = sessions.flatMap(row => row.items.filter(item => item.source === 'initiative' && item.text && item.initiative?.kind === 'insight')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (originals.length < 20) return;
  const project = { id: projectId, inbox: [], mind: {} }, session = { id: 's', items: [] }, outcomes = [];
  for (const item of originals) {
    const now = Date.parse(item.createdAt);
    session.items = [...history.filter(row => Date.parse(row.createdAt) <= now).map(row => ({ id: row.id, kind: 'user', text: row.text, createdAt: row.createdAt })), ...session.items.filter(row => row.kind !== 'user')].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const due = welcomeBackDue(project, pacingSignals(project, [session], { now }));
    if (due.length) { const { text } = composeWelcomeBack(due); session.items.push({ id: `w${session.items.length}`, kind: 'assistant', source: 'initiative', text, createdAt: item.createdAt, initiative: { kind: 'welcome_back' } }); applyWelcomeBack(project, due, { itemId: session.items.at(-1).id, now }); }
    const plan = await narrate({ project, sessions: [session], candidate: { kind: 'share', text: item.text, evidenceIds: item.evidenceIds ?? [], reason: item.reason }, now });
    outcomes.push({ at: item.createdAt, outcome: plan.outcome });
    assert.equal(plan.text, item.text.trim(), 'the agent text is never altered');
    if (plan.outcome === 'send') { const id = `n${session.items.length}`; session.items.push({ id, kind: 'assistant', source: 'initiative', text: plan.text, createdAt: item.createdAt, initiative: { kind: 'insight' } }); applyNarration(project, plan, { itemId: id, now }); }
    else applyNarration(project, plan, { now });
  }
  const overnight = outcomes.filter(row => row.at >= '2026-09-25T19:20' && row.at <= '2026-09-26T04:05');
  assert.ok(overnight.length >= 8 && overnight.every(row => row.outcome !== 'send'), JSON.stringify(overnight));
  const before = longestUnrepliedChain(conversationTimeline(sessions.map(row => ({ ...row, items: row.items.filter(item => item.kind === 'user' || item.initiative?.kind === 'insight') }))));
  const after = longestUnrepliedChain(conversationTimeline([session]));
  assert.ok(after < before / 2, `longest unreplied chain ${before} → ${after}`);
});

test('an action that declares resolves settles its mind entries only once the message was actually delivered', async t => {
  let clock = local(28, 3);
  const f = await fixture(t, { now: () => clock });
  const calls = []; f.store.mind = { resolve: (projectId, ids, by) => { calls.push([projectId, ids, by]); return ids; } };
  f.store.mutate(state => { const target = state.projects.find(row => row.id === f.project.id); state.sessions.find(row => row.id === f.session.id).items.push(...daytimeMessages()); target.mind = { agenda: [], lessons: [], commitments: [{ id: 'c1', request: '把第二关的落点问题修好', status: 'pending', trigger: 'user_request', createdAt: new Date(local(27, 10)).toISOString() }], threads: [], findings: [] }; });
  const held = await f.share('r1', '第二关的落点问题修好了：裁剪逻辑不再误删前方平台。', { resolves: ['c1'] });
  assert.equal(held.reach, 'inbox'); assert.deepEqual(calls, [], 'held at night: nothing is settled yet');
  assert.equal(f.mind().threads[0].ref.commitmentId, 'c1', 'the message attaches to the commitment it resolves');
  clock = local(28, 11);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'morning', kind: 'user', text: '早', createdAt: new Date(clock - 60000).toISOString() }); });
  const sent = await f.share('r2', '第二关的回归用例也补上了，跨关切换后前方平台一直存在。', { resolves: ['c1'] });
  assert.equal(sent.reach, 'inline');
  assert.deepEqual(calls, [[f.project.id, ['c1'], { kind: 'delivery', actionId: 'r2' }]]);
});
