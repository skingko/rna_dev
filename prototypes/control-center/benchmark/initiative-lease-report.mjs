#!/usr/bin/env node
// PDL-2 foreground lease, post-ship measurement (docs/planning/p1-specs-20261004/prefix.md §3.5), read-only. Per day and
// project: paid initiative ledger rows that ran inside a foreground turn window, zero-token (aborted) initiative rows
// inside a turn or within 5 s after its end, paid decisions per completed user turn, the decision-kernel ledger's
// `foreground_lease` and `bypass_*` rule rows, and the distribution of `in_progress_covers` predictions.
// Usage: node benchmark/initiative-lease-report.mjs --ledger <usage-cache.jsonl copy> --state <state.json copy>
//        [--kernel <GET /api/decision-kernel/ledger?limit=200 JSON>] [--since ISO]; without --kernel, the ledger file beside the state copy
// Never open a Store on production state: pass copies (readStateFile only reads).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { parseUsageLedger } from '../usage-cache-service.mjs';
import { decisionLedgerFile, readDecisionLedger } from '../decision-ledger.mjs';

const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
const day = at => new Date(at).toISOString().slice(0, 10);

/** Turn windows per project: [start, end] of every rna turn of its non-side conversations (end = completion, or now). */
export function turnWindows(state, now = Date.now()) {
  const windows = new Map();
  for (const session of state.sessions ?? []) {
    if (!session.projectId || session.kind === 'side') continue;
    for (const turn of session.turns ?? []) {
      if (turn.modelConfig?.execution !== 'rna' || turn.simulated === true) continue;
      const start = time(turn.createdAt); if (start === null) continue;
      const end = time(turn.completedAt) ?? (turn.status === 'running' ? now : start);
      (windows.get(session.projectId) ?? windows.set(session.projectId, []).get(session.projectId)).push({ start, end, completed: turn.status === 'completed' });
    }
  }
  return windows;
}
export function leaseReport(rows, state, { kernel = null, since = -Infinity, now = Date.now() } = {}) {
  const windows = turnWindows(state, now), report = {};
  const cell = (projectId, at) => { const key = `${day(at)} ${String(projectId).slice(0, 8)}`; return report[key] ??= { paidInTurn: 0, paidInTurnUncached: 0, paidInTurnCached: 0, paidInTurnOutput: 0, abortedInOrAfterTurn: 0, paidDecisions: 0, completedTurns: 0 }; };
  for (const row of rows) {
    if (row.purpose !== 'initiative' || !row.projectId) continue;
    const at = time(row.at); if (at === null || at < since) continue;
    const list = windows.get(row.projectId) ?? [], target = cell(row.projectId, at), paid = (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0) > 0;
    if (paid) target.paidDecisions++;
    if (paid && list.some(window => at >= window.start && at <= window.end)) { target.paidInTurn++; target.paidInTurnUncached += row.input ?? 0; target.paidInTurnCached += row.cacheRead ?? 0; target.paidInTurnOutput += row.output ?? 0; }
    if (!paid && list.some(window => at >= window.start && at <= window.end + 5000)) target.abortedInOrAfterTurn++;
  }
  for (const [projectId, list] of windows) for (const window of list) if (window.completed && window.end >= since) cell(projectId, window.end).completedTurns++;
  for (const value of Object.values(report)) value.paidDecisionsPerCompletedTurn = value.completedTurns ? Math.round(value.paidDecisions / value.completedTurns * 100) / 100 : null;
  const ledger = (kernel ?? state.decisionKernelRuntime?.recent ?? []).filter(row => (row.at ?? 0) >= since);
  const reasons = {};
  for (const row of ledger) if (row.source === 'rule' && (row.reason === 'foreground_lease' || String(row.reason).startsWith('bypass_'))) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  const covers = ledger.map(row => row.predictions?.in_progress_covers).filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = q => covers.length ? covers[Math.min(covers.length - 1, Math.floor(q * covers.length))] : null;
  const totals = {};
  for (const value of Object.values(report)) for (const [key, number] of Object.entries(value)) if (key !== 'paidDecisionsPerCompletedTurn') totals[key] = (totals[key] ?? 0) + number;
  totals.paidDecisionsPerCompletedTurn = totals.completedTurns ? Math.round(totals.paidDecisions / totals.completedTurns * 100) / 100 : null;
  return { totals, byDayAndProject: report, kernelRuleRows: reasons, inProgressCovers: { count: covers.length, held: ledger.filter(row => row.disposition === 'deferred' && Number.isFinite(row.predictions?.in_progress_covers) && row.source !== 'rule' && row.savings).length, p10: quantile(.1), p50: quantile(.5), p90: quantile(.9) } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const ledger = arg('--ledger'), statePath = arg('--state');
  if (!ledger || !statePath) { console.error('Usage: --ledger <jsonl copy> --state <state.json copy> [--kernel <ledger json>] [--since ISO]'); process.exit(2); }
  const rows = parseUsageLedger(readFileSync(ledger, 'utf8'));
  // The judgment ledger: a saved ledger route response (array, or the v2 page's `rows`), else the ledger file beside the
  // state copy (0.69: `<state>.rna/metrics/decision-ledger.jsonl`; state no longer holds the rows).
  const saved = arg('--kernel') ? JSON.parse(readFileSync(arg('--kernel'), 'utf8')) : null, beside = readDecisionLedger(decisionLedgerFile(statePath));
  const { state } = readStateFile(statePath), kernel = saved ? saved.rows ?? saved : beside.length ? beside : null;
  console.log(JSON.stringify(leaseReport(rows, state, { kernel, since: arg('--since') ? Date.parse(arg('--since')) : -Infinity }), null, 2));
}
