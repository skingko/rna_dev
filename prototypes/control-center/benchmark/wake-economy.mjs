#!/usr/bin/env node
// Where the background decision tokens go, from the wake log (read-only; pass a COPY of `<state>.rna/metrics/wakes.jsonl`).
// For each project and in total: wakes and tokens by outcome, the floor wakes whose request was the previous one bar the clock
// (`prompt.divergedIn = clock.now`: a decision paid for twice), and since 0.74.0 the wakes that rested on their last wait's own
// rest (`deferred` / `unchanged_since_wait`) with the tokens of the requests they did not send. Run it before and after a release
// to see the rest rule work (docs/research/wake-rest-and-harness2-20261022.md).
// Usage: node benchmark/wake-economy.mjs <wakes.jsonl copy> [--since 2026-10-01T00:00:00Z]
import { readWakeLog } from '../wake-log.mjs';
const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('Usage: wake-economy.mjs <wakes.jsonl copy> [--since <ISO time>]'); process.exit(2); }
const sinceArg = rest[rest.indexOf('--since') + 1], since = rest.includes('--since') ? Date.parse(sinceArg) : -Infinity;
if (!Number.isFinite(since) && since !== -Infinity) { console.error('--since needs an ISO time'); process.exit(2); }
const rounds = value => Math.round(value / 1000) / 1000;
function summarize(rows) {
  const out = { wakes: rows.length, tokensM: 0, byOutcome: {}, floorRepeats: { wakes: 0, tokensM: 0, thought: 0, work: 0 }, rested: { wakes: 0, savedM: 0 } };
  let tokens = 0, repeatTokens = 0, saved = 0;
  for (const row of rows) {
    const used = Number.isFinite(row.tokens) ? row.tokens : 0, group = out.byOutcome[row.outcome] ??= { wakes: 0, tokensM: 0, tokens: 0 };
    group.wakes++; group.tokens += used; tokens += used;
    if (row.outcome === 'deferred' && row.reason === 'unchanged_since_wait') { out.rested.wakes++; saved += Number.isFinite(row.saved) ? row.saved : 0; }
    // The previous request repeated bar the clock; a floor wake that still asked the model about it.
    if (row.floor && row.prompt?.divergedIn === 'clock.now' && ['thought', 'work'].includes(row.outcome)) { out.floorRepeats.wakes++; repeatTokens += used; out.floorRepeats[row.outcome]++; }
  }
  for (const group of Object.values(out.byOutcome)) { group.tokensM = rounds(group.tokens); delete group.tokens; }
  out.tokensM = rounds(tokens); out.floorRepeats.tokensM = rounds(repeatTokens); out.rested.savedM = rounds(saved);
  return out;
}
const log = readWakeLog(file), report = { since: Number.isFinite(since) ? new Date(since).toISOString() : null, projects: {} };
const all = [];
for (const [projectId, rows] of Object.entries(log)) { const kept = rows.filter(row => Date.parse(row.at) >= since); all.push(...kept); report.projects[projectId] = summarize(kept); }
report.total = summarize(all);
console.log(JSON.stringify(report, null, 2));
