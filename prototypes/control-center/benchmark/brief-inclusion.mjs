#!/usr/bin/env node
// Equivalence check for the scheduled-run dedupe (token burn T3, design P2), offline, no model call, no network.
//
// A scheduled run's first request repeated its own task text: in the planning state (the schedule's `task`), in its own
// receipt and pending job, and in the receipts of earlier runs of the same schedule (an excerpt of their own message).
// The worker brief now leaves out exactly that. This script proves it on real runs: for each recorded occurrence it builds
// the OLD first request (the brief and the planning state as they were) and the NEW one from a copy of the live state
// rewound to the moment the run started, then
//   1. asserts every fragment the new request leaves out is found word for word in the text the new request keeps
//      (the occurrence message first); the only things allowed to be missing are structural labels (status, action, kind,
//      detailsTool) and the run's own action id, and they are listed;
//      and the run's own action id is one the model never wrote in that run (the journal holds everything it wrote);
//   2. asserts the new request ADDS nothing but the fixed placeholders (so nothing else was reworded or reordered);
//   3. when a baseline code root is given (`--base`), asserts the old request built by this revision (no `own`) is deep
//      equal to the one the baseline revision builds (a run that is not a scheduled occurrence is untouched);
//   4. compares the rebuilt old request with the one recorded in the run's journal where the journal has the same form;
//   5. reports the characters and estimated tokens the first request loses, and how many earlier runs' task excerpts were replaced by
//      the statement (EARLIER_TASK_PLACEHOLDER) over a task that was whole word for word today's (the rest differed in the part the excerpt never showed).
// Usage: node benchmark/brief-inclusion.mjs <state.json copy> <journal.jsonl> [<journal.jsonl> …] [--base <code root>]
// The state is read only (pass a copy: readStateFile never writes, but production state is not for benchmarks). The
// journals are copies of runs' `*.rna.jsonl`. Exit code 1 when a check fails.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readStateFile } from '../state-shards.mjs';
import { ProjectInitiativeController, scheduledRunOwn, scheduledOccurrence, EARLIER_TASK_PLACEHOLDER, EXCERPT_MARKER } from '../project-initiative-controller.mjs';
import { mindBackgroundView } from '../project-mind.mjs';
import { projectWorkingContext, SCHEDULE_TASK_PLACEHOLDER } from '../../../packages/sdk/src/project-context.mjs';
import { prepareContext } from '../../../packages/sdk/src/context.mjs';
import { buildRequest } from '../../../packages/sdk/src/providers.mjs';

/** Keys whose string value is a structural label of a row (what kind of row it is), not text the model reads for content. */
const LABEL_KEYS = new Set(['status', 'action', 'kind', 'detailsTool']);
/** Tokens per character fitted by the study on the 2026-10-05 run against provider usage (anat/ledger.py): other characters, CJK characters. */
const TOKENS_PER_CHAR = { other: 0.293, cjk: 0.868 };
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef\u2000-\u206f]/gu;
export const estimateTokens = text => { const cjk = (String(text).match(CJK) ?? []).length; return Math.round((String(text).length - cjk) * TOKENS_PER_CHAR.other + cjk * TOKENS_PER_CHAR.cjk); };
/** The prefix every run of this project shares (system prompt + tool declarations): the cache read the first requests of earlier runs got, in provider tokens. */
const SHARED_PREFIX_TOKENS = 13248;

/** The messages of a run's journal before its first model request, and what identifies the run. */
export function recordedFirstRequest(journalText) {
  const records = journalText.trim().split('\n').map(line => JSON.parse(line)), messages = [];
  const header = records.find(row => row.type === 'session_header')?.data;
  for (const row of records) { if (row.type === 'request_started') break; if (row.type === 'message') messages.push(structuredClone(row.data.message)); }
  const task = messages.find(message => message.role === 'user' && message.source === 'user');
  if (!header || !task) throw new Error('The journal has no first user message');
  const context = source => messages.flatMap(message => message.context ?? []).find(item => item.source === source)?.text ?? null;
  const first = records.find(row => row.type === 'request_started'), usage = records.find(row => row.type === 'request_completed')?.data?.message?.usage;
  // Everything the model wrote in the run (reasoning, text, tool arguments): what "the model used" can be searched in.
  const modelOutput = records.filter(row => row.type === 'request_completed').flatMap(row => row.data.message.content ?? []).map(block => `${block.thinking ?? ''}${block.text ?? ''}${block.arguments ? JSON.stringify(block.arguments) : ''}`).join('\n');
  return { modelOutput, sessionId: header.sessionId, projectId: header.projectId, messages, taskText: task.content.map(block => block.text ?? '').join(''), context, startedAt: Date.parse(first?.time ?? records[1]?.time ?? records[0].time),
    providerPromptTokens: usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : null };
}

const ms = value => typeof value === 'number' ? value : Date.parse(value);
/**
 * The saved state as it was when the run started: the run's action is the last one and running, its job is running, the
 * records created later are gone, and the schedule's task is the one the occurrence message carries (the schedule was
 * claimed at that revision). Returns { state, project, action }. Mutates a clone, never `state`.
 */
export function rewindToRun(state, { projectId, actionId, at, task = null }) {
  state = structuredClone(state);
  const project = state.projects.find(row => row.id === projectId), runtime = project?.initiativeRuntime?.sdkState;
  const index = runtime?.actions.findIndex(row => row.id === actionId) ?? -1;
  if (index < 0) throw new Error(`The state has no action ${actionId} (is the state copy older than the run?)`);
  runtime.actions = runtime.actions.slice(0, index + 1);
  const action = runtime.actions[index];
  for (const key of ['finishedAt', 'handoff', 'resultSummary', 'failure', 'errorCode', 'error']) delete action[key];
  action.status = 'running';
  project.jobs = (project.jobs ?? []).filter(job => job.id === actionId || ms(job.createdAt) < at);
  const job = project.jobs.find(row => row.id === actionId);
  if (job) { job.status = 'running'; for (const key of ['completedAt', 'output', 'handoff', 'usage', 'toolReceipts', 'toolReceiptCounts', 'deliveryText', 'failure', 'errorCode', 'runtimeFile', 'memoryContext', 'briefStats']) delete job[key]; }
  const schedule = (project.schedules ?? []).find(row => row.id === action.hostSchedule?.scheduleId);
  if (schedule && typeof task === 'string') schedule.task = task;
  for (const session of state.sessions.filter(row => row.projectId === projectId)) {
    session.items = session.items.filter(item => !(ms(item.createdAt) > at));
    session.turns = session.turns.filter(turn => !(ms(turn.createdAt) > at));
    for (const turn of session.turns) if (ms(turn.completedAt) > at) { turn.status = 'running'; delete turn.completedAt; }
  }
  return { state, project, action };
}

/** A controller that can build worker briefs from `state` at `now` (the same shape the request-size benchmark uses). */
function briefHost(Controller, state, now, mindView) {
  const mind = { backgroundContext: (projectId, { query = '' } = {}) => { const view = mindView(state.projects.find(row => row.id === projectId), { now, query }); return view ? JSON.stringify(view) : null; } };
  const store = { state, file: null, usageLedger: null, configurationService: { secrets: {}, secretValues: () => [] }, presences: new Map(), mind };
  return Object.assign(Object.create(Controller.prototype), { store, now: () => now, independentLearning: true });
}

/** The texts of the two context entries the dedupe touches, as the host composes them. */
const evidenceText = (brief, evidence) => JSON.stringify({ project: brief.volatile, evidence });
const planningText = working => JSON.stringify(working);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rowKey = row => isObject(row) ? row.actionId ?? row.id ?? null : null;
/** Every leaf of a JSON value with its path, the key it sits under and its type: strings are the text the model reads, the rest are flags and counts. */
const strings = (node, path = '', key = '', out = []) => {
  if (Array.isArray(node)) node.forEach((item, index) => strings(item, `${path}[${index}]`, key, out));
  else if (isObject(node)) for (const [name, value] of Object.entries(node)) strings(value, path ? `${path}.${name}` : name, name, out);
  else out.push({ path, key, text: typeof node === 'string' ? node : String(node), type: typeof node === 'string' ? 'string' : 'other' });
  return out;
};
/** Paths of the leaves two JSON values do not share (informational, for the fidelity report). */
const differingPaths = (a, b, path = '', out = []) => {
  if (isObject(a) && isObject(b)) for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differingPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
  else if (Array.isArray(a) && Array.isArray(b)) for (let index = 0; index < Math.max(a.length, b.length); index++) differingPaths(a[index], b[index], `${path}[${index}]`, out);
  else if (!isDeepStrictEqual(a, b)) out.push(path);
  return out;
};
const commonPrefixAtLine = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; if (!n) return 0; const cut = a.lastIndexOf('\n', n - 1); return cut < 0 ? 0 : cut + 1; };
/**
 * What `after` no longer says compared with `before` (and what it says instead), leaf by leaf. Arrays of rows with an id
 * are aligned by id, other arrays by position. A changed string keeps the lines both share at its start; the rest of the
 * old string is the removed text (split at the excerpt marker: the marker itself is a note, not content), the rest of the
 * new one is the added text.
 */
export function leafDiff(before, after, path = '', key = '', out = { removed: [], added: [] }) {
  if (typeof before === 'string') {
    if (before === after) return out;
    if (typeof after !== 'string') { out.removed.push({ path, key, text: before, type: 'string', row: false }); return out; }
    const cut = commonPrefixAtLine(before, after);
    out.removed.push({ path, key, text: before.slice(cut), type: 'string', row: false });
    out.added.push({ path, key, text: after.slice(cut), type: 'string' });
  } else if (Array.isArray(before)) {
    const next = Array.isArray(after) ? after : [], keyed = before.every(row => rowKey(row) !== null) && next.every(row => rowKey(row) !== null);
    const at = (row, index) => `${path}[${keyed ? rowKey(row) : index}]`;
    before.forEach((row, index) => {
      const mate = keyed ? next.find(item => rowKey(item) === rowKey(row)) : next[index];
      if (mate === undefined) for (const leaf of strings(row, at(row, index), key)) out.removed.push({ ...leaf, row: true });
      else leafDiff(row, mate, at(row, index), key, out);
    });
    next.forEach((row, index) => { if (keyed ? !before.some(item => rowKey(item) === rowKey(row)) : index >= before.length) for (const leaf of strings(row, at(row, index), key)) out.added.push(leaf); });
  } else if (isObject(before)) {
    for (const [name, value] of Object.entries(before)) leafDiff(value, isObject(after) ? after[name] : undefined, path ? `${path}.${name}` : name, name, out);
    if (isObject(after)) for (const [name, value] of Object.entries(after)) if (!(name in before)) for (const leaf of strings(value, path ? `${path}.${name}` : name, name)) out.added.push(leaf);
  } else if (before !== after) {
    out.removed.push({ path, key, text: String(before), type: 'other', row: false });
    if (after !== undefined) out.added.push({ path, key, text: String(after), type: 'other' });
  }
  return out;
}

/**
 * The inclusion check. `before` and `after`: { evidence, planning } as parsed JSON of the old and the new request; `kept`: the texts
 * the new request keeps, searched in order (the occurrence message first). Fails (ok false) on a removed fragment found
 * nowhere, unless it is a structural label or the run's own action id, on a removed count or flag, and on an addition that
 * is not a fixed placeholder.
 */
export function inclusionCheck({ before, after, kept, ownActionId, placeholders = [SCHEDULE_TASK_PLACEHOLDER, EARLIER_TASK_PLACEHOLDER] }) {
  const diff = leafDiff(before, after), found = [], exempt = [], missing = [];
  // An excerpt's omission marker is a note, not content: the pieces around it are what the request must still carry.
  const pieces = diff.removed.flatMap(fragment => fragment.text.split(EXCERPT_MARKER).filter(piece => piece.trim()).map(piece => ({ ...fragment, text: piece })));
  for (const fragment of pieces) {
    // A flag or a count is not text anywhere else in the request: only the one flag a duplicate row carries is excused.
    if (fragment.type !== 'string') { (fragment.row && fragment.key === 'blocksExecution' && fragment.text === 'false' ? exempt.push({ ...fragment, why: 'structural flag of a removed row' }) : missing.push(fragment)); continue; }
    if (fragment.row && LABEL_KEYS.has(fragment.key)) { exempt.push({ ...fragment, why: 'structural label of a removed row' }); continue; }
    const where = kept.find(source => source.text.includes(fragment.text));
    if (where) found.push({ ...fragment, in: where.name });
    else if (fragment.text === ownActionId) exempt.push({ ...fragment, why: 'the run\'s own action id (nothing else in the request names it)' });
    else missing.push(fragment);
  }
  const unexpected = diff.added.filter(leaf => !(leaf.type === 'string' && (!leaf.text.trim() || placeholders.includes(leaf.text))));
  return { ok: missing.length === 0 && unexpected.length === 0, removedFragments: pieces.length, found, exempt, missing, unexpectedAdditions: unexpected, added: diff.added };
}

/** The first request's messages with the two context entries replaced, rendered as the wire carries them: text parts and their size. */
function render(messages, replace) {
  const swapped = messages.map(message => ({ ...structuredClone(message), ...(message.context ? { context: message.context.map(item => item.source in replace ? { ...item, text: replace[item.source] } : item) } : {}) }));
  const model = { providerId: 'benchmark', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://benchmark.invalid/v1', contextWindow: 1000000, maxOutputTokens: 131072, reasoning: 'max' };
  const context = prepareContext({ sessionId: 'benchmark', projectId: 'benchmark', systemPrompt: '', tools: [], messages: swapped, model });
  const wire = buildRequest({ model, systemPrompt: '', messages: context.messages, tools: [], cache: {} }).body.messages;
  const texts = wire.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text ?? ''));
  const text = texts.join('');
  return { chars: text.length, tokens: estimateTokens(text), heuristicTokens: context.heuristicTokens };
}

/**
 * Old and new first request of one recorded occurrence, and every check. `base`: { Controller, projectWorkingContext, mindView }
 * of a baseline revision, to prove the old request this revision builds is the one that revision builds.
 */
export function checkOccurrence({ state, journal, base = null }) {
  const recorded = recordedFirstRequest(journal);
  const evidenceRecorded = recorded.context('project-evidence'), planningRecorded = recorded.context('project-planning-state');
  const clock = evidenceRecorded ? JSON.parse(evidenceRecorded).project?.clock?.now : null, at = Number.isFinite(Date.parse(clock)) ? Date.parse(clock) : recorded.startedAt;
  const evidence = evidenceRecorded ? JSON.parse(evidenceRecorded).evidence ?? [] : [];
  const rewound = rewindToRun(state, { projectId: recorded.projectId, actionId: recorded.sessionId, at });
  // The schedule's task as claimed is the occurrence message's own (the live record has been edited since for some runs).
  const own = scheduledRunOwn(rewound.action);
  if (!own) throw new Error(`The action ${recorded.sessionId} is not a scheduled occurrence the host recognizes`);
  if (own.occurrence.content !== recorded.taskText) throw new Error('The occurrence message in the state differs from the one in the journal');
  const schedule = rewound.project.schedules.find(row => row.id === own.scheduleId);
  if (schedule) schedule.task = own.occurrence.task;
  const host = briefHost(ProjectInitiativeController, rewound.state, at, mindBackgroundView);
  const oldBrief = host.workerBrief(rewound.project, { evidence, query: rewound.action.content }), newBrief = host.workerBrief(rewound.project, { evidence, query: rewound.action.content, own });
  const oldPlanning = projectWorkingContext(rewound.project), newPlanning = projectWorkingContext(rewound.project, { omitScheduleTask: { scheduleId: own.scheduleId, task: own.occurrence.task } });
  const oldEvidence = evidenceText(oldBrief, evidence), newEvidence = evidenceText(newBrief, evidence);
  const before = { evidence: JSON.parse(oldEvidence), planning: oldPlanning }, after = { evidence: JSON.parse(newEvidence), planning: newPlanning };
  const kept = [{ name: 'task message', text: recorded.taskText }, ...['evidence', 'planning'].flatMap(name => strings(after[name], name, name).map(leaf => ({ name: leaf.path, text: leaf.text }))),
    ...['project-brief', 'project-memory', 'project-mind', 'host-purpose-instructions', 'host-authorization'].map(source => ({ name: source, text: recorded.context(source) ?? '' }))];
  const inclusion = inclusionCheck({ before, after, kept, ownActionId: own.actionId });
  // An earlier run's receipt shows only its task's beginning and the message's closing text, so its replacement is a statement of
  // those two ends; this counts how many of the replaced ones stood over a task that was word for word today's whole, and how many differed in the middle.
  const replaced = after.evidence.project.continuity.actionReceipts.filter(row => typeof row.intent === 'string' && row.intent.endsWith(EARLIER_TASK_PLACEHOLDER));
  const earlier = { replaced: replaced.length, sameWholeTask: replaced.filter(row => scheduledOccurrence(rewound.project.initiativeRuntime?.sdkState?.actions?.find(action => action.id === row.actionId)?.content)?.task === own.occurrence.task).length };
  // The one identifier nothing else in the request names is the run's own action id: the run must never have written it (or its start).
  const ownIdWritten = [own.actionId, own.actionId.replace(/^schedule-work-/, '').slice(0, 12)].some(id => recorded.modelOutput.includes(id));
  // The same state, the old request built by the baseline revision.
  let baseline = null;
  if (base) {
    const baseHost = briefHost(base.Controller, rewound.state, at, base.mindView);
    const baseBrief = baseHost.workerBrief(rewound.project, { evidence, query: rewound.action.content });
    baseline = { briefEqual: isDeepStrictEqual(JSON.parse(JSON.stringify(baseBrief)), JSON.parse(JSON.stringify(oldBrief))), planningEqual: isDeepStrictEqual(JSON.parse(JSON.stringify(base.projectWorkingContext(rewound.project))), JSON.parse(JSON.stringify(oldPlanning))) };
  }
  // Fidelity of the rebuilt old request to the recorded one, where the journal has the brief's form (a pre-0.68 run recorded the decision snapshot).
  const recordedEvidenceDoc = evidenceRecorded ? JSON.parse(evidenceRecorded) : null, sameForm = Boolean(recordedEvidenceDoc?.project?.continuity && !recordedEvidenceDoc.project.actionContracts);
  const fidelity = {
    form: sameForm ? 'worker brief' : 'decision snapshot (recorded before 0.68: not comparable)',
    evidenceEqual: sameForm ? isDeepStrictEqual(recordedEvidenceDoc, before.evidence) : null,
    receiptsEqual: sameForm ? isDeepStrictEqual(recordedEvidenceDoc.project.continuity.actionReceipts, before.evidence.project.continuity.actionReceipts) : null,
    pendingJobsEqual: sameForm ? isDeepStrictEqual(recordedEvidenceDoc.project.pendingJobs, before.evidence.project.pendingJobs) : null,
    planningEqual: planningRecorded ? isDeepStrictEqual(JSON.parse(planningRecorded), JSON.parse(planningText(oldPlanning))) : null,
    ...(planningRecorded && !isDeepStrictEqual(JSON.parse(planningRecorded), JSON.parse(planningText(oldPlanning))) ? { planningDiffers: differingPaths(JSON.parse(planningRecorded), JSON.parse(planningText(oldPlanning))) } : {}),
  };
  const wireOf = (evidenceValue, planningValue) => render(recorded.messages, { 'project-evidence': evidenceValue, 'project-planning-state': planningValue });
  const recordedWire = evidenceRecorded && planningRecorded ? wireOf(evidenceRecorded, planningRecorded) : null, oldWire = wireOf(oldEvidence, planningText(oldPlanning)), newWire = wireOf(newEvidence, planningText(newPlanning));
  const removedChars = inclusion.found.reduce((sum, row) => sum + row.text.length, 0) + inclusion.exempt.reduce((sum, row) => sum + row.text.length, 0);
  return {
    occurrence: own.occurrence.header.split('\n')[0].replace('Scheduled occurrence ', ''), actionId: own.actionId,
    ok: inclusion.ok && !ownIdWritten && (!baseline || baseline.briefEqual && baseline.planningEqual),
    ownIdWrittenByModel: ownIdWritten, modelOutputChars: recorded.modelOutput.length,
    inclusion: { ok: inclusion.ok, removedFragments: inclusion.removedFragments, foundWordForWord: inclusion.found.length, inTaskMessage: inclusion.found.filter(row => row.in === 'task message').length, exempt: inclusion.exempt.map(row => ({ path: row.path.replace(/\[[^\]]{20,}\]/g, '[<id>]'), text: row.text.length > 80 ? `${row.text.slice(0, 77)}...` : row.text, why: row.why })), missing: inclusion.missing.map(row => ({ path: row.path, text: row.text.slice(0, 120) })), unexpectedAdditions: inclusion.unexpectedAdditions.map(row => ({ path: row.path, text: row.text.slice(0, 120) })), additions: inclusion.added.map(row => ({ path: row.path, text: row.text })) },
    removed: inclusion.found.map(row => ({ path: row.path.replace(/\[[^\]]{20,}\]/g, '[<id>]'), chars: row.text.length, in: row.in })),
    removedChars, earlier, baseline, fidelity,
    first: { recordedChars: recordedWire?.chars ?? null, oldChars: oldWire.chars, newChars: newWire.chars, charsRemoved: oldWire.chars - newWire.chars,
      oldTokens: oldWire.tokens, newTokens: newWire.tokens, tokensRemoved: oldWire.tokens - newWire.tokens, heuristicTokensRemoved: oldWire.heuristicTokens - newWire.heuristicTokens,
      recordedMessageTokens: recordedWire?.tokens ?? null, providerPromptTokens: recorded.providerPromptTokens, providerMessageTokens: recorded.providerPromptTokens ? recorded.providerPromptTokens - SHARED_PREFIX_TOKENS : null },
  };
}

async function main(argv) {
  const baseAt = argv.indexOf('--base'), baseRoot = baseAt >= 0 ? argv[baseAt + 1] : null, args = argv.filter((_, index) => index !== baseAt && index !== baseAt + 1 || baseAt < 0);
  const [statePath, ...journals] = args;
  if (!statePath || !journals.length) { console.error('Usage: brief-inclusion.mjs <state.json copy> <journal.jsonl>… [--base <code root>]'); return 2; }
  const { state } = readStateFile(statePath);
  let base = null;
  if (baseRoot) {
    const controller = await import(`${baseRoot}/prototypes/control-center/project-initiative-controller.mjs`), context = await import(`${baseRoot}/packages/sdk/src/project-context.mjs`), mind = await import(`${baseRoot}/prototypes/control-center/project-mind.mjs`);
    base = { Controller: controller.ProjectInitiativeController, projectWorkingContext: context.projectWorkingContext, mindView: mind.mindBackgroundView };
  }
  let failed = false; const results = [];
  for (const path of journals) {
    try { const result = checkOccurrence({ state, journal: readFileSync(path, 'utf8'), base }); results.push({ journal: path, ...result }); failed ||= !result.ok; }
    catch (error) { results.push({ journal: path, ok: false, error: error.message }); failed = true; }
  }
  console.log(JSON.stringify(results, null, 2));
  return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
