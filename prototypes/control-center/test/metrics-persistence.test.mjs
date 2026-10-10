// Plan 2026-10-05 B7: metrics persist outside the hot state, in `<state>.rna/metrics/`. The decision ledger is a sidecar
// (recent, index and labels moved out of state, migrated and re-migrated after a rollback without losing a row), usage
// rows fold into a daily rollup before the 7-day ledger drops them (30d/90d reports), windows are [since, until) in local
// days, archived projects show on request, misses carry a cause (pi detectMiss), and two outcome labels exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyRollup, metricsRoot } from '../metrics-rollup.mjs';
import { DecisionLedger, decisionLedgerFile, labelSourceOf, compactRow, FULL_ROWS, readDecisionLedger } from '../decision-ledger.mjs';
import { UsageLedger, aggregateCacheUsage, cacheMiss, outcomeLabels, cacheUsageResponse } from '../usage-cache-service.mjs';
import { windowRange, localDay, dayStart, addDays } from '../metric-windows.mjs';
import { experienceReport } from '../experience-report.mjs';
import { foldWakes, proactiveMetrics, proactiveMetricSeries, computeProactiveMetrics } from '../proactive-metrics.mjs';
import { createHostMetrics, rollupFile } from '../host-metrics.mjs';
import { turnJudgedFinished, settledRequests } from '../project-mind.mjs';
import { CHECKPOINT_SIDECARS, excludedSibling } from '../state-checkpoint.mjs';
import { instrument, LoopHistograms, routeName } from '../loop-histograms.mjs';
import { DecisionService } from '../decision-service.mjs';
import { DECISION_THRESHOLDS, stakeThreshold } from '../../../packages/sdk/src/decision-templates.mjs';

const DAY = 86400000, TZ = 'Asia/Shanghai';
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'rna-b7-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return { dir, stateFile: join(dir, 'state.json') }; };
const usage = (input, cacheRead = 0) => ({ input, output: 10, cacheRead, cacheWrite: 0, cacheUsageReported: true });

test('windows are whole local days, half open: "7d" is today and the six days before it, the previous window ends where it starts', () => {
  const now = Date.parse('2026-10-05T01:00:00Z'), range = windowRange('7d', { now, timeZone: TZ });
  assert.deepEqual(range.days, ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.equal(new Date(range.since).toISOString(), '2026-09-28T16:00:00.000Z'); assert.equal(new Date(range.until).toISOString(), '2026-10-05T16:00:00.000Z');
  assert.equal(localDay(Date.parse('2026-10-04T16:00:00Z'), TZ), '2026-10-05'); assert.equal(dayStart(addDays('2026-10-05', 1), TZ), range.until);
  assert.equal(windowRange('24h', { now }).since, now - DAY, 'hour windows roll');
  assert.throws(() => windowRange('5d', { now }), { status: 400 });
});

test('usage rows fold into the daily rollup before the 7-day ledger drops them: exactly once across a crash, and 30d/90d read both', t => {
  const { stateFile } = temp(t); let now = Date.parse('2026-10-05T04:00:00Z');
  const file = `${stateFile}.usage-cache.jsonl`, rollup = () => new DailyRollup({ file: join(metricsRoot(stateFile), 'usage-daily.json'), kind: 'usage', now: () => now, timeZone: TZ });
  let ledger = new UsageLedger({ file, now: () => now, rollup: rollup() });
  ledger.record({ purpose: 'foreground', projectId: 'p1', sessionId: 's', providerId: 'a', modelId: 'm', usage: usage(1000) });
  now += DAY; ledger.record({ purpose: 'initiative', projectId: 'p1', providerId: 'a', modelId: 'm', usage: usage(2000) });
  // Nine days later: the first two rows leave the ledger with the next record, folded first.
  now += 9 * DAY; ledger.record({ purpose: 'foreground', projectId: 'p1', sessionId: 's', providerId: 'a', modelId: 'm', usage: usage(500, 500) });
  assert.equal(ledger.rows.length, 1); assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3, 'the file keeps them until a rewrite');
  const report = window => aggregateCacheUsage(ledger.records(), { window, now, rollup: ledger.rollup, timeZone: TZ });
  assert.equal(report('30d').overall.requests, 3, '30 days: two from the rollup, one raw'); assert.equal(report('30d').byPurpose.initiative.requests, 1);
  assert.equal(report('7d').overall.requests, 1); assert.equal(report('90d').overall.input, report('30d').overall.input); assert.equal(report('30d').overall.input, 3500);
  assert.equal('cost' in report('30d').overall, false, 'no price in the report');
  assert.equal(report('30d').rollup.firstDay, '2026-10-05');
  // A crash before the rollup was written: the raw rows are still in the file and fold again, once.
  ledger = new UsageLedger({ file, now: () => now, rollup: rollup() });
  assert.equal(aggregateCacheUsage(ledger.records(), { window: '30d', now, rollup: ledger.rollup, timeZone: TZ }).overall.requests, 3);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'rewritten only after the rollup was on disk');
  // Restarting again neither loses nor double-counts.
  ledger = new UsageLedger({ file, now: () => now, rollup: rollup() });
  assert.equal(aggregateCacheUsage(ledger.records(), { window: '90d', now, rollup: ledger.rollup, timeZone: TZ }).overall.requests, 3);
  // A rollup written but a raw file never rewritten (a crash between the two): rows behind the watermark are skipped.
  const stale = `${JSON.stringify({ at: new Date(now - 9 * DAY).toISOString(), purpose: 'foreground', projectId: 'p1', input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, cacheReported: true })}\n`;
  writeFileSync(file, stale + readFileSync(file, 'utf8'));
  ledger = new UsageLedger({ file, now: () => now, rollup: rollup() });
  assert.equal(aggregateCacheUsage(ledger.records(), { window: '90d', now, rollup: ledger.rollup, timeZone: TZ }).overall.requests, 3);
  // A quiet stretch after the watermark is not a gap: a later restart, with no request since, records none.
  ledger.flush(); now += 2 * DAY; ledger = new UsageLedger({ file, now: () => now, rollup: rollup() }); ledger.flush();
  assert.deepEqual(ledger.rollup.gaps, []); assert.equal(aggregateCacheUsage(ledger.records(), { window: '90d', now, rollup: ledger.rollup, timeZone: TZ }).overall.requests, 3);
  // The rollup lives in the journal root; nothing new beside the state file.
  assert.ok(existsSync(rollupFile(stateFile, 'usage')));
  assert.doesNotMatch(readFileSync(rollupFile(stateFile, 'usage'), 'utf8'), /cost|amounts|priced/i, 'no price in the cells the rows were folded into');
  assert.throws(() => aggregateCacheUsage([], { window: '45d', now }), { status: 400 });
});

test('a usage rollup folded while rows were still priced reads without error: its cost cells are ignored and never shown, and the format markers stay as they were', t => {
  const { stateFile } = temp(t); let now = Date.parse('2026-10-05T04:00:00Z');
  const file = rollupFile(stateFile, 'usage');
  mkdirSync(metricsRoot(stateFile), { recursive: true });
  // The cell of an earlier 0.69 build (same version and fold): the counts plus its list-price `cost`, `estimatedCost` and per-miss `amounts`.
  const old = { k: { projectId: 'p1', purpose: 'foreground', providerId: 'a', modelId: 'm' }, v: { requests: 3, reported: 3, input: 3000, cacheRead: 6000, rawInput: 3000, rawCacheRead: 6000, output: 300, estimatedRequests: 1, estimatedInput: 500, estimatedOutput: 50,
    cost: { priced: 2, unpriced: 1, amounts: { USD: 0.0123 } }, estimatedCost: { priced: 1, amounts: { USD: 0.001 } }, miss: { idle: { n: 1, tokens: 9500, amounts: { USD: 0.00855 } } } } };
  writeFileSync(file, JSON.stringify({ version: 1, kind: 'usage', fold: 1, timeZone: TZ, updatedAt: new Date(now).toISOString(), marks: { usage: now - 8 * DAY }, raw: {}, gaps: [], timeZones: [], days: { '2026-09-20': [old] } }));
  const rollup = new DailyRollup({ file, kind: 'usage', now: () => now, timeZone: TZ });
  assert.equal(rollup.readOnly, null, 'the same format and fold: this release owns the file');
  const ledger = new UsageLedger({ file: `${stateFile}.usage-cache.jsonl`, now: () => now, rollup });
  const report = () => aggregateCacheUsage(ledger.records(), { window: '30d', now, rollup, timeZone: TZ });
  assert.deepEqual([report().overall.requests, report().overall.input, report().overall.cacheRead, report().overall.estimated.requests], [3, 3000, 6000, 1]);
  assert.deepEqual(report().overall.misses, { count: 1, tokens: 9500, byReason: { idle: { count: 1, tokens: 9500 } } });
  assert.doesNotMatch(JSON.stringify(report()), /cost|amounts|USD|priced/i, 'nothing priced reaches the report');
  // This release folds rows into the same file: the markers an older build (and a rollback) look at do not change, and its cells carry no price.
  ledger.record({ purpose: 'foreground', projectId: 'p1', sessionId: 's', providerId: 'a', modelId: 'm', usage: usage(700, 300) });
  now += 9 * DAY; ledger.record({ purpose: 'foreground', projectId: 'p1', sessionId: 's', providerId: 'a', modelId: 'm', usage: usage(10) });
  assert.equal(ledger.flush(), true);
  const written = JSON.parse(readFileSync(file, 'utf8')), fresh = Object.entries(written.days).filter(([day]) => day !== '2026-09-20');
  assert.deepEqual([written.version, written.kind, written.fold], [1, 'usage', 1]);
  assert.equal(fresh.length, 1); assert.equal(fresh[0][1][0].v.input, 700); assert.doesNotMatch(JSON.stringify(fresh), /cost|amounts|priced/i);
  assert.equal(aggregateCacheUsage(ledger.records(), { window: '30d', now, rollup, timeZone: TZ }).overall.requests, 5, 'the old cell still counts: three requests, plus the two of this release');
});

test('days a rolled-back release pruned without folding are one recorded gap, never guessed or counted twice', t => {
  const { stateFile } = temp(t); let now = Date.parse('2026-10-05T04:00:00Z');
  const file = `${stateFile}.usage-cache.jsonl`, rollup = () => new DailyRollup({ file: rollupFile(stateFile, 'usage'), kind: 'usage', now: () => now, timeZone: TZ });
  let ledger = new UsageLedger({ file, now: () => now, rollup: rollup() });
  for (let day = 0; day < 10; day++) { ledger.record({ purpose: 'foreground', projectId: 'p', usage: usage(100) }); now += DAY; }
  assert.equal(ledger.flush(), true, 'the host writes the rollup when it stops');
  const mark = ledger.rollup.mark('usage'), folded = aggregateCacheUsage(ledger.records(), { window: '30d', now, rollup: ledger.rollup, timeZone: TZ }).overall.requests;
  assert.equal(folded, 10); assert.ok(mark > 0);
  // Three days of an older release: it prunes rows past its 7 days and folds nothing (as 0.68.0 does), and records two more.
  now += 3 * DAY;
  const older = new UsageLedger({ file, now: () => now });
  older.record({ purpose: 'foreground', projectId: 'p', usage: usage(100) }); older.record({ purpose: 'foreground', projectId: 'p', usage: usage(100) });
  // The upgrade back notes the hole between the watermark and the raw retention, once however often it starts.
  for (let start = 0; start < 3; start++) { ledger = new UsageLedger({ file, now: () => now, rollup: rollup() }); ledger.flush(); }
  assert.deepEqual(ledger.rollup.gaps, [{ source: 'usage', from: new Date(mark).toISOString(), to: new Date(now - 7 * DAY).toISOString() }]);
  const report = aggregateCacheUsage(ledger.records(), { window: '30d', now, rollup: ledger.rollup, timeZone: TZ });
  assert.equal(report.overall.requests, 10 - 4 + 2, 'the four rows (days 2–5) the older release deleted unfolded are missing, nothing else');
  assert.equal(report.rollup.gaps.length, 1);
});

test('a cache miss carries its cause, above pi\'s 1,024-token noise floor; a summary resets the comparison; the tokens re-billed ride into the daily rollup', t => {
  const row = (continuity, extra = {}) => ({ purpose: 'foreground', sessionId: 's', providerId: 'a', modelId: 'm', prefixKey: 'p'.repeat(16), input: 9000, cacheRead: 1000, cacheWrite: 0, cacheReported: true, continuity, ...extra });
  const previous = { purpose: 'foreground', providerId: 'a', modelId: 'm', prefixKey: 'p'.repeat(16) };
  assert.deepEqual(cacheMiss(row({ continuous: true, gapMs: 600000, previousPromptTokens: 10000 }), previous, { coldAfterMs: 300000 }), { reason: 'idle', tokens: 9000 });
  assert.deepEqual(cacheMiss(row({ continuous: true, gapMs: 60000, previousPromptTokens: 10000 }), previous, { coldAfterMs: 300000 }), { reason: 'eviction', tokens: 9000 });
  assert.deepEqual(cacheMiss(row({ continuous: true, gapMs: 600000, previousPromptTokens: 10000, bridged: true }), previous, { coldAfterMs: 300000 }), { reason: 'eviction', tokens: 9000 }, 'pings kept it warm');
  assert.deepEqual(cacheMiss(row({ continuous: false, gapMs: 1000, previousPromptTokens: 10000 }), { ...previous, modelId: 'other' }), { reason: 'model', tokens: 9000 });
  assert.deepEqual(cacheMiss(row({ continuous: false, gapMs: 1000, previousPromptTokens: 10000 }), { ...previous, prefixKey: 'q'.repeat(16) }), { reason: 'prefix', tokens: 9000 });
  assert.deepEqual(cacheMiss(row({ continuous: false, gapMs: 1000, previousPromptTokens: 10000, edited: { comparableTokens: 6000 } }), previous), { reason: 'history_edit', tokens: 5000 });
  assert.deepEqual(cacheMiss(row({ continuous: false, gapMs: 1000, previousPromptTokens: 10000 }), previous), { reason: 'history_rewrite', tokens: 9000 });
  assert.deepEqual(cacheMiss(row({ continuous: true, gapMs: 600000, previousPromptTokens: 10000 }), previous), { reason: 'unknown', tokens: 9000 }, 'no known lifetime');
  assert.equal(cacheMiss(row({ continuous: true, gapMs: 1000, previousPromptTokens: 1500 }), previous), null, 'under the noise floor');
  assert.equal(cacheMiss(row({ continuous: false, gapMs: 1000, previousPromptTokens: 10000 }), { ...previous, purpose: 'compaction' }), null, 'after a summary the prompt is new content');
  assert.equal(cacheMiss(row({ continuous: true, gapMs: 1000, previousPromptTokens: 10000 }, { purpose: 'compaction' }), previous), null, 'a summary is not a conversation request');
  // Recorded at write time and summed per bucket.
  let now = Date.parse('2026-10-05T04:00:00Z');
  const ledger = new UsageLedger({ now: () => now });
  ledger.record({ purpose: 'foreground', sessionId: 's', providerId: 'a', modelId: 'm', usage: usage(10000) });
  now += 600000; ledger.record({ purpose: 'foreground', sessionId: 's', providerId: 'a', modelId: 'm', ttlMs: 300000, prefixKey: 'p'.repeat(16), usage: usage(9500, 500), continuity: { continuous: true, gapMs: 600000, previousPromptTokens: 10000 } });
  assert.deepEqual(ledger.rows[1].miss, { reason: 'idle', tokens: 9500 });
  assert.deepEqual(aggregateCacheUsage(ledger.rows, { window: '1h', now }).overall.misses, { count: 1, tokens: 9500, byReason: { idle: { count: 1, tokens: 9500 } } });
  // The tokens re-billed ride into the daily rollup when the row leaves the 7-day ledger (no price is computed or kept).
  const { stateFile } = temp(t), rollup = new DailyRollup({ file: join(metricsRoot(stateFile), 'usage-daily.json'), kind: 'usage', now: () => now, timeZone: TZ });
  const kept = new UsageLedger({ file: `${stateFile}.usage-cache.jsonl`, now: () => now, rollup });
  kept.record({ purpose: 'foreground', sessionId: 's', providerId: 'a', modelId: 'm', usage: usage(10000) });
  now += 600000; kept.record({ purpose: 'foreground', sessionId: 's', providerId: 'a', modelId: 'm', ttlMs: 300000, prefixKey: 'p'.repeat(16), usage: usage(9500, 500), continuity: { continuous: true, gapMs: 600000, previousPromptTokens: 10000 } });
  now += 8 * DAY; kept.record({ purpose: 'foreground', sessionId: 's2', providerId: 'a', modelId: 'm', usage: usage(10) });
  assert.equal(kept.rows.length, 1, 'the two older rows left the ledger');
  assert.deepEqual(aggregateCacheUsage(kept.records(), { window: '30d', now, rollup, timeZone: TZ }).overall.misses, { count: 1, tokens: 9500, byReason: { idle: { count: 1, tokens: 9500 } } });
});

test('outcome labels: a ping paid when its conversation next read the cache it kept; an idle summary\'s conversation came back within 7 days', () => {
  const now = Date.parse('2026-10-05T04:00:00Z'), at = minutes => new Date(now - minutes * 60000).toISOString();
  const rows = [
    { at: at(60), purpose: 'foreground', sessionId: 'a', cacheReported: true, input: 10, cacheRead: 9000 },
    { at: at(56), purpose: 'foreground', sessionId: 'a', keepAlive: true, cacheReported: true, cacheRead: 9000 },
    { at: at(52), purpose: 'foreground', sessionId: 'a', keepAlive: true, cacheReported: true, cacheRead: 9000 },
    { at: at(50), purpose: 'foreground', sessionId: 'a', cacheReported: true, input: 10, cacheRead: 9000 },
    { at: at(40), purpose: 'foreground', sessionId: 'b', keepAlive: true, cacheReported: true, cacheRead: 9000 },
    { at: at(30), purpose: 'foreground', sessionId: 'b', cacheReported: true, input: 9000, cacheRead: 0 },
    { at: at(20), purpose: 'foreground', sessionId: 'c', keepAlive: true, cacheReported: true, cacheRead: 9000 },
    { at: at(60 * 24 * 8), purpose: 'compaction', trigger: 'idle', sessionId: 'd' },
    { at: at(60 * 24 * 7.5), purpose: 'foreground', sessionId: 'd', cacheReported: true, input: 10 },
    { at: at(60 * 24 * 7.9), purpose: 'compaction', trigger: 'idle', sessionId: 'e' },
    { at: at(60), purpose: 'compaction', trigger: 'idle', sessionId: 'f' },
  ];
  const labels = outcomeLabels(rows, { now });
  assert.deepEqual(rows.map(row => labels.get(row) ?? null), [null, 'wasted', 'worth', null, 'wasted', null, 'open', 'returned', null, 'not_returned', 'open']);
  const report = aggregateCacheUsage(rows.filter(row => Date.parse(row.at) > now - 3600000 * 2), { window: '24h', now, reference: rows });
  assert.deepEqual(report.keepAlive.outcomes, { worth: 1, wasted: 2, open: 1, worthRate: .333 });
  assert.deepEqual(report.idleCompaction, { returned: 0, notReturned: 0, open: 1, returnRate: null });
});

test('the decision ledger moves out of state once, keeps rows a rolled-back release wrote, and loses none across rollback and upgrade', t => {
  const { stateFile } = temp(t); let now = Date.parse('2026-10-05T04:00:00Z');
  const row = (id, at, extra = {}) => ({ id, at, point: 'initiative.review', backend: 'typesafe', source: 'judge', mode: 'active', reason: 'accepted', scope: { projectId: 'p' }, disposition: 'deferred', policy: { yes: .8 }, answers: { needs_main_model: { type: 'boolean', probability: .1 } }, predictions: { needs_main_model: .1 }, decided: true, latencyMs: 200, networkAttempted: true, execution: { latencyClass: 'inline' }, ...extra });
  // What 0.68.0 leaves in state: the 200-row window, the 30-day index (with rows that left the window) and labels.
  const day = new Date(now).toISOString().slice(0, 10), store = { file: stateFile, state: { decisionKernelRuntime: { metrics: { requests: 7 }, recent: [row('r2', now - 2000), row('r3', now - 1000, { label: { value: 'wake_unneeded', at: now } })],
    index: { [day]: [{ id: 'r1', point: 'initiative.review', at: now - 3000, source: 'rule', projectId: 'p' }, { id: 'r2', point: 'initiative.review', at: now - 2000, source: 'judge', projectId: 'p' }] }, labels: { r1: { value: 'defer_right', at: now } } } }, mutate(fn) { return fn(this.state); } };
  const ledger = new DecisionLedger({ file: decisionLedgerFile(stateFile), now: () => now });
  assert.equal(ledger.absorb(store), 3);
  assert.deepEqual(store.state.decisionKernelRuntime.recent, [], 'an older release appends to this array after a rollback'); assert.equal(store.state.decisionKernelRuntime.index, undefined); assert.equal(store.state.decisionKernelRuntime.labels, undefined);
  assert.equal(store.state.decisionKernelRuntime.metrics.requests, 7);
  assert.deepEqual(ledger.rows().map(value => [value.id, value.label?.value ?? null, value.label?.source ?? null]), [['r1', 'defer_right', 'self'], ['r2', null, null], ['r3', 'wake_unneeded', 'self']]);
  assert.equal(ledger.absorb(store), 0, 'idempotent');
  // This release writes on; then a rollback to 0.68.0 appends to state as it always did, and labels its own rows only.
  ledger.add(row('n1', now + 1000)); ledger.label('n1', 'delivery_replied');
  now += 60000;
  store.state.decisionKernelRuntime.recent.push(row('old1', now)); store.state.decisionKernelRuntime.index = { [day]: [{ id: 'old1', point: 'initiative.review', at: now, source: 'judge', projectId: 'p' }, { id: 'old0', point: 'initiative.review', at: now - 10, source: 'rule', projectId: 'p' }] };
  store.state.decisionKernelRuntime.labels = { old1: { value: 'wake_needed_work', at: now } };
  // The upgrade back: a new process reads the file and absorbs what the older release wrote.
  const again = new DecisionLedger({ file: decisionLedgerFile(stateFile), now: () => now });
  assert.equal(again.absorb(store), 2);
  assert.deepEqual(again.rows().map(value => value.id), ['r1', 'r2', 'r3', 'n1', 'old0', 'old1'], 'no row lost on either side');
  assert.deepEqual(readDecisionLedger(decisionLedgerFile(stateFile)).map(value => [value.id, value.label?.value ?? null]), again.rows().map(value => [value.id, value.label?.value ?? null]), 'what a read-only reader of the file sees');
  assert.equal(again.get('n1').label.source, 'outcome'); assert.equal(again.get('old1').label.value, 'wake_needed_work');
  assert.deepEqual(store.state.decisionKernelRuntime.recent, []);
  // Lines a later release writes survive this one's rewrites (rollback safety, ACC-7).
  appendFileSync(decisionLedgerFile(stateFile), `${JSON.stringify({ t: 'future', at: now, id: 'x' })}\n`);
  const third = new DecisionLedger({ file: decisionLedgerFile(stateFile), now: () => now }); third.rewrite();
  assert.match(readFileSync(decisionLedgerFile(stateFile), 'utf8'), /"t":"future"/);
  // A failed write leaves state as it was: nothing is lost.
  const { dir } = temp(t); writeFileSync(join(dir, 'x'), '');
  const blocked = { state: { decisionKernelRuntime: { recent: [row('z', now)] } }, mutate(fn) { return fn(this.state); } };
  assert.equal(new DecisionLedger({ file: join(dir, 'x', 'ledger.jsonl'), now: () => now }).absorb(blocked), 0);
  assert.equal(blocked.state.decisionKernelRuntime.recent.length, 1);
});

test('a ledger that failed to write absorbed rows keeps them in state through every later absorb until a write lands (B7 review 1)', t => {
  const { dir } = temp(t); const now = Date.parse('2026-10-05T04:00:00Z');
  writeFileSync(join(dir, 'x'), ''); // a file where the metrics folder should be: every write fails
  const row = (id, at) => ({ id, at, point: 'turn.route', source: 'judge', scope: {} });
  const store = { state: { decisionKernelRuntime: { recent: [row('r1', now - 1000), row('r2', now - 500)], index: {}, labels: { r2: { value: 'wake_unneeded', at: now } } } }, mutate(fn) { return fn(this.state); } };
  const file = join(dir, 'x', 'ledger.jsonl'), ledger = new DecisionLedger({ file, now: () => now });
  assert.equal(ledger.absorb(store), 0); assert.equal(store.state.decisionKernelRuntime.recent.length, 2);
  // The rows are in memory now, so a second absorb imports nothing new; it must still not let state forget them.
  assert.equal(ledger.absorb(store), 0);
  ledger.add(row('n1', now)); assert.equal(ledger.absorb(store), 0, 'nor after a judgment (record() absorbs before it adds)');
  assert.deepEqual(store.state.decisionKernelRuntime.recent.map(value => value.id), ['r1', 'r2']); assert.ok(store.state.decisionKernelRuntime.labels.r2);
  assert.equal(existsSync(file), false);
  // A restart before the disk recovers reads nothing from the file, and state still has every row.
  assert.deepEqual(new DecisionLedger({ file, now: () => now }).rows(), []);
  // The disk recovers: the next absorb writes them, then clears state; a restart reads them back.
  rmSync(join(dir, 'x')); ledger.absorb(store);
  assert.deepEqual(store.state.decisionKernelRuntime.recent, []); assert.equal(store.state.decisionKernelRuntime.labels, undefined);
  assert.deepEqual(new DecisionLedger({ file, now: () => now }).rows().map(value => [value.id, value.label?.value ?? null]), [['r1', null], ['r2', 'wake_unneeded'], ['n1', null]]);
});

test('a decision rollup that cannot be written does not fold the leaving rows again on the next prune, and the file keeps them meanwhile (B7 review 3)', t => {
  const { dir } = temp(t); let now = Date.parse('2026-10-05T04:00:00Z');
  mkdirSync(join(dir, 'm')); writeFileSync(join(dir, 'blocked'), '');
  const rollupPath = join(dir, 'blocked', 'decisions-daily.json'), file = join(dir, 'm', 'decision-ledger.jsonl');
  const rollup = new DailyRollup({ file: rollupPath, kind: 'decisions', now: () => now, timeZone: TZ });
  const ledger = new DecisionLedger({ file, now: () => now, rollup }), judgment = id => ({ id, at: now, point: 'turn.route', source: 'judge', scope: {} });
  const folded = value => value.cells({}).reduce((sum, cell) => sum + (cell.v.decisions ?? 0), 0);
  ledger.add(judgment('a'));
  now += 33 * DAY; ledger.add(judgment('b'));
  now += 1000; ledger.add(judgment('c'));
  now += 1000; ledger.prune({ rewrite: true });
  assert.equal(folded(rollup), 1, 'one expired row, folded once however often prune runs');
  assert.deepEqual(ledger.rows().map(row => row.id), ['b', 'c']);
  assert.match(readFileSync(file, 'utf8'), /"id":"a"/, 'the file keeps the row until the rollup holding it is on disk');
  // A restart before the rollup could be written: the older rollup (none) and the file's row fold it once more, once.
  const fresh = new DailyRollup({ file: rollupPath, kind: 'decisions', now: () => now, timeZone: TZ });
  new DecisionLedger({ file, now: () => now, rollup: fresh });
  assert.equal(folded(fresh), 1);
  // The disk recovers: the rollup lands with one count, then the file drops the row; a restart reads both and counts it once.
  rmSync(join(dir, 'blocked')); mkdirSync(join(dir, 'blocked'));
  assert.equal(ledger.prune({ rewrite: true }), true);
  assert.equal(folded(new DailyRollup({ file: rollupPath, kind: 'decisions', now: () => now, timeZone: TZ })), 1);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /"id":"a"/);
  const after = new DailyRollup({ file: rollupPath, kind: 'decisions', now: () => now, timeZone: TZ });
  assert.deepEqual(new DecisionLedger({ file, now: () => now, rollup: after }).rows().map(row => row.id), ['b', 'c']); assert.equal(folded(after), 1);
});

test('a rollup a later release wrote (newer format or fold, or another kind) is never replaced: this release reads none of it and writes nothing (B7 review 2)', t => {
  const { stateFile } = temp(t); let now = Date.parse('2026-10-05T04:00:00Z');
  const later = kind => JSON.stringify({ version: 1, kind, fold: 2, timeZone: TZ, marks: { usage: now - 8 * DAY, decisions: now - 32 * DAY }, raw: {}, gaps: [], days: { '2025-11-01': [{ k: { purpose: 'foreground', projectId: 'p1', shape: 'later' }, v: { requests: 40, later: { nested: 1 } } }] } });
  mkdirSync(metricsRoot(stateFile), { recursive: true });
  for (const kind of ['usage', 'decisions', 'wakes']) writeFileSync(rollupFile(stateFile, kind), later(kind));
  const before = kind => readFileSync(rollupFile(stateFile, kind), 'utf8'), saved = Object.fromEntries(['usage', 'decisions', 'wakes'].map(kind => [kind, before(kind)]));
  const store = { file: stateFile, state: { projects: [{ id: 'p1', mind: { pacing: { wake: { history: [{ at: new Date(now - 1000).toISOString(), outcome: 'work' }] } } } }] } };
  const metrics = createHostMetrics(store, { now: () => now, timeZone: TZ, wakeFlushMs: 0 });
  assert.equal(metrics.usage.readOnly, 'newer_version'); assert.equal(metrics.usage.mark('usage'), null, 'nothing of it is read'); assert.deepEqual(metrics.usage.cells({}), []);
  const usageLedger = new UsageLedger({ file: `${stateFile}.usage-cache.jsonl`, now: () => now, rollup: metrics.usage });
  usageLedger.record({ purpose: 'foreground', projectId: 'p1', sessionId: 's', providerId: 'a', modelId: 'm', usage: usage(1000) });
  metrics.ledger.add({ id: 'd1', at: now, point: 'turn.route', source: 'judge', scope: { projectId: 'p1' } });
  // Rows expire: they leave as they would from a release without a rollup; the later release finds the hole when it is back.
  now += 40 * DAY; usageLedger.record({ purpose: 'foreground', projectId: 'p1', sessionId: 's', providerId: 'a', modelId: 'm', usage: usage(500, 500) });
  metrics.ledger.add({ id: 'd2', at: now, point: 'turn.route', source: 'judge', scope: { projectId: 'p1' } });
  usageLedger.prune(true, true); metrics.ledger.prune({ rewrite: true });
  assert.deepEqual(usageLedger.rows.map(row => row.input), [500]); assert.deepEqual(metrics.ledger.rows().map(row => row.id), ['d2']);
  metrics.close(); usageLedger.flush();
  for (const kind of ['usage', 'decisions', 'wakes']) assert.equal(before(kind), saved[kind], `${kind}-daily.json is untouched`);
  // A 30-day report says the rollup could not be read instead of passing the raw week off as thirty days.
  const report = aggregateCacheUsage(usageLedger.records(), { window: '30d', now, rollup: metrics.usage, timeZone: TZ });
  assert.deepEqual(report.rollup, { unavailable: 'newer_version' }); assert.equal(report.overall.requests, 1);
  assert.equal(aggregateCacheUsage(usageLedger.records(), { window: '7d', now, rollup: metrics.usage, timeZone: TZ }).rollup, undefined, 'the raw week covers 7 days');
  // Another kind in the file is not this release's to replace either; an older fold of its own kind still is (the upgrade path).
  writeFileSync(rollupFile(stateFile, 'usage'), JSON.stringify({ version: 1, kind: 'wakes', fold: 1, days: {} }));
  assert.equal(new DailyRollup({ file: rollupFile(stateFile, 'usage'), kind: 'usage', now: () => now, timeZone: TZ }).readOnly, 'other_kind');
  writeFileSync(rollupFile(stateFile, 'usage'), JSON.stringify({ version: 2, kind: 'usage', fold: 1, days: {} }));
  assert.equal(new DailyRollup({ file: rollupFile(stateFile, 'usage'), kind: 'usage', now: () => now, timeZone: TZ }).readOnly, 'newer_version');
  writeFileSync(rollupFile(stateFile, 'usage'), JSON.stringify({ version: 1, kind: 'usage', fold: 0, days: { '2026-01-01': [] } }));
  const older = new DailyRollup({ file: rollupFile(stateFile, 'usage'), kind: 'usage', now: () => now, timeZone: TZ });
  assert.equal(older.readOnly, null); assert.equal(older.flush(), true); assert.equal(JSON.parse(before('usage')).fold, 1);
});

test('calibration views: exclude is include minus archived projects and conversations; rows known only from an older index are counted apart (B7 review 4, 7)', () => {
  const now = Date.parse('2026-10-05T04:00:00Z');
  const store = { state: { configuration: { decisionKernel: {} }, settings: {}, projects: [{ id: 'live' }, { id: 'shelved', archivedAt: '2026-10-01T00:00:00Z' }, { id: 'sim', simulated: true }], sessions: [{ id: 's-archived', projectId: 'live', archivedAt: '2026-10-02T00:00:00Z' }, { id: 's-live', projectId: 'live' }],
    // What 0.68.0 left: one judgment only in its 30-day index (id, point, source, project; nothing it was scored by).
    decisionKernelRuntime: { recent: [], index: { '2026-10-05': [{ id: 'i1', point: 'session.resume', at: now - 50, source: 'judge', projectId: 'live' }] } } }, configurationService: { secrets: {} }, mutate(fn) { return fn(this.state); } };
  const service = new DecisionService(store, { now: () => now, kernelFactory: () => ({ close() {} }) });
  const row = (id, scope) => ({ id, at: now - 100, point: 'session.resume', source: 'judge', mode: 'active', reason: 'accepted', scope, answers: { returns_soon: { type: 'boolean', probability: .9 } }, predictions: { returns_soon: .9 }, decided: true });
  for (const [id, scope] of [['plain', {}], ['live', { projectId: 'live' }], ['deleted', { projectId: 'deleted-project' }], ['simulated', { projectId: 'sim' }], ['session-only', { sessionId: 's-live' }], ['archived-project', { projectId: 'shelved' }], ['archived-session', { projectId: 'live', sessionId: 's-archived' }]]) service.ledgerStore.add(row(id, scope));
  const report = archived => service.calibration({ window: '7d', archived });
  assert.equal(report('include').decisions, 7); assert.equal(report('exclude').decisions, 5, 'everything but the archived project\'s and the archived conversation\'s'); assert.equal(report('only').decisions, 2);
  // The index-only row is a decision that happened, not a calibration row: no `unknown` reason or mode, counted apart.
  const all = report('include');
  assert.equal(all.indexOnly, 1); assert.deepEqual(all.unscoredReasons, {}); assert.deepEqual(all.modes, { active: 7 }); assert.equal(all.scored, 7);
  assert.equal(all.points['session.resume'].indexOnly, 1);
  assert.equal(service.calibrationSummary()['session.resume'].decisions, 7);
});

test('compact rows keep what calibration and labels read; a turn.settled verdict is read back from them', () => {
  const full = { id: 'x', at: 1, point: 'turn.settled', backend: 'typesafe', source: 'judge', mode: 'active', scope: { projectId: 'p', turnId: 't1', revision: 'r' }, answers: { instruction_complete: { type: 'boolean', probability: .97 }, deferred_without_cause: { type: 'boolean', probability: .02 } }, predictions: { instruction_complete: .97, deferred_without_cause: .02 }, policy: { yes: .8 }, execution: {}, assessmentDisplay: [], outcome: { continue: false } };
  const compact = compactRow(full);
  assert.deepEqual(Object.keys(compact).sort(), ['at', 'backend', 'compact', 'id', 'mode', 'outcome', 'point', 'predictions', 'scope', 'scored', 'source']);
  assert.deepEqual(compact.scope, { projectId: 'p', turnId: 't1' });
  assert.deepEqual(turnJudgedFinished({}, 't1', { rows: [compact] }), { ledgerId: 'x' }, 'the compact form still settles the request');
  assert.equal(turnJudgedFinished({}, 't1', { rows: [{ ...compact, predictions: { instruction_complete: .4 } }] }), null);
  assert.equal(FULL_ROWS, 200);
  assert.equal(labelSourceOf('wake_needed_share'), 'self'); assert.equal(labelSourceOf('gene_active'), 'heuristic'); assert.equal(labelSourceOf('returned'), 'outcome');
});

test('B5 + B7: the verdict stored on the turn (MIND-19) is read before the ledger rows, in either form; the rows decide only for a turn without one', t => {
  const { stateFile } = temp(t), now = Date.parse('2026-10-05T04:00:00Z');
  const full = { id: 'L-full', at: now - 1000, point: 'turn.settled', backend: 'typesafe', source: 'judge', mode: 'active', scope: { projectId: 'p', turnId: 't1' }, answers: { instruction_complete: { type: 'boolean', probability: .97 }, deferred_without_cause: { type: 'boolean', probability: .02 } }, predictions: { instruction_complete: .97, deferred_without_cause: .02 } };
  const compact = compactRow(full), unsure = { ...compactRow({ ...full, id: 'L-unsure' }), predictions: { instruction_complete: .4, deferred_without_cause: .02 } };
  const turn = { id: 't1' }, state = { sessions: [{ id: 's', projectId: 'p', turns: [turn], items: [] }] };
  // No stored verdict: the ledger rows, full or compact, decide.
  assert.deepEqual(turnJudgedFinished(state, 't1', { rows: [full] }), { ledgerId: 'L-full' });
  assert.deepEqual(turnJudgedFinished(state, 't1', { rows: [compact] }), { ledgerId: 'L-full' }, 'the compact form');
  assert.equal(turnJudgedFinished(state, 't1', { rows: [unsure] }), null);
  // A stored "not finished" wins over a ledger row that says finished, full or compact.
  turn.settledVerdict = { finished: false, complete: false, waiting: true, deferred: null };
  for (const rows of [[full], [compact]]) assert.equal(turnJudgedFinished(state, 't1', { rows }), null, 'the stored verdict first');
  assert.equal(turnJudgedFinished(state, 't1', { turn, rows: [compact] }), null, 'and from the turn the caller passes');
  // A stored "finished" settles with no ledger row at all (the row aged out of the 31 days, or was never kept).
  turn.settledVerdict = { finished: true, complete: true, waiting: false, deferred: false, ledgerId: 'L-stored' };
  assert.deepEqual(turnJudgedFinished(state, 't1', { rows: [unsure] }), { ledgerId: 'L-stored' });
  assert.deepEqual(turnJudgedFinished(state, 't1', { rows: [] }), { ledgerId: 'L-stored' });
  // settledRequests reads the same order through the ledger rows it is given (the mind passes ledgerRows).
  const project = { id: 'p', mind: { lessons: [], commitments: [{ id: 'c1', status: 'pending', trigger: 'user_request', request: 'Rewrite chapter one.', source: { kind: 'capture', sessionId: 's', itemId: 'u1', turnId: 't1' } }] } };
  turn.settledVerdict = { finished: false, complete: false, waiting: true, deferred: null };
  assert.deepEqual(settledRequests(state, project, [full]), [], 'stored "not finished" keeps the request owed');
  delete turn.settledVerdict;
  assert.deepEqual(settledRequests(state, project, [compact]).map(row => [row.id, row.by.ledgerId]), [['c1', 'L-full']], 'without one the compact ledger row settles it');
  // Through a ledger file (rows past the newest 200 are compact): the same answer after a reload.
  const ledger = new DecisionLedger({ file: decisionLedgerFile(stateFile), now: () => now, fullRows: 0 });
  ledger.add(full); assert.equal(ledger.get('L-full').compact, true);
  assert.deepEqual(turnJudgedFinished(state, 't1', { rows: new DecisionLedger({ file: decisionLedgerFile(stateFile), now: () => now, fullRows: 0 }).rows() }), { ledgerId: 'L-full' });
  turn.settledVerdict = { finished: false };
  assert.equal(turnJudgedFinished(state, 't1', { rows: ledger.rows() }), null);
});

test('a compact turn.settled row whose rounded predictions sit on a threshold settles nothing the full row would not (B5: an abstention changes nothing)', t => {
  const { stateFile } = temp(t), now = Date.parse('2026-10-05T04:00:00Z');
  const t1 = DECISION_THRESHOLDS.points['turn.settled'];
  assert.equal(stakeThreshold(t1.unfinished), .85); assert.equal(stakeThreshold(t1.deferred), .75);
  // A row as decision-service records it: answers at full precision, predictions rounded to 3 decimals.
  const row = (id, complete, deferred, backend = 'typesafe') => ({ id, at: now - 1000, point: 'turn.settled', backend, source: 'judge', mode: 'active', scope: { projectId: 'p', turnId: id },
    answers: { instruction_complete: { type: 'boolean', probability: complete }, deferred_without_cause: { type: 'boolean', probability: deferred } },
    predictions: { instruction_complete: Math.round(complete * 1000) / 1000, deferred_without_cause: Math.round(deferred * 1000) / 1000 } });
  const read = (value, rows) => turnJudgedFinished({}, value.id, { rows });
  // The judge abstained (0.8496 is under .85); the compact form rounds it onto .850 and must still abstain.
  const unsure = row('t-unsure', .8496, .02);
  assert.equal(read(unsure, [unsure]), null);
  assert.equal(compactRow(unsure).predictions.instruction_complete, .85);
  assert.equal(read(unsure, [compactRow(unsure)]), null, 'a rounded prediction on the threshold is not "finished"');
  // The judge said "put off without cause" (0.7502 ≥ .75); rounded onto .750 the compact form must not settle either.
  const deferred = row('t-deferred', .97, .7502);
  assert.equal(read(deferred, [deferred]), null);
  assert.equal(read(deferred, [compactRow(deferred)]), null, 'a rounded deferral on the threshold still holds the request');
  // On the LLM backend (every tier raised by .1) the same holds at its own threshold.
  const llm = row('t-llm', .9496, .02, 'llm');
  assert.equal(read(llm, [llm]), null); assert.equal(read(llm, [compactRow(llm)]), null);
  // Clear of the threshold by a rounding step, the compact form reads as the full row does.
  for (const sure of [row('t-sure', .8514, .7484), row('t-clear', .97, .02)]) {
    assert.deepEqual(read(sure, [sure]), { ledgerId: sure.id });
    assert.deepEqual(read(sure, [compactRow(sure)]), { ledgerId: sure.id });
  }
  // Through the ledger file (fullRows 0: every row compact) and settledRequests, as the upkeep sweep reads them.
  const ledger = new DecisionLedger({ file: decisionLedgerFile(stateFile), now: () => now, fullRows: 0 });
  for (const value of [unsure, deferred, row('t-sure', .8514, .7484)]) ledger.add(value);
  const rows = new DecisionLedger({ file: decisionLedgerFile(stateFile), now: () => now, fullRows: 0 }).rows();
  assert.ok(rows.every(value => value.compact === true && !value.answers));
  const commitment = turnId => ({ id: `c-${turnId}`, status: 'pending', trigger: 'user_request', request: 'Rewrite chapter one.', source: { kind: 'capture', sessionId: 's', itemId: `u-${turnId}`, turnId } });
  const turns = ['t-unsure', 't-deferred', 't-sure'], state = { sessions: [{ id: 's', projectId: 'p', turns: turns.map(id => ({ id })), items: [] }] };
  const project = { id: 'p', mind: { lessons: [], commitments: turns.map(commitment) } };
  assert.deepEqual(settledRequests(state, project, rows).map(value => [value.id, value.by.ledgerId]), [['c-t-sure', 't-sure']], 'only the request the judge was sure about settles');
});

test('B3 + B7: the local-day windows keep B3\'s one classifier: status rows are never messages, quiet-tier deliveries never unanswered, votes on status rows never engagement', () => {
  const now = Date.parse('2026-10-05T04:00:00Z'), at = (day, hour) => new Date(dayStart(day, TZ) + hour * 3600000).toISOString();
  const share = (id, createdAt, extra = {}) => ({ id, kind: 'assistant', source: 'initiative', text: `finding ${id}`, createdAt, initiativeActionId: `act-${id}`, initiative: { kind: 'insight', reach: 'inline' }, ...extra });
  const status = (id, createdAt, initiative, key = `${id}-changes`, extra = {}) => ({ id, kind: 'assistant', source: 'initiative', text: `status ${id}`, createdAt, initiativeActionId: key, initiative: { kind: 'insight', reach: 'inbox', ...initiative }, ...extra });
  const items = [
    // 10-03: four interrupting shares between status rows and a filed (inbox-tier) share, then the user, then one more.
    share('a', at('2026-10-03', 9)), status('w1', at('2026-10-03', 9.5), { backgroundWork: { actionId: 'w1', status: 'done' } }), share('b', at('2026-10-03', 10)),
    share('f', at('2026-10-03', 10.5), { initiative: { kind: 'insight', reach: 'inbox', filedAt: at('2026-10-03', 10.5) } }), status('r', at('2026-10-03', 11), {}, 'a2-changes-revert'),
    share('c', at('2026-10-03', 11.5)), status('t', at('2026-10-03', 11.7), { kind: 'thread_close', reach: 'inline', threadId: 't1' }, undefined), share('c2', at('2026-10-03', 12)),
    { id: 'u', kind: 'user', text: 'ok', createdAt: at('2026-10-03', 13) }, share('d', at('2026-10-03', 14)),
    // 10-04: a digest (quiet), a version-control line, a share the user liked, a work line the user disliked.
    share('g', at('2026-10-04', 9), { initiative: { kind: 'digest', reach: 'digest' } }), status('gl', at('2026-10-04', 9.2), { backgroundChange: 'change-1' }),
    share('e', at('2026-10-04', 10), { feedback: { vote: 'up' } }), status('w2', at('2026-10-04', 11), { backgroundWork: { actionId: 'w2', status: 'done' } }, undefined, { feedback: { vote: 'down' } }),
    // 10-05: one share and a work line.
    share('h', at('2026-10-05', 1)), status('w3', at('2026-10-05', 2), { backgroundWork: { actionId: 'w3', status: 'running' } }),
  ];
  const project = { id: 'p', inbox: [], mind: {} }, sessions = [{ id: 's', projectId: 'p', items }];
  const series = proactiveMetricSeries(project, sessions, { now, window: '7d', timeZone: TZ }), daily = key => series.metrics[key].series.map(cell => cell.value);
  assert.equal(series.delivered, 9, 'nine deliveries (two quiet ones among them); none of the six status rows');
  assert.deepEqual(daily('proactiveDelivered'), [0, 0, 0, 0, 6, 2, 1]);
  assert.deepEqual(daily('longestUnrepliedChain'), [0, 0, 0, 0, 4, 1, 1], 'per local day: the filed share and the status rows never extend a run');
  assert.equal(series.longestUnrepliedChain, 4, 'over the window: a, b, c, c2 before the user\'s reply');
  assert.equal(series.currentUnrepliedChain, 3, 'since the reply: d, e, h (the digest asks for no reply)');
  assert.equal(series.usefulShareRate, 1, 'the vote on a work line is not engagement with a message');
  // A rolling or one-day window reads the same rule.
  const today = computeProactiveMetrics({ projects: [project], sessions }, 'p', { now, window: '1d', timeZone: TZ });
  assert.deepEqual([today.delivered, today.longestUnrepliedChain, today.currentUnrepliedChain], [1, 1, 3]);
  const rolling = proactiveMetrics(project, sessions, { now, windowMs: 3 * DAY });
  assert.deepEqual([rolling.delivered, rolling.longestUnrepliedChain], [9, 4]);
});

test('the experience report counts a week of wakes from the rollup, not the 50 the history keeps; archived projects on request', t => {
  const now = Date.parse('2026-10-05T04:00:00Z'), hours = n => new Date(now - n * 3600000).toISOString();
  // 120 wakes over the last six days, as the pacing history would have recorded them one by one.
  const all = Array.from({ length: 120 }, (_, index) => ({ at: hours(140 - index), outcome: index % 3 ? 'thought' : 'work', tokens: 1000, ...(index % 10 === 0 ? { outcome: 'failed', reason: 'provider_timeout' } : {}) }));
  const project = { id: 'p', name: '小说', inbox: [], mind: { pacing: { wake: { history: [] } } }, genes: { genes: [], generations: [] } };
  const state = { settings: { interfaceLanguage: 'zh' }, projects: [project, { id: 'gone', name: '旧项目', archivedAt: hours(1), inbox: [], mind: { pacing: { wake: { history: [{ at: hours(2), outcome: 'work' }] } } }, genes: { genes: [] } }], sessions: [] };
  const wakes = new DailyRollup({ kind: 'wakes', now: () => now, timeZone: TZ }), seen = new Map();
  for (const row of all) { project.mind.pacing.wake.history = [...project.mind.pacing.wake.history, row].slice(-50); foldWakes(wakes, state, { seen }); }
  assert.equal(project.mind.pacing.wake.history.length, 50);
  const report = experienceReport(state, { now, days: 7, wakes, timeZone: TZ });
  assert.equal(report.projects.length, 1); assert.equal(report.projects[0].wakes.total, 120, 'every wake of the week, not the last 50');
  assert.equal(report.projects[0].wakes.failed, 12); assert.deepEqual(report.projects[0].wakes.failureReasons, { provider_timeout: 12 });
  assert.equal(experienceReport(state, { now, days: 7, timeZone: TZ }).projects[0].wakes.total, 50, 'without the rollup only the history is known');
  assert.equal(report.days, 7); assert.equal(report.since, '2026-09-28T16:00:00.000Z');
  const archived = experienceReport(state, { now, days: 7, wakes, archived: 'include', timeZone: TZ });
  assert.deepEqual(archived.projects.map(row => [row.projectId, row.archived ?? false]), [['p', false], ['gone', true]]);
  assert.deepEqual(experienceReport(state, { now, archived: 'only', wakes, timeZone: TZ }).projects.map(row => row.projectId), ['gone']);
  assert.throws(() => experienceReport(state, { now, archived: 'all' }), { status: 400 });
  // Folding again changes nothing.
  foldWakes(wakes, state, { seen: new Map() }); assert.equal(experienceReport(state, { now, days: 7, wakes, timeZone: TZ }).projects[0].wakes.total, 120);
});

test('metric series: the previous window ends where the current one starts and each daily cell is its own local day', () => {
  const now = Date.parse('2026-10-05T04:00:00Z'), at = (day, hour) => new Date(dayStart(day, TZ) + hour * 3600000).toISOString();
  const proactive = (id, createdAt) => ({ id, kind: 'assistant', source: 'initiative', text: `message ${id}`, createdAt, initiative: {} });
  const items = [proactive('a', at('2026-10-05', 1)), proactive('b', at('2026-10-03', 9)), proactive('c', at('2026-10-03', 10)), proactive('d', at('2026-09-27', 12))];
  const project = { id: 'p', inbox: [], mind: {} }, sessions = [{ id: 's', projectId: 'p', items }];
  const series = proactiveMetricSeries(project, sessions, { now, window: '7d', timeZone: TZ });
  assert.equal(series.delivered, 3); assert.equal(series.metrics.proactiveDelivered.previous, 1, 'the previous seven days only, not everything since');
  // One grouping pass gives what filtering each day on its own gives; an unreplied run restarts at midnight within a day cell.
  for (const cell of series.metrics.proactiveDelivered.series) assert.equal(cell.value, proactiveMetrics(project, sessions, { now, range: { since: dayStart(cell.date, TZ), until: dayStart(addDays(cell.date, 1), TZ) } }).delivered, cell.date);
  assert.deepEqual(series.metrics.longestUnrepliedChain.series.map(cell => cell.value), [0, 0, 0, 0, 2, 0, 1]); assert.equal(series.longestUnrepliedChain, 3, 'across the window the run spans days');
  assert.deepEqual(series.metrics.proactiveDelivered.series.map(cell => [cell.date, cell.value]), [['2026-09-29', 0], ['2026-09-30', 0], ['2026-10-01', 0], ['2026-10-02', 0], ['2026-10-03', 2], ['2026-10-04', 0], ['2026-10-05', 1]]);
  // Archived conversations of the project on request.
  const state = { projects: [project], sessions: [{ ...sessions[0], archivedAt: at('2026-10-05', 2) }] };
  assert.equal(computeProactiveMetrics(state, 'p', { now, timeZone: TZ }).delivered, 0);
  assert.equal(computeProactiveMetrics(state, 'p', { now, archived: 'include', timeZone: TZ }).delivered, 3);
});

test('event-loop attribution: named fixed-bucket histograms over rolling windows, routes by pattern', () => {
  let now = Date.parse('2026-10-05T04:00:00Z');
  const histograms = new LoopHistograms({ now: () => now });
  for (const ms of [3, 4, 30, 700]) histograms.record(routeName('GET', '/api/v2/projects/0b838ef9-378e-4003-ae5e-95613aa70289/metrics?window=7d'), ms);
  histograms.record('store tick', 2);
  const [first, second] = histograms.report('1h');
  assert.deepEqual(first, { name: 'http GET /api/v2/projects/:id/metrics', count: 4, totalMs: 737, maxMs: 700, p50Ms: 5, p95Ms: 1000, p99Ms: 1000 });
  assert.equal(second.name, 'store tick');
  now += 2 * 3600000; histograms.record('later', 1);
  assert.deepEqual(histograms.report('1h').map(row => row.name), ['later']); assert.equal(histograms.report('24h').length, 3);
  assert.equal(routeName('GET', '/index.html'), 'http GET (static)');
  // A section inside other work is timed on its own instance, keeps its receiver when called bare, and is wrapped once.
  const target = { calls: 0, persist(value) { this.calls++; return value * 2; } }, bare = (instrument(target, 'persist', 'store persist', histograms), target.persist);
  assert.equal(bare(21), 42); assert.equal(target.calls, 1); assert.equal(instrument(target, 'persist', 'store persist', histograms), false);
  assert.equal(histograms.report('1h', { limit: 50 }).find(row => row.name === 'store persist').count, 1);
});

test('host metrics live in the journal root; a deleted project leaves every rollup and the ledger', t => {
  const { dir, stateFile } = temp(t); const now = Date.parse('2026-10-05T04:00:00Z');
  const hooks = new Set(), listeners = new Set();
  const store = { file: stateFile, state: { projects: [{ id: 'p', mind: { pacing: { wake: { history: [{ at: new Date(now - 1000).toISOString(), outcome: 'work' }] } } } }, { id: 'q', mind: { pacing: { wake: { history: [{ at: new Date(now - 1000).toISOString(), outcome: 'thought' }] } } } }] },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, onProjectDeleted(hook) { hooks.add(hook); return () => hooks.delete(hook); } };
  const metrics = createHostMetrics(store, { now: () => now, timeZone: TZ });
  metrics.ledger.add({ id: 'd1', at: now, point: 'turn.route', source: 'judge', scope: { projectId: 'p' } }); metrics.ledger.add({ id: 'd2', at: now, point: 'turn.route', source: 'judge', scope: { projectId: 'q' } });
  assert.equal(metrics.wakes.cells({}).length, 2, 'the wakes already in state are folded at start');
  for (const hook of hooks) hook({ id: 'p' });
  assert.deepEqual(metrics.wakes.cells({}).map(cell => cell.k.projectId), ['q']); assert.deepEqual(metrics.ledger.rows().map(row => row.id), ['d2']);
  assert.doesNotMatch(readFileSync(decisionLedgerFile(stateFile), 'utf8'), /"d1"/);
  metrics.close(); assert.equal(hooks.size, 0); assert.equal(listeners.size, 0);
  assert.deepEqual(readdirSync(metricsRoot(stateFile)).sort(), ['decision-ledger.jsonl', 'wakes-daily.json'], 'a rollup is written once it holds something');
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('state.json.')).map(name => name.slice('state.json'.length)).filter(suffix => !CHECKPOINT_SIDECARS.includes(suffix) && !excludedSibling(suffix)), [], 'no sibling an older release would refuse');
  assert.equal(JSON.parse(readFileSync(rollupFile(stateFile, 'wakes'), 'utf8')).days[localDay(now, TZ)].length, 1);
});

test('GET routes: the paged ledger, archived views of usage and calibration, health with the loop\'s last hour and its busiest routes', async t => {
  const { createServer } = await import('../server.mjs');
  const { dir, stateFile } = temp(t);
  // A state as 0.68.0 left it: the ledger inside state.
  const now = Date.now(), row = (id, at) => ({ id, at, point: 'turn.route', backend: 'typesafe', source: 'judge', mode: 'active', reason: 'accepted', scope: {}, answers: {}, predictions: { needs_tools: .9 } });
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false }); await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const created = app.store.createProject({ name: 'Archived later', description: 'x', workspace: dir });
  app.store.mutate(state => { state.projects.find(value => value.id === created.project.id).simulated = false; state.decisionKernelRuntime = { metrics: { requests: 3 }, recent: Array.from({ length: 3 }, (_, index) => ({ ...row(`r${index}`, now - (3 - index) * 1000), scope: { projectId: created.project.id } })) }; });
  const base = `http://127.0.0.1:${app.server.address().port}`, get = async path => { const response = await fetch(`${base}${path}`); return { status: response.status, body: await response.json() }; };
  const page = await get('/api/v2/decision-kernel/ledger?limit=2');
  assert.deepEqual(page.body.rows.map(value => value.id), ['r2', 'r1']); assert.equal(page.body.nextBefore, 'r1');
  assert.deepEqual((await get(`/api/v2/decision-kernel/ledger?before=${page.body.nextBefore}`)).body.rows.map(value => value.id), ['r0']);
  assert.deepEqual(app.store.state.decisionKernelRuntime.recent, [], 'read through the ledger, which absorbed them');
  assert.ok(existsSync(decisionLedgerFile(stateFile)));
  app.store.usageLedger.record({ purpose: 'foreground', projectId: created.project.id, usage: usage(100, 900) });
  app.store.mutate(state => { state.projects.find(value => value.id === created.project.id).archivedAt = new Date().toISOString(); });
  assert.equal((await get('/api/v2/decision-kernel/ledger')).body.rows.length, 0, 'an archived project\'s judgments are left out by default');
  assert.equal((await get('/api/v2/decision-kernel/ledger?archived=include')).body.rows.length, 3);
  assert.equal((await get('/api/decision-kernel/ledger?archived=only&limit=1')).body.length, 1, 'the legacy route pages too, as an array');
  assert.equal((await get('/api/v2/usage/cache?window=30d')).body.overall.requests, 1, 'usage includes archived projects by default');
  assert.equal((await get('/api/v2/usage/cache?window=30d&archived=exclude')).body.overall.requests, 0);
  assert.equal((await get('/api/v2/usage/cache?window=90d&archived=only')).body.overall.requests, 1);
  assert.equal((await get('/api/v2/usage/cache?archived=nope')).status, 400);
  // The documented 400 codes reach the client (B7 review 5): the shared handler forwards only its own list.
  for (const [path, code] of [['/api/v2/decision-kernel/ledger?before=nope', 'ledger_cursor_invalid'], ['/api/decision-kernel/ledger?point=nope', 'ledger_point_invalid'], ['/api/v2/decision-kernel/ledger?archived=nope', 'archived_invalid'], ['/api/v2/usage/cache?archived=nope', 'archived_invalid'], ['/api/v2/decision-kernel/calibration?archived=nope', 'archived_invalid'], ['/api/v2/experience?archived=nope', 'archived_invalid']]) {
    const reply = await get(path); assert.deepEqual([reply.status, reply.body.code], [400, code], path); assert.ok(reply.body.error);
  }
  assert.equal((await get('/api/v2/decision-kernel/calibration?window=7d&archived=exclude')).body.decisions, 0);
  assert.equal((await get('/api/v2/decision-kernel/calibration?window=7d')).body.decisions, 3);
  assert.equal((await get('/api/v2/experience?archived=only')).body.projects[0].archived, true);
  const health = (await get('/api/health')).body.eventLoop;
  assert.ok(Number.isFinite(health.p99Ms)); assert.ok('lastHour' in health && 'lastDay' in health);
  assert.ok(health.attribution.lastHour.some(value => value.name === 'http GET /api/v2/decision-kernel/ledger'), JSON.stringify(health.attribution.lastHour.map(value => value.name)));
  assert.equal(app.store.persist.instrumented, true, 'state commits are timed'); assert.equal(app.apiV2.hub.diffIndex.instrumented, true, 'index diffs are timed');
});
