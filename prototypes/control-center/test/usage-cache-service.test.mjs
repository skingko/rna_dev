import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger, aggregateCacheUsage, usageRecord, meteredProvider, cacheUsageResponse, isProbeJudgment, USAGE_RUN_LIMIT, runLabeler } from '../usage-cache-service.mjs';
import { DailyRollup, metricsRoot } from '../metrics-rollup.mjs';
import { createServer } from '../server.mjs';

const at = (minutesAgo, now) => now - minutesAgo * 60000;
const row = (purpose, usage, minutesAgo, now, projectId = 'p1') => usageRecord({ at: at(minutesAgo, now), purpose, projectId, usage: usage && { ...usage, cacheUsageReported: usage.cacheUsageReported ?? true } });

test('aggregation is token-weighted and separates coverage, cold starts and unreported receipts', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const rows = [
    row('foreground', { input: 100, cacheRead: 0, cacheWrite: 0 }, 50, now), // small miss: not a cold start
    row('foreground', { input: 10, cacheRead: 990, cacheWrite: 0 }, 40, now),
    row('initiative', { input: 1500, cacheRead: 0, cacheWrite: 500 }, 30, now), // cold start (>=1024 uncached input)
    row('background-work', { input: 0, cacheRead: 0, cacheWrite: 0, cacheUsageReported: false }, 20, now), // unknown, never 0%
    row('compaction', null, 10, now),
    row('foreground', { input: 1, cacheRead: 99, cacheWrite: 0 }, 5, now, 'p2'),
    row('foreground', { input: 5000, cacheRead: 0, cacheWrite: 0 }, 120, now) // outside 1h
  ];
  const report = aggregateCacheUsage(rows, { window: '1h', projectId: 'p1', now });
  assert.deepEqual(report.overall, { requests: 5, input: 1610, cacheRead: 990, cacheWrite: 500, output: 0, reasoningTokens: 0, lengthStops: 0, estimated: { requests: 0, input: 0, output: 0 }, hitRate: 990 / 3100, coverage: 1 / 3, coldStarts: 1, unreported: 2 });
  assert.equal(report.byPurpose.foreground.hitRate, 990 / 1100, 'not the mean of 0% and 99%');
  assert.deepEqual(Object.keys(report.byPurpose), ['foreground', 'initiative', 'background-work', 'compaction']);
  assert.equal(report.byPurpose['background-work'].hitRate, null); assert.equal(report.byPurpose['background-work'].unreported, 1);
  assert.deepEqual(report.latest, { purpose: 'initiative', hitRate: 0, at: new Date(at(30, now)).toISOString() });
  assert.equal(aggregateCacheUsage(rows, { window: '24h', now }).overall.requests, 7);
  assert.throws(() => aggregateCacheUsage(rows, { window: '45d', now }), { status: 400 });
});

test('metered provider records one purpose-tagged receipt per request, tags compaction, and persists across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-usage-ledger-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json.usage-cache.jsonl'), ledger = new UsageLedger({ file });
  const base = async function* (request) { yield { type: 'text_delta', delta: 'x' }; if (!request.noUsage) yield { type: 'usage', usage: { input: 40, output: 2, cacheRead: 60, cacheWrite: 0, totalTokens: 102, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' }; };
  const provider = meteredProvider(base, { ledger, purpose: 'background-work', projectId: 'p1', sessionId: 's1' });
  assert.equal(provider.meteredBase, base);
  for (const request of [{ model: { providerId: 'a', modelId: 'm' } }, { model: { providerId: 'a', modelId: 'm' }, purpose: 'compaction' }, { model: { providerId: 'a', modelId: 'm' }, noUsage: true }]) for await (const _ of provider(request)) {}
  assert.deepEqual(ledger.rows.map(row => [row.purpose, row.cacheRead, row.cacheReported]), [['background-work', 60, true], ['compaction', 60, true], ['background-work', 0, false]]);
  const raw = await readFile(file, 'utf8'); assert.equal(raw.trim().split('\n').length, 3); assert.doesNotMatch(raw, /text_delta|"x"/, 'counts only');
  assert.equal(new UsageLedger({ file }).rows.length, 3);
  assert.equal(meteredProvider(base, {}), base, 'no ledger, no wrapper');
});

test('GET /api/v2/usage/cache returns the contract shape from the store ledger', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-usage-http-')), stateFile = join(dir, 'state.json');
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false }); await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.store.usageLedger.record({ purpose: 'foreground', projectId: 'p1', usage: { input: 10, cacheRead: 90, cacheWrite: 0, cacheUsageReported: true } });
  app.store.usageLedger.record({ purpose: 'initiative', projectId: 'p2', usage: { input: 2000, cacheRead: 0, cacheWrite: 0, cacheUsageReported: true } });
  const url = `http://127.0.0.1:${app.server.address().port}/api/v2/usage/cache`;
  const all = await (await fetch(`${url}?window=24h`)).json();
  assert.equal(all.window, '24h'); assert.equal(all.overall.requests, 2); assert.equal(all.overall.coldStarts, 1); assert.equal(all.overall.hitRate, 90 / 2100);
  assert.deepEqual(Object.keys(all.byPurpose), ['foreground', 'initiative']); assert.equal(all.latest.purpose, 'initiative');
  const scoped = await (await fetch(`${url}?projectId=p1`)).json();
  assert.equal(scoped.window, '24h'); assert.equal(scoped.overall.hitRate, 0.9); assert.equal(scoped.projectId, 'p1');
  assert.equal((await fetch(`${url}?window=2d`)).status, 400);
  assert.deepEqual(cacheUsageResponse(null, new URLSearchParams()).overall.requests, 0);
});

test('JEV judgments never enter cache metrics; they are reported separately', () => {
  const now = Date.parse('2026-09-29T12:00:00Z'), at = new Date(now - 60000).toISOString();
  const rows = [
    { at, purpose: 'foreground', input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0, cacheReported: true },
    ...Array.from({ length: 5 }, () => ({ at, purpose: 'jev', projectId: 'p1', input: 2000, output: 80, cacheRead: 0, cacheWrite: 0, cacheReported: false })),
  ];
  const result = aggregateCacheUsage(rows, { now });
  assert.equal(result.overall.requests, 1); assert.equal(result.overall.unreported, 0); assert.equal(result.overall.coverage, 1); assert.equal(result.overall.hitRate, 0.9);
  assert.equal(result.byPurpose.jev, undefined);
  assert.deepEqual(result.judge, { requests: 5, input: 10000, output: 400, product: { requests: 5, input: 10000, output: 400 }, probe: { requests: 0, input: 0, output: 0 } });
  assert.equal(result.latest.purpose, 'foreground');
});

// Z2 (token-burn study 2026-10-05): the probe endpoint is a developer's tool and had 98.6% of a day's JEV requests, all counted
// as the product's own. New probe rows say so; older rows are told apart structurally: the probe records no project and no
// session, a daemon decision records its project, or outside any project its session.
test('JEV judgments split into product judgments and probes, by detail and for older rows by structure', () => {
  const now = Date.parse('2026-10-05T12:00:00Z'), at = new Date(now - 60000).toISOString(), jev = (extra, input = 1000, output = 10) => ({ at, purpose: 'jev', input, output, cacheRead: 0, cacheWrite: 0, cacheReported: false, ...extra });
  assert.equal(isProbeJudgment(jev({ detail: 'probe', projectId: 'p1' })), true, 'detail decides first');
  assert.equal(isProbeJudgment(jev({})), true, 'an older row with neither project nor session is a probe');
  assert.equal(isProbeJudgment(jev({ projectId: 'p1' })), false); assert.equal(isProbeJudgment(jev({ sessionId: 's1' })), false, 'a decision of a project-less session is the product\'s');
  assert.equal(isProbeJudgment(jev({ detail: 'decision' })), false, 'another detail is never a probe');
  // A decision the daemon asked for outside any project and session (session.resume of a project-less conversation) says `decision` itself: it has no scope, and without the detail it would read as a probe.
  const rows = [jev({ detail: 'probe' }, 4000, 40), jev({}, 2000, 20), jev({ projectId: 'p1' }, 300, 3), jev({ sessionId: 's1' }, 200, 2), jev({ projectId: 'p2', sessionId: 's2' }, 100, 1), jev({ detail: 'decision' }, 50, 5)];
  const { judge } = aggregateCacheUsage(rows, { now });
  assert.deepEqual(judge, { requests: 6, input: 6650, output: 71, product: { requests: 4, input: 650, output: 11 }, probe: { requests: 2, input: 6000, output: 60 } });
  assert.equal(aggregateCacheUsage([], { now }).judge, undefined, 'no judgments, no block');
  assert.equal(aggregateCacheUsage(rows, { now, projectId: 'p1' }).judge.probe.requests, 0, 'a project scope never contains probes');
});

test('a probe is recorded with detail "probe", and the detail survives the ledger file and the rollup key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-usage-probe-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json.usage-cache.jsonl'), ledger = new UsageLedger({ file });
  ledger.record({ purpose: 'jev', detail: 'probe', providerId: 'typesafe', modelId: 'jev-latest', usage: { input: 120, output: 0 } });
  ledger.record({ purpose: 'jev', projectId: 'p1', providerId: 'typesafe', modelId: 'jev-latest', usage: { input: 30, output: 1 } });
  assert.equal(ledger.rows[0].detail, 'probe'); assert.equal(ledger.rows[1].detail, undefined, 'a row recorded without a detail has none (rows from before 0.69 are told apart by structure)');
  const reloaded = new UsageLedger({ file }), { judge } = aggregateCacheUsage(reloaded.rows, {});
  assert.deepEqual([judge.product.requests, judge.probe.requests, judge.probe.input], [1, 1, 120]);
});

// A day folded into the rollup keeps what separates a probe: the cell key carries the detail and the project (never the session).
test('probe and product judgments are told apart in the rollup too, as they are in raw rows', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-usage-probe-rollup-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-05T04:00:00Z'); const TZ = 'Asia/Shanghai', DAY = 86400000, stateFile = join(dir, 'state.json');
  const rollup = new DailyRollup({ file: join(metricsRoot(stateFile), 'usage-daily.json'), kind: 'usage', now: () => now, timeZone: TZ });
  const ledger = new UsageLedger({ file: `${stateFile}.usage-cache.jsonl`, now: () => now, rollup });
  const jevs = () => { ledger.record({ purpose: 'jev', detail: 'probe', usage: { input: 700, output: 7 } }); ledger.record({ purpose: 'jev', usage: { input: 70, output: 7 } }); ledger.record({ purpose: 'jev', projectId: 'p1', usage: { input: 20, output: 2 } }); };
  jevs(); const before = aggregateCacheUsage(ledger.records(), { window: '30d', now, rollup, timeZone: TZ }).judge;
  now += 9 * DAY; ledger.record({ purpose: 'foreground', projectId: 'p1', usage: { input: 5, output: 1, cacheUsageReported: true } });
  assert.equal(ledger.rows.length, 1, 'the judgments left the raw ledger');
  const after = aggregateCacheUsage(ledger.records(), { window: '30d', now, rollup, timeZone: TZ });
  assert.ok(after.rollup, 'read from the rollup'); assert.deepEqual(after.judge, before, 'the same split from rollup cells as from raw rows');
  assert.deepEqual(after.judge.probe, { requests: 2, input: 770, output: 14 }); assert.deepEqual(after.judge.product, { requests: 1, input: 20, output: 2 });
});

// Spec p1 compaction §A2: the SDK's request metadata reaches the ledger row — continuity for every session request,
// the trigger of a compaction — and the session's last cache-bearing request is remembered (an idle summary is not one).
test('ledger rows keep continuity and the compaction trigger; lastSessionRequest skips idle summaries and judgments', async () => {
  let now = Date.parse('2026-10-04T08:00:00Z');
  const ledger = new UsageLedger({ now: () => now });
  const base = async function* () { yield { type: 'usage', usage: { input: 10, output: 2, cacheRead: 90, cacheWrite: 0, totalTokens: 102, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' }; };
  const provider = meteredProvider(base, { ledger, purpose: 'foreground', projectId: 'p', sessionId: 's' });
  for await (const _ of provider({ model: { providerId: 'a', modelId: 'm' }, ledger: { continuity: { continuous: true, gapMs: 120000.4, previousPromptTokens: 100 } } })) {}
  now += 1000;
  for await (const _ of provider({ model: { providerId: 'a', modelId: 'm' }, purpose: 'compaction', ledger: { trigger: 'idle' } })) {}
  for await (const _ of provider({ model: { providerId: 'a', modelId: 'm' }, purpose: 'compaction', ledger: { trigger: 'bogus', continuity: { continuous: 'yes' } } })) {}
  assert.deepEqual(ledger.rows[0].continuity, { continuous: true, gapMs: 120000, previousPromptTokens: 100 });
  assert.equal(ledger.rows[0].trigger, undefined, 'a trigger only on compaction rows');
  assert.equal(ledger.rows[1].trigger, 'idle'); assert.equal(ledger.rows[2].trigger, undefined); assert.equal(ledger.rows[2].continuity, undefined, 'invalid metadata is dropped');
  assert.deepEqual(ledger.lastSessionRequest('s'), { at: Date.parse('2026-10-04T08:00:01Z'), providerId: 'a', modelId: 'm' }, 'the bogus-trigger compaction counts, the idle one does not');
  ledger.record({ purpose: 'jev', sessionId: 's', usage: {} });
  assert.equal(ledger.lastSessionRequest('s').at, Date.parse('2026-10-04T08:00:01Z'));
  const report = aggregateCacheUsage(ledger.rows, { now });
  assert.deepEqual(report.byPurpose.compaction.byTrigger, { idle: { requests: 1, input: 10, output: 2 }, unknown: { requests: 1, input: 10, output: 2 } });
});

// Z1 (token-burn study 2026-10-05): the page showed 8.2M "tokens" of which 95% were cache reads. The report keeps cache reads apart
// from fresh tokens and lists the largest runs by their tokens. It weighs nothing by price: the user decided (2026-10-05) that the
// backend does not track real prices, so no cost or price-weighted number is in the report.
const request = (at, extra, usage) => usageRecord({ at, providerId: 'zhipu', modelId: 'glm', ...extra, usage: { cacheUsageReported: true, output: 0, cacheRead: 0, cacheWrite: 0, ...usage } });
const PRICED = () => ({ entry: { currency: 'USD', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } });
// A price list is no option of the report any more: a caller that still passes one gets the same report, with no cost in it.

test('the report carries no price-derived number: no cost, no relative cost, none per run, whatever a caller passes as a price list', () => {
  const now = Date.parse('2026-10-05T12:00:00Z'), at = now - 60000;
  const rows = [request(at, { purpose: 'foreground', projectId: 'p1', sessionId: 's1' }, { input: 100, cacheRead: 1000, cacheWrite: 40, output: 10 }), request(at, { purpose: 'initiative', projectId: 'p1' }, { input: 1000, output: 100 })];
  const plain = aggregateCacheUsage(rows, { now });
  for (const options of [{ now }, { now, pricing: () => null }, { now, pricing: PRICED }]) {
    const report = aggregateCacheUsage(rows, options);
    assert.deepEqual(report, plain); assert.doesNotMatch(JSON.stringify(report), /cost|amounts|priced/i, 'no list-price cost anywhere in the report');
    assert.equal('relative' in report, false); assert.equal(JSON.stringify(report).includes('assumed'), false, 'no assumed weights');
    assert.equal(report.runs.every(run => !('relative' in run)), true);
    // The token counts do not depend on prices: a run is its tokens, cache reads apart.
    assert.deepEqual(report.runs, [{ sessionId: 's1', purpose: 'foreground', projectId: 'p1', requests: 1, tokens: 1150, input: 100, cacheRead: 1000, cacheWrite: 40, output: 10, firstAt: new Date(at).toISOString(), lastAt: new Date(at).toISOString() }]);
  }
});

test('runs leave out JEV judgments and keep-alive pings, which are reported apart', () => {
  const now = Date.parse('2026-10-05T12:00:00Z'), at = now - 60000;
  const rows = [request(at, { purpose: 'foreground', projectId: 'p1', sessionId: 's' }, { input: 10, cacheRead: 100 }), request(at, { purpose: 'jev', projectId: 'p1', sessionId: 's' }, { input: 5000, output: 100 }),
    request(at, { purpose: 'foreground', projectId: 'p1', sessionId: 's', keepAlive: true }, { cacheRead: 4000 })];
  const { runs, keepAlive, judge } = aggregateCacheUsage(rows, { now });
  assert.deepEqual(runs.map(run => [run.sessionId, run.requests, run.tokens, run.cacheRead]), [['s', 1, 110, 100]], 'neither the JEV request nor the ping');
  assert.equal(keepAlive.requests, 1); assert.equal(judge.requests, 1);
});

// A request that reported no usage has its whole prompt estimate as `input`; the cache statistics split it like the reported requests
// of its prefix (ACC-4). The run row shows fresh tokens apart from cache reads, so it shows the same split: its total is what was recorded.
test('a run shows the estimated request\'s prompt split into fresh and cache read as the cache statistics split it, with the same total', () => {
  const now = Date.parse('2026-10-05T12:00:00Z'), at = now - 60000, key = 'b'.repeat(16);
  const reported = request(at - 1000, { purpose: 'background-work', projectId: 'p1', sessionId: 'job', prefixKey: key }, { input: 100, cacheRead: 900 });
  const aborted = usageRecord({ at, purpose: 'background-work', projectId: 'p1', sessionId: 'job', providerId: 'zhipu', modelId: 'glm', prefixKey: key, estimated: true, usage: { input: 1000, output: 10 } });
  const [run] = aggregateCacheUsage([reported, aborted], { now }).runs;
  assert.equal(run.requests, 2); assert.deepEqual([run.input, run.cacheRead, run.cacheWrite, run.output], [100 + 100, 900 + 900, 0, 10], 'its 1000 prompt tokens: 100 fresh, 900 read from the cache');
  assert.equal(run.tokens, 100 + 900 + 1000 + 10, 'the tokens of the run are the recorded ones');
  // With nothing to split by, all of the prompt is fresh (the upper bound).
  const [alone] = aggregateCacheUsage([aborted], { now }).runs; assert.deepEqual([alone.input, alone.cacheRead, alone.tokens], [1000, 0, 1010]);
});

test('the largest runs: sessions by tokens, the top eight, with their cache reads apart from fresh tokens', () => {
  const now = Date.parse('2026-10-05T12:00:00Z'), at = minutes => now - minutes * 60000;
  const rows = [];
  for (let n = 1; n <= 10; n++) rows.push(request(at(500 - n), { purpose: 'background-work', projectId: 'p1', sessionId: `run-${n}` }, { input: 100 * n, cacheRead: 10 * n }));
  // `talk` is a long conversation: many requests that read their prefix. By tokens it is the largest (3,050, against run-10's 1,100), though almost all of it is cache reads.
  for (let i = 0; i < 20; i++) rows.push(request(at(300 - i), { purpose: 'foreground', projectId: 'p1', sessionId: 'talk' }, { input: 1, cacheRead: 150 }));
  rows.push(request(at(200), { purpose: 'compaction', projectId: 'p1', sessionId: 'talk' }, { input: 30 }));
  // No session (a decision wake, an evaluation) is not a run; a JEV request with a session is not one either.
  rows.push(request(at(100), { purpose: 'initiative', projectId: 'p1' }, { input: 999999 }), request(at(90), { purpose: 'jev', projectId: 'p1', sessionId: 'run-1' }, { input: 999999 }));
  const { runs, overall } = aggregateCacheUsage(rows, { now });
  assert.equal(USAGE_RUN_LIMIT, 8); assert.equal(runs.length, 8);
  assert.deepEqual(runs.map(run => run.sessionId), ['talk', 'run-10', 'run-9', 'run-8', 'run-7', 'run-6', 'run-5', 'run-4'], 'by tokens, largest first; run-3 (330 tokens) and below are cut');
  assert.deepEqual(runs[1], { sessionId: 'run-10', purpose: 'background-work', projectId: 'p1', requests: 1, tokens: 1100, input: 1000, cacheRead: 100, cacheWrite: 0, output: 0, firstAt: new Date(at(490)).toISOString(), lastAt: new Date(at(490)).toISOString() });
  const talk = runs[0];
  assert.equal(talk.requests, 21); assert.equal(talk.purpose, 'foreground', 'the purpose that carried most of the session\'s tokens'); assert.deepEqual([talk.input, talk.cacheRead, talk.output], [50, 3000, 0]); assert.equal(talk.tokens, 3050);
  assert.equal(runs.every(run => run.tokens === run.input + run.cacheRead + run.cacheWrite + run.output), true);
  assert.ok(runs.reduce((sum, run) => sum + run.requests, 0) < overall.requests, 'runs never include requests without a session');
  assert.deepEqual(aggregateCacheUsage(rows, { now, projectId: 'nobody' }).runs, []);
  // Equal tokens: the session with more requests first.
  const tie = aggregateCacheUsage([request(at(30), { purpose: 'foreground', sessionId: 'one' }, { input: 100 }), request(at(20), { purpose: 'foreground', sessionId: 'two' }, { input: 50 }), request(at(10), { purpose: 'foreground', sessionId: 'two' }, { input: 50 })], { now }).runs;
  assert.deepEqual(tie.map(run => run.sessionId), ['two', 'one']);
});

test('runs list only the raw ledger: a window reaching into the daily rollup counts its days in `overall` but names no session', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-usage-runs-rollup-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-05T04:00:00Z'); const TZ = 'Asia/Shanghai', DAY = 86400000, stateFile = join(dir, 'state.json');
  const rollup = new DailyRollup({ file: join(metricsRoot(stateFile), 'usage-daily.json'), kind: 'usage', now: () => now, timeZone: TZ });
  const ledger = new UsageLedger({ file: `${stateFile}.usage-cache.jsonl`, now: () => now, rollup });
  ledger.record({ purpose: 'background-work', projectId: 'p1', sessionId: 'old', providerId: 'a', modelId: 'm', usage: { input: 100, cacheRead: 1000, cacheUsageReported: true } });
  now += 9 * DAY; ledger.record({ purpose: 'foreground', projectId: 'p1', sessionId: 'later', providerId: 'a', modelId: 'm', usage: { input: 10, cacheRead: 20, cacheUsageReported: true } });
  assert.equal(ledger.rows.length, 1, 'the first day left the raw ledger');
  const report = aggregateCacheUsage(ledger.records(), { window: '30d', now, rollup, timeZone: TZ });
  assert.ok(report.rollup, 'read from the rollup'); assert.equal(report.overall.requests, 2); assert.equal(report.overall.input + report.overall.cacheRead, 1130);
  assert.deepEqual(report.runs.map(run => [run.sessionId, run.tokens]), [['later', 30]], 'the rollup keeps no session: only raw sessions are listed');
});

test('runs are named from the state: a scheduled run by its schedule, another background run by its job, nothing is stored', () => {
  const now = Date.parse('2026-10-05T12:00:00Z'); let clock = now - 3600000; const ledger = new UsageLedger({ now: () => clock });
  const record = (sessionId, purpose, input, projectId = 'p1') => { clock += 60000; ledger.record({ purpose, projectId, sessionId, providerId: 'zhipu', modelId: 'glm', usage: { input, output: 0, cacheUsageReported: true } }); };
  record('schedule-work-abc', 'background-work', 5000); record('job-1', 'background-work', 4000); record('gone', 'background-work', 3000, 'p-deleted'); record('talk', 'foreground', 2000);
  const projects = [{ id: 'p1', name: '项目甲', schedules: [{ id: 'sch1', title: '每日调研' }], jobs: [{ id: 'schedule-work-abc', scheduleId: 'sch1', title: 'job title', kind: 'research' }, { id: 'job-1', kind: 'research', title: 'Fix the importer' }] }];
  const { runs } = cacheUsageResponse(ledger, new URLSearchParams({ window: '24h' }), { now, projects });
  assert.deepEqual(runs.map(run => run.sessionId), ['schedule-work-abc', 'job-1', 'gone', 'talk'], 'ranked by tokens');
  const byId = Object.fromEntries(runs.map(run => [run.sessionId, run]));
  assert.deepEqual([byId['schedule-work-abc'].kind, byId['schedule-work-abc'].scheduleId, byId['schedule-work-abc'].title, byId['schedule-work-abc'].projectName], ['scheduled', 'sch1', '每日调研', '项目甲'], 'the schedule\'s title, not the job\'s');
  assert.deepEqual([byId['job-1'].kind, byId['job-1'].scheduleId, byId['job-1'].title], ['job', undefined, 'Fix the importer']);
  assert.deepEqual([byId.talk.kind, byId.talk.title, byId.talk.projectName], [undefined, undefined, '项目甲'], 'a conversation has no job: the project\'s name only');
  assert.equal(byId.gone.projectName, undefined); assert.equal(byId.gone.title, undefined, 'a deleted project is no label, never an error');
  assert.equal(runLabeler(null)('x', 'p1'), null); assert.equal(runLabeler([{ id: 'p1' }])('x', 'p1') !== null, true);
  // A labeler that throws never fails the report.
  assert.equal(aggregateCacheUsage(ledger.rows, { now, runLabel: () => { throw new Error('boom'); } }).runs.length, 4);
  // Nothing about a run is written to the ledger rows.
  assert.equal(ledger.rows.every(row => !('title' in row) && !('runs' in row)), true);
});
