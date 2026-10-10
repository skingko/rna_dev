// W2 paired replay (design2 §7 W2, user decision 2026-10-05: the new schedule texts may be the default only after a replay
// shows that they do not stop the model from writing a lasting user rule into the schedule). Runs inside the live daemon, so it
// uses the app's configured model and key without anyone reading a secrets file; it never changes a conversation or a
// schedule: the journals are only read (a truncated COPY is rebuilt by the SDK), no tool is executed, no state is written
// besides the usage ledger, the daily real-token reservation and its own reports.
//
// What is replayed, each under BOTH text versions (schedulePromptVersion v1 and v2, paired: the same context, the same model, one
// request per case and version):
//  - the four recorded foreground turns (SCHEDULE_HISTORY path 'tool'): the request the model was sent just before its first
//    project_schedule call of the turn, rebuilt from the journal, with today's project prefix (system prompt and tools as the
//    runtime last published them) whose schedule paragraph and project_schedule declaration are swapped for each version;
//  - the constructed planner scenario (path 'planner'): the newest captured decision request of the project (effort capture),
//    with the schedule's task as it stood before the recorded change, the user message that triggered it added as the newest
//    evidence, and the host's contract and policy texts swapped for each version. The planner requests of 09-26..10-02 were
//    never archived, so this is a construction: less credible than the foreground cases, and the report says so.
// Each reply is read for one thing: did the model write the task (a project_schedule update with a changed `task`, or a
// schedule update action), and how many of the earlier text's sentences did it remove or rewrite? Pass conditions (§7 W2):
// the six lasting requests (rev 8, 10, 12, 14, 15, 17) are still written, touching no more than the allowance, and the one-off
// writes (rev 3, 16) and the mechanical ones (rev 2, 11, 13) are not written under v2. A durable write that is lost fails the gate.
//
// Safety, as the effort replay and the compaction-fork probe: `approved: true` is required; the approved total (1,000,000 tokens,
// more only by an explicit `approveMore`, up to MAX_RUN_BUDGET for one run in all) and every run's spend are recorded in `<state>.rna/schedule-text-replay/spend.json`
// (a request's worst case reaches it before the request is sent, a failed write sends nothing); spend is counted from the
// provider's reported usage (input + output + cache), a request that reports none is charged its worst case; no request
// starts whose worst case would take the spend past the run's budget, nor while application maintenance holds new work; every
// request is metered (purpose evaluation, detail schedule-text-replay) and charged to the daily real-token cap.
//
// Run it with `./rna schedule-text replay --approved` (cli-schedule-text.mjs). It is meant to be run once, after the texts
// are deployed under the default v1, and only with the user's approval of its spend (about 0.75M tokens).
import { createReadStream, mkdirSync, mkdtempSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync, lstatSync, chmodSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { iterateCompletion, streamCompletion, REASONING_VALUES } from '../../../packages/sdk/src/providers.mjs';
import { canonicalJSON } from '../../../packages/sdk/src/journal.mjs';
import { decideInitiative, decisionInputEstimate } from '../../../packages/sdk/src/initiative.mjs';
import { resolveModel } from '../configuration.mjs';
import { sessionsLive, EffortCapture } from '../internal-reasoning.mjs';
import { meteredProvider } from '../usage-cache-service.mjs';
import { latestPrefixFor } from '../prompt-prefix-registry.mjs';
import { realBudgetRemaining, reserveRealTokens, releaseRealTokens, chargeRealTokens } from '../budget-service.mjs';
import { SCHEDULE_TEXT_V1, SCHEDULE_TEXT_V2, scheduleForegroundParagraph, scheduleToolDescription, scheduleToolParameters, scheduleContractText, schedulePolicyReason, schedulePromptVersionOfStore } from '../schedule-prompt.mjs';
import { projectUserItems, scheduleBasisCheck, citedMessageIds } from '../schedule-basis.mjs';
import { SCHEDULE_HISTORY, REQUIRED, historyOf } from './schedule-text-cases.mjs';
/** The lasting and one-off changes the gate needs (rev numbers). */
const REQUIRED_REVS = [...REQUIRED.durable, ...REQUIRED.oneOff];

/** The user-approved amount (2026-10-05, about 0.75M tokens estimated, a hard cap of 1,000,000): every run together spends no more, until the user approves more (`approveMore`, 2026-10-10). */
export const SCHEDULE_REPLAY_BUDGET_TOKENS = 1000000;
/** `budgetTokens` (a run's own limit) defaults to what is approved and unspent: 1,000,000 until the user approves more. */
export const REPLAY_DEFAULTS = Object.freeze({ budgetTokens: undefined, foreground: 4, planner: 8, baseline: 'all' });
/**
 * The versions a case is sent under. 'all' (the default, what was asked for): every case under v1 and v2. 'effect': a lasting request
 * only under v2 (the pass condition is about v2: it is still written) and the cases that show the problem (one-off, mechanical)
 * under both: v1's baseline there shows that the replay reproduces the write the new text should stop. It costs about 30% less.
 */
export const conditionsOf = (entry, baseline = 'all') => baseline === 'effect' && entry.label === 'durable' ? ['v2'] : ['v1', 'v2'];
/**
 * The most one run's budget may be in all: the approved and unspent amount plus an `approveMore` (the sanity bound on `--budget` is the same
 * number). What a run may actually spend is bounded by the approval; a plan fills only PLAN_SHARE of its budget, so a plan of N tokens
 * needs a budget of at least N / PLAN_SHARE.
 */
export const MAX_RUN_BUDGET = 8000000;
/** A request's worst case is its input with this headroom plus the whole output allowance it is sent with. */
export const HEADROOM = 1.2;
/** The output allowance of one replayed request: a reply that is one tool call carrying a task of at most 6,000 characters, with room for reasoning. */
export const REPLY_ALLOWANCE = 32768;
/** Planning figure for the output of one request (the allowance above is the hard cap). */
export const OUTPUT_ESTIMATE = 6144;
/** Share of the available budget the default selection may fill. */
export const PLAN_SHARE = 0.9;
/**
 * "Only the touched sentence changed" (§7 W2): a lasting request may remove or rewrite at most this many sentences of the earlier text,
 * the same bound for every case (what v1 did in the same case is shown beside it, never allowed for: a v2 that rewrites as much as v1
 * did has not narrowed the edit). The one exception is a request that is itself a rewrite (schedule-text-cases.mjs `rewrite`: rev 8,
 * "make the task prompt more concise"), whose scope is shown and not bounded. A sentence here is a clause up to a stop (。；;!?.) or a
 * line end, so one logical sentence may count twice.
 */
export const SCOPE_TOUCHED_ALLOWANCE = 3;
const DETAIL = 'schedule-text-replay';
const TOOL = 'project_schedule';
const fail = (message, status = 400, code = 'replay_invalid') => { throw Object.assign(new Error(message), { status, code }); };
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const round = (value, digits = 3) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const promptOf = usage => usage ? ['input', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + Math.max(0, Number(usage[key]) || 0), 0) : null;
const tokensOf = usage => usage ? ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + Math.max(0, Number(usage[key]) || 0), 0) : 0;
const compactUsage = usage => usage ? Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens'].filter(key => Number.isFinite(usage[key])).map(key => [key, usage[key]])) : null;
const emptySpend = () => ({ version: 1, approvals: [], jobs: {} });
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const CONDITIONS = Object.freeze(['v1', 'v2']);
const idOf = (kind, rev) => `${kind === 'foreground' ? 'fg' : 'pl'}-r${rev}`;
export const scheduleReplayRoot = stateFile => join(`${stateFile}.rna`, 'schedule-text-replay');
const REPORT_FILE = /^(schedtext-[a-zA-Z0-9-]{1,80})\.json$/;
const realDirectory = path => { try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; } };
function redact(value, secrets) {
  if (typeof value === 'string') { let text = value; for (const secret of secrets) text = text.split(secret).join('[REDACTED]'); return text; }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  return value;
}

// ------------------------------------------------------------------------------------------- reading a reply
/** Sentences of a task text (the stops of Chinese and English prose, and line ends). */
export const sentencesOf = text => String(text ?? '').split(/(?<=[。！？!?；;])|(?<=\.)(?=\s)|\n+/).map(row => row.replace(/\s+/g, ' ').trim()).filter(Boolean);
/** How many of the earlier text's sentences a proposed text keeps verbatim (as a multiset), removes or rewrites, and how many it adds (null where the earlier text is unknown). */
export function sentenceDiff(previous, proposed) {
  // An earlier text that is not known cannot be compared with: nothing is kept or removed, and a bound on what was touched is not met.
  if (typeof previous !== 'string') return { previous: null, proposed: sentencesOf(proposed).length, kept: null, removed: null, added: null };
  const before = sentencesOf(previous), after = sentencesOf(proposed), pool = new Map();
  for (const row of after) pool.set(row, (pool.get(row) ?? 0) + 1);
  let kept = 0;
  for (const row of before) { const count = pool.get(row) ?? 0; if (count > 0) { kept++; pool.set(row, count - 1); } }
  return { previous: before.length, proposed: after.length, kept, removed: before.length - kept, added: after.length - kept };
}
const changedTask = (task, previous) => typeof task === 'string' && task.trim() !== '' && (previous === null || previous === undefined || squash(task) !== squash(previous));
/** What a foreground reply did about the schedule: its tool calls (never executed here). */
export function classifyCalls(calls, { previousTask = null } = {}) {
  const schedule = calls.filter(call => call.name === TOOL), update = schedule.find(call => call.arguments?.action === 'update' && changedTask(call.arguments.task, previousTask));
  return { scheduleCalls: schedule.length, creates: schedule.filter(call => call.arguments?.action === 'create').length, write: Boolean(update), task: update?.arguments.task ?? null, basis: typeof update?.arguments.basis === 'string' ? update.arguments.basis : null, toolNames: [...new Set(calls.map(call => call.name))].slice(0, 12) };
}
/** What a planner decision did about the schedule. */
export function classifyDecision(decision, { previousTask = null } = {}) {
  const schedule = decision?.action === 'schedule' ? decision.schedule : null, update = schedule?.operation === 'update' && changedTask(schedule.task, previousTask);
  return { action: decision?.action ?? null, evidenceIds: Array.isArray(decision?.evidenceIds) ? decision.evidenceIds : [], scheduleOperation: schedule?.operation ?? null, write: Boolean(update), task: update ? schedule.task : null, basis: update && typeof schedule.basis === 'string' ? schedule.basis : null, creates: schedule?.operation === 'create' ? 1 : 0 };
}

// ------------------------------------------------------------------------------------------- the two versions of one request
const prefixTokensOf = (systemPrompt, tools) => Math.ceil(Buffer.byteLength(canonicalJSON({ systemPrompt, tools }), 'utf8') / 3);
/**
 * `request` (a system prompt, tool declarations and messages) with the schedule texts of `version`: the foreground paragraph and the
 * `project_schedule` declaration (description and parameters; added at the end when the prefix declares none). Everything else is
 * the request as it was. Throws when the system prompt holds the schedule paragraph of neither version exactly once (a prompt
 * this replay does not know: nothing is sent).
 */
export function withScheduleTexts(request, version) {
  const own = scheduleForegroundParagraph(version), other = version === 'v2' ? SCHEDULE_TEXT_V1.foreground : SCHEDULE_TEXT_V2.foreground, count = text => request.systemPrompt.split(text).length - 1;
  let systemPrompt = request.systemPrompt;
  if (count(own) === 1 && count(other) === 0) { /* already the target's */ }
  else if (count(other) === 1 && count(own) === 0) systemPrompt = systemPrompt.replace(other, () => own);
  else throw Object.assign(new Error('The system prompt does not hold the schedule paragraph of either version exactly once.'), { code: 'schedule_paragraph_missing' });
  const declaration = { description: scheduleToolDescription(version), parameters: JSON.parse(canonicalJSON(scheduleToolParameters(version))) };
  let found = false;
  const tools = request.tools.map(tool => { if (tool.name !== TOOL) return tool; found = true; return { ...tool, ...declaration }; });
  if (!found) tools.push({ name: TOOL, ...declaration });
  const delta = prefixTokensOf(systemPrompt, tools) - prefixTokensOf(request.systemPrompt, request.tools);
  return { ...request, systemPrompt, tools, ...(Number.isFinite(request.estimatedInputTokens) ? { estimatedInputTokens: Math.max(1, request.estimatedInputTokens + delta) } : {}) };
}
/** A planner request with the contract and policy texts of `version` (the SDK prompt follows the version it is called with). */
export function withPlannerTexts(request, version) {
  const project = structuredClone(request.project ?? {}), contract = scheduleContractText(version);
  if (project.actionContracts?.schedule) Object.assign(project.actionContracts.schedule, { authorization: contract.authorization, scope: contract.scope });
  if (project.scheduleContext?.policy) project.scheduleContext.policy.reason = schedulePolicyReason(version);
  return { ...request, project };
}

// ------------------------------------------------------------------------------------------- the schedule's text history
/**
 * The text each recorded revision of each schedule of `project` carried, from what the state keeps: the planner's own actions
 * (sdkState.actions[].schedule.task, with the receipt that gives the revision and the time) and the foreground tool calls
 * (the saved record in the tool item's output). A revision that changed no text (a pause, a rule) is not listed: the text in
 * force before revision r is that of the newest listed revision below r.
 */
export function scheduleTextVersions(project, state) {
  const versions = [], actions = new Map((project?.initiativeRuntime?.sdkState?.actions ?? []).map(action => [action.id, action]));
  for (const receipt of project?.scheduleManagementReceipts ?? []) {
    const task = actions.get(receipt.actionId)?.schedule?.task;
    if (receipt.operation !== 'delete' && typeof task === 'string' && Number.isSafeInteger(receipt.revision)) versions.push({ revision: receipt.revision, task, at: receipt.committedAt, by: 'planner', ref: receipt.actionId, scheduleId: receipt.scheduleId });
  }
  for (const session of state?.sessions ?? []) {
    if (session.projectId !== project?.id) continue;
    for (const item of session.items ?? []) {
      if (item.kind !== 'tool' || item.tool?.name !== TOOL || item.tool.status !== 'succeeded') continue;
      let record; try { record = JSON.parse(item.tool.output); } catch { continue; }
      if (typeof record?.task === 'string' && Number.isSafeInteger(record.revision)) versions.push({ revision: record.revision, task: record.task, at: item.createdAt, by: 'conversation', ref: item.turnId, scheduleId: record.id });
    }
  }
  return versions.sort((a, b) => a.revision - b.revision);
}
/** The newest listed text below `revision` (of that schedule), or null. */
export const textBefore = (versions, revision, scheduleId) => versions.filter(row => row.scheduleId === scheduleId && row.revision < revision).at(-1) ?? null;

// ------------------------------------------------------------------------------------------- the foreground turns in a journal
/**
 * One streaming pass over a conversation journal for the requests that produced the named tool calls: for each call key
 * (assistantMessageId/toolCallId), the record sequence of the request that was sent (every record before it is the
 * context), the model it ran on and the prompt it reported. Read-only; a torn line is skipped.
 */
export async function scanRequestsOf(file, callKeys) {
  const want = new Set(callKeys), intents = new Map(), starts = new Map(), completions = new Map();
  let header = null, model = null;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    const { type, data = {} } = record;
    if (type === 'session_header') header = { sessionId: data.sessionId, projectId: data.projectId ?? null };
    else if (type === 'model_change') model = { providerId: data.to?.providerId, modelId: data.to?.modelId, protocol: model?.protocol, reasoning: model?.reasoning };
    else if (type === 'request_started') {
      if (data.model?.modelId) model = { providerId: data.model.providerId, modelId: data.model.modelId, protocol: data.model.protocol ?? model?.protocol, reasoning: data.model.reasoning };
      starts.set(data.requestId, { seq: record.seq, at: record.time, model: model && { ...model }, prefixTokens: positive(data.message?.contextPrefixTokens), purpose: data.purpose ?? null });
    } else if (type === 'request_completed') { if (typeof data.message?.id === 'string') completions.set(data.message.id, { requestId: data.requestId, promptTokens: data.message.usageReported === true ? promptOf(data.message.usage) : null }); }
    else if (type === 'tool_intent' && want.has(data.callKey) && !intents.has(data.callKey)) intents.set(data.callKey, record.seq);
  }
  const out = new Map();
  for (const key of want) {
    if (!intents.has(key)) continue;
    const done = completions.get(key.split('/')[0]), start = done && starts.get(done.requestId);
    if (start && !start.purpose) out.set(key, { requestSeq: start.seq, at: start.at, model: start.model, promptTokens: done.promptTokens, prefixTokens: start.prefixTokens });
  }
  return { header, points: out };
}

// ------------------------------------------------------------------------------------------- judging a run
/**
 * The pass conditions over the cases that ran (design2 §7 W2). `complete`: every required case was run under both versions.
 * `pass`: complete, and under v2 every required lasting request is still written within the allowance (a bound met only by a known
 * count), every required one-off and mechanical change is not, and v1 wrote at least one of the latter in the same replay (the
 * writes "disappear" only if they appeared). `safe`: the same without that last condition: nothing the new text must not do was
 * done, and no lasting write was lost. A required mechanical case that could not be rebuilt from the state (`not_replayable`: its
 * earlier text or its request was never kept) is listed and does not block; every other required case that did not run blocks.
 */
export function summarizeReplay(job) {
  const cases = job.cases ?? [], byRev = new Map(cases.map(row => [row.rev, row]));
  const ran = row => row && (row.conditions ?? CONDITIONS).every(condition => row.runs?.[condition]?.status === 'completed');
  const required = [...REQUIRED.durable.map(rev => ({ rev, need: 'write' })), ...REQUIRED.oneOff.map(rev => ({ rev, need: 'no_write' })), ...REQUIRED.mechanical.map(rev => ({ rev, need: 'no_write' }))];
  const rows = [], reasons = [], notReplayable = [], missing = [];
  for (const { rev, need } of required) {
    const row = byRev.get(rev);
    if (!row) { missing.push(rev); continue; }
    // "Six lasting writes remain, two one-off writes are gone" cannot be shown for a case that was not run: one that cannot be
    // rebuilt blocks. Only a mechanical change may be left out (it has no request behind it, so what the replay can show of it
    // is thin at best, and revision 1's text was written outside the conversation and is not in the state): it is listed.
    if (row.status === 'not_replayable') { if (row.label !== 'mechanical') reasons.push(`rev_${rev}_not_replayable`); else notReplayable.push({ rev, reason: row.reason }); continue; }
    if (!ran(row)) { missing.push(rev); continue; }
    const v1 = row.runs.v1 ?? {}, v2 = row.runs.v2, touched1 = v1.scope?.removed ?? null, touched2 = v2.scope?.removed ?? null, rewrite = historyOf(rev)?.rewrite === true;
    // "Only the touched sentence changed": one fixed bound (v1's count is for the reader), met only when the count is known; a request
    // that is itself a rewrite is not bounded (null: not applicable).
    const scoped = need !== 'write' || !v2.write || rewrite ? null : touched2 !== null && touched2 <= SCOPE_TOUCHED_ALLOWANCE;
    const ok = need === 'write' ? v2.write === true && scoped !== false : v2.write === false;
    rows.push({ rev, kind: row.kind, label: row.label, need, v1Wrote: v1.write ?? null, v2Wrote: v2.write, scoped, ...(rewrite ? { rewrite: true } : {}), touchedV1: touched1, touchedV2: touched2, basisV2: v2.basisCheck ?? null, reproduced: need === 'no_write' ? (row.runs.v1 ? v1.write === true : null) : null, ok });
    if (!ok) reasons.push(need === 'write' ? (!v2.write ? `rev_${rev}_durable_write_lost` : touched2 === null ? `rev_${rev}_scope_unknown` : `rev_${rev}_rewrote_too_much`) : `rev_${rev}_${row.label}_written`);
  }
  for (const rev of missing) reasons.push(`rev_${rev}_not_run`);
  if (!rows.length) reasons.push('nothing_tested');
  const durable = rows.filter(row => row.need === 'write'), oneOff = rows.filter(row => row.label === 'one_off'), mechanical = rows.filter(row => row.label === 'mechanical');
  const complete = missing.length === 0 && job.phase === 'completed';
  if (job.phase !== 'completed') reasons.push('run_incomplete');
  // "The one-off and mechanical writes disappear" needs them to appear first: a replay in which v1 wrote none of them shows no harm
  // (`safe`) and nothing about what the new text prevents, so it does not pass.
  const effectDemonstrated = oneOff.length + mechanical.length > 0 ? [...oneOff, ...mechanical].some(row => row.reproduced === true) : null;
  if (effectDemonstrated === false) reasons.push('effect_not_demonstrated');
  return { complete, pass: reasons.length === 0, safe: reasons.every(reason => reason === 'effect_not_demonstrated'), reasons, durable: { required: REQUIRED.durable.length, tested: durable.length, written: durable.filter(row => row.v2Wrote).length, kept: durable.filter(row => row.ok).length },
    oneOff: { tested: oneOff.length, v1Wrote: oneOff.filter(row => row.v1Wrote).length, v2Wrote: oneOff.filter(row => row.v2Wrote).length }, mechanical: { tested: mechanical.length, v1Wrote: mechanical.filter(row => row.v1Wrote).length, v2Wrote: mechanical.filter(row => row.v2Wrote).length },
    effectDemonstrated, notReplayable, missing, rows };
}
const yes = value => value === true ? 'yes' : value === false ? 'no' : '-';
export function replayMarkdown(job) {
  const summary = job.summary ?? summarizeReplay(job), lines = [`# Schedule text replay ${job.id}`, '',
    `Phase **${job.phase}**${job.stopReason ? ` (${job.stopReason})` : ''}; ${job.done}/${job.calls} requests, ${job.spentTokens} of ${job.budgetTokens} tokens counted from reported usage (estimated ${job.estimate}).`, '',
    `**Gate:** ${summary.pass ? 'passed' : 'not passed'}${summary.reasons.length ? ` (${summary.reasons.join(', ')})` : ''}. Safe (no lasting write lost, nothing one-off or mechanical written under v2): ${yes(summary.safe)}. Complete: ${yes(summary.complete)}. Lasting requests still written under v2: ${summary.durable.kept}/${summary.durable.required} (${summary.durable.tested} tested). One-off writes v1 → v2: ${summary.oneOff.v1Wrote} → ${summary.oneOff.v2Wrote} of ${summary.oneOff.tested}. Mechanical writes v1 → v2: ${summary.mechanical.v1Wrote} → ${summary.mechanical.v2Wrote} of ${summary.mechanical.tested}.`,
    ...(summary.effectDemonstrated === false ? ['', 'The v1 baseline did not write any of the one-off or mechanical changes in this replay: their absence under v2 shows no harm but does not show that the new text prevents them, so the gate is not passed on that account.'] : []),
    ...(summary.notReplayable.length ? ['', `Not replayable from the state (their earlier text or request was never kept): ${summary.notReplayable.map(row => `rev ${row.rev} (${row.reason})`).join(', ')}.`] : []),
    '', 'The planner cases are a construction (the 09-26..10-02 planner requests were never archived): today\'s captured request with the earlier task text and the triggering message added. The foreground cases are the recorded context.', '',
    '| case | kind | label | status | v1 writes | v2 writes | touched v1 → v2 | scoped | basis (v2) | tokens |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const row of job.cases ?? []) {
    const v1 = row.runs?.v1, v2 = row.runs?.v2, tokens = (v1?.tokens ?? 0) + (v2?.tokens ?? 0);
    const result = (summary.rows ?? []).find(item => item.rev === row.rev);
    lines.push(`| ${row.id} (rev ${row.rev}) | ${row.kind} | ${row.label}${row.informational ? ' (info)' : ''} | ${row.status === 'not_replayable' ? `not replayable: ${row.reason}` : `${v1?.status ?? '-'} / ${v2?.status ?? '-'}`} | ${yes(v1?.write)} | ${yes(v2?.write)} | ${v1?.scope ? (v1.scope.removed ?? '?') : '-'} → ${v2?.scope ? (v2.scope.removed ?? '?') : '-'} | ${result?.rewrite ? 'rewrite asked' : yes(result?.scoped)} | ${v2?.basisCheck ?? '-'} | ${tokens} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** A conversation deleted: every report that replayed it goes with it (a report holds the model's proposed task and the words it quoted). */
function dropReports(stateFile, gone) {
  const root = scheduleReplayRoot(stateFile);
  if (!realDirectory(`${stateFile}.rna`) || !realDirectory(root)) return 0;
  let removed = 0, names = [];
  try { names = readdirSync(root); } catch { return 0; }
  for (const name of names) {
    const match = REPORT_FILE.exec(name); if (!match) continue;
    try {
      let report; try { report = JSON.parse(readFileSync(join(root, name), 'utf8')); } catch (error) { if (error?.code === 'ENOENT') continue; report = null; }
      const ids = report ? (report.cases ?? []).flatMap(row => row.sessionIds ?? []) : null;
      if (ids !== null && !ids.some(gone)) continue;
      rmSync(join(root, name), { force: true }); rmSync(join(root, `${match[1]}.md`), { force: true }); removed++;
    } catch { /* the next sweep retries this file */ }
  }
  return removed;
}
export const purgeScheduleReplayReports = (stateFile, sessionId) => typeof sessionId === 'string' && sessionId ? dropReports(stateFile, id => id === sessionId) : 0;
export const pruneScheduleReplayReports = (stateFile, { state } = {}) => state ? dropReports(stateFile, id => !sessionsLive(state, [id])) : 0;

export class ScheduleTextReplay {
  /**
   * `decisions`: the live DecisionService (secrets for redaction); `provider`: the model stream, metered into `ledger` as purpose
   * evaluation; `held()`: whether application maintenance holds new work; `prefixFor(projectId)`: the project's latest published
   * prefix (prompt-prefix-registry): the journal records messages, not the system prompt or the tools.
   */
  constructor(store, { decisions = null, provider = streamCompletion, now = Date.now, ledger = store?.usageLedger ?? null, held = () => false, prefixFor = latestPrefixFor } = {}) {
    Object.assign(this, { store, decisions, provider, now, ledger, held: typeof held === 'function' ? held : () => false, prefixFor, job: null, controller: null, promise: null, inFlight: 0, sequence: 0, scans: new Map() });
    this.capture = new EffortCapture({ stateFile: store.file, now });
    if (store?.file) this.clearScratch();
  }
  get running() { return Boolean(this.promise); }
  reportDir() { return scheduleReplayRoot(this.store.file); }
  spendFile() { return join(this.reportDir(), 'spend.json'); }
  scratchDir() { return join(this.reportDir(), 'scratch'); }
  clearScratch() { try { rmSync(this.scratchDir(), { recursive: true, force: true }); } catch { /* the next start tries again */ } }
  options(input = {}) {
    const integer = (value, fallback, min, max) => value === undefined ? fallback : Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(`replay option out of range (${min}–${max})`);
    const options = { foreground: integer(input.foreground, REPLAY_DEFAULTS.foreground, 0, 4), planner: integer(input.planner, REPLAY_DEFAULTS.planner, 0, 8), baseline: input.baseline === undefined ? REPLAY_DEFAULTS.baseline : ['all', 'effect'].includes(input.baseline) ? input.baseline : fail('baseline 只能是 all 或 effect'), ...(input.budgetTokens === undefined ? {} : { budgetTokens: integer(input.budgetTokens, undefined, 1, MAX_RUN_BUDGET) }) };
    if (input.projectId !== undefined) { if (typeof input.projectId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.projectId)) fail('projectId 无效'); options.projectId = input.projectId; }
    return options;
  }
  // ------------------------------------------------------------- models
  usable(model) { return Boolean(model) && model.execution === 'rna' && model.usagePolicy !== 'interactive_only' && (model.protocol === 'openai' || model.protocol === 'anthropic'); }
  /** The configured model a recorded request ran on (with the recorded reasoning), if it can still run here; never its key. */
  modelFor(recorded) {
    if (!recorded?.providerId || !recorded?.modelId) return null;
    let model; try { model = resolveModel(this.store.state.configuration, { providerId: recorded.providerId, modelId: recorded.modelId }); } catch { return null; }
    if (!this.usable(model)) return null;
    return REASONING_VALUES.has(recorded.reasoning) ? { ...model, reasoning: recorded.reasoning } : model;
  }
  /** The project's background model as configured now, or null. */
  currentModel(projectId) {
    const state = this.store.state, project = state.projects.find(item => item.id === projectId);
    try { const model = project ? resolveModel(state.configuration, project.initiative?.modelSelection ?? null) : null; return this.usable(model) ? model : null; } catch { return null; }
  }
  apiKeyOf(model) { const provider = this.store.state.configuration.providers.find(row => row.id === model.providerId); return provider ? this.store.configurationService.secret(provider.id, provider) : null; }
  // ------------------------------------------------------------- what can be replayed
  journalsOf(session) {
    const folder = join(resolve(`${this.store.file}.rna`), session.id), recorded = session.runtime?.engine === 'rna' && typeof session.runtime.sessionFile === 'string' ? resolve(session.runtime.sessionFile) : null;
    let files = [];
    if (recorded && dirname(recorded) === folder) files = [recorded];
    else try { files = readdirSync(folder).filter(name => name.endsWith('.rna.jsonl')).map(name => join(folder, name)); } catch { files = []; }
    return files.filter(file => { try { return statSync(file).isFile(); } catch { return false; } });
  }
  async scan(file, keys) {
    const info = statSync(file), id = `${file}|${keys.join(',')}`, cached = this.scans.get(id);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.result;
    const result = await scanRequestsOf(file, keys);
    this.scans.set(id, { size: info.size, mtimeMs: info.mtimeMs, result });
    return result;
  }
  /** The foreground turn of a recorded edit: its conversation, its first project_schedule call and the request that produced it. */
  async foregroundCase(edit, state, versions, callKeys) {
    const base = { id: idOf('foreground', edit.rev), rev: edit.rev, kind: 'foreground', label: edit.label, ...(edit.informational ? { informational: true } : {}) };
    let located = null;
    for (const session of state.sessions ?? []) {
      if (session.kind === 'side') continue;
      const item = (session.items ?? []).find(row => row.kind === 'tool' && row.tool?.name === TOOL && typeof row.tool.callKey === 'string' && String(row.turnId ?? '').startsWith(edit.ref));
      if (item) { located = { session, item }; break; }
    }
    if (!located) return { ...base, status: 'not_replayable', reason: 'turn_not_found' };
    const { session, item } = located, project = state.projects.find(row => row.id === session.projectId);
    if (!project) return { ...base, status: 'not_replayable', reason: 'project_missing' };
    const files = this.journalsOf(session);
    if (!files.length) return { ...base, status: 'not_replayable', reason: 'journal_missing' };
    let point = null, journal = null, header = null;
    // One pass over a journal answers every foreground case in it (the keys are all of them, so the scan is cached).
    for (const file of files) { let scanned; try { scanned = await this.scan(file, callKeys); } catch { continue; } if (scanned.points.has(item.tool.callKey)) { point = scanned.points.get(item.tool.callKey); journal = file; header = scanned.header; break; } }
    if (!point) return { ...base, status: 'not_replayable', reason: 'request_not_in_journal' };
    let record = null; try { record = JSON.parse(item.tool.output); } catch { record = null; }
    const scheduleId = record?.id ?? item.tool.args?.id ?? null, previous = Number.isSafeInteger(record?.revision) ? textBefore(versions, record.revision, scheduleId) : null;
    // Without the earlier text there is nothing to say a lasting write left alone: it cannot be replayed (as a planner case cannot).
    if (!previous && edit.label === 'durable') return { ...base, status: 'not_replayable', reason: 'earlier_text_not_kept' };
    return { ...base, status: 'ready', projectId: project.id, sessionId: session.id, sessionIds: [session.id], turnId: item.turnId, callKey: item.tool.callKey, scheduleId, revisionAfter: record?.revision ?? null, previousTask: previous?.task ?? null, journal, header, point };
  }
  /** The planner scenario of a recorded edit: today's captured decision request, the earlier task text, the triggering message. */
  plannerCase(edit, state, versions, rows) {
    const base = { id: idOf('planner', edit.rev), rev: edit.rev, kind: 'planner', label: edit.label };
    let action = null, project = null;
    for (const row of state.projects ?? []) { const found = (row.initiativeRuntime?.sdkState?.actions ?? []).find(item => typeof item.id === 'string' && item.id.startsWith(edit.ref) && item.schedule); if (found) { action = found; project = row; break; } }
    if (!action) return { ...base, status: 'not_replayable', reason: 'action_not_found' };
    const receipt = (project.scheduleManagementReceipts ?? []).find(item => item.actionId === action.id);
    if (!receipt || !Number.isSafeInteger(receipt.revision)) return { ...base, status: 'not_replayable', reason: 'receipt_missing' };
    const previous = textBefore(versions, receipt.revision, receipt.scheduleId);
    if (!previous) return { ...base, status: 'not_replayable', reason: 'earlier_text_not_kept' };
    const items = projectUserItems(state, project.id), messages = edit.cited.map(prefix => items.find(item => item.id.startsWith(prefix)) ?? null);
    if (messages.some(message => !message)) return { ...base, status: 'not_replayable', reason: 'message_not_found' };
    const row = rows.filter(item => item.projectId === project.id && item.request?.project && Array.isArray(item.request.events) && Array.isArray(item.request.availableActions) && item.request.availableActions.includes('schedule') && (item.request.project.schedules ?? []).some(record => record.id === receipt.scheduleId))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (!row) return { ...base, status: 'not_replayable', reason: 'no_captured_decision_request' };
    return { ...base, status: 'ready', projectId: project.id, sessionIds: [...new Set(messages.map(message => message.sessionId))], scheduleId: receipt.scheduleId, revisionAfter: receipt.revision, previousTask: previous.task, messages: messages.map(message => ({ id: message.id, sessionId: message.sessionId, at: message.at, chars: message.text.length })), captured: { id: row.id, at: row.at, providerId: row.providerId ?? null, modelId: row.modelId ?? null } };
  }
  /** The dry run: what would be replayed, the estimate, the approval and today's cap; no model call. */
  async plan(input = {}) { const { selection, ...plan } = await this.preview(input); return plan; }
  async preview(input = {}) {
    const options = this.options(input), state = this.store.state, projects = (state.projects ?? []).filter(row => !options.projectId || row.id === options.projectId), scoped = { ...state, projects };
    const versions = new Map(projects.map(project => [project.id, scheduleTextVersions(project, state)]));
    const versionsOf = project => versions.get(project?.id) ?? [];
    const all = [], rows = [], callKeys = [];
    for (const project of projects) rows.push(...this.capture.calls('decision', { projectId: project.id }));
    for (const edit of SCHEDULE_HISTORY) if (edit.path === 'tool') for (const session of state.sessions ?? []) { const item = (session.items ?? []).find(row => row.kind === 'tool' && row.tool?.name === TOOL && typeof row.tool.callKey === 'string' && String(row.turnId ?? '').startsWith(edit.ref)); if (item) callKeys.push(item.tool.callKey); }
    for (const edit of SCHEDULE_HISTORY) {
      // The state that holds the edit's records decides which project it belongs to: the foreground turn, or the planning action.
      const owner = projects.find(project => edit.path === 'tool' ? state.sessions.some(session => session.projectId === project.id && (session.items ?? []).some(row => row.kind === 'tool' && row.tool?.name === TOOL && String(row.turnId ?? '').startsWith(edit.ref))) : (project.initiativeRuntime?.sdkState?.actions ?? []).some(item => String(item.id).startsWith(edit.ref)));
      if (!owner) { all.push({ id: idOf(edit.path === 'tool' ? 'foreground' : 'planner', edit.rev), rev: edit.rev, kind: edit.path === 'tool' ? 'foreground' : 'planner', label: edit.label, status: 'not_replayable', reason: 'not_in_state' }); continue; }
      all.push(edit.path === 'tool' ? await this.foregroundCase(edit, scoped, versionsOf(owner), callKeys) : this.plannerCase(edit, scoped, versionsOf(owner), rows));
    }
    // A further amount the user approved with this start counts toward what the plan may fill (recorded only at the start).
    const approval = this.approval(), more = this.approveMoreOf(input.approveMore, approval.remaining), daily = realBudgetRemaining(state, { now: this.now() }), available = Math.min(options.budgetTokens ?? Infinity, approval.remaining + more);
    for (const entry of all.filter(row => row.status === 'ready')) { entry.estimate = this.estimateOf(entry); entry.conditions = conditionsOf(entry, options.baseline); entry.cost = entry.conditions.reduce((sum, condition) => sum + entry.estimate[condition], 0); const warning = this.warningOf(entry); if (warning) entry.warning = warning; }
    const selection = selectCases(all, { foreground: options.foreground, planner: options.planner, budget: Math.floor(available * PLAN_SHARE) });
    const chosen = new Set(selection.map(row => row.id)), calls = selection.reduce((sum, row) => sum + row.conditions.length, 0), estimate = selection.reduce((sum, row) => sum + row.cost, 0);
    // What the gate needs: every required lasting and one-off case, under both versions (the mechanical ones are optional evidence).
    const needed = all.filter(row => row.status === 'ready' && row.label !== 'mechanical' && !row.informational), required = { cases: needed.map(row => row.rev).sort((a, b) => a - b), estimate: needed.reduce((sum, row) => sum + row.cost, 0), covered: needed.every(row => chosen.has(row.id)), missing: REQUIRED_REVS.filter(rev => !needed.some(row => row.rev === rev)).sort((a, b) => a - b) };
    return { options: { ...options, budgetTokens: available }, covers: ['foreground', 'planner'], required, found: { ready: all.filter(row => row.status === 'ready').length, notReplayable: all.filter(row => row.status === 'not_replayable').length }, selected: selection.length, calls, estimate, withinBudget: estimate <= available, approval, dailyRemaining: Number.isFinite(daily) ? daily : null,
      cases: all.map(row => ({ id: row.id, rev: row.rev, kind: row.kind, label: row.label, ...(row.informational ? { informational: true } : {}), status: row.status === 'ready' ? chosen.has(row.id) ? 'selected' : 'deferred' : row.status, ...(row.reason ? { reason: row.reason } : {}), ...(row.warning ? { warning: row.warning } : {}), ...(row.cost ? { estimate: row.cost, conditions: row.conditions } : {}) })), selection };
  }
  /**
   * A further amount the user approved with a start (0 when none): a whole number of tokens, and what is approved and unspent plus this
   * amount is a run's whole budget, so it may not pass MAX_RUN_BUDGET (the plan and the start check the same bound).
   */
  approveMoreOf(value, remaining = this.approval().remaining) {
    if (value === undefined) return 0;
    if (!(Number.isSafeInteger(value) && value >= 1)) fail('approveMore 必须是正整数（用户另行批准的 token 数）。', 400, 'invalid_replay');
    if (remaining + value > MAX_RUN_BUDGET) fail(`approveMore ${value} 加上已批准且未花的额度 ${remaining} 超过一次回放的总预算上限 ${MAX_RUN_BUDGET}（approveMore 至多 ${Math.max(0, MAX_RUN_BUDGET - remaining)}）。`, 400, 'invalid_replay');
    return value;
  }
  /** What will keep a ready foreground case from running, known before anything is spent (the plan still lists it). */
  warningOf(entry) {
    if (entry.kind !== 'foreground') return null;
    const prefix = this.prefixFor(entry.projectId);
    if (!prefix || typeof prefix.systemPrompt !== 'string' || !Array.isArray(prefix.tools)) return 'prefix_unavailable';
    try { withScheduleTexts({ systemPrompt: prefix.systemPrompt, tools: prefix.tools, messages: [] }, 'v2'); } catch (error) { return error?.code ?? 'prompt_mismatch'; }
    return null;
  }
  /** Planning tokens of one case under each version: a foreground case's recorded prompt moved to today's prefix (as the
   * runtime last published it) and carrying each version's texts, a planner request's own estimate, and a typical reply. */
  estimateOf(entry) {
    if (entry.kind === 'foreground') {
      const size = Number.isFinite(entry.point.promptTokens) ? entry.point.promptTokens : 100000, prefix = this.prefixFor(entry.projectId);
      const today = prefix && typeof prefix.systemPrompt === 'string' && Array.isArray(prefix.tools) ? prefixTokensOf(prefix.systemPrompt, prefix.tools) : null, delta = today !== null && Number.isFinite(entry.point.prefixTokens) ? today - entry.point.prefixTokens : 0;
      const each = version => { let input = size + delta; try { input = withScheduleTexts({ systemPrompt: prefix.systemPrompt, tools: prefix.tools, messages: [], estimatedInputTokens: input }, version).estimatedInputTokens; } catch { /* the plan warns; the run skips */ } return Math.ceil(Math.max(1, input) * 1.1) + OUTPUT_ESTIMATE; };
      return { v1: each('v1'), v2: each('v2') };
    }
    const row = this.plannerRow(entry), input = row ? this.plannerInput(row.request, entry, 'v1') : 60000, recorded = Number(row?.outcome?.usage?.totalTokens), each = (Number.isFinite(recorded) && recorded > 0 ? Math.ceil(recorded * 1.1) : Math.ceil(input * 1.1)) + OUTPUT_ESTIMATE;
    return { v1: each, v2: each };
  }
  plannerRow(entry) { return this.capture.calls('decision', { projectId: entry.projectId }).find(row => row.id === entry.captured?.id) ?? null; }
  /** The planner request of a case under a version: the captured one with the earlier task, the triggering message and the version's texts. */
  plannerRequest(row, entry, version) {
    const request = withPlannerTexts(structuredClone(row.request), version), project = request.project;
    for (const record of project.schedules ?? []) if (record.id === entry.scheduleId) { record.task = entry.previousTask; delete record.taskBasis; }
    const events = [...(request.events ?? [])];
    // The user messages the recorded change cited arrive as the newest evidence, in the order they were written.
    const latest = events.reduce((time, event) => Math.max(time, Number(event.at) || 0), 0), items = projectUserItems(this.store.state, entry.projectId);
    for (const [index, message] of (entry.messages ?? []).entries()) events.push({ id: `message:${message.id}`, type: 'user_message', summary: items.find(row2 => row2.id === message.id)?.text ?? '', at: latest + 1000 * (index + 1) });
    return { ...request, events };
  }
  plannerInput(request, entry, version) { try { return decisionInputEstimate({ ...this.plannerRequest({ request }, entry, version), schedulePromptVersion: version }); } catch { return Math.ceil(Buffer.byteLength(JSON.stringify(request)) / 3) + 6000; } }
  // ------------------------------------------------------------- approval (the spend record)
  status() { return { running: this.running, job: this.job ? structuredClone(this.job) : null, reports: this.reports(), approval: this.approval() }; }
  reports() { try { return readdirSync(this.reportDir()).filter(name => REPORT_FILE.test(name)).map(name => name.slice(0, -5)).sort().slice(-20); } catch { return []; } }
  report(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail('报告 ID 无效');
    let json, markdown;
    try { json = JSON.parse(readFileSync(join(this.reportDir(), `${id}.json`), 'utf8')); markdown = readFileSync(join(this.reportDir(), `${id}.md`), 'utf8'); } catch { fail('报告不存在', 404, 'replay_report_missing'); }
    if (json.phase === 'running' && !(this.running && this.job?.id === id)) { json.phase = 'interrupted'; json.summary = summarizeReplay(json); markdown = replayMarkdown(json); }
    return { id, json, markdown };
  }
  readSpend() {
    let text;
    try { text = readFileSync(this.spendFile(), 'utf8'); } catch (error) { return error?.code === 'ENOENT' ? emptySpend() : { ...emptySpend(), unreadable: true }; }
    try { const value = JSON.parse(text); if (value && Array.isArray(value.approvals) && value.jobs && typeof value.jobs === 'object') return value; } catch { /* flagged below */ }
    return { ...emptySpend(), unreadable: true };
  }
  writeSpend(value) {
    mkdirSync(this.reportDir(), { recursive: true, mode: 0o700 });
    const file = this.spendFile(), temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(temp, file);
  }
  /** The approved total, what every run spent (a run its daemon lost mid-request counts that request at its worst case), and what is left. */
  approval() {
    const spend = this.readSpend(), approved = spend.approvals.length ? spend.approvals.reduce((sum, row) => sum + Math.max(0, Number(row.tokens) || 0), 0) : SCHEDULE_REPLAY_BUDGET_TOKENS, current = this.running ? this.job?.id : null;
    const spent = Object.entries(spend.jobs).reduce((sum, [id, row]) => sum + Math.max(0, Number(row.spentTokens) || 0) + (row.phase === 'running' && id !== current ? Math.max(0, Number(row.inFlightTokens) || 0) : 0), 0) + (current ? this.inFlight : 0);
    return { approved, spent, remaining: Math.max(0, approved - spent), approvals: spend.approvals.length, ...(spend.unreadable ? { unreadable: true } : {}) };
  }
  /** Start (202) with `approved: true`, within what is left of the approved total, today's real-token cap and the run's budget. */
  async start(input = {}) {
    if (input?.approved !== true) fail(`回放会调用主模型并计费：需要 approved: true（用户批准的预算约 75 万 token，硬上限 ${SCHEDULE_REPLAY_BUDGET_TOKENS}）。`, 400, 'replay_not_approved');
    if (this.running) fail('已有日程文本回放在运行。', 409, 'replay_running');
    this.approveMoreOf(input.approveMore);
    const unreadable = () => fail('回放批准与花费记录（schedule-text-replay/spend.json）无法读取：拒绝开始，以免忘记此前的花费。', 409, 'replay_record_unreadable');
    if (this.approval().unreadable) unreadable();
    const plan = await this.preview(input);
    if (this.running) fail('已有日程文本回放在运行。', 409, 'replay_running');
    // What is left of the approval, read after the preview's await; from here to `this.promise` nothing awaits.
    const before = this.approval();
    if (before.unreadable) unreadable();
    const more = this.approveMoreOf(input.approveMore, before.remaining), remaining = before.remaining + more, budget = Math.min(plan.options.budgetTokens, remaining);
    if (Number.isSafeInteger(input.budgetTokens) && input.budgetTokens > remaining) fail(`预算 ${input.budgetTokens} 超过已批准且未花的额度 ${remaining}（共批准 ${before.approved + more}，此前回放已用 ${before.spent}），拒绝开始；用户另行批准后用 --approve-more <token 数> 记录。`, 400, 'replay_over_budget');
    // The effective budget is bounded by what is approved and unspent unless the user asked for less (--budget).
    const limitedByApproval = input.budgetTokens === undefined || input.budgetTokens >= remaining;
    const spent = `已批准的回放额度剩余 ${remaining} token（共批准 ${before.approved + more}，此前回放已用 ${before.spent}）`;
    if (!plan.selected) {
      if (!plan.found.ready) fail('没有可回放的案例：状态里找不到那四个前台回合或规划行动（或其会话已删除）。', 409, 'replay_no_cases');
      if (limitedByApproval) fail(`${spent}，放不下任何一个案例：拒绝开始。用户另行批准后用 --approve-more <token 数> 记录。`, 409, 'replay_approval_spent');
      fail(`预算内放不下任何一个案例（本次预算 ${plan.options.budgetTokens}）：拒绝开始；调大 --budget 或减少 --foreground/--planner。`, 409, 'replay_no_cases');
    }
    if (plan.estimate > budget) {
      if (limitedByApproval) fail(`${spent}，不足估算的 ${plan.estimate}：拒绝开始。用户另行批准后用 --approve-more <token 数> 记录，或减少 --foreground/--planner。`, 409, 'replay_approval_spent');
      fail(`估算 ${plan.estimate} token 超过预算 ${plan.options.budgetTokens}，拒绝开始；减少 --foreground/--planner。`, 400, 'replay_estimate_over_budget');
    }
    const daily = realBudgetRemaining(this.store.state, { now: this.now() });
    if (plan.estimate > daily) fail(`今天的真实模型 token 限额只剩 ${daily}，不足回放估算的 ${plan.estimate}：拒绝开始。`, 409, 'replay_daily_cap');
    const id = `schedtext-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, stamp = new Date(this.now()).toISOString();
    const spend = this.readSpend();
    if (!spend.approvals.length) spend.approvals.push({ at: stamp, tokens: SCHEDULE_REPLAY_BUDGET_TOKENS, kind: 'initial', note: 'user decision 2026-10-05 (W2 paired schedule-text replay, about 0.75M tokens estimated)', jobId: id });
    if (more) spend.approvals.push({ at: stamp, tokens: more, kind: 'additional', jobId: id });
    this.clearScratch();
    this.controller = new AbortController(); this.inFlight = 0;
    this.job = { id, phase: 'running', startedAt: stamp, options: plan.options, covers: plan.covers, textVersions: ['v1', 'v2'], budgetTokens: budget, approval: { approved: before.approved + more, spentBefore: before.spent, ...(more ? { approvedNow: more } : {}) }, estimate: plan.estimate, spentTokens: 0, done: 0, calls: plan.calls,
      cases: plan.selection.map(entry => this.caseRecord(entry)).concat(plan.cases.filter(row => row.status !== 'selected').map(row => ({ id: row.id, rev: row.rev, kind: row.kind, label: row.label, ...(row.informational ? { informational: true } : {}), status: row.status === 'deferred' ? 'deferred' : 'not_replayable', ...(row.reason ? { reason: row.reason } : { reason: 'budget' }), sessionIds: [], runs: {} }))) };
    spend.jobs[id] = { startedAt: stamp, budgetTokens: budget, spentTokens: 0, inFlightTokens: 0, phase: 'running', updatedAt: stamp };
    try { this.writeSpend(spend); } catch { fail('无法记录回放批准与花费，拒绝开始。', 500, 'replay_record_failed'); }
    this.promise = this.run(plan.selection, this.controller.signal).catch(error => { this.job.phase = 'failed'; this.job.error = String(error?.message ?? error).slice(0, 300); }).finally(() => { this.promise = null; this.controller = null; this.inFlight = 0; this.clearScratch(); this.finish(); this.write(); });
    this.write();
    return structuredClone(this.job);
  }
  cancel() { if (!this.running) return { cancelled: false }; this.controller.abort(); return { cancelled: true }; }
  async close() { this.controller?.abort(); await this.promise?.catch(() => {}); }
  caseRecord(entry) {
    return { id: entry.id, rev: entry.rev, kind: entry.kind, label: entry.label, ...(entry.informational ? { informational: true } : {}), status: 'pending', projectId: entry.projectId, sessionIds: [...(entry.sessionIds ?? [])], scheduleId: entry.scheduleId ?? null, revisionAfter: entry.revisionAfter ?? null, previousChars: typeof entry.previousTask === 'string' ? entry.previousTask.length : null, ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.messages?.length ? { messages: entry.messages.map(message => ({ ...message })) } : {}), ...(entry.captured ? { captured: { ...entry.captured } } : {}), conditions: [...entry.conditions], estimate: entry.cost, runs: {} };
  }
  finish() {
    if (!this.job) return;
    if (this.job.phase === 'running') this.job.phase = 'completed';
    this.job.finishedAt = new Date(this.now()).toISOString();
    this.job.summary = summarizeReplay(this.job);
  }
  // ------------------------------------------------------------- running
  async run(selection, signal) {
    const records = new Map(this.job.cases.map(row => [row.id, row]));
    for (const [index, entry] of selection.entries()) {
      if (signal.aborted) break;
      const record = records.get(entry.id);
      const outcome = await this.runCase(entry, record, signal, index);
      this.write();
      if (outcome?.stop) { this.job.phase = outcome.stop; this.job.stopReason = outcome.reason; break; }
    }
    if (signal.aborted && this.job.phase === 'running') this.job.phase = 'cancelled';
    for (const record of this.job.cases) if (record.status === 'pending' || record.status === 'running') record.status = this.job.phase === 'running' ? 'skipped' : 'not_run';
  }
  async runCase(entry, record, signal, index) {
    record.status = 'running';
    const skip = reason => { record.status = 'skipped'; record.reason = reason; return null; };
    if (this.held()) return { stop: 'maintenance_stop', reason: 'maintenance' };
    const resolved = entry.kind === 'foreground' ? await this.resolveForeground(entry, record, signal) : this.resolvePlanner(entry, record);
    if (resolved.skip) return skip(resolved.skip);
    record.model = { providerId: resolved.model.providerId, modelId: resolved.model.modelId, reasoning: resolved.model.reasoning ?? null, ...(resolved.substituted ? { substituted: true } : {}) };
    // v1 and v2 alternate which goes first, so neither version always meets a colder provider cache.
    const order = entry.conditions.length === 2 && index % 2 === 1 ? [...entry.conditions].reverse() : entry.conditions;
    for (const condition of order) {
      if (signal.aborted) break;
      const outcome = await this.runCondition(entry, record, condition, resolved, signal);
      if (outcome?.stop) { if (record.status === 'running') record.status = 'not_run'; return outcome; }
    }
    record.status = signal.aborted ? 'cancelled' : 'ran';
    return null;
  }
  /** The project, the conversation (live), the model and key, the prefix and the request one foreground case was sent: or why it is skipped. */
  async resolveForeground(entry, record, signal) {
    if (!sessionsLive(this.store.state, entry.sessionIds)) return { skip: 'session_deleted' };
    let model = this.modelFor(entry.point.model), substituted = false;
    if (!model) { model = this.currentModel(entry.projectId); substituted = true; }
    if (!model) return { skip: 'model_unavailable' };
    const apiKey = this.apiKeyOf(model);
    if (!apiKey) return { skip: 'key_missing' };
    const prefix = this.prefixFor(entry.projectId);
    if (!prefix || typeof prefix.systemPrompt !== 'string' || !Array.isArray(prefix.tools)) return { skip: 'prefix_unavailable' };
    let main;
    try { main = await this.materialize(entry, { model, prefix }); } catch (error) { if (signal.aborted) return { skip: 'cancelled' }; return { skip: `rebuild_failed:${String(error?.code ?? error?.message ?? 'error').slice(0, 60)}` }; }
    if (!main) return { skip: 'journal_unreadable' };
    try { withScheduleTexts(main, 'v1'); withScheduleTexts(main, 'v2'); } catch (error) { return { skip: error?.code ?? 'prompt_mismatch' }; }
    record.rebuilt = { estimatedInputTokens: main.estimatedInputTokens, messages: main.messages.length, recordedPromptTokens: entry.point.promptTokens };
    return { model, substituted, apiKey, main };
  }
  resolvePlanner(entry) {
    if (!sessionsLive(this.store.state, entry.sessionIds)) return { skip: 'session_deleted' };
    const model = this.currentModel(entry.projectId);
    if (!model) return { skip: 'model_unavailable' };
    const apiKey = this.apiKeyOf(model), row = this.plannerRow(entry), project = this.store.state.projects.find(item => item.id === entry.projectId);
    if (!apiKey) return { skip: 'key_missing' };
    if (!row) return { skip: 'captured_request_gone' };
    if (!project) return { skip: 'project_missing' };
    return { model, apiKey, row, substituted: false };
  }
  /**
   * The main request of the recorded call, built by the SDK on a journal COPY truncated before the call's request record (the
   * live journal is only read; the copy lives in a private folder, removed before this returns). The prefix is today's published
   * one; the messages are the recorded context.
   */
  async materialize(entry, { model, prefix }) {
    mkdirSync(this.scratchDir(), { recursive: true, mode: 0o700 });
    const dir = realpathSync(mkdtempSync(join(this.scratchDir(), 'case-'))); chmodSync(dir, 0o700);
    const copy = join(dir, 'case.jsonl');
    let session = null;
    try {
      let header = null, buffer = '', written = 0;
      const fd = openSync(copy, 'w', 0o600), input = createReadStream(entry.journal, { encoding: 'utf8' }), lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const seq = Number(/^\{"seq":(\d+),/.exec(line)?.[1] ?? NaN);
          if (!Number.isSafeInteger(seq)) continue;
          if (seq >= entry.point.requestSeq) break;
          if (seq === 1) { try { header = JSON.parse(line).data; } catch { header = null; } }
          buffer += `${line}\n`; written++;
          if (buffer.length > 1 << 20) { writeSync(fd, buffer); buffer = ''; }
        }
        if (buffer) writeSync(fd, buffer);
      } finally { lines.close(); input.destroy(); closeSync(fd); }
      if (!header?.sessionId || !written) return null;
      const tools = prefix.tools.map(tool => ({ ...tool, execute: async () => { throw new Error('The schedule-text replay never runs a tool.'); } }));
      const cacheScope = header.projectId ? `project:${header.projectId}` : prefix.cacheScope;
      session = await createSession({ sessionId: header.sessionId, projectId: header.projectId ?? undefined, cwd: dir, stateDir: dir, sessionFile: copy, model, systemPrompt: prefix.systemPrompt, tools, ...(cacheScope ? { cacheScope } : {}),
        autoCompaction: false, preparedCompactionFile: join(dir, 'none.json'), redactValues: this.decisions?.secrets?.() ?? [], provider: async function* () { throw new Error('The replay sends its requests itself.'); } });
      return session.mainRequest();
    } finally {
      await session?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** The model stream, metered (purpose evaluation, detail schedule-text-replay, no project, no session, no keep-alive) and observed: usage summed over every call, the stop reason, what streamed. */
  observe() {
    const seen = { usage: null, totalTokens: 0, stopReason: null, streamed: 0, estimatedInput: null, sent: false, calls: 0 };
    const base = this.ledger ? meteredProvider(this.provider, { ledger: this.ledger, purpose: 'evaluation', keepAlive: null }) : this.provider;
    const stream = async function* (input) {
      // One request per case and version: a second call (a repair, a retry) is never sent.
      if (++seen.calls > 1) throw Object.assign(new Error('The schedule-text replay sends one request per case.'), { code: 'replay_single_request' });
      seen.sent = true;
      if (Number.isFinite(input?.estimatedInputTokens)) seen.estimatedInput = Math.ceil(input.estimatedInputTokens);
      for await (const event of base({ ...input, purposeDetail: DETAIL })) { if (event.type === 'usage') { seen.usage = event.usage; seen.totalTokens += tokensOf(event.usage); } else if (event.type === 'done') seen.stopReason = event.stopReason; else if (event.type === 'text_delta' || event.type === 'thinking_delta') seen.streamed += Buffer.byteLength(String(event.delta ?? '')); yield event; }
    };
    return { seen, stream };
  }
  /**
   * One paid request: reserved at its worst case against the daily cap and recorded in spend.json before it is sent (a reservation
   * that cannot be recorded sends nothing), then charged from the usage the provider reported, or its worst case when it went out
   * and reported none. `perform(stream)` runs the request and returns what it found.
   */
  async paid(ceiling, tag, signal, perform) {
    if (signal.aborted) return { stop: 'cancelled', reason: 'cancelled' };
    if (this.held()) return { stop: 'maintenance_stop', reason: 'maintenance' };
    if (this.job.spentTokens + this.inFlight + ceiling > this.job.budgetTokens) return { stop: 'budget_stop', reason: 'budget' };
    const key = `schedule-text:${this.job.id}:${++this.sequence}`;
    try { this.store.mutate(state => { reserveRealTokens(state, key, ceiling, { now: this.now() }); }); }
    catch (error) { if (error?.code === 'budget') return { stop: 'budget_stop', reason: 'daily_cap' }; throw error; }
    this.inFlight += ceiling;
    try { this.recordSpend(); }
    catch {
      this.inFlight -= ceiling;
      try { this.store.mutate(state => { releaseRealTokens(state, key, { now: this.now() }); }); } catch { /* charged at the next start (budget-service) */ }
      return { stop: 'record_failed', reason: 'record_failed' };
    }
    this.writeReports();
    const { seen, stream } = this.observe(), started = performance.now();
    let found;
    try { found = await perform(stream, seen); }
    catch (error) { found = { status: signal.aborted ? 'cancelled' : 'failed', code: signal.aborted ? 'cancelled' : typeof error?.code === 'string' ? error.code : 'provider_error' }; }
    const estimate = seen.usage ? seen.totalTokens : (seen.estimatedInput ?? 0) + Math.ceil(seen.streamed / 3), charged = seen.usage ? estimate : seen.sent ? ceiling : 0;
    this.inFlight -= ceiling;
    try { this.store.mutate(state => { releaseRealTokens(state, key, { now: this.now() }); chargeRealTokens(state, estimate, { estimated: !seen.usage, now: this.now() }); }); } catch { /* the reservation is charged at the next start (budget-service) */ }
    this.job.spentTokens += charged; this.job.done++;
    try { this.recordSpend(); } catch { /* the next request is refused until it can be recorded */ }
    return { result: { tag, ...found, stopReason: seen.stopReason, usage: compactUsage(seen.usage), estimated: !seen.usage, tokens: charged, ceiling, latencyMs: Math.round(performance.now() - started) } };
  }
  async runCondition(entry, record, condition, resolved, signal) {
    const { model, apiKey } = resolved, secrets = [apiKey, ...(this.decisions?.secrets?.() ?? [])].filter(value => typeof value === 'string' && value);
    let sent;
    if (entry.kind === 'foreground') {
      const request = withScheduleTexts(resolved.main, condition), allowance = Math.max(1, Math.min(positive(model.maxOutputTokens) ?? REPLY_ALLOWANCE, REPLY_ALLOWANCE, (positive(model.contextWindow) ?? Infinity) - request.estimatedInputTokens)), ceiling = Math.ceil(request.estimatedInputTokens * HEADROOM) + allowance;
      sent = await this.paid(ceiling, `${entry.id}:${condition}`, signal, async stream => {
        const calls = [];
        let text = '';
        // The request as the runtime would send it, under a cache key of its own: it never reads or warms the conversation's.
        for await (const event of iterateCompletion(stream, { model, apiKey, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools, maxOutputTokens: allowance, signal, cache: { ...request.cache, sessionKey: `schedule-text-replay:${entry.id}:${condition}` }, estimatedInputTokens: request.estimatedInputTokens })) {
          if (event.type === 'text_delta') text += String(event.delta ?? '');
          else if (event.type === 'tool_call') calls.push({ name: String(event.name ?? event.toolCall?.name ?? ''), arguments: event.arguments ?? event.toolCall?.arguments ?? {} });
        }
        return { status: 'pending', calls, textChars: text.length };
      });
    } else {
      const request = this.plannerRequest(resolved.row, entry, condition), policy = request.policy ?? {};
      const input = decisionInputEstimate({ ...request, schedulePromptVersion: condition }), allowance = Math.max(1, Math.min(positive(model.maxOutputTokens) ?? REPLY_ALLOWANCE, positive(policy.decisionMaxTokens) ?? REPLY_ALLOWANCE)), ceiling = Math.ceil(input * HEADROOM) + allowance;
      sent = await this.paid(ceiling, `${entry.id}:${condition}`, signal, async (stream, seen) => {
        const outcome = await decideInitiative({ project: request.project, events: request.events, availableActions: request.availableActions, promptActions: request.promptActions, presence: request.presence ?? {}, policy: request.policy ?? {}, recentActions: request.recentActions ?? [], previousDecision: request.previousDecision ?? null,
          model, apiKey, provider: stream, signal, maxAttempts: 1, redactValues: this.decisions?.secrets?.() ?? [], schedulePromptVersion: condition });
        return outcome.status === 'decided' ? { status: 'pending', decision: outcome.decision } : { status: 'failed', code: `blocked:${String(outcome.reason ?? 'unknown').slice(0, 40)}` };
      });
    }
    if (sent.stop) { record.runs[condition] = { condition, status: 'not_run', reason: sent.reason, tokens: 0 }; return sent.stop === 'cancelled' ? null : sent; }
    record.runs[condition] = this.judge(entry, condition, sent.result, secrets);
    return null;
  }
  /** What one reply did about the schedule, as the record keeps it (the model's words only where the user's own are quoted back). */
  judge(entry, condition, result, secrets) {
    const base = { condition, status: result.status, ...(result.code ? { code: result.code } : {}), stopReason: result.stopReason, usage: result.usage, estimated: result.estimated, tokens: result.tokens, ceiling: result.ceiling, latencyMs: result.latencyMs };
    if (result.status !== 'pending') return base;
    // A reply cut at the allowance, or one the SDK refused to read, says nothing about what the model would have written.
    if (result.stopReason === 'length') return { ...base, status: 'length' };
    const previousTask = entry.previousTask ?? null;
    const read = entry.kind === 'foreground' ? classifyCalls(result.calls, { previousTask }) : classifyDecision(result.decision, { previousTask });
    const items = projectUserItems(this.store.state, entry.projectId);
    const basisCheck = read.write && condition === 'v2' ? scheduleBasisCheck({ basis: read.basis, items, referenced: entry.kind === 'planner' ? citedMessageIds(read.evidenceIds) : null }).check : null;
    return { ...base, status: 'completed', write: read.write, ...(read.write ? { scope: sentenceDiff(previousTask, read.task), proposedChars: read.task.length, proposedTask: redact(read.task, secrets), ...(read.basis ? { basis: redact(read.basis, secrets) } : {}) } : {}), ...(basisCheck ? { basisCheck } : {}),
      ...(entry.kind === 'foreground' ? { scheduleCalls: read.scheduleCalls, creates: read.creates, toolNames: read.toolNames, textChars: result.textChars } : { action: read.action, scheduleOperation: read.scheduleOperation, creates: read.creates }) };
  }
  recordSpend() {
    const spend = this.readSpend();
    if (spend.unreadable) throw Object.assign(new Error('The replay spend record is unreadable.'), { code: 'record_unreadable' });
    spend.jobs[this.job.id] = { ...(spend.jobs[this.job.id] ?? {}), startedAt: this.job.startedAt, budgetTokens: this.job.budgetTokens, spentTokens: this.job.spentTokens, inFlightTokens: this.inFlight, phase: this.job.phase, updatedAt: new Date(this.now()).toISOString() };
    this.writeSpend(spend);
  }
  /** The spend line first, then progress (a crash keeps it). */
  write() {
    if (!this.job) return;
    try { this.recordSpend(); } catch { /* paid() refuses the next request until it can be recorded */ }
    this.writeReports();
  }
  writeReports() {
    if (!this.job) return;
    try {
      mkdirSync(this.reportDir(), { recursive: true, mode: 0o700 });
      const job = this.job.summary ? this.job : { ...this.job, summary: summarizeReplay(this.job) };
      writeFileSync(join(this.reportDir(), `${this.job.id}.json`), JSON.stringify(this.job, null, 2), { mode: 0o600 });
      writeFileSync(join(this.reportDir(), `${this.job.id}.md`), replayMarkdown(job), { mode: 0o600 });
    } catch { /* the in-memory job still answers status */ }
  }
}

// ------------------------------------------------------------------------------------------- choosing the cases
/**
 * Which ready cases the plan runs, within `budget` planning tokens (both versions of a case count, and a case runs under both or
 * not at all). In priority order: the foreground lasting requests and the one-off, the planner lasting requests and the one-off, the
 * informational foreground edit, then the mechanical planner changes. `foreground` and `planner` cap how many of each kind.
 */
export function selectCases(cases, { foreground = REPLAY_DEFAULTS.foreground, planner = REPLAY_DEFAULTS.planner, budget = Infinity } = {}) {
  const ready = cases.filter(row => row.status === 'ready');
  const tier = row => row.label === 'mechanical' ? 4 : row.informational ? 3 : row.kind === 'planner' ? 2 : 1;
  const limits = { foreground, planner }, taken = { foreground: 0, planner: 0 }, chosen = [];
  let sum = 0;
  for (const row of ready.sort((a, b) => tier(a) - tier(b) || a.rev - b.rev)) {
    if (taken[row.kind] >= limits[row.kind]) continue;
    const cost = row.cost ?? row.estimate.v1 + row.estimate.v2;
    if (sum + cost > budget) continue;
    sum += cost; taken[row.kind]++; chosen.push(row);
  }
  return chosen.sort((a, b) => a.rev - b.rev);
}
