#!/usr/bin/env node
// Compaction summary coverage (plan A3; docs/research/compaction-summary-coverage-20261005.md). For every compaction
// in the session journals (read-only; pass copies), each user request behind its boundary gets two questions on one
// state { checkpoint, request }: does the checkpoint keep this request or say it was finished (`kept`), and does the
// request ask for anything of its own (`substantive`, so "继续" or "好的" do not count as losses). Coverage = kept among
// substantive. The state goes to the live daemon's probe (POST /api/v2/decision-kernel/probe: one raw System One call
// with the app's configured key; no thresholds, cache or ledger). The checkpoint is what the model reads after the
// boundary: the summary plus the file lists the compaction record carries (compactionFilesText). Questions, state,
// thresholds and the request list are the SDK's (summary.coverage, userRequests), shared with the C5 fork probe
// (compaction-fork-probe.mjs).
//
//   node benchmark/compaction-summary-coverage.mjs <dir with <sessionId>/*.rna.jsonl> [--session id] [--latest] [--fork] [--span] [--dry] [--labels file.json] [--out file.json]
//
// --latest: only each journal's newest compaction. --fork: only the compactions whose summary was the TC-6 fork request (C5: the record
// says `fork: true`, with the `requestId` of the summary request and the `prefixMessageId` it extended; `forkRejected` marks a
// flattened fallback), so the next live fork compaction on GLM is measured on its own. --span: only the requests archived by that compaction itself (by
// default every request behind its boundary, since a chained summary replaces all of them). --dry: no probe calls.
// --labels: hand labels { "<compactionId>:<requestMessageId>": true|false } (true = the checkpoint keeps the request
// or says it was finished); the run then reports the confusion of `kept` at each threshold, so the threshold is read
// off the labelled distribution (AGENTS.md), not copied.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournalRecords } from '../../../packages/sdk/src/journal.mjs';
import { compactionFilesText, userRequests } from '../../../packages/sdk/src/context.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { summaryCoverageTemplate, wireQuestions, DECISION_THRESHOLDS } from '../../../packages/sdk/src/decision-templates.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = (name, fallback = null) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : fallback; };
const root = process.argv[2], only = arg('--session'), latest = process.argv.includes('--latest'), forkOnly = process.argv.includes('--fork'), span = process.argv.includes('--span'), dry = process.argv.includes('--dry');
if (!root || root.startsWith('--')) { console.error('usage: compaction-summary-coverage.mjs <journal dir> [--session id] [--latest] [--fork] [--span] [--dry] [--out file]'); process.exit(2); }

/** The messages and compactions of one journal as the session replays them (session.mjs replay: messages, rewinds, compactions). */
function compactionsOf(file) {
  const messages = [], ids = new Set(), found = [];
  let live = [];
  const add = message => { if (message?.id && !ids.has(message.id)) { ids.add(message.id); messages.push(message); } };
  for (const { type, data } of readJournalRecords(file, { verify: false, wantEvent: () => false })) {
    if (type === 'message' || type === 'inbox_claimed' || type === 'tool_completed' || type === 'finish_review') add(data?.message);
    else if (type === 'request_completed' && data?.discarded !== true) add(data?.message);
    else if (type === 'context_rewind') {
      const cut = messages.findIndex(message => message.id === data.beforeMessageId);
      if (cut >= 0) { const gone = new Set(messages.splice(cut).map(message => message.id)); live = live.filter(row => !gone.has(row.throughMessageId)); }
    } else if (type === 'context_compaction') {
      const requests = userRequests(messages, { throughMessageId: data.throughMessageId, previousThroughMessageId: live.at(-1)?.throughMessageId ?? null });
      if (!requests) continue;
      found.push({ id: data.id, trigger: data.trigger ?? (data.automatic ? 'automatic' : 'manual'), fork: data.fork === true, requestId: data.requestId ?? null, prefixMessageId: data.prefixMessageId ?? null, forkRejected: data.forkRejected?.reason ?? null, summaryChars: data.summary.length, archivedMessages: data.archivedMessages, checkpoint: `${data.summary}${compactionFilesText(data)}`, requests });
      live.push(data);
    }
  }
  return found;
}

const QUESTIONS = wireQuestions(summaryCoverageTemplate());
let calls = 0, inputTokens = 0;
async function probe(state) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions: QUESTIONS }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  calls++; inputTokens += body.usage?.input_tokens ?? 0;
  return body;
}
const round = value => typeof value === 'number' ? Math.round(value * 1000) / 1000 : null;
/**
 * `kept` at or above this counts as kept (DECISION_THRESHOLDS.points['summary.coverage']). Measured on 69 hand-labelled
 * requests over the five live summaries of 2026-10-05 (docs/research/compaction-summary-coverage-20261005.md): accuracy
 * 0.91 at 0.3 (1 false positive, 5 false negatives) against 0.73 at 0.5, where JEV misses summaries that record a
 * request's outcome in other words. Coverage is reported at 0.5 too. Re-read the threshold from --labels when the
 * question or the summaries' shape changes.
 */
const { kept: KEPT_THRESHOLD, substantive: SUBSTANTIVE_THRESHOLD } = DECISION_THRESHOLDS.points['summary.coverage'];
const BUCKETS = [0.1, 0.25, 0.5, 0.75, 0.9];
const histogram = values => Object.fromEntries([...BUCKETS.map((edge, index) => [`<${edge}`, values.filter(value => value < edge && (index === 0 || value >= BUCKETS[index - 1])).length]), [`>=${BUCKETS.at(-1)}`, values.filter(value => value >= BUCKETS.at(-1)).length]]);

const sessions = readdirSync(root).filter(name => name !== 'initiative' && (!only || name === only));
const results = { at: new Date().toISOString(), base: BASE, scope: span ? 'span' : 'cumulative', compactions: [] };
for (const session of sessions) {
  let files; try { files = readdirSync(join(root, session)).filter(file => file.endsWith('.rna.jsonl')); } catch { continue; }
  for (const file of files) {
    let found = compactionsOf(join(root, session, file));
    if (latest) found = found.slice(-1);
    if (forkOnly) found = found.filter(row => row.fork);
    for (const compaction of found) {
      const requests = compaction.requests.filter(row => !span || row.inSpan), rows = [];
      for (const request of requests) {
        const row = { id: request.id, inSpan: request.inSpan, chars: request.text.length, preview: request.text.slice(0, 80).replace(/\s+/g, ' ') };
        if (!dry) {
          const body = await probe(buildDecisionState('summary.coverage', { checkpoint: compaction.checkpoint, request: request.text }));
          Object.assign(row, { kept: round(body.answers?.kept?.noul), substantive: round(body.answers?.substantive?.noul), latencyMs: body.latencyMs });
        }
        rows.push(row);
      }
      const judged = rows.filter(row => typeof row.kept === 'number' && typeof row.substantive === 'number'), substantive = judged.filter(row => row.substantive >= SUBSTANTIVE_THRESHOLD);
      const keptAt = threshold => substantive.filter(row => row.kept >= threshold).length;
      results.compactions.push({ session, file, id: compaction.id, trigger: compaction.trigger, fork: compaction.fork, requestId: compaction.requestId, prefixMessageId: compaction.prefixMessageId, forkRejected: compaction.forkRejected, summaryChars: compaction.summaryChars, archivedMessages: compaction.archivedMessages, requests: rows.length,
        ...(judged.length ? { substantive: substantive.length, kept: keptAt(KEPT_THRESHOLD), coverage: round(keptAt(KEPT_THRESHOLD) / Math.max(1, substantive.length)), coverageAt05: round(keptAt(0.5) / Math.max(1, substantive.length)), meanKept: round(substantive.reduce((sum, row) => sum + row.kept, 0) / Math.max(1, substantive.length)), keptHistogram: histogram(substantive.map(row => row.kept)), substantiveHistogram: histogram(judged.map(row => row.substantive)) } : {}),
        rows });
    }
  }
}
results.calls = calls; results.inputTokens = inputTokens;
// Hand labels: the confusion of `kept` at each threshold over the labelled requests.
const labelsFile = arg('--labels');
if (labelsFile && !dry) {
  const labels = JSON.parse(readFileSync(labelsFile, 'utf8'));
  const labelled = results.compactions.flatMap(row => row.rows.map(item => ({ key: `${row.id}:${item.id}`, kept: item.kept }))).filter(item => typeof labels[item.key] === 'boolean' && typeof item.kept === 'number');
  results.labels = { count: labelled.length, positives: labelled.filter(item => labels[item.key]).length, byThreshold: Object.fromEntries([0.2, 0.25, 0.3, 0.35, 0.4, 0.5].map(threshold => {
    const count = (label, above) => labelled.filter(item => labels[item.key] === label && (item.kept >= threshold) === above).length;
    const tp = count(true, true), fp = count(false, true), fn = count(true, false), tn = count(false, false);
    return [threshold, { tp, fp, fn, tn, accuracy: round((tp + tn) / Math.max(1, labelled.length)) }];
  })) };
}
const out = arg('--out');
if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
for (const row of results.compactions) console.log(JSON.stringify({ session: row.session.slice(0, 8), id: row.id.slice(0, 12), trigger: row.trigger, fork: row.fork, forkRejected: row.forkRejected, requestId: row.requestId?.slice(0, 12) ?? null, summaryChars: row.summaryChars, requests: row.requests, substantive: row.substantive, kept: row.kept, coverage: row.coverage, coverageAt05: row.coverageAt05, meanKept: row.meanKept, keptHistogram: row.keptHistogram }));
if (results.labels) console.log(JSON.stringify(results.labels));
console.log(JSON.stringify({ calls, inputTokens }));
