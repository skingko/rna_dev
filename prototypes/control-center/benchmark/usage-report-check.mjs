#!/usr/bin/env node
// T1 (token-burn study 2026-10-05, design Z1/Z2) equivalence check, read-only. The usage report gained `runs` (the largest
// sessions, ranked by tokens) and a product / probe split of `judge`. None of it may change a number the page already showed,
// and every new number must add up from the ledger rows by a plain, independent formula. The report weighs nothing by price (the
// user decided on 2026-10-05 that the backend does not track real prices), so there is no cost to check here: the check
// fails when any price-derived field (`cost`, `estimatedCost`, `relative`) shows up anywhere in the report.
// This recomputes each of them from a ledger copy without the report's own code paths and compares (the run limit and the probe
// rule are written out below as the design states them, never imported from the module under test):
//   - tokens per purpose and in total (input + cache read + cache write + output), the totals the page showed before;
//   - the largest runs: session, requests, tokens, cache reads, in rank order (most tokens first, then most requests);
//   - the JEV split: product + probe = the old judge totals; a probe is detail 'probe', or no detail, no project and no session.
// Requests that reported no usage (estimated) and keep-alive pings are counted and left to the report: how an estimated prompt
// splits into fresh and cached tokens depends on the ledger's prefix mix, so no plain formula exists (the real ledger has none).
// Usage: node benchmark/usage-report-check.mjs --ledger <usage-cache.jsonl copy> [--window 24h] [--now ISO]
// Never open a Store on production state: pass a copy (parseUsageLedger reads, it never writes).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { aggregateCacheUsage, parseUsageLedger } from '../usage-cache-service.mjs';
import { windowRange, within } from '../metric-windows.mjs';

const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
// As the design states it: the length of "largest runs".
const RUN_LIMIT = 8;
const sum = row => (row.input ?? 0) + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0) + (row.output ?? 0);
// A price-derived field anywhere in the report (a bucket, a purpose, the judge, the keep-alive, a miss, a run).
const PRICE_FIELDS = new Set(['cost', 'estimatedCost', 'relative']);
const hasPrice = value => Boolean(value) && typeof value === 'object' && Object.entries(value).some(([key, item]) => PRICE_FIELDS.has(key) || hasPrice(item));

/** The plain recomputation of the report for one rolling window, from ledger rows (contract purposes, as parseUsageLedger returns them). */
export function recompute(rows, { window = '24h', now }) {
  const range = windowRange(window, { now }), inside = rows.filter(row => within(Date.parse(row.at), range));
  const judgments = inside.filter(row => row.purpose === 'jev'), conversation = inside.filter(row => row.purpose !== 'jev' && row.keepAlive !== true && row.estimated !== true);
  const byPurpose = {}, sessions = new Map();
  for (const row of conversation) {
    const cell = byPurpose[row.purpose] ??= { requests: 0, tokens: 0 };
    cell.requests++; cell.tokens += sum(row);
    if (row.sessionId) { const run = sessions.get(row.sessionId) ?? sessions.set(row.sessionId, { sessionId: row.sessionId, requests: 0, tokens: 0, cacheRead: 0 }).get(row.sessionId); run.requests++; run.tokens += sum(row); run.cacheRead += row.cacheRead ?? 0; }
  }
  const probe = row => row.detail === 'probe' || (!row.detail && !row.projectId && !row.sessionId);
  const part = list => ({ requests: list.length, input: list.reduce((n, row) => n + (row.input ?? 0), 0), output: list.reduce((n, row) => n + (row.output ?? 0), 0) });
  return { byPurpose, tokens: conversation.reduce((n, row) => n + sum(row), 0),
    runs: [...sessions.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests).slice(0, RUN_LIMIT),
    judge: { total: part(judgments), product: part(judgments.filter(row => !probe(row))), probe: part(judgments.filter(probe)) },
    skipped: { estimated: inside.filter(row => row.purpose !== 'jev' && row.estimated === true).length, keepAlive: inside.filter(row => row.keepAlive === true).length } };
}

/**
 * Compare a report with its recomputation. `report` defaults to aggregateCacheUsage over the same rows (tests pass a doctored
 * one to see the check fail). Returns { checks: [{ name, ok, detail }], ok, summary }.
 */
export function checkUsageReport(rows, { window = '24h', now, report } = {}) {
  const at = now ?? Date.parse(rows.at(-1).at) + 1, actual = report ?? aggregateCacheUsage(rows, { window, now: at }), expected = recompute(rows, { window, now: at });
  const checks = [], check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const reportTokens = actual.overall.input + actual.overall.cacheRead + actual.overall.cacheWrite + actual.overall.output;
  const purposes = Object.keys(expected.byPurpose);
  check('tokens in total', reportTokens === expected.tokens, `${reportTokens} vs ${expected.tokens}`);
  check('requests per purpose', purposes.every(purpose => actual.byPurpose[purpose]?.requests === expected.byPurpose[purpose].requests) && Object.keys(actual.byPurpose).length === purposes.length, purposes.map(purpose => `${purpose} ${actual.byPurpose[purpose]?.requests}/${expected.byPurpose[purpose].requests}`).join(', '));
  check('no price-weighted number', !hasPrice(actual), '');
  check('largest runs', actual.runs.length === expected.runs.length && expected.runs.every((run, index) => { const got = actual.runs[index]; return got?.sessionId === run.sessionId && got.requests === run.requests && got.tokens === run.tokens && got.cacheRead === run.cacheRead; }), expected.runs.map((run, index) => `${run.sessionId.slice(0, 18)} ${actual.runs[index]?.tokens}/${run.tokens}`).join(', '));
  check('no run beyond the limit', actual.runs.length <= RUN_LIMIT, `${actual.runs.length}`);
  if (expected.judge.total.requests || actual.judge) {
    const judge = actual.judge ?? {};
    const same = (a, b) => a?.requests === b.requests && a?.input === b.input && a?.output === b.output;
    check('judge total unchanged', same(judge, expected.judge.total), `${judge.requests} vs ${expected.judge.total.requests}`);
    check('judge product', same(judge.product, expected.judge.product), `${judge.product?.requests} vs ${expected.judge.product.requests}`);
    check('judge probe', same(judge.probe, expected.judge.probe), `${judge.probe?.requests} vs ${expected.judge.probe.requests}`);
    check('product + probe = total', judge.product && judge.probe && judge.product.requests + judge.probe.requests === judge.requests && judge.product.input + judge.probe.input === judge.input && judge.product.output + judge.probe.output === judge.output, '');
  }
  return { checks, ok: checks.every(row => row.ok), summary: { window, now: new Date(at).toISOString(), requests: actual.overall.requests, tokens: reportTokens, cacheRead: actual.overall.cacheRead, judge: actual.judge ?? null, runs: actual.runs.map(run => ({ sessionId: run.sessionId, purpose: run.purpose, requests: run.requests, tokens: run.tokens })), skipped: expected.skipped } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const ledger = arg('--ledger'); if (!ledger) { console.error('usage: usage-report-check.mjs --ledger <usage-cache.jsonl copy> [--window 24h|1h] [--now ISO]'); process.exit(2); }
  const rows = parseUsageLedger(readFileSync(ledger, 'utf8')), now = arg('--now') ? Date.parse(arg('--now')) : undefined;
  const result = checkUsageReport(rows, { window: arg('--window') ?? '24h', ...(Number.isFinite(now) ? { now } : {}) });
  console.log(JSON.stringify(result.summary, null, 2));
  for (const row of result.checks) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? `  (${row.detail})` : ''}`);
  console.log(result.ok ? 'ALL CHECKS PASS' : 'CHECKS FAILED');
  process.exit(result.ok ? 0 : 1);
}
