#!/usr/bin/env node
// Equivalence check for the lean scheduled-run tool surface (token-burn T2, design 2026-10-05 §5 P1), offline and
// without any model: a scheduled run declares only the tools it can execute, which removes information only if the
// model ever called a tool it was not going to be allowed to run. This scans a directory of SDK journals (copies of
// `<state>.rna/**` and `<state>.d/**`) and asserts, run by run:
//   - every `tool_intent` names a tool in the `executableTools` of the run's own `host-authorization` context (the latest
//     one before the call: the block is re-sent when it changes), so the lean array would have held every tool it used;
//   - no call was refused as `tool_unavailable_for_purpose` (the stubs a lean surface leaves out).
// Journals written before the authorization block existed have none: their calls are checked against the tools no
// background-work run in the scan could ever execute (the names that are only ever declared-but-unavailable there: the
// stubs), so the older runs count too. It also checks what a lean run adds to watch after release: tool results that
// say "not assigned to this session" (the SDK's answer to a call to an undeclared tool, which has no tool_intent). A call
// the model made to a tool the lean array left out is not a violation of the equivalence (nothing ran), but the design
// rolls the surface back (RNA_SCHEDULED_SURFACE=full) when those results exceed 0.5% of a lean run's tool calls: the share
// is `not assigned / (calls + not assigned)` over the lean runs in the scan, and above `--max-not-assigned` (default 0.005)
// the check fails. Old (full-surface) journals have none, so a scan of them is unaffected.
// Usage: node benchmark/surface-replay.mjs <directory of journal copies> [--json] [--max-not-assigned=0.005]
// Exit code 1 when any call was not executable, hit a stub, or the not-assigned share is over the limit. Reads files only;
// point it at copies, never at live state.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REFUSALS = ['tool_unavailable_for_purpose', 'authorization_read_only', 'authorization_scope', 'permission_revoked'];
const NOT_ASSIGNED = /Tool is not assigned to this session/;
const BACKGROUND = 'background-work';
/** The design's roll-back line (token-burn design 2026-10-05 §5 P1): "not assigned" results above 0.5% of a lean run's calls. */
export const MAX_NOT_ASSIGNED_SHARE = 0.005;
// Every journal line is `{"seq":…,"prevHash":…,"time":…,"type":"<type>",…`; events are most of the file and are skipped unparsed.
const TYPE = /^\{"seq":\d+,"prevHash":(?:null|"[0-9a-f]*"),"time":"[^"]*","type":"([a-z_]+)"/;

const textOf = result => (result?.content ?? []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('');
const authorizationOf = message => {
  for (const entry of message?.context ?? []) if (entry?.source === 'host-authorization') { try { return JSON.parse(entry.text); } catch { return null; } }
  return null;
};

/** One journal's findings, or null when `text` is not an SDK session journal. `text`: the journal file's content. */
export function replayJournal(text, { file = '' } = {}) {
  const run = { file, purpose: null, authorizations: 0, lean: false, requests: 0, calls: 0, checked: 0, violations: [], unchecked: [], tools: {}, stubHits: 0, notAssigned: [], refusals: {}, executable: new Set(), unavailable: new Set() };
  let auth = null, header = false;
  const requested = new Map(); // callKey (`<message id>/<call id>`) -> tool name, from the model's own response
  for (const line of text.split('\n')) {
    if (!line) continue;
    const type = TYPE.exec(line)?.[1];
    if (type === 'event') continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const data = record.data ?? {};
    if (record.type === 'session_header') { header = data.format === 'rna-session'; if (!header) return null; continue; }
    if (!header) return null;
    if (record.type === 'message') {
      const next = authorizationOf(data.message);
      if (next) {
        auth = next; run.authorizations++; run.purpose ??= next.purpose ?? null; if (Array.isArray(next.notDeclaredHere)) run.lean = true;
        for (const name of next.executableTools ?? []) run.executable.add(name);
        for (const name of next.declaredButUnavailable ?? []) run.unavailable.add(name);
      }
    } else if (record.type === 'request_completed') {
      run.requests++;
      for (const block of data.message?.content ?? []) if (block?.type === 'toolCall') requested.set(`${data.message.id}/${block.id}`, block.name);
    } else if (record.type === 'tool_intent') {
      run.calls++;
      const name = data.toolName; run.tools[name] = (run.tools[name] ?? 0) + 1;
      if (!auth) { run.unchecked.push({ seq: record.seq, tool: name }); continue; }
      run.checked++;
      if (!(auth.executableTools ?? []).includes(name)) run.violations.push({ seq: record.seq, tool: name, reason: (auth.declaredButUnavailable ?? []).includes(name) ? 'declared_but_unavailable' : (auth.notDeclaredHere ?? []).includes(name) ? 'not_declared' : 'unlisted' });
    } else if (record.type === 'tool_completed') {
      const result = data.result, code = result?.details?.code;
      if (REFUSALS.includes(code)) { run.refusals[code] = (run.refusals[code] ?? 0) + 1; if (code === 'tool_unavailable_for_purpose') run.stubHits++; }
      // The record carries `isError` beside the result, and the tool-result message with the name the model asked for.
      if ((data.isError === true || result?.isError === true) && NOT_ASSIGNED.test(textOf(result))) run.notAssigned.push({ seq: record.seq, tool: data.message?.toolName ?? requested.get(data.callKey) ?? null });
    }
  }
  return header ? run : null;
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

/** True for a journal under `initiative/`: a background run's own session (scheduled or decision-started). */
const underInitiative = file => file.split(sep).includes('initiative');
/** True for a scheduled occurrence's own session (`schedule-work-<id>`), the runs the lean surface applies to. */
const isScheduled = file => file.split(sep).some(part => part.startsWith('schedule-work-'));

/** The report for scanned runs (see replaySurface). Pure: takes what replayJournal returned. `maxNotAssigned`: the share of a lean run's calls that may be refused as not assigned. */
export function summarize(runs, { maxNotAssigned = MAX_NOT_ASSIGNED_SHARE } = {}) {
  if (!Number.isFinite(maxNotAssigned) || maxNotAssigned < 0 || maxNotAssigned > 1) throw new RangeError('maxNotAssigned must be a share between 0 and 1');
  const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
  const authorized = runs.filter(run => run.authorizations > 0), bare = runs.filter(run => run.authorizations === 0);
  // The stubs: tools some background-work run declared but could not execute, and no background-work run could execute.
  const canRun = new Set(), refused = new Set();
  for (const run of authorized.filter(row => row.purpose === BACKGROUND)) { for (const name of run.executable) canRun.add(name); for (const name of run.unavailable) refused.add(name); }
  const stubs = [...refused].filter(name => !canRun.has(name)).sort();
  // A background run's calls made before (or without) an authorization block are checked against the stubs. A foreground or
  // subagent journal without a block is not a background run, where those tools are executable: it is only counted.
  const background = runs.filter(run => run.purpose === BACKGROUND || run.authorizations === 0 && underInitiative(run.file));
  const stubCalls = background.flatMap(run => run.unchecked.filter(call => stubs.includes(call.tool)).map(call => ({ file: run.file, ...call })));
  const view = rows => ({ runs: rows.length, calls: sum(rows, run => run.checked), violations: sum(rows, run => run.violations.length), stubHits: sum(rows, run => run.stubHits), notAssigned: sum(rows, run => run.notAssigned.length), leanRuns: rows.filter(run => run.lean).length });
  const purposes = Object.fromEntries([...new Set(authorized.map(run => run.purpose))].sort().map(purpose => [purpose, view(authorized.filter(run => run.purpose === purpose))]));
  const older = bare.filter(run => underInitiative(run.file)), others = bare.filter(run => !underInitiative(run.file));
  // What a lean run asked for that its array did not declare, as a share of everything it asked for (a call that ran has a
  // tool_intent; one that was not assigned has none).
  const lean = authorized.filter(run => run.lean), leanAsked = sum(lean, run => run.calls) + sum(lean, run => run.notAssigned.length);
  const notAssignedShare = leanAsked ? sum(lean, run => run.notAssigned.length) / leanAsked : 0;
  return {
    journals: runs.length, ...view(authorized), purposes,
    // The background-work runs the design counts: each with its own authorization block, plus the older ones checked against the stubs.
    background: { runs: background.length, calls: sum(background, run => run.calls), stubCalls: stubCalls.length, stubRefusals: sum(background, run => run.stubHits) },
    scheduled: (rows => ({ runs: rows.length, calls: sum(rows, run => run.calls), stubCalls: sum(rows, run => run.stubHits) + rows.flatMap(run => run.unchecked).filter(call => stubs.includes(call.tool)).length, tools: Object.fromEntries(Object.entries(rows.reduce((all, run) => { for (const [name, count] of Object.entries(run.tools)) all[name] = (all[name] ?? 0) + count; return all; }, {})).sort(([a], [b]) => a.localeCompare(b, 'en'))) }))(background.filter(run => isScheduled(run.file))),
    olderBackground: { runs: older.length, calls: sum(older, run => run.unchecked.length) },
    notBackground: { runs: others.length, calls: sum(others, run => run.unchecked.length) },
    stubs,
    leanNotAssigned: { runs: lean.length, asked: leanAsked, notAssigned: sum(lean, run => run.notAssigned.length), share: notAssignedShare, max: maxNotAssigned, over: notAssignedShare > maxNotAssigned },
    failures: [...authorized.filter(run => run.violations.length || run.stubHits).map(run => ({ file: run.file, purpose: run.purpose, violations: run.violations, stubHits: run.stubHits })),
      ...stubCalls.map(call => ({ file: call.file, purpose: null, violations: [{ seq: call.seq, tool: call.tool, reason: 'stub_without_authorization' }], stubHits: 0 })),
      ...bare.filter(run => run.stubHits).map(run => ({ file: run.file, purpose: null, violations: [], stubHits: run.stubHits }))],
    get ok() { return this.failures.length === 0 && !this.leanNotAssigned.over; },
  };
}

/** Scans a directory tree of journal copies. Files that are not SDK session journals (ledgers, logs) are ignored. */
export async function replaySurface(directory, options) {
  const runs = [];
  for await (const path of walk(directory)) {
    const run = replayJournal(await readFile(path, 'utf8'), { file: relative(directory, path) });
    if (run) runs.push(run);
  }
  return summarize(runs, options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [directory, ...flags] = process.argv.slice(2);
  const limit = flags.find(flag => flag.startsWith('--max-not-assigned='));
  if (!directory || flags.some(flag => flag !== '--json' && flag !== limit) || limit && !/^--max-not-assigned=(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(limit)) { console.error('Usage: surface-replay.mjs <directory of journal copies> [--json] [--max-not-assigned=<share between 0 and 1, default 0.005>]'); process.exit(2); }
  const report = await replaySurface(directory, limit ? { maxNotAssigned: Number(limit.split('=')[1]) } : undefined);
  if (flags.includes('--json')) console.log(JSON.stringify({ ...report, ok: report.ok }, null, 2));
  else {
    console.log(`SDK journals ${report.journals}`);
    console.log(`with an authorization block: ${report.runs} runs, ${report.calls} calls, ${report.violations} not executable, ${report.stubHits} stub hits, ${report.notAssigned} "not assigned" results, ${report.leanRuns} lean runs`);
    for (const [purpose, row] of Object.entries(report.purposes)) console.log(`  ${purpose}: ${row.runs} runs, ${row.calls} calls, ${row.violations} not executable, ${row.stubHits} stub hits, ${row.notAssigned} not assigned, ${row.leanRuns} lean`);
    console.log(`older background journals (no authorization block): ${report.olderBackground.runs} runs, ${report.olderBackground.calls} calls, checked against the ${report.stubs.length} stubs (${report.stubs.join(', ')}); other journals without one: ${report.notBackground.runs} (${report.notBackground.calls} calls, not checked)`);
    console.log(`background-work runs in all: ${report.background.runs} runs, ${report.background.calls} calls, ${report.background.stubCalls} stub calls, ${report.background.stubRefusals} stub refusals`);
    console.log(`scheduled occurrences (the runs the lean surface applies to): ${report.scheduled.runs} runs, ${report.scheduled.calls} calls, ${report.scheduled.stubCalls} stub calls; tools called: ${Object.entries(report.scheduled.tools).map(([name, count]) => `${name} ${count}`).join(', ')}`);
    const lean = report.leanNotAssigned, percent = value => `${(value * 100).toFixed(2)}%`;
    console.log(`lean runs: ${lean.runs}, asked for ${lean.asked} tool calls, ${lean.notAssigned} not assigned (${percent(lean.share)}, limit ${percent(lean.max)})`);
    for (const failure of report.failures) console.log(`FAIL ${failure.file}: ${JSON.stringify(failure.violations)} stub hits ${failure.stubHits}`);
    if (lean.over) console.log(`FAIL not assigned share ${percent(lean.share)} is over ${percent(lean.max)}: roll the surface back with RNA_SCHEDULED_SURFACE=full`);
    console.log(report.ok ? 'OK: every call named a tool the run could execute' + (lean.runs ? `, and the not-assigned share is within ${percent(lean.max)}` : '') : 'NOT OK');
  }
  process.exit(report.ok ? 0 : 1);
}
