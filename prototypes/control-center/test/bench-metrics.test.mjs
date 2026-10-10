import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeProjectMetrics, percentile, unrepliedChains, repeatClusters, creditReplies, jevParaphraseJudge, windowMs } from '../benchmark/metrics.mjs';
import { projectDataset, localHour, isNight } from '../benchmark/dataset.mjs';
import { heuristicLabels, applyManualLabels, isStatusReport, hasDeliverableManifest, persistenceMarked } from '../benchmark/labels.mjs';
import { createMetricsRoute, loadProactiveProvider } from '../benchmark/metrics-route.mjs';
import { syntheticState, PROJECT_ID, SYNTHETIC_NOW } from '../benchmark/examples/synthetic-state.mjs';

const NOW = Date.parse(SYNTHETIC_NOW);
const metrics = (mutate, window = '7d') => { const { state, side } = syntheticState(); mutate?.(state); return computeProjectMetrics(state, PROJECT_ID, window, { now: NOW, side }); };

test('proactive metrics on the synthetic state match hand-computed values', () => {
  const { proactive: p, owners } = metrics();
  assert.equal(owners.proactive, 'k4-baseline');
  assert.deepEqual(p.counts, { messages: 6, unscheduled: 5, scheduled: 1, replied: 2, acted: 2, dismissed: 0, ignored: 2, pending: 0 });
  assert.equal(p.usefulShareRate, 0.5, 'acted p2,p3 + non-correction reply to p5; the reply to p1 is a correction');
  assert.equal(p.ignoreRate, 0.333); assert.equal(p.dismissRate, 0);
  assert.equal(p.longestUnrepliedChain, 2); assert.equal(p.longestUnrepliedChainSpan.from, '2026-10-09T10:00:00.000Z');
  assert.equal(p.awayShare, 0.8); assert.equal(p.nightShare, 0.2);
  assert.equal(p.repeatRate, 0.2); assert.equal(p.repeatClusters, 1);
  assert.equal(p.statusReportShare, 0.167); assert.equal(p.fileMentionShare, 0.167);
  assert.deepEqual(p.commitments, { total: 1, source: 'heuristic', resolved: 1, p50Ms: 600000, p90Ms: 600000, overdue: 0, pending: 0 });
  assert.deepEqual(p.falseSilence, { progressQueries: 1, silentWithFindings: 1 });
  assert.equal(p.wakes.decisions, 4); assert.equal(p.wakes.invalidRate, 0.2); assert.equal(p.wakes.tokensPerWake, 2000); assert.equal(p.wakes.cacheReadShare, 0.167); assert.equal(p.wakes.latencyMsP50, null);
});

test('learning metrics on the synthetic state match hand-computed values', () => {
  const { learning: l } = metrics();
  assert.equal(l.turns, 5); assert.equal(l.corrections, 2); assert.equal(l.correctionsPerTurn, 0.4);
  assert.equal(l.repeatCorrectionRate, 0.5, 'u5 repeats u2 ("仍然" + same complaint)');
  assert.equal(l.firstAttemptAcceptance, 0.667); assert.equal(l.judgedTurns, 3);
  assert.equal(l.retriesPerTurn, 0.2); assert.equal(l.failedTurnRate, 0.2); assert.equal(l.abortsPerTurn, 0.2);
  assert.equal(l.toolFailureRate, 0.286); assert.equal(l.tokensPerAcceptedDeliverable, 1600); assert.equal(l.minutesPerAcceptedDeliverable, 1);
  assert.equal(l.preferences, 1); assert.equal(l.messageComplaints, 1); assert.equal(l.lessonHitRate, null);
  assert.deepEqual(l.evolution, { versions: 3, nonBaseline: 2, candidates: 2, passed: 0, adopted: 0, genes: { generation: 0, active: 0, trial: 0, retired: 0, rejected: 0 } });
});

test('keyed UI shape: metrics[key] = { value, previous, series (daily), sample }', () => {
  const { metrics: m } = metrics();
  for (const key of ['usefulShareRate', 'ignoreRate', 'dismissRate', 'longestUnrepliedChain', 'commitmentResolutionP50Ms', 'commitmentResolutionP90Ms', 'correctionsPerTurn', 'repeatCorrectionRate', 'firstAttemptAcceptance', 'lessonHitRate']) {
    assert.deepEqual(Object.keys(m[key]).sort(), ['previous', 'sample', 'series', 'value'], key); assert.equal(m[key].series.length, 7, key);
  }
  assert.equal(m.usefulShareRate.value, 0.5); assert.equal(m.usefulShareRate.sample, 6); assert.equal(m.usefulShareRate.previous, null, 'no data in the window before');
  assert.deepEqual(m.usefulShareRate.series.at(-1), { date: '2026-10-10', value: 0.6, sample: 5 });
  assert.deepEqual(m.usefulShareRate.series.at(-2), { date: '2026-10-09', value: null, sample: 0 }, 'the only message that day was still pending at the end of that day');
  assert.equal(m.correctionsPerTurn.value, 0.4); assert.equal(m.correctionsPerTurn.sample, 5);
  assert.equal(m.commitmentResolutionP50Ms.value, 600000); assert.equal(m.lessonHitRate.value, null); assert.equal(m.lessonHitRate.sample, 0);
  const { state, side } = syntheticState();
  const later = computeProjectMetrics(state, PROJECT_ID, '1d', { now: NOW + 86400000, side });
  assert.equal(later.metrics.usefulShareRate.value, null); assert.equal(later.metrics.usefulShareRate.previous, 0.6);
  const all = metrics(undefined, 'all'); assert.equal(all.metrics.usefulShareRate.series.length, 30); assert.equal(all.metrics.usefulShareRate.previous, null);
});

test('windows exclude older rows; invalid windows are rejected', () => {
  const day = metrics(undefined, '7d'), all = metrics(undefined, 'all');
  assert.equal(all.proactive.counts.messages, day.proactive.counts.messages);
  const { state, side } = syntheticState();
  const late = computeProjectMetrics(state, PROJECT_ID, '7d', { now: NOW + 8 * 86400000, side });
  assert.equal(late.proactive.counts.messages, 0); assert.equal(late.learning.turns, 0);
  assert.throws(() => windowMs('1y'), { code: 'bench_window_invalid' });
});

test('project.mind commitments and lessons are preferred when present (K1 contract)', () => {
  const m = metrics(state => { state.projects[0].mind = {
    commitments: [{ id: 'c1', request: '修复闪烁', trigger: 'user_request', createdAt: '2026-10-10T06:00:00.000Z', overdueAt: '2026-10-10T10:00:00.000Z', status: 'resolved', resolvedAt: '2026-10-10T07:00:00.000Z' },
      { id: 'c2', request: '加关卡', trigger: 'user_request', createdAt: '2026-10-10T06:30:00.000Z', overdueAt: '2026-10-10T10:30:00.000Z', status: 'pending' }],
    lessons: [{ id: 'l1', kind: 'preference', text: '不要问我', status: 'active', uses: { recalled: 4, applied: 3, contradicted: 1 } }] }; });
  assert.equal(m.proactive.commitments.source, 'mind'); assert.equal(m.proactive.commitments.total, 2);
  assert.equal(m.proactive.commitments.p50Ms, 3600000); assert.equal(m.proactive.commitments.overdue, 1); assert.equal(m.proactive.commitments.pending, 1);
  assert.equal(m.learning.lessonHitRate, 0.75); assert.equal(m.learning.lessons, 1); assert.equal(m.harness.coverage.commitmentsSource, 'mind');
});

test('a K2 proactive block replaces the baseline and keeps the baseline for comparison', () => {
  const { state, side } = syntheticState();
  const m = computeProjectMetrics(state, PROJECT_ID, '7d', { now: NOW, side, proactiveProvider: () => ({ usefulShareRate: 0.9, source: 'k2' }) });
  assert.equal(m.owners.proactive, 'k2'); assert.equal(m.proactive.source, 'k2'); assert.equal(m.proactiveBaseline.usefulShareRate, 0.5);
  assert.deepEqual(m.metrics.usefulShareRate, { value: 0.9, previous: null, series: [], sample: null }, 'a flat K2 value becomes the keyed entry');
  assert.equal(m.metrics.correctionsPerTurn.value, 0.4, 'K4 learning keys are kept');
  const keyed = computeProjectMetrics(state, PROJECT_ID, '7d', { now: NOW, side, proactiveProvider: () => ({ metrics: { ignoreRate: { value: 0.1, previous: 0.2, series: [{ date: '2026-10-10', value: 0.1 }], sample: 9 } } }) });
  assert.deepEqual(keyed.metrics.ignoreRate, { value: 0.1, previous: 0.2, series: [{ date: '2026-10-10', value: 0.1 }], sample: 9 }); assert.equal(keyed.proactive.metrics, undefined);
  const broken = computeProjectMetrics(state, PROJECT_ID, '7d', { now: NOW, side, proactiveProvider: () => { throw new Error('boom'); } });
  assert.equal(broken.owners.proactive, 'k4-baseline');
});

test('metric helpers: percentile, chains, reply crediting, repeat clusters, time of day', async () => {
  assert.equal(percentile([], 50), null); assert.equal(percentile([5, 1, 3], 50), 3); assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  const row = (role, at, extra = {}) => ({ role, at: `2026-10-10T0${at}:00:00.000Z`, channel: role === 'agent' ? 'proactive' : 'foreground', sessionId: 's', ...extra });
  assert.deepEqual(unrepliedChains([row('agent', 1), row('agent', 2), row('agent', 3), row('agent', 4), row('user', 5), row('agent', 6)]), { longest: 4, from: '2026-10-10T01:00:00.000Z', to: '2026-10-10T04:00:00.000Z', chainsOver3: 1 });
  const proactive = [{ itemId: 'a', sessionId: 's', at: '2026-10-10T01:00:00.000Z' }, { itemId: 'b', sessionId: 's', at: '2026-10-10T03:00:00.000Z' }, { itemId: 'c', sessionId: 's', at: '2026-10-10T03:30:00.000Z' }];
  const credited = creditReplies(proactive, [{ role: 'user', id: 'u', sessionId: 's', at: '2026-10-10T04:00:00.000Z', labels: [] }]);
  assert.deepEqual([...credited.keys()].sort(), ['b', 'c'], 'a reply answers the latest burst, not the whole unreplied run');
  const texts = [{ itemId: '1', at: '2026-10-10T01:00:00.000Z', text: '写入权限还没有生效，请在项目权限里打开写入' }, { itemId: '2', at: '2026-10-10T01:16:00.000Z', text: '需要你在项目权限中开启写入，目前写入权限没有生效' }, { itemId: '3', at: '2026-10-10T01:20:00.000Z', text: '第二关闪烁已修复，回归通过' }];
  assert.deepEqual(repeatClusters(texts), { clusters: 1, repeatedMessages: 1, largest: 2 });
  const judged = await jevParaphraseJudge(texts, async (a, b) => a.includes('闪烁') || b.includes('闪烁'));
  assert.deepEqual(repeatClusters(texts, { similar: judged }), { clusters: 1, repeatedMessages: 2, largest: 3 });
  assert.equal(localHour('2026-10-09T16:00:00.000Z', 'Asia/Shanghai'), 0); assert.equal(isNight(0), true); assert.equal(isNight(7), false); assert.equal(isNight(23), true);
});

test('heuristic labels on the plan\'s quoted user phrases; manual labels replace or amend', () => {
  assert.ok(heuristicLabels('场景仍然较单一').includes('correction'));
  assert.ok(heuristicLabels('目前所有场景似乎都是一个平面而已').includes('correction'));
  assert.ok(heuristicLabels('近景仍然比较单调，继续完善').includes('correction'));
  assert.deepEqual(heuristicLabels('你应该自己决策，不需要问我').filter(label => ['preference', 'message_complaint'].includes(label)), ['preference', 'message_complaint']);
  assert.ok(heuristicLabels('不要写交付物详单之类，只需要直接交付 daily.md 的内容').includes('message_complaint'));
  assert.ok(heuristicLabels('啰嗦').includes('message_complaint'));
  assert.deepEqual(heuristicLabels('方案 B', { source: 'interaction-answer' }), ['decision']);
  assert.ok(heuristicLabels('现在进展怎么样了？').includes('progress_query'));
  assert.equal(persistenceMarked('箭矢依然浮在空中'), true); assert.equal(persistenceMarked('依然喜欢'), false);
  assert.deepEqual(applyManualLabels('x', ['correction'], { labels: { x: { remove: ['correction'], add: ['approval'], topic: 't' } } }), { labels: ['approval'], labelSource: 'manual', topic: 't' });
  assert.equal(isStatusReport('检查点：锚点零漂移，仍待你试玩后裁决。'), true); assert.equal(isStatusReport('发现：闪烁根因是接缝，已修复。'), false);
  assert.equal(hasDeliverableManifest('| 文件 | 内容 |\n| a.md | x |'), true); assert.equal(hasDeliverableManifest('今天三条要点'), false);
});

test('metrics route serves plan §8 GET /api/v2/projects/:id/metrics and merges a K2 provider', async t => {
  const { state } = syntheticState(), sent = [];
  const store = { state, file: null };
  const route = createMetricsRoute({ store, now: () => NOW, labelsFile: join(tmpdir(), 'rna-bench-no-labels.json'), providerModules: [] });
  const call = async (path, method = 'GET') => { const url = new URL(`http://x${path}`); return route.handle({ method }, null, { pathname: url.pathname, url, send: (status, body) => sent.push({ status, body }) }); };
  assert.equal(await call('/api/v2/projects/x/other'), false); assert.equal(await call(`/api/v2/projects/${PROJECT_ID}/metrics`, 'POST'), false);
  assert.equal(await call(`/api/v2/projects/${PROJECT_ID}/metrics?window=1y`), true); assert.equal(sent.pop().status, 400);
  assert.equal(await call('/api/v2/projects/missing/metrics'), true); assert.equal(sent.pop().status, 404);
  assert.equal(await call(`/api/v2/projects/${PROJECT_ID}/metrics?window=30d`), true);
  const body = sent.pop().body; assert.equal(body.window, '30d'); assert.equal(body.providers.proactive, 'k4-baseline'); assert.ok(body.learning && body.harness);
  const dir = mkdtempSync(join(tmpdir(), 'rna-bench-provider-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'proactive-metrics.mjs'), 'export async function computeProactiveMetrics(state, projectId, { window }) { return { owner: "k2", window, projectId }; }\n');
  const provider = await loadProactiveProvider(['./proactive-metrics.mjs', './missing.mjs'], pathToFileURL(`${dir}/`).href);
  assert.equal(provider.module, './proactive-metrics.mjs');
  assert.equal(await loadProactiveProvider(['./missing.mjs'], pathToFileURL(`${dir}/`).href), null);
});

test('dataset marks scheduled deliveries and presence from the timeline', () => {
  const { state, side } = syntheticState(), dataset = projectDataset(state, PROJECT_ID, { side, now: NOW });
  assert.equal(dataset.timeZone, 'Asia/Shanghai');
  assert.deepEqual(dataset.scheduled.map(row => row.itemId), ['p0']); assert.equal(dataset.scheduled[0].shape.manifest, true);
  const p4 = dataset.proactive.find(row => row.itemId === 'p4'); assert.equal(p4.presence.night, true); assert.equal(p4.presence.away, true);
  const p2 = dataset.proactive.find(row => row.itemId === 'p2'); assert.equal(p2.presence.away, false); assert.equal(p2.presence.minutesSinceUser, 30);
  assert.throws(() => projectDataset(state, 'nope'), { code: 'bench_project_missing' });
});
