import { join } from 'node:path';
import { DailyRollup, metricsRoot } from './metrics-rollup.mjs';
import { DecisionLedger, decisionLedgerFile } from './decision-ledger.mjs';
import { foldWakes } from './proactive-metrics.mjs';
import { WakeLog, wakeLogFile } from './wake-log.mjs';
import { WorkOutcomeLog, outcomeLogFile } from './work-outcome.mjs';
import { LoopHistograms } from './loop-histograms.mjs';
import { appTimeZone } from './metric-windows.mjs';

/**
 * The host's durable metrics (plan 2026-10-05 B7), all in `<state>.rna/metrics/` (metricsRoot): the decision ledger
 * (decision-ledger.jsonl) and four daily rollups kept 13 months — usage (folded by the usage ledger before its 7-day
 * rows leave), decisions (folded when ledger rows leave after 31 days), wakes (folded as each wake is recorded) and
 * outcomes (folded when work-outcome transitions leave their 31 days) — the wake rows themselves (wakes.jsonl, C2: state
 * keeps only their tail) and the work-outcome transitions (work-outcomes.jsonl), plus in-memory event-loop attribution. A deleted project's rows leave every one of them.
 */
export const rollupFile = (stateFile, kind) => join(metricsRoot(stateFile), `${kind}-daily.json`);
export function createHostMetrics(store, { stateFile = store?.file, now = Date.now, timeZone = appTimeZone(), wakeFlushMs = 30000 } = {}) {
  const rollup = kind => new DailyRollup({ file: stateFile ? rollupFile(stateFile, kind) : null, kind, now, timeZone });
  const usage = rollup('usage'), decisions = rollup('decisions'), wakes = rollup('wakes'), outcomes = rollup('outcomes'), histograms = new LoopHistograms({ now });
  const ledger = store.decisionLedger ??= new DecisionLedger({ file: stateFile ? decisionLedgerFile(stateFile) : null, now, rollup: decisions });
  // The wake rows and the work-outcome transitions (C2): the initiative controller finds them on the store, like the ledger.
  const wakeLog = store.wakeLog ??= new WakeLog({ file: stateFile ? wakeLogFile(stateFile) : null, now });
  const outcomeLog = store.outcomeLog ??= new WorkOutcomeLog({ file: stateFile ? outcomeLogFile(stateFile) : null, now, rollup: outcomes });
  // Readers that get the store (the K4 metrics route) find the wake rollup beside the ledgers.
  store.wakeRollup = wakes;
  // Wakes are folded on every committed change that touched a project's wake history (the history array is replaced
  // on each wake, so an unchanged one is skipped by identity), and written at most every `wakeFlushMs` and at close: the
  // history in state still holds the rows a crash could lose from memory, and the watermark folds them again.
  const seen = new Map();
  let timer = null;
  const flushWakes = () => { clearTimeout(timer); timer = null; wakes.flush(); };
  const fold = () => {
    try { if (foldWakes(wakes, store.state, { seen }) && !timer) { timer = setTimeout(flushWakes, wakeFlushMs); timer.unref?.(); } } catch { /* metrics never block a commit */ }
  };
  fold();
  const unsubscribe = typeof store.subscribe === 'function' ? store.subscribe(() => histograms.time('metrics wake-fold', fold), { display: false }) : () => {};
  const unhook = typeof store.onProjectDeleted === 'function' ? store.onProjectDeleted(project => {
    for (const value of [usage, decisions, wakes]) { value.removeProject(project.id); value.flush(); }
    try { wakeLog.removeProject(project.id); outcomeLog.removeProject(project.id); } catch { /* best effort; the rows hold no content */ }
    try { ledger.removeProject(project.id); } catch { /* best effort; its rows hold no content */ }
    try { store.usageLedger?.removeProject?.(project.id); } catch { /* idem */ }
  }) : () => {};
  return { usage, decisions, wakes, outcomes, wakeLog, outcomeLog, histograms, ledger, fold,
    close() { unsubscribe(); unhook(); fold(); flushWakes(); usage.flush(); decisions.flush(); outcomes.flush(); } };
}
