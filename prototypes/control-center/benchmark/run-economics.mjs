#!/usr/bin/env node
// Offline run economics (token-burn design, 2026-10-05, item M): where one background run's tokens and relative cost go, and what
// splitting it would change, measured on COPIES of session journals. Read-only: it opens journal copies for reading, never a
// Store or the daemon, never a provider (no model call, no JEV call, no network), and writes nothing except the JSON report
// named by --out (default: a mode-600 file in the system temp directory, never the working directory: the report holds raw
// snippets of the journals). A path inside a live `.state` tree is refused: copy the journal first.
//
// "The design" and the python names below (ledger.py, phases.py, splitsim.py, longsim.py, boundary.py, contuse.py, blockuse.py)
// are the token-burn study of 2026-10-05 and its scratch scripts, which are not in this repository: every formula they gave is restated
// in the doc comments of the functions here, and the tests pin it on a hand-checked fixture.
//
// Per run (all numbers are the provider-reported usage of each request; only per-tool-result and per-context-entry tokens are
// estimates, labelled as such):
// - phases: the requests after the first and the last write of the deliverable, and their share of the run's tokens (phases.py);
// - first request: what its prompt is made of, per context entry, scaled to the measured prompt size less the system prompt and tool
//   declarations (an ASSUMED estimate from the journal's own prefix size and the declaration bytes; --prefix-tokens measures it);
// - stub tax: tokens per request spent declaring tools the run's purpose could never execute (host-authorization says which),
//   the saving for the run if they were not declared, and the calls that actually reached them (none expected);
//   the per-tool declaration sizes are a snapshot (run-economics-tool-sizes.json, app 0.68.0; --tool-sizes replaces it);
// - repeated reads, reasoning share (generation and replay), a cost attribution (base / tool results / reasoning / other output);
// - "split at this boundary": the run's later requests started in a fresh context that carries only a handoff (design 4.4 and
//   Appendix A; splitsim.py), under the design's formula and under the measured billing (a request's cache read covers the
//   previous PROMPT, not the previous output), with the break-even number of remaining requests, the section-5-S offer test
//   (E[remaining] of the OTHER runs of the project > R*) and its gate (i) (3 of a project's last 10 scheduled runs went on for >= R*);
// - for deep runs: which identifiers the model used after a boundary exist only in earlier tool results or its own earlier
//   output (boundary.py), and which context blocks it reused (contuse.py / blockuse.py).
// Across a project: E[remaining requests | at request k] over all its runs, and the long runs split at their midpoint (longsim.py).
//
// Cost weights: the model's real list price (model-pricing.mjs MODEL_PRICES, priced when exactly one price page lists the model
// id) as per-token weights, otherwise ASSUMED weights input 1, cache read 0.1, cache write 1.25, output 4.5 in "uncached input
// equivalents" (UIE), flagged `assumed` everywhere they are used. Peak and long-context tiers are not modelled in the weights;
// for a priced model the report also carries the exact requestCost sum. `--weights reference` weighs by REFERENCE_PRICES (the
// published list prices of a plan-served model, e.g. GLM-5.3: not a cost, a relative weighing; flagged `reference`),
// `--weights <input,cacheRead,cacheWrite,output>` sets them by hand (flagged `override`): both for sensitivity runs.
//
//   node benchmark/run-economics.mjs <journal.jsonl | directory>... [--out report.json] [--deliverable <regex>] [--top 15]
//     [--detail <session id prefix>] [--deep all|none|auto] [--at <session prefix>:<request>[,...]] [--boundaries 12,24,28]
//     [--writes all|tools] [--handoff-in 3000] [--handoff-out 1500] [--lean-tokens 12000] [--min-requests 60]
//     [--system-tokens N --prefix-tokens N] [--tool-sizes file.json] [--price-preset <id>] [--weights reference|1,0.25,1.25,3.5] [--all]
//   --out - writes no JSON, no --out writes to the system temp directory (printed); --deliverable none skips the phase and split analyses. The default deliverable is the AI-research
//   project's daily.md; --writes tools counts only write/edit tool calls (phases.py), not exec commands that write the file.
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as pricing from '../model-pricing.mjs';

const { MODEL_PRICES, requestCost } = pricing;

export const ASSUMED_WEIGHTS = Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 4.5 });
const DEFAULT_TOOL_SIZES = fileURLToPath(new URL('./run-economics-tool-sizes.json', import.meta.url));
// Rna tool names the analyses key on (the host and SDK declare these; a journal of another host just finds fewer matches).
const WRITE_TOOL = /(^|_)(write|edit|patch|append)$/, EDIT_TOOL = /(^|_)(edit|patch)$/, EXEC_TOOL = /(^|_)(exec|bash|shell)$/;
const WRITTEN_TOOLS = new Set(['project_write', 'project_edit', 'project_exec']), DISK_READ_TOOLS = new Set(['project_read', 'skill_load', 'project_list']);
const READ_TOOL = /(^|_)(read|fetch)$/;
const RUN_TYPES = new Set(['session_header', 'message', 'request_started', 'request_completed', 'tool_intent', 'tool_completed']);
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef\u2000-\u206f]/gu;
const ASCII_ANCHOR = /[A-Za-z0-9][A-Za-z0-9_\-.:/@]{6,}/g, CJK_RUN = /[\u3400-\u9fff]{4,}/g;
const sum = (rows, pick = row => row) => rows.reduce((total, row) => total + pick(row), 0);
const round = (value, digits = 1) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const pct = (part, whole) => whole ? round(100 * part / whole, 1) : null;
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const codePoints = text => { let n = 0; for (const _ of text) n++; return n; };

// ---------------------------------------------------------------------------------------------------------------------------
// Text helpers (lib.py / reuse.py)
/** Estimated tokens of a text: 0.293 per non-CJK character, 0.868 per CJK character (calibrated on GLM prompts, about +-15% on CJK). */
export function estimateTokens(text) { const cjk = (text.match(CJK) ?? []).length; return (codePoints(text) - cjk) * 0.293 + cjk * 0.868; }
export const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => block?.type === 'text' ? block.text ?? '' : '').join('') : '';
/** Distinctive identifiers of a text: 7+ character ASCII identifiers (URLs, paths, ids) and CJK 4-grams at even offsets of 4+ runs. */
export function anchorsOf(text) {
  const found = new Set();
  for (const match of text.matchAll(ASCII_ANCHOR)) found.add(match[0]);
  for (const run of text.match(CJK_RUN) ?? []) for (let i = 0; i + 4 <= run.length; i += 2) found.add(run.slice(i, i + 4));
  return found;
}
export const isStrongAnchor = anchor => /[0-9_\-/:@.]/.test(anchor) || /[A-Z]/.test(anchor.slice(1)) || /[\u3400-\u9fff]/.test(anchor);

// ---------------------------------------------------------------------------------------------------------------------------
// Journals
const TYPE_AT = /"type":\s*"([a-z_]+)"/;
/** The records of a journal copy whose type is wanted. A line is classified from its first 400 characters (seq, prevHash, time,
 * type come first) so the large `event` lines are never parsed; a torn last line is skipped. */
export function parseRecords(text, wanted = RUN_TYPES) {
  const records = []; let from = 0;
  while (from < text.length) {
    let to = text.indexOf('\n', from); if (to < 0) to = text.length;
    const line = text.slice(from, to); from = to + 1;
    if (!line) continue;
    const type = TYPE_AT.exec(line.slice(0, 400))?.[1];
    if (!type || !wanted.has(type)) continue;
    try { records.push(JSON.parse(line)); } catch { /* a torn tail */ }
  }
  return records;
}
const messageView = message => ({ id: message.id, role: message.role, source: message.source, contextKey: message.contextKey ?? null, text: textOf(message.content), context: (message.context ?? []).map(entry => ({ source: entry.source, text: String(entry.text ?? '') })) });

/** One journal as the analyses read it. `steps` are the requests that reported usage (position `k` counts every request_completed
 * in journal order, so a boundary means the same request in every table); `total` also counts aborted and failed requests. */
export function loadRun(file) {
  const records = parseRecords(readFileSync(file, 'utf8'));
  const headerRecord = records.find(record => record.type === 'session_header'), header = headerRecord?.data ?? null;
  const toolDone = new Map(), started = new Map();
  for (const record of records) { if (record.type === 'tool_completed') toolDone.set(record.data.callKey, record); else if (record.type === 'request_started') started.set(record.data.requestId, record.data); }
  const messages = [], steps = []; let initial = null, total = 0, unreported = 0, firstStartedAt = null;
  for (const record of records) {
    if (record.type === 'request_started' && initial === null) initial = messages.length;
    if (record.type === 'message' && record.data?.message) messages.push(messageView(record.data.message));
    if (record.type !== 'request_completed' || !record.data?.message) continue;
    const message = record.data.message, k = total++, usage = message.usage ?? {};
    firstStartedAt ??= headerRecord?.time ?? record.time;
    if (message.usageReported === false || record.data.discarded === true) { unreported++; continue; }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const calls = blocks.filter(block => block.type === 'toolCall').map(block => ({ id: block.id, name: block.name, arguments: block.arguments ?? {} }));
    const results = calls.map(call => { const done = toolDone.get(`${message.id}/${call.id}`)?.data; const text = done ? textOf(done.result?.content) : ''; return { name: call.name, args: call.arguments, argjson: JSON.stringify(call.arguments), text, code: typeof done?.result?.details?.code === 'string' ? done.result.details.code : null, isError: done?.isError ?? null, done: Boolean(done) }; });
    const input = Number(usage.input) || 0, cacheRead = Number(usage.cacheRead) || 0, cacheWrite = Number(usage.cacheWrite) || 0;
    steps.push({ k, time: Date.parse(record.time), P: input + cacheRead + cacheWrite, inp: input, cr: cacheRead, cw: cacheWrite, O: Number(usage.output) || 0, R: Number(usage.reasoningTokens) || 0, usage, model: message.model ?? started.get(record.data.requestId)?.model?.modelId ?? null, protocol: started.get(record.data.requestId)?.model?.protocol ?? null,
      th: blocks.filter(block => block.type === 'thinking').map(block => block.thinking ?? '').join(''), tx: blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join(''), calls, res: results, stopReason: message.stopReason ?? null });
  }
  const firstStart = [...started.values()][0];
  return { file, header, sessionId: header?.sessionId ?? null, projectId: header?.projectId ?? null, messages, initialMessages: messages.slice(0, initial ?? messages.length), steps, requests: { total, billed: steps.length, unreported }, startedAt: firstStartedAt, firstStart, contextPrefixTokens: firstStart?.message?.contextPrefixTokens ?? null };
}

/** The cheap first pass over a journal: session, project and request counts (header and request_completed only). */
export function scanRun(file) {
  const records = parseRecords(readFileSync(file, 'utf8'), new Set(['session_header', 'request_completed']));
  const header = records.find(record => record.type === 'session_header')?.data ?? {}, completed = records.filter(record => record.type === 'request_completed' && record.data?.message);
  return { file, sessionId: header.sessionId ?? null, projectId: header.projectId ?? null, total: completed.length, billed: completed.filter(record => record.data.message.usageReported !== false && record.data.discarded !== true).length };
}

/** The per-request ledger (ledger.py): `I` is what the request's output and results added to the next prompt, `T` the share of that
 * which is tool results, spread over this request's results in proportion to their estimated size. The last request has no next prompt. */
export function buildLedger(steps) {
  return steps.map((step, i) => {
    const next = steps[i + 1], I = next ? next.P - step.P : null, O = step.O, R = Math.min(step.R, O), T = I === null ? 0 : I - O;
    const weights = step.res.map(result => estimateTokens(result.text)), total = sum(weights) || 1;
    return { ...step, I, R, W: O - R, T, res: step.res.map((result, j) => ({ ...result, chars: codePoints(result.text), tokens: I === null ? 0 : Math.max(0, T) * weights[j] / total })) };
  });
}
const outputText = step => `${step.th}\n${step.tx}\n${step.calls.map(call => JSON.stringify(call.arguments)).join('\n')}`;
const tokensOf = rows => sum(rows, row => row.P + row.O);

// ---------------------------------------------------------------------------------------------------------------------------
// Cost model
// Request protocols of subscription endpoints (a ChatGPT subscription): not billed per token, so the model's API list price is no cost
// of the run (model-pricing.mjs modelPrice returns null for them). The journal records the protocol, not the provider's auth mode.
const SUBSCRIPTION_PROTOCOLS = new Set(['openai-codex']);
/** Per-token weights for a model id: its list price when exactly one price page (or the named preset) lists it, else the assumed
 * weights. A price with an unstated rate (null) takes the assumed ratio for that bucket and is `partial`. A run served by a subscription
 * endpoint (`protocol`) is not priced by the model's API page unless a preset is named. */
export function resolveCostModel(modelId, { preset = null, weights = null, protocol = null } = {}) {
  if (weights === 'reference') return referenceCostModel(modelId, preset);
  if (Array.isArray(weights)) { const [input, cacheRead, cacheWrite, output] = weights; return { source: 'override', unit: 'UIE', weights: { input, cacheRead, cacheWrite, output }, modelId, reason: `weights set by hand: input ${input}, cache read ${cacheRead}, cache write ${cacheWrite}, output ${output}` }; }
  if (!preset && SUBSCRIPTION_PROTOCOLS.has(protocol)) return { source: 'assumed', unit: 'UIE', weights: { ...ASSUMED_WEIGHTS }, modelId, reason: `${modelId} was served by a subscription endpoint (${protocol}): not billed per token, so its API list price is no cost of this run` };
  const matches = Object.entries(MODEL_PRICES).filter(([id, models]) => (!preset || id === preset) && models[modelId]).map(([id, models]) => [id, models[modelId]]);
  const distinct = new Set(matches.map(([, entry]) => JSON.stringify([entry.currency, entry.input, entry.output, entry.cacheRead, entry.cacheWrite])));
  if (!matches.length || distinct.size > 1) return { source: 'assumed', unit: 'UIE', weights: { ...ASSUMED_WEIGHTS }, modelId, reason: matches.length ? `${matches.length} price pages list ${modelId} with different prices (pass --price-preset)` : `no price listed for ${modelId}` };
  const [presetId, entry] = matches[0], partial = [];
  const rate = (key, ratio) => { if (entry[key] != null) return entry[key]; partial.push(key); return entry.input * ratio; };
  const per = { input: entry.input, cacheRead: rate('cacheRead', ASSUMED_WEIGHTS.cacheRead), cacheWrite: rate('cacheWrite', ASSUMED_WEIGHTS.cacheWrite), output: entry.output };
  return { source: partial.length ? 'partial' : 'priced', unit: entry.currency, weights: Object.fromEntries(Object.entries(per).map(([key, value]) => [key, value / 1e6])), modelId, presetId, entry, partial, reason: partial.length ? `${partial.join(', ')} unstated on the price page: assumed ratio` : 'list price' };
}
/** Weights from a REFERENCE_PRICES row of the model (a plan-served model's published list price): relative weights only, never a cost. The
 * cache write rate, unstated there, takes the assumed ratio. Falls back to the assumed weights when the checkout has no such row. */
function referenceCostModel(modelId, preset) {
  const references = pricing.REFERENCE_PRICES ?? {}, rows = Object.entries(references).filter(([id, models]) => (!preset || id === preset) && models[modelId]).map(([id, models]) => [id, models[modelId]]);
  const distinct = new Set(rows.map(([, entry]) => JSON.stringify([entry.currency, entry.input, entry.output, entry.cacheRead])));
  if (!rows.length || distinct.size > 1) return { source: 'assumed', unit: 'UIE', weights: { ...ASSUMED_WEIGHTS }, modelId, reason: rows.length ? `${rows.length} reference rows list ${modelId} with different prices (pass --price-preset)` : `no reference price listed for ${modelId}: assumed weights` };
  const [presetId, entry] = rows[0];
  return { source: 'reference', unit: 'UIE', weights: { input: 1, cacheRead: entry.cacheRead / entry.input, cacheWrite: ASSUMED_WEIGHTS.cacheWrite, output: entry.output / entry.input }, modelId, presetId, reason: `reference list price ${entry.currency} ${entry.input} / ${entry.cacheRead} cache read / ${entry.output} output per million (${entry.source?.url}): relative weights, not a cost; cache write assumed` };
}
export const costOf = (rows, w) => sum(rows, row => row.inp * w.input + row.cr * w.cacheRead + row.cw * w.cacheWrite + row.O * w.output);
/** What a token that is new to a prompt costs in this run: the run's own mix of uncached input and cache writes (a provider that reports
 * no cache write, GLM, bills it all at the input weight). The split simulation bills its new tokens the way the baseline did: a model
 * with a cache-write rate must not look cheaper to split just because the simulation forgot to write the cache. */
export function freshRate(rows, w) {
  const input = sum(rows, row => row.inp), written = sum(rows, row => row.cw);
  return input + written > 0 ? (input * w.input + written * w.cacheWrite) / (input + written) : w.input;
}
const dominantModel = steps => { const counts = new Map(); for (const step of steps) counts.set(step.model, (counts.get(step.model) ?? 0) + 1); return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
const protocolOf = (steps, modelId) => steps.find(step => step.model === modelId && step.protocol)?.protocol ?? null;

// ---------------------------------------------------------------------------------------------------------------------------
// Deliverable writes and phases (phases.py)
const execWrites = (command, source) => {
  if (typeof command !== 'string' || !new RegExp(source).test(command)) return false;
  const token = `[^\\s'"\`|;&<>()]*(?:${source})[^\\s'"\`|;&<>()]*`;
  return [new RegExp(`open\\(\\s*[rRbBuUfF]*['"][^'"\\n]*(?:${source})[^'"\\n]*['"]\\s*,\\s*['"][wax]`), new RegExp(`(?:>>?|\\btee\\b(?:\\s+-a)?)\\s*['"]?${token}`), new RegExp(`Path\\([^)]*(?:${source})[^)]*\\)\\.write_(?:text|bytes)`)].some(pattern => pattern.test(command));
};
const WRITE_RANK = { edit: 1, exec: 2, write: 3 };
/** The requests that write the deliverable: write / edit tool calls on it (path field, else anywhere in the arguments) and, unless
 * `tools` only (phases.py), exec commands that write it through open(..., 'w'), a redirection, tee or write_text. */
export function detectWrites(ledger, deliverable, { tools = false } = {}) {
  const source = deliverable instanceof RegExp ? deliverable.source : String(deliverable), at = new RegExp(source), writes = [];
  for (const step of ledger) {
    // A request with several writing calls is one write; a whole-file write (tool or exec) outranks a patch whichever call comes first,
    // so the boundary does not depend on the order of the calls inside one request.
    let via = null; const note = kind => { if (via === null || WRITE_RANK[kind] > WRITE_RANK[via]) via = kind; };
    for (const call of step.calls) {
      const args = call.arguments ?? {};
      if (WRITE_TOOL.test(call.name)) { const path = [args.path, args.file_path, args.file].find(value => typeof value === 'string'); if (path !== undefined ? at.test(path) : at.test(JSON.stringify(args))) note(EDIT_TOOL.test(call.name) ? 'edit' : 'write'); }
      else if (!tools && EXEC_TOOL.test(call.name) && execWrites(args.command ?? args.cmd, source)) note('exec');
    }
    if (via) writes.push({ k: step.k, via });
  }
  return writes;
}
const after = (ledger, k) => { const rows = ledger.filter(step => step.k > k), tokens = tokensOf(rows); return { requests: rows.length, tokens, share: pct(tokens, tokensOf(ledger)) }; };
/** Phases around the deliverable. `boundary` = the end of the writing phase: the last whole-file write (write tool or exec), else the
 * last patch (a patch after a full write is a review fix). It reproduces the design's boundaries for the five daily runs. */
export function phaseReport(ledger, writes) {
  if (!writes.length) return null;
  const firstWrite = writes[0].k, lastWrite = writes.at(-1).k, bulk = writes.filter(write => write.via !== 'edit');
  const boundary = bulk.length ? bulk.at(-1).k : lastWrite, total = tokensOf(ledger);
  const slice = (from, to) => { const rows = ledger.filter(step => step.k > from && step.k <= to), tokens = tokensOf(rows); return { requests: rows.length, tokens, share: pct(tokens, total) }; };
  return { writes, firstWrite, lastWrite, boundary, boundaryRule: bulk.length ? 'last whole-file write' : 'last patch', afterFirstWrite: after(ledger, firstWrite), afterLastWrite: after(ledger, lastWrite), afterBoundary: after(ledger, boundary), collect: slice(-1, firstWrite), write: slice(firstWrite, lastWrite), verify: slice(lastWrite, Infinity) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Splitting (splitsim.py, longsim.py; design 4.4, Appendix A)
/** Requests 0..bi unchanged; the rest start in a new context: the first request's prompt + a handoff of `handoffIn` tokens + what
 * the old context's later prompts grew by; the handoff's output is paid once. `outputBilling` 'cached' = the design's formula (the
 * next request reads the previous prompt AND output from cache), 'uncached' = the measured billing (a cache read covers the
 * previous prompt only, so the previous output is billed as new input). Output tokens are held (so these are upper bounds). */
export function simulateSplit(ledger, bi, w, { handoffIn = 3000, handoffOut = 1500, warmPrefix = 0, leanTokens = 0, outputBilling = 'cached' } = {}) {
  const pre = ledger.slice(0, bi + 1), post = ledger.slice(bi + 1), p0 = ledger[0].P - leanTokens, fresh = freshRate(ledger, w);
  let cost = costOf(pre, w) + handoffOut * w.output, tokens = tokensOf(pre) + handoffOut, previous = null;
  for (const step of post) {
    const prompt = p0 + handoffIn + (step.P - post[0].P);
    cost += (previous === null ? (prompt - warmPrefix) * fresh + warmPrefix * w.cacheRead : (prompt - previous) * fresh + previous * w.cacheRead) + step.O * w.output;
    tokens += prompt + step.O; previous = outputBilling === 'cached' ? prompt + step.O : prompt;
  }
  return { tokens, cost };
}
/** Break-even of a handoff (Appendix A): each remaining request saves (pNow - base - handoff) x cache-read weight; the fixed cost is the
 * new context's base + handoff billed at the rate of a new token (`fresh`, default the input weight; see freshRate) instead of the cached
 * one (less a warm shared prefix) plus the handoff's output. `rStar` is the number of remaining requests at which it pays. */
export function handoffBreakEven({ pNow, base, handoff = 3000, handoffOut = 1500, warmPrefix = 0, fresh = null }, w = ASSUMED_WEIGHTS) {
  const saving = (pNow - base - handoff) * w.cacheRead, fixed = Math.max(0, base + handoff - warmPrefix) * ((fresh ?? w.input) - w.cacheRead) + handoffOut * w.output;
  return { savingPerRequest: saving, fixedCost: fixed, rStar: saving > 0 ? fixed / saving : Infinity };
}
const indexAt = (ledger, position) => { let found = -1; for (let i = 0; i < ledger.length; i++) if (ledger[i].k <= position) found = i; return found; };
/** The split scenarios of one run at a boundary (a request position = the last request of the old context): cold, warm shared prefix,
 * an 8K handoff, a leaner base (`leanTokens` less in the first prompt), each under both billing readings; the break-even, with P_now the
 * prompt the old context would send next; and, given an expectation, the section-5-S trigger (offer when E[remaining] > R*). */
export function splitReport(ledger, boundary, w, { handoffIn = 3000, handoffOut = 1500, warmPrefix = 0, leanTokens = 12000, remaining = null, peers = null } = {}) {
  const bi = indexAt(ledger, boundary);
  if (bi < 0 || bi >= ledger.length - 1) return null;
  const baseTokens = tokensOf(ledger), baseCost = costOf(ledger, w), requestsAfter = ledger.length - bi - 1;
  const scenario = (options, billing) => { const run = simulateSplit(ledger, bi, w, { handoffIn, handoffOut, ...options, outputBilling: billing }); return { tokens: run.tokens, tokensPct: pct(run.tokens - baseTokens, baseTokens), cost: run.cost, costPct: pct(run.cost - baseCost, baseCost) }; };
  const variants = { cold: {}, ...(warmPrefix ? { warm: { warmPrefix } } : {}), coldLargeHandoff: { handoffIn: 8000 }, coldLean: leanTokens ? { leanTokens } : null };
  const scenarios = {};
  for (const [name, options] of Object.entries(variants)) if (options) scenarios[name] = { designFormula: scenario(options, 'cached'), measuredBilling: scenario(options, 'uncached') };
  const pNow = ledger[bi + 1].P, breakEven = handoffBreakEven({ pNow, base: ledger[0].P, handoff: handoffIn, handoffOut, fresh: freshRate(ledger, w) }, w);
  return { boundary: ledger[bi].k, requestsAfter, tokensAfterShare: pct(tokensOf(ledger.slice(bi + 1)), baseTokens), baseline: { tokens: baseTokens, cost: baseCost }, scenarios, pNow, breakEven: { ...breakEven, rStar: Number.isFinite(breakEven.rStar) ? round(breakEven.rStar, 1) : null }, trigger: remaining == null ? null : { expectedRemaining: remaining.mean, runs: remaining.runs, basis: peers, offer: remaining.mean > breakEven.rStar } };
}
/** Design 5-S gate (i), per project: of the last `window` scheduled runs that write the deliverable (runs in start order), how many went on
 * for at least their own break-even number of requests after the writing boundary (cold start, the configured handoff; no saving per
 * request = never)? Stage handoff is built only when `needed` of them did; this reads the realized runs, not an expectation. */
export function handoffGate(runs, { window = 10, needed = 3 } = {}) {
  const byProject = new Map();
  for (const run of runs) {
    if (run.kind !== 'schedule' || !run.phases) continue;
    const split = run.splits.find(row => row.boundary === run.phases.boundary), saving = split?.breakEven.savingPerRequest, rStar = saving > 0 ? split.breakEven.fixedCost / saving : null, requestsAfter = run.phases.afterBoundary.requests;
    const key = JSON.stringify(run.projectId ?? null); if (!byProject.has(key)) byProject.set(key, { projectId: run.projectId ?? null, rows: [] });
    byProject.get(key).rows.push({ short: run.short, startedAt: run.startedAt, requestsAfter, rStar: rStar == null ? null : round(rStar, 1), pass: rStar != null && requestsAfter >= rStar });
  }
  return [...byProject.values()].map(({ projectId, rows }) => { const last = rows.slice(-window), passing = last.filter(row => row.pass).length; return { projectId, window, needed, considered: last.length, passing, met: passing >= needed, runs: last }; });
}
/** The long runs of a project split at their midpoint, or after request 63 when the run went past the 64-step yield (longsim.py). */
export function longRunSplit(ledger, requestTotal, w) {
  const boundary = requestTotal > 64 ? 63 : requestTotal >> 1, bi = indexAt(ledger, boundary);
  if (bi < 0 || bi >= ledger.length - 1) return null;
  const base = costOf(ledger, w), baseTokens = tokensOf(ledger), pick = (extra, billing) => { const run = simulateSplit(ledger, bi, w, { handoffOut: 1500, ...extra, outputBilling: billing }); return { tokensPct: pct(run.tokens - baseTokens, baseTokens), costPct: pct(run.cost - base, base) }; };
  return { boundary, requestsAfter: ledger.length - bi - 1, firstPrompt: ledger[0].P, lastPrompt: ledger.at(-1).P, tokens: baseTokens, cost: base, handoff3K: { designFormula: pick({ handoffIn: 3000 }, 'cached'), measuredBilling: pick({ handoffIn: 3000 }, 'uncached') }, handoff8K: { designFormula: pick({ handoffIn: 8000 }, 'cached'), measuredBilling: pick({ handoffIn: 8000 }, 'uncached') } };
}
/** E[remaining requests | the run is past request k]: over the runs that issued a request k+1, the mean and median of (n - k). */
export function remainingExpectation(counts, ks = null) {
  const top = Math.max(0, ...counts), points = ks ?? Array.from({ length: top }, (_, i) => i + 1), rows = [];
  for (const k of points) { const remaining = counts.filter(n => n > k).map(n => n - k); if (remaining.length) rows.push({ k, runs: remaining.length, mean: round(sum(remaining) / remaining.length, 1), median: median(remaining), p90: [...remaining].sort((a, b) => a - b)[Math.min(remaining.length - 1, Math.floor(remaining.length * 0.9))] }); }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------------
// First request: prefix, composition, stub tax
// Two calibration constants from the one pair of measurements the study has (2026-10-05, a scheduled GLM-5.3 run of app 0.68.0): the
// shared system + tool-declaration prefix was 13,248 tokens (the cache hit two runs showed) while the SDK's own estimate (bytes / 3,
// `contextPrefixTokens`) said 18,503; the 50 tool declarations were 45,186 bytes and, after the 3,264-token system prompt, 9,984 tokens.
// Both are ASSUMED to carry over to other runs (the tokenizer is the same, the prompt versions are not): a run reports its own
// `source`, and --prefix-tokens / --system-tokens replace the estimate with a measurement.
export const PREFIX_TOKENS_PER_ESTIMATE = 13248 / 18503, TOOL_BYTES_PER_TOKEN = 45186 / 9984;
/** The tools a run's purpose could execute and those it only declares (host-authorization), or null when the journal has no such block. */
export function declaredToolSet(run) {
  const text = run.initialMessages.flatMap(message => message.context).find(entry => entry.source === 'host-authorization')?.text;
  let authorization = null; try { authorization = text ? JSON.parse(text) : null; } catch { /* unreadable */ }
  return authorization && Array.isArray(authorization.executableTools) && Array.isArray(authorization.declaredButUnavailable) ? { executable: authorization.executableTools, stubs: authorization.declaredButUnavailable } : null;
}
/** Declaration bytes of tool names from the size table (an unlisted name takes the table's median). */
export function declarationBytes(names, sizes) {
  const known = Object.values(sizes.bytes), fallback = median(known) ?? 0, unsized = names.filter(name => sizes.bytes[name] === undefined);
  return { bytes: sum(names, name => sizes.bytes[name] ?? fallback), unsized };
}
/** The system + tool-declaration prefix of a run's first request: from `contextPrefixTokens` x the calibrated ratio, or an option; the tool
 * declarations from their bytes when the run declares a known tool set; the system prompt is the rest. */
export function estimatePrefix(run, declared, { systemTokens = null, prefixTokens = null } = {}) {
  const prefix = prefixTokens ?? (run.contextPrefixTokens != null ? Math.round(run.contextPrefixTokens * PREFIX_TOKENS_PER_ESTIMATE) : null);
  const tools = declared ? Math.round(declared.bytes / TOOL_BYTES_PER_TOKEN) : null;
  const system = systemTokens ?? (prefix != null && tools != null ? Math.max(0, prefix - tools) : null);
  return { prefixTokens: prefix ?? (system != null && tools != null ? system + tools : null), toolsTokens: tools, systemTokens: system, source: prefixTokens != null ? 'option' : prefix != null ? 'assumed: contextPrefixTokens x 0.716' : 'unknown' };
}
/** What the first request's prompt is made of: the context entries (each message source; project-evidence split into the recent
 * turns, the action receipts and the rest) with character counts and tokens estimated by character class, scaled so the entries
 * sum to the measured prompt less the prefix; the prefix itself. */
export function firstRequestComposition(run, ledger, prefix) {
  if (!ledger.length) return null;
  const entries = new Map();
  for (const message of run.initialMessages) { if (message.source === 'user' && message.text) entries.set('task-message', message.text); for (const entry of message.context) entries.set(entry.source, entry.text); }
  const rows = [];
  for (const [source, text] of entries) {
    if (source === 'project-evidence') {
      let parsed = null; try { parsed = JSON.parse(text.slice(text.indexOf('{'))); } catch { /* not JSON */ }
      const continuity = parsed?.project?.continuity;
      if (continuity && (continuity.recentTurns || continuity.actionReceipts)) {
        const parts = [['project-evidence.recentTurns', JSON.stringify(continuity.recentTurns ?? null)], ['project-evidence.actionReceipts', JSON.stringify(continuity.actionReceipts ?? null)]];
        let rest = estimateTokens(text), restChars = codePoints(text);
        for (const [name, part] of parts) { const tokens = estimateTokens(part); rows.push({ source: name, chars: codePoints(part), raw: tokens }); rest -= tokens; restChars -= codePoints(part); }
        rows.push({ source: 'project-evidence.rest', chars: Math.max(0, restChars), raw: Math.max(0, rest) });
        continue;
      }
    }
    rows.push({ source, chars: codePoints(text), raw: estimateTokens(text) });
  }
  const first = ledger[0], contextTokens = prefix?.prefixTokens != null && first.P > prefix.prefixTokens ? first.P - prefix.prefixTokens : null, rawSum = sum(rows, row => row.raw), scale = contextTokens != null && rawSum ? contextTokens / rawSum : 1;
  return { promptTokens: first.P, cacheRead: first.cr, systemTokens: prefix?.systemTokens ?? null, toolDeclarationTokens: prefix?.toolsTokens ?? null, prefixSource: prefix?.source ?? 'unknown', contextTokens, scale: round(scale, 3), scaled: contextTokens != null, rawContextTokens: Math.round(rawSum), entries: rows.map(row => ({ source: row.source, chars: row.chars, tokens: Math.round(row.raw * scale), share: pct(row.raw * scale, first.P) })) };
}
// The receipt a host returns for a declared tool the request purpose cannot execute (SDK prompt-layers.mjs authorizationRejection): the
// code is machine-readable in `details.code`; the text (Chinese for the user) is the fallback of a journal that lost the details, and the
// old SDK refusal of a tool that was never assigned to the session is English.
const STUB_REJECTION_TEXT = /此工具在当前请求用途中不可用|This tool is not available for the current request purpose|not assigned to this session/i;
export const isStubRejection = result => result.code === 'tool_unavailable_for_purpose' || (result.code == null && STUB_REJECTION_TEXT.test(result.text ?? ''));
/** The tool declarations a run's purpose could never execute (host-authorization: declaredButUnavailable), what they cost per request
 * (their declaration bytes / the calibrated bytes per token) and what not declaring them would save this run: tokens x requests, and in
 * relative cost the first request at the uncached rate and the later ones at the cache-read rate (Appendix A: S x (1 + w x (N - 1))). */
export function stubTax(declared, ledger, w, sizes) {
  if (!declared) return null;
  const all = [...declared.stubs, ...declared.executable], stub = declarationBytes(declared.stubs, sizes), full = declarationBytes(all, sizes);
  const stubSet = new Set(declared.stubs), calls = ledger.flatMap(step => step.calls).filter(call => stubSet.has(call.name)).length;
  const receipts = ledger.flatMap(step => step.res).filter(isStubRejection).length;
  const n = ledger.length, perRequest = stub.bytes / TOOL_BYTES_PER_TOKEN, saving = perRequest * (w.input + w.cacheRead * Math.max(0, n - 1));
  return { declared: all.length, executable: declared.executable.length, stubs: declared.stubs.length, stubByteShare: round(full.bytes ? stub.bytes / full.bytes : 0, 3), unsizedTools: [...new Set([...stub.unsized, ...full.unsized])], stubTokensPerRequest: Math.round(perRequest), tokensSaved: Math.round(perRequest * n), tokensSavedPct: pct(perRequest * n, tokensOf(ledger)), costSavedPct: pct(saving, costOf(ledger, w)), calls, rejectionReceipts: receipts, firstRequestCacheRead: ledger[0]?.cr ?? 0 };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Repeated reads, reasoning, cost attribution
const READ_KEYS = ['path', 'file_path', 'file', 'url', 'id'];
/** Reads of one target more than once in a run (same tool and path/url/id): how many times, how big, whether the content was identical,
 * and the estimated tokens of the 2nd and later results (and how many requests carried them). */
export function repeatedReads(ledger) {
  const groups = new Map(), n = ledger.length;
  ledger.forEach((step, i) => step.res.forEach(result => {
    if (!READ_TOOL.test(result.name)) return;
    const target = READ_KEYS.map(key => result.args?.[key]).find(value => typeof value === 'string' && value);
    if (!target) return;
    const key = `${result.name} ${target}`; if (!groups.has(key)) groups.set(key, { tool: result.name, target, reads: [] });
    groups.get(key).reads.push({ k: step.k, chars: result.chars, tokens: Math.round(result.tokens), args: Object.fromEntries(Object.entries(result.args).filter(([name, value]) => name !== 'path' && typeof value !== 'object')), text: result.text, carried: n - 1 - i });
  }));
  const rows = [...groups.values()].filter(group => group.reads.length > 1).map(group => ({ tool: group.tool, target: group.target, reads: group.reads.length, identical: new Set(group.reads.map(read => read.text)).size === 1, chars: group.reads.map(read => read.chars), steps: group.reads.map(read => read.k),
    laterTokens: sum(group.reads.slice(1), read => read.tokens), laterTokenSteps: sum(group.reads.slice(1), read => read.tokens * read.carried) }));
  return { groups: rows.sort((a, b) => b.laterTokenSteps - a.laterTokenSteps), laterTokens: sum(rows, row => row.laterTokens), laterTokenSteps: sum(rows, row => row.laterTokenSteps), shareOfPromptTokens: pct(sum(rows, row => row.laterTokenSteps), sum(ledger, step => step.P)) };
}
/** Where one run's cost goes, by the carrying model: every token that enters the prompt is billed uncached the first time it is
 * re-sent and at the cache-read rate in the later requests; generated tokens are billed as output once. Residual = reported - modelled. */
export function costBreakdown(ledger, w) {
  const n = ledger.length; if (!n) return null;
  const carried = (tokens, m) => m <= 0 ? 0 : tokens * (w.input + w.cacheRead * (m - 1));
  const parts = { base: carried(ledger[0].P, n), toolResults: 0, reasoningGeneration: 0, reasoningReplay: 0, otherOutputGeneration: 0, otherOutputReplay: 0, finalAnswer: ledger.at(-1).W * w.output };
  ledger.forEach((step, i) => {
    const m = n - 1 - i;
    parts.toolResults += carried(Math.max(0, step.T), m); parts.reasoningGeneration += step.R * w.output; parts.reasoningReplay += carried(step.R, m);
    if (i < n - 1) { parts.otherOutputGeneration += step.W * w.output; parts.otherOutputReplay += carried(step.W, m); }
  });
  const modelled = sum(Object.values(parts)), actual = costOf(ledger, w), reasoning = parts.reasoningGeneration + parts.reasoningReplay, other = parts.otherOutputGeneration + parts.otherOutputReplay;
  const replayTokenSteps = sum(ledger.map((step, i) => step.R * (n - 1 - i)));
  return { actual, modelled, residual: actual - modelled, parts, shares: { base: pct(parts.base, actual), toolResults: pct(parts.toolResults, actual), reasoning: pct(reasoning, actual), reasoningGeneration: pct(parts.reasoningGeneration, actual), reasoningReplay: pct(parts.reasoningReplay, actual), otherOutput: pct(other, actual), finalAnswer: pct(parts.finalAnswer, actual), residual: pct(actual - modelled, actual) }, reasoningTokenSteps: replayTokenSteps };
}
export function reasoningReport(ledger, breakdown) {
  const output = sum(ledger, step => step.O), reasoning = sum(ledger, step => step.R), prompt = sum(ledger, step => step.P);
  return { outputTokens: output, reasoningTokens: reasoning, reasoningOfOutputPct: pct(reasoning, output), replayedTokenSteps: breakdown?.reasoningTokenSteps ?? 0, replayedOfPromptPct: pct(breakdown?.reasoningTokenSteps ?? 0, prompt), generationCostPct: breakdown?.shares.reasoningGeneration ?? null, replayCostPct: breakdown?.shares.reasoningReplay ?? null, costPct: breakdown?.shares.reasoning ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Deep text analyses (boundary.py, contuse.py, blockuse.py)
const firstIndex = (map, key, index) => { if (!map.has(key)) map.set(key, index); };
/** Which identifiers the model used after a boundary exist only in tool results or its own output from before it. A model output after
 * the boundary is split, per identifier, into the first category that holds: static context, also in a later tool result (so the new
 * context would get it again), new after the boundary, in a file written before it, in the opening reads (README, skill, listing), ONLY
 * in a pre-boundary tool result, ONLY in the model's own earlier output. The last two are what a handoff would have to carry. */
export function boundaryDependence(run, ledger, boundaries) {
  const n = ledger.length, out = ledger.map(step => anchorsOf(outputText(step))), res = ledger.map(step => anchorsOf(step.res.map(result => result.text).join('\n')));
  const written = ledger.map(step => anchorsOf(step.calls.filter(call => WRITTEN_TOOLS.has(call.name)).map(call => JSON.stringify(call.arguments)).join('\n')));
  const disk = ledger.map(step => anchorsOf(step.res.filter(result => DISK_READ_TOOLS.has(result.name)).map(result => result.text).join('\n')));
  const base = anchorsOf(run.messages.map(message => `${message.text} ${message.context.map(entry => entry.text).join(' ')}`).join(' '));
  const firstRes = new Map(), lastRes = new Map(), firstOut = new Map(), firstWritten = new Map(), firstDisk = new Map();
  for (let i = 0; i < n; i++) {
    for (const a of res[i]) { firstIndex(firstRes, a, i); lastRes.set(a, i); }
    for (const a of out[i]) firstIndex(firstOut, a, i);
    for (const a of written[i]) firstIndex(firstWritten, a, i);
    for (const a of disk[i]) firstIndex(firstDisk, a, i);
  }
  return boundaries.map(boundary => {
    const b = indexAt(ledger, boundary), counts = {}, samples = {}, seen = new Set();
    if (b < 0) return { boundary, requestsAfter: 0, categories: counts, samples };
    const note = (category, anchor, j) => { counts[category] = (counts[category] ?? 0) + 1; (samples[category] ??= []); if (samples[category].length < 25) samples[category].push({ anchor: anchor.slice(0, 60), step: ledger[j].k }); };
    for (let j = b + 1; j < n; j++) for (const a of out[j]) {
      if (seen.has(a)) continue; seen.add(a);
      const inRes = firstRes.has(a) && firstRes.get(a) <= b, inOut = firstOut.has(a) && firstOut.get(a) <= b;
      if (base.has(a)) note('static_context', a, j);
      else if (lastRes.has(a) && lastRes.get(a) > b) note('also_in_post_results', a, j);
      else if (!inRes && !inOut) note('new_after_boundary', a, j);
      else if (firstWritten.has(a) && firstWritten.get(a) <= b) note('in_files_written_before_b', a, j);
      else if (firstDisk.has(a) && firstDisk.get(a) <= b) note('in_step0_disk_reads', a, j);
      else if (inRes) note('ONLY_in_pre_b_tool_results', a, j);
      else note('ONLY_in_pre_b_own_output', a, j);
    }
    return { boundary: ledger[b].k, requestsAfter: n - b - 1, categories: counts, samples };
  });
}
const strongOf = used => used.filter(isStrongAnchor);
/** Which context blocks the model reused: identifiers unique to a block (not in the other blocks, not in any tool result) that the
 * model's output contains. `evidence` splits project-evidence into the chat excerpt, the prior-run receipts, the recent conversation and
 * the collaboration block (contuse.py); `blocks` is every context source in turn (blockuse.py). 'Reused' can falsify "unused", never prove
 * "used": read the model's reasoning before calling a block load-bearing. */
export function contextBlockUse(run, ledger) {
  const first = run.messages.slice(0, 12), results = anchorsOf(ledger.flatMap(step => step.res.map(result => result.text)).join(' ')), outputs = new Set();
  for (const step of ledger) for (const a of anchorsOf(outputText(step))) outputs.add(a);
  const pool = new Map(), add = (key, text) => pool.set(key, (pool.get(key) ?? '') + text);
  for (const message of first) { for (const entry of message.context) add(entry.source, entry.text); if (message.role === 'user' && (!message.context.length || message.contextKey == null)) add('user-text', message.text); }
  const usage = (text, others) => { const a = [...anchorsOf(text)].filter(anchor => !others.has(anchor) && !results.has(anchor)), used = a.filter(anchor => outputs.has(anchor)), strong = strongOf(used); return { uniqueAnchors: a.length, reused: used.length, strong: strong.length, examples: strong.slice(0, 8).map(anchor => anchor.slice(0, 40)) }; };
  let evidence = null;
  const text = pool.get('project-evidence');
  if (text) {
    let parsed = null; try { parsed = JSON.parse(text.slice(text.indexOf('{'))); } catch { /* not JSON */ }
    if (parsed?.project) {
      const continuity = parsed.project.continuity ?? {}, json = value => value === undefined ? 'null' : JSON.stringify(value), rest = JSON.parse(JSON.stringify(parsed));
      if (rest.project.continuity) { delete rest.project.continuity.recentTurns; delete rest.project.continuity.actionReceipts; } delete rest.project.recentConversation; delete rest.project.communication;
      const others = anchorsOf(`${[...pool].filter(([key]) => key !== 'project-evidence').map(([, value]) => value).join(' ')} ${JSON.stringify(rest)}`);
      evidence = Object.entries({ recentTurns: json(continuity.recentTurns), actionReceipts: json(continuity.actionReceipts), recentConversation: json(parsed.project.recentConversation), communication: json(parsed.project.communication) }).filter(([, value]) => value.length >= 20).map(([name, value]) => ({ block: name, chars: value.length, ...usage(value, others) }));
    }
  }
  const blocks = new Map();
  for (const message of first) { for (const entry of message.context) blocks.set(entry.source, entry.text); if (message.role === 'user' && message.contextKey == null) blocks.set('user-text', message.text); }
  return { evidence, blocks: [...blocks].map(([name, value]) => ({ block: name, chars: value.length, ...usage(value, anchorsOf([...blocks].filter(([key]) => key !== name).map(([, other]) => other).join(' '))) })) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collecting journals, the analysis, the report
const LIVE_SEGMENTS = new Set(['.state', 'state.json.rna']);
/** Refuses a path inside a live `.state` tree (a journal the daemon may be appending to): copy it first. */
export function assertCopy(path) {
  const absolute = resolve(path); let real = absolute; try { real = realpathSync(absolute); } catch { /* not there yet */ }
  for (const candidate of new Set([absolute, real])) if (candidate.split(sep).some(part => LIVE_SEGMENTS.has(part))) throw new Error(`${path} is inside a live .state tree; copy the journal elsewhere first (this tool reads copies only).`);
  return real;
}
function journalFiles(root, found = []) {
  const stat = statSync(root);
  if (stat.isDirectory()) for (const name of readdirSync(root).sort()) { if (name.startsWith('.')) continue; journalFiles(join(root, name), found); }
  else if (/\.jsonl$/.test(root)) found.push(root);
  return found;
}
const headOf = (file, bytes = 1200) => { const fd = openSync(file, 'r'); try { const buffer = Buffer.alloc(bytes), read = readSync(fd, buffer, 0, bytes, 0); return buffer.toString('utf8', 0, read); } finally { closeSync(fd); } };
const isJournal = head => /"type":\s*"session_header"/.test(head) && /"format":\s*"rna-session"/.test(head);
/** Journal copies under the given files and directories, one per session id (a repeated copy of the same session is listed, not counted twice). */
export function collectJournals(paths) {
  const files = [], skipped = [], duplicates = [], bySession = new Map();
  for (const path of paths) { assertCopy(path); journalFiles(resolve(path), files); }
  for (const file of [...new Set(files)].sort()) {
    const head = headOf(file);
    if (!isJournal(head)) { skipped.push({ file, reason: 'not a session journal' }); continue; }
    const sessionId = /"sessionId":\s*"([^"]+)"/.exec(head)?.[1] ?? file;
    if (bySession.has(sessionId)) { duplicates.push({ file, sameAs: bySession.get(sessionId) }); continue; }
    bySession.set(sessionId, file);
  }
  return { files: [...bySession.values()], skipped, duplicates };
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export const DEFAULTS = { deliverable: 'daily\\.md', writes: 'all', handoffIn: 3000, handoffOut: 1500, leanTokens: 12000, minRequests: 60, top: 15, deep: 'auto' };
const kindOf = sessionId => /^schedule-work-/.test(sessionId ?? '') ? 'schedule' : 'other';
const parseAt = text => Object.fromEntries((text ?? '').split(',').filter(Boolean).map(item => { const [session, request] = item.split(':'); return [session, Number(request)]; }));

/** Analyse a set of journal files. Pass 1 counts each run's requests (the expectation of the remaining requests needs every run of a
 * project before any one run is judged); pass 2 analyses each run with its journal in memory only for that run. */
export function analyze(files, options = {}) {
  const o = { ...DEFAULTS, ...options }, sizes = o.toolSizes ? readJson(o.toolSizes) : readJson(DEFAULT_TOOL_SIZES), at = parseAt(o.at), boundariesOption = (o.boundaries ?? '').split(',').filter(Boolean).map(Number);
  const scans = files.map(scanRun);
  // Peer groups are keyed by the (project, kind) pair, never by a joined string: a journal header may carry no project (null) and an id may hold a '/'.
  const groupKey = (projectId, kind) => JSON.stringify([projectId ?? null, kind]), groups = new Map();
  const addTo = (projectId, kind, scan) => { const key = groupKey(projectId, kind); if (!groups.has(key)) groups.set(key, { projectId: projectId ?? null, kind, scans: [] }); groups.get(key).scans.push(scan); };
  for (const scan of scans) { addTo(scan.projectId, null, scan); addTo(scan.projectId, kindOf(scan.sessionId), scan); }
  const expectation = new Map([...groups].map(([key, group]) => [key, remainingExpectation(group.scans.map(row => row.total))]));
  const pooled = remainingExpectation(scans.map(scan => scan.total));
  const runs = [], longRuns = [], modelCounts = new Map();
  for (const file of files) {
    const run = loadRun(file), ledger = buildLedger(run.steps); if (!ledger.length) continue;
    const modelId = dominantModel(run.steps), cost = resolveCostModel(modelId, { preset: o.pricePreset ?? null, weights: o.weights ?? null, protocol: protocolOf(run.steps, modelId) }), w = cost.weights;
    modelCounts.set(`${modelId}|${cost.source}|${cost.unit}`, (modelCounts.get(`${modelId}|${cost.source}|${cost.unit}`) ?? 0) + 1);
    const declared = declaredToolSet(run), prefix = estimatePrefix(run, declared ? declarationBytes([...declared.stubs, ...declared.executable], sizes) : null, { systemTokens: o.systemTokens ?? null, prefixTokens: o.prefixTokens ?? null });
    const writes = o.deliverable && o.deliverable !== 'none' ? detectWrites(ledger, o.deliverable, { tools: o.writes === 'tools' }) : [], phases = phaseReport(ledger, writes);
    // The run's own expectation for the offer test leaves the run itself out (it is not in the history the host would have at that moment):
    // from its project's schedule runs when there are 3 or more of them, else from all the project's runs. The project table counts every run.
    const session = run.sessionId ?? basename(file), shortId = session.replace(/^schedule-work-/, '').slice(0, 8), project = run.projectId ?? null, kind = kindOf(session), kindGroup = groups.get(groupKey(project, kind)), peerGroup = kindGroup.scans.length >= 3 ? kindGroup : groups.get(groupKey(project, null));
    const othersTotal = peerGroup.scans.filter(scan => scan.file !== file).map(scan => scan.total), peers = peerGroup.kind === null ? 'project' : `project/${peerGroup.kind}`;
    const boundaries = new Set(); if (phases) { boundaries.add(phases.boundary); if (phases.lastWrite !== phases.boundary) boundaries.add(phases.lastWrite); }
    for (const [prefix, request] of Object.entries(at)) if (session.includes(prefix) || basename(file).includes(prefix)) boundaries.add(request);
    const remainingAt = k => remainingExpectation(othersTotal, [k])[0] ?? null;
    const splits = [...boundaries].map(boundary => splitReport(ledger, boundary, w, { handoffIn: o.handoffIn, handoffOut: o.handoffOut, warmPrefix: prefix.prefixTokens ?? 0, leanTokens: o.leanTokens, remaining: remainingAt(boundary + 1), peers })).filter(Boolean);
    const breakdown = costBreakdown(ledger, w), actualRequestCost = cost.source === 'priced' || cost.source === 'partial' ? sumRequestCost(ledger, cost) : null;
    const summary = { sessionId: session, short: shortId, kind, projectId: project, file, startedAt: run.startedAt, model: modelId, cost: { source: cost.source, unit: cost.unit, reason: cost.reason, weights: w },
      requests: run.requests, tokens: tokensOf(ledger), promptTokens: sum(ledger, step => step.P), outputTokens: sum(ledger, step => step.O), uncachedInput: sum(ledger, step => step.inp), cacheRead: sum(ledger, step => step.cr), cacheWrite: sum(ledger, step => step.cw), firstPrompt: ledger[0].P, lastPrompt: ledger.at(-1).P, cacheReadShare: pct(sum(ledger, step => step.cr), sum(ledger, step => step.P)), cacheReadOfTokensPct: pct(sum(ledger, step => step.cr), tokensOf(ledger)), toolCalls: sum(ledger, step => step.calls.length),
      relativeCost: costOf(ledger, w), requestCostSum: actualRequestCost, phases, firstRequest: firstRequestComposition(run, ledger, prefix), stubTax: stubTax(declared, ledger, w, sizes), repeatedReads: repeatedReads(ledger), reasoning: reasoningReport(ledger, breakdown), costBreakdown: breakdown, splits };
    const deep = o.deep === 'all' || (o.deep === 'auto' && phases);
    if (deep) { const list = boundariesOption.length ? boundariesOption : [...boundaries]; summary.boundaryDependence = boundaryDependence(run, ledger, list); summary.contextUse = contextBlockUse(run, ledger); }
    if (run.requests.total >= o.minRequests) { const long = longRunSplit(ledger, run.requests.total, w); if (long) longRuns.push({ sessionId: session, short: shortId, projectId: project, requests: run.requests.total, ...long }); }
    runs.push(summary);
  }
  runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const projects = [...groups].map(([key, group]) => ({ projectId: group.projectId, kind: group.kind, runs: group.scans.length, requests: sum(group.scans, row => row.total), remaining: expectation.get(key) })).filter(group => group.kind === null || groups.get(groupKey(group.projectId, null)).scans.length !== group.runs);
  return { tool: 'run-economics', generatedAt: new Date().toISOString(), options: { weights: o.weights ?? null, deliverable: o.deliverable, writes: o.writes, handoffIn: o.handoffIn, handoffOut: o.handoffOut, leanTokens: o.leanTokens, minRequests: o.minRequests }, calibration: { prefixTokensPerEstimate: round(PREFIX_TOKENS_PER_ESTIMATE, 4), toolBytesPerToken: round(TOOL_BYTES_PER_TOKEN, 3), assumed: true, overrides: { systemTokens: o.systemTokens ?? null, prefixTokens: o.prefixTokens ?? null } },
    models: [...modelCounts].map(([key, runsCount]) => { const [model, source, unit] = key.split('|'); return { model, source, unit, runs: runsCount }; }), toolSizes: { version: sizes.version, tools: Object.keys(sizes.bytes).length },
    totals: { journals: scans.length, runs: runs.length, requests: sum(runs, run => run.requests.total), billedRequests: sum(runs, run => run.requests.billed), unreportedRequests: sum(runs, run => run.requests.unreported), tokens: sum(runs, run => run.tokens) }, runs, projects, pooledRemaining: pooled, longRuns, handoffGate: handoffGate(runs) };
}
function sumRequestCost(ledger, cost) { let amount = 0, statuses = new Set(); for (const step of ledger) { const row = requestCost({ input: step.inp, cacheRead: step.cr, cacheWrite: step.cw, output: step.O }, cost.entry, { at: step.time }); statuses.add(row.status); amount += row.amount ?? 0; } return { amount: round(amount, 6), currency: cost.unit, statuses: [...statuses] }; }

// ---------------------------------------------------------------------------------------------------------------------------
// Table
const num = value => value == null ? '-' : Math.round(value).toLocaleString('en-US');
const money = (value, unit) => value == null ? '-' : unit === 'UIE' ? num(value) : value.toFixed(4);
const signed = value => value == null ? '-' : `${value > 0 ? '+' : ''}${value}%`;
const col = (value, width, right = true) => right ? String(value).padStart(width) : String(value).padEnd(width);
const short = id => String(id ?? '-').slice(0, 8);
const when = value => String(value ?? '-').slice(0, 16).replace('T', ' ');
const costLabel = row => row.source === 'priced' ? `priced, ${row.unit}` : row.source === 'partial' ? `partly priced, ${row.unit}` : row.source === 'reference' ? 'REFERENCE list-price ratios (relative unit UIE, not a cost)' : row.source === 'override' ? 'OVERRIDDEN weights by hand (relative unit UIE)' : 'ASSUMED weights input 1 / cache read 0.1 / cache write 1.25 / output 4.5, relative unit UIE';
export function renderTable(report, { top = 15, detail = null, all = false } = {}) {
  const lines = [], runs = report.runs, c = report.calibration;
  lines.push(`run-economics: ${report.totals.runs} runs analysed of ${report.totals.journals} journals, ${num(report.totals.requests)} requests (${num(report.totals.unreportedRequests)} aborted or failed without usage), ${num(report.totals.tokens)} tokens`);
  lines.push(`cost weights: ${report.models.map(row => `${row.model} ${costLabel(row)} x${row.runs}`).join('; ')}${report.models.some(row => row.source === 'assumed') ? '. Assumed weights are an assumption, not a price.' : ''}`);
  lines.push(`prefix (system + tool declarations): ASSUMED per run: contextPrefixTokens x ${c.prefixTokensPerEstimate}, tool declarations at ${c.toolBytesPerToken} bytes per token (one measurement, 2026-10-05)${c.overrides.prefixTokens != null ? `; prefix overridden to ${num(c.overrides.prefixTokens)}` : ''}`);
  lines.push('');
  const shown = all ? runs : [...runs].sort((a, b) => b.tokens - a.tokens).slice(0, top).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  lines.push(`runs${all ? '' : ` (the ${shown.length} largest by tokens; --all or the JSON for the rest)`}`);
  lines.push([col('session', 9, false), col('project', 9, false), col('started (UTC)', 16, false), col('req', 4), col('1st P', 7), col('last P', 7), col('tokens', 10), col('cost', 10), col('reason/out', 10), col('reason cost', 11), col('stub tok/req', 12), col('stub dTok', 9), col('stub dCost', 10)].join(' '));
  for (const run of shown) lines.push([col(run.short, 9, false), col(short(run.projectId), 9, false), col(when(run.startedAt), 16, false), col(run.requests.total, 4), col(num(run.firstPrompt), 7), col(num(run.lastPrompt), 7), col(num(run.tokens), 10), col(money(run.relativeCost, run.cost.unit), 10), col(run.reasoning.reasoningOfOutputPct == null ? '-' : `${run.reasoning.reasoningOfOutputPct}%`, 10), col(run.reasoning.costPct == null ? '-' : `${run.reasoning.costPct}%`, 11),
    col(num(run.stubTax?.stubTokensPerRequest), 12), col(signed(run.stubTax?.tokensSavedPct == null ? null : -run.stubTax.tokensSavedPct), 9), col(signed(run.stubTax?.costSavedPct == null ? null : -run.stubTax.costSavedPct), 10)].join(' '));
  lines.push('  cost = relative cost of the run; reason/out = reasoning share of output tokens; reason cost = share of the run\'s cost (generation + replay); stub = tool declarations this purpose can never execute; dTok / dCost = the run without them.');
  lines.push('');
  const deliverable = runs.filter(run => run.phases && run.splits.length);
  if (deliverable.length) {
    lines.push(`runs that write the deliverable (/${report.options.deliverable}/): a fresh context after the writing phase, handoff ${num(report.options.handoffIn)} in / ${num(report.options.handoffOut)} out; cost change of the whole run, design formula / measured billing`);
    lines.push([col('session', 9, false), col('started (UTC)', 16, false), col('req', 4), col('writes', 14, false), col('boundary', 8), col('after', 6), col('tok share', 9), col('tokens', 8), col('cost cold', 17), col('cost warm', 17), col('R*', 5), col('E[rem] (n)', 9), col('offer', 5)].join(' '));
    for (const run of deliverable) {
      const phases = run.phases, split = run.splits.find(row => row.boundary === phases.boundary) ?? run.splits[0], cold = split.scenarios.cold, warm = split.scenarios.warm;
      lines.push([col(run.short, 9, false), col(when(run.startedAt), 16, false), col(run.requests.total, 4), col(`${phases.firstWrite}..${phases.lastWrite}`, 14, false), col(split.boundary, 8), col(split.requestsAfter, 6), col(`${split.tokensAfterShare}%`, 9), col(signed(cold.designFormula.tokensPct), 8), col(`${signed(cold.designFormula.costPct)} / ${signed(cold.measuredBilling.costPct)}`, 17), col(warm ? `${signed(warm.designFormula.costPct)} / ${signed(warm.measuredBilling.costPct)}` : '-', 17), col(split.breakEven.rStar ?? 'never', 5), col(split.trigger ? `${split.trigger.expectedRemaining} (${split.trigger.runs})` : '-', 9), col(split.trigger ? (split.trigger.offer ? 'yes' : 'no') : '-', 5)].join(' '));
    }
    lines.push('  boundary = the last whole-file write of the deliverable (else the last patch); after = requests after it; R* = remaining requests at which the handoff pays; E[rem] (n) = expected remaining requests of the n OTHER peer runs (the project\'s schedule runs, else its runs; this run left out) that went past the boundary; offer = E[rem] > R*.');
    for (const gate of report.handoffGate ?? []) lines.push(`  gate (i) of the stage handoff, project ${short(gate.projectId)}: of the last ${gate.considered} scheduled runs that write the deliverable, ${gate.passing} went on for at least their own R* requests after the boundary (needs ${gate.needed} of the last ${gate.window}): ${gate.met ? 'met' : 'not met'}`);
    lines.push('');
  }
  lines.push('E[remaining requests | the run is past request k]  (mean / median (runs) over the project\'s runs that issued request k+1; aborted requests counted)');
  const ks = [10, 20, 30, 40, 50, 60];
  lines.push(`${col('project', 14, false)} ${col('runs', 5)} ${ks.map(k => col(`k=${k}`, 16)).join(' ')}`);
  for (const [name, runsCount, rows] of [...report.projects.map(project => [`${short(project.projectId)}${project.kind ? `/${project.kind.slice(0, 5)}` : ''}`, project.runs, project.remaining]), ['all', report.totals.journals, report.pooledRemaining]]) lines.push(`${col(name, 14, false)} ${col(runsCount, 5)} ${ks.map(k => { const row = rows.find(item => item.k === k); return col(row ? `${row.mean} / ${row.median} (${row.runs})` : '-', 16); }).join(' ')}`);
  lines.push('');
  if (report.longRuns.length) {
    lines.push(`long runs (>= ${report.options.minRequests} requests) split at the midpoint (after request 63 when past the 64-step yield), handoff 3K in / ${num(report.options.handoffOut)} out: cost change, design formula / measured billing`);
    for (const row of [...report.longRuns].sort((a, b) => b.requests - a.requests)) lines.push(`  ${col(row.short, 9, false)} ${col(short(row.projectId), 9, false)} n=${col(row.requests, 3)} first ${col(num(row.firstPrompt), 7)} last ${col(num(row.lastPrompt), 7)} split@${col(row.boundary, 2)} after ${col(row.requestsAfter, 2)}: tokens ${signed(row.handoff3K.designFormula.tokensPct)}  cost ${signed(row.handoff3K.designFormula.costPct)} / ${signed(row.handoff3K.measuredBilling.costPct)}  (8K handoff ${signed(row.handoff8K.designFormula.costPct)} / ${signed(row.handoff8K.measuredBilling.costPct)})`);
    lines.push('');
  }
  const picked = detail ? runs.filter(run => run.sessionId.includes(detail) || run.short.startsWith(detail)) : [[...runs].sort((a, b) => b.tokens - a.tokens)[0]].filter(Boolean);
  for (const run of picked) lines.push(...renderDetail(run), '');
  return lines.join('\n');
}
const percent = value => value == null ? '-' : `${value}%`;
function renderDetail(run) {
  const lines = [`detail: ${run.sessionId}  (${run.requests.total} requests, ${num(run.tokens)} tokens, relative cost ${money(run.relativeCost, run.cost.unit)} ${run.cost.unit}${['assumed', 'reference', 'override'].includes(run.cost.source) ? ` ${run.cost.source.toUpperCase()}` : ''})`];
  const first = run.firstRequest;
  if (first) {
    lines.push(`  first request ${num(first.promptTokens)} tokens (cache read ${num(first.cacheRead)}): system ${num(first.systemTokens)} + tool declarations ${num(first.toolDeclarationTokens)} + context ${num(first.contextTokens)}${first.scaled ? ` [prefix ${first.prefixSource}; entries scaled x${first.scale} from ${num(first.rawContextTokens)} estimated]` : ' (no prefix estimate: entries are unscaled estimates)'}`);
    for (const entry of first.entries) lines.push(`    ${col(entry.source, 34, false)} ${col(num(entry.chars), 8)} chars ${col(num(entry.tokens), 7)} tokens ${col(percent(entry.share), 6)}`);
  }
  const stub = run.stubTax;
  if (stub) lines.push(`  stub tax: ${stub.stubs} of ${stub.declared} declared tools are never executable here (${Math.round(stub.stubByteShare * 100)}% of declaration bytes): ${num(stub.stubTokensPerRequest)} tokens/request; without them ${num(stub.tokensSaved)} tokens (${percent(stub.tokensSavedPct)}) and ${percent(stub.costSavedPct)} of relative cost; calls to them ${stub.calls}, rejection receipts ${stub.rejectionReceipts}${stub.unsizedTools.length ? `; no size for ${stub.unsizedTools.length} tools (median used)` : ''}`);
  const phases = run.phases;
  if (phases) lines.push(`  deliverable written at request ${phases.writes.map(write => `${write.k}(${write.via})`).join(', ')}; boundary ${phases.boundary} (${phases.boundaryRule}): ${phases.afterBoundary.requests} requests (${percent(phases.afterBoundary.share)} of tokens) after; collect ${phases.collect.requests} req ${percent(phases.collect.share)} / write ${phases.write.requests} req ${percent(phases.write.share)} / verify ${phases.verify.requests} req ${percent(phases.verify.share)}; after the first write ${phases.afterFirstWrite.requests} req ${percent(phases.afterFirstWrite.share)}, after the last ${phases.afterLastWrite.requests} req ${percent(phases.afterLastWrite.share)}`);
  const reads = run.repeatedReads; if (reads.groups.length) lines.push(`  repeated reads: ${reads.groups.slice(0, 4).map(group => `${group.target} x${group.reads}${group.identical ? ' identical' : ''}`).join('; ')} (later results ~${num(reads.laterTokens)} tokens, ${percent(reads.shareOfPromptTokens)} of prompt tokens)`);
  const r = run.reasoning; lines.push(`  reasoning: ${num(r.reasoningTokens)} of ${num(r.outputTokens)} output tokens (${percent(r.reasoningOfOutputPct)}); replayed ${percent(r.replayedOfPromptPct)} of prompt tokens; cost ${percent(r.generationCostPct)} generation + ${percent(r.replayCostPct)} replay = ${percent(r.costPct)}`);
  const s = run.costBreakdown?.shares; if (s) lines.push(`  cost attribution: base ${percent(s.base)}, tool results ${percent(s.toolResults)}, reasoning ${percent(s.reasoning)}, other output ${percent(s.otherOutput)}, final answer ${percent(s.finalAnswer)}, residual ${percent(s.residual)}`);
  for (const split of run.splits) {
    lines.push(`  split after request ${split.boundary}: ${split.requestsAfter} requests after (${percent(split.tokensAfterShare)} of tokens); break-even ${split.breakEven.rStar ?? 'never'} remaining requests (saves ${money(split.breakEven.savingPerRequest, run.cost.unit)}/request, fixed ${money(split.breakEven.fixedCost, run.cost.unit)})${split.trigger ? `; E[remaining] ${split.trigger.expectedRemaining} over ${split.trigger.runs} ${split.trigger.basis} runs -> ${split.trigger.offer ? 'offer' : 'do not offer'}` : ''}`);
    for (const [name, row] of Object.entries(split.scenarios)) lines.push(`    ${col(name, 17, false)} tokens ${col(signed(row.designFormula.tokensPct), 7)}  cost ${col(signed(row.designFormula.costPct), 7)} (design formula) ${col(signed(row.measuredBilling.costPct), 7)} (measured billing)`);
  }
  for (const item of run.boundaryDependence ?? []) lines.push(`  identifiers used after request ${item.boundary}: ${Object.entries(item.categories).map(([name, count]) => `${name} ${count}`).join(', ')}`);
  for (const row of run.contextUse?.evidence ?? []) lines.push(`  context use ${row.block}: ${num(row.chars)} chars, ${row.uniqueAnchors} unique identifiers, reused ${row.reused} (strong ${row.strong}) ${row.examples.join(' | ')}`);
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const paths = [], options = {}, valued = new Set(['out', 'deliverable', 'top', 'detail', 'deep', 'at', 'boundaries', 'writes', 'handoff-in', 'handoff-out', 'lean-tokens', 'min-requests', 'system-tokens', 'prefix-tokens', 'tool-sizes', 'price-preset', 'weights']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--all') { options.all = true; continue; }
    if (!arg.startsWith('--')) { paths.push(arg); continue; }
    const name = arg.slice(2); if (!valued.has(name) || i + 1 >= argv.length) throw new Error(`Unknown or incomplete option ${arg}.`);
    options[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (options.weights !== undefined && options.weights !== 'reference' && options.weights !== 'assumed') { const parts = String(options.weights).split(',').map(Number); if (parts.length !== 4 || parts.some(value => !(value >= 0))) throw new Error('--weights takes reference, assumed or four numbers: input,cacheRead,cacheWrite,output.'); options.weights = parts; }
  if (options.weights === 'assumed') delete options.weights;
  for (const key of ['top', 'handoffIn', 'handoffOut', 'leanTokens', 'minRequests', 'systemTokens', 'prefixTokens']) if (options[key] !== undefined) options[key] = Number(options[key]);
  return { paths, options };
}
export const USAGE = `run-economics: offline token and cost anatomy of background runs, read from COPIES of session journals (no model, JEV or network call; refuses a path inside a live .state tree).

usage: node benchmark/run-economics.mjs <journal.jsonl | directory>... [options]

  --out FILE            write the JSON report to FILE ('-' writes none). Default: run-economics-<time>.json in the system temp directory, mode 600,
                        NEVER the working directory: the report holds raw snippets (URLs, paths, text fragments) of the journals, so keep it out of a repository
  --deliverable REGEX   the deliverable's path pattern (default daily\\.md); 'none' skips the phase and split analyses
  --writes all|tools    'tools' counts only write/edit tool calls, not exec commands that write the file
  --weights W           'reference' (published list-price ratios), 'assumed' or input,cacheRead,cacheWrite,output by hand (sensitivity runs); default the model's price, else assumed
  --price-preset ID     take prices from this provider preset when several price pages list the model
  --handoff-in N --handoff-out N --lean-tokens N     the split simulation's handoff and leaner-base sizes (3000, 1500, 12000)
  --boundaries 12,24,28 request positions for the identifier analysis; --at SESSION:REQUEST[,..] adds a split boundary to the run with that id prefix
  --deep all|none|auto  identifier and context-block analyses (default auto: runs that write the deliverable)
  --system-tokens N --prefix-tokens N     measured system prompt / system + tool declaration size, replacing the estimate
  --tool-sizes FILE     per-tool declaration bytes (default: the snapshot of app 0.68.0)
  --min-requests N      runs of at least N requests are split at their midpoint (60); --top N --detail SESSION --all choose what the table shows
  --help                this text

Cost weights come from the model's list price when one price page lists it, else they are ASSUMED (input 1, cache read 0.1, cache write 1.25, output 4.5) and flagged as such.
`;
export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const { paths, options } = parseArgs(argv);
  if (options.help || !paths.length) { stdout.write(USAGE); return null; }
  const out = options.out === undefined ? join(tmpdir(), `run-economics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`) : options.out; if (out !== '-') assertCopy(out);
  const { files, skipped, duplicates } = collectJournals(paths);
  const report = analyze(files, options);
  report.inputs = { files: files.length, skipped: skipped.length, duplicates: duplicates.length, skippedFiles: skipped.map(row => basename(row.file)), duplicateFiles: duplicates.map(row => basename(row.file)) };
  stdout.write(`${renderTable(report, { top: options.top ?? DEFAULTS.top, detail: options.detail ?? null, all: Boolean(options.all) })}\n`);
  stdout.write(`journals: ${files.length} read, ${skipped.length} skipped (not session journals), ${duplicates.length} repeated copies of a session ignored\n`);
  if (out !== '-') { writeFileSync(out, `${JSON.stringify(report, (key, value) => value === Infinity ? 'Infinity' : value, 2)}\n`, { mode: 0o600 }); stdout.write(`report written to ${resolve(out)}\n`); }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exit(1); });
