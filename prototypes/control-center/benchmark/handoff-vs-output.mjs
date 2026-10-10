#!/usr/bin/env node
// Equivalence checks for the W1 information corrections (token-burn study 2026-10-05, design2.md §6.4, §6.5, §7 W1), read
// only, no network, no model, no JEV. Run on a COPY of the saved state (never production state while the daemon runs):
//
//   node benchmark/handoff-vs-output.mjs <state.json copy | projects.json copy> [--project <id prefix>] [--baseline <code root>] [--rows] [--json]
//
// The state is either an Rna state file (sharded or plain) or a JSON array of project records (the shape of a state's
// `projects`). `--baseline` is a checkout of the revision before W1 (e.g. `git archive <rev> prototypes/control-center
// packages/sdk | tar -x -C dir`).
//
//  A. The channel (§6.4): does the next decision read the worker's final reply, not only its handoff line? For every
//     completed job a later decision cites (`action:<id>:completed` in its evidence), the identifiers (URLs, English words of
//     7+ characters, 4-character Chinese runs) that are in the job's final reply but in neither its handoff line nor its
//     instruction, counted among those the decision's reason/content use again. A job with 3 or more of them was read past
//     its handoff line. Only a proxy (the same text may reach a decision by another path), so it can only refute "the reply
//     is not read": 0 reused features would not prove it unread, 3 or more prove the channel exists.
//  B. The deadline wording (§6.5): the recorded handoff and output of every `action_timeout` job, and what they now say. The
//     new text is computed by the code that writes it (work-run-text.mjs deadlineText); status and error code are not
//     inputs, so they are what the row says. Jobs stopped with a tool call unfinished (`uncertain_tool`) at exactly a whole
//     number of minutes are listed as probable deadline stops: their rows do not record the cause, so nothing is recomputed.
//  C. The requests (--baseline, or the current code alone): the decision snapshot of every project is byte-identical with and
//     without W1, rendered with the project's isolation answer both false and true (production has it true wherever worktrees
//     are on); a worker's brief is byte-identical too unless the run is in its own worktree, where it differs by exactly one
//     added key, `work.workspace` (the copy note), and nothing is removed.
//  D. The worker's prompt: the false sentence is gone and the handoff line is still the one the next decision reads.
// A check is true, false, or null when nothing was compared (no action_timeout job in the selection, no --baseline, no
// project with initiative state): null is not a pass, so `checks.ok` is true only when every check ran and held.
// Exit code 1 when a check fails, 3 when none failed but some were not compared, 0 when every check held.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { oneLine } from '../../../packages/sdk/src/proactive-message.mjs';
import { deadlineText, WORKER_COPY_NOTE, WORKER_REPLY_NOTE } from '../work-run-text.mjs';

const here = dirname(fileURLToPath(import.meta.url)), codeRoot = resolve(here, '../../..');

/** What the old texts said and the new ones must not: the deadline recorded as a context change or a stop instruction. */
export const FALSE_DEADLINE_REASON = /项目上下文变化或收到停止指令|收到新的项目上下文或暂停指令/;
/** A job id the host gives a scheduled occurrence (`schedule-work-…`); every other id is a decision-started run. */
export const scheduledJob = job => String(job?.id ?? '').startsWith('schedule-');

/** The identifiers of a text: URLs, English words of 7+ characters (lower-cased), and every 4-character run of Chinese. */
export function features(text) {
  const value = String(text ?? ''), found = new Set(value.match(/https?:\/\/[^\s)）」"']+/g) ?? []);
  for (const word of value.match(/[A-Za-z][A-Za-z0-9_.\-]{6,}/g) ?? []) found.add(word.toLowerCase());
  for (const run of value.match(/[一-鿿]+/g) ?? []) for (let index = 0; index + 4 <= run.length; index++) found.add(run.slice(index, index + 4));
  return found;
}
const minus = (a, b) => [...a].filter(item => !b.has(item));

/** A. One row per completed job (with output) that a later decision cites. */
export function reuseRows(projects, { prefix = '' } = {}) {
  const rows = [];
  for (const project of projects.filter(row => String(row.id).startsWith(prefix))) {
    const decisions = [...(project.decisions ?? [])].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    for (const job of project.jobs ?? []) {
      if (job.status !== 'completed' || !job.output) continue;
      const key = `action:${job.id}:completed`, next = decisions.find(decision => (decision.evidenceIds ?? []).includes(key) || (decision.sourceIds ?? []).includes(key));
      if (!next) continue;
      const handoff = job.handoff ?? '', instruction = features(job.instruction ?? ''), handoffOwn = new Set(minus(features(handoff), instruction));
      const onlyOutput = minus(minus(features(job.output), features(handoff)), instruction), read = `${next.reason ?? ''} ${next.content ?? ''}`;
      const reused = onlyOutput.filter(feature => read.includes(feature));
      rows.push({ project: String(project.id).slice(0, 8), created: String(job.createdAt ?? '').slice(0, 16), job: String(job.id).slice(0, 8), kind: scheduledJob(job) ? 'scheduled' : 'decision', next: next.action, outputChars: job.output.length, handoffChars: handoff.length,
        onlyOutput: onlyOutput.length, reused: reused.length, handoffFeatures: handoffOwn.size, handoffReused: [...handoffOwn].filter(feature => read.includes(feature)).length, examples: reused.slice(0, 6) });
    }
  }
  return rows;
}
/** The §6.4 figures: all rows, and the ones from after jobs carried a handoff line (decision-started, scheduled). */
export function reuseSummary(rows) {
  const read = list => list.filter(row => row.reused >= 3).length, withHandoff = rows.filter(row => row.handoffChars > 0);
  const decision = withHandoff.filter(row => row.kind === 'decision'), scheduled = withHandoff.filter(row => row.kind === 'scheduled');
  return { jobsCited: rows.length, readPastHandoff3: read(rows), readPastHandoff1: rows.filter(row => row.reused >= 1).length,
    decisionStartedWithHandoff: { jobs: decision.length, readPastHandoff3: read(decision), ids: decision.filter(row => row.reused >= 3).map(row => `${row.job}(${row.reused})`) },
    scheduledWithHandoff: { jobs: scheduled.length, readPastHandoff3: read(scheduled) } };
}

/** B. The `action_timeout` jobs: what they recorded, and what the same stop records now (both interface languages). */
export function deadlineRows(projects, { prefix = '' } = {}) {
  const rows = [], probable = [];
  for (const project of projects.filter(row => String(row.id).startsWith(prefix))) for (const job of project.jobs ?? []) {
    const ran = Date.parse(job.completedAt) - Date.parse(job.createdAt), whole = Number.isFinite(ran) && ran >= 60000 && Math.abs(ran - Math.round(ran / 60000) * 60000) <= 10000;
    if (job.errorCode === 'uncertain_tool' && whole) { probable.push({ project: String(project.id).slice(0, 8), job: String(job.id).slice(0, 8), status: job.status, errorCode: job.errorCode, ranMinutes: Math.round(ran / 60000) }); continue; }
    if (job.errorCode !== 'action_timeout') continue;
    const deadlineMs = whole ? Math.round(ran / 60000) * 60000 : 1800000, task = oneLine(job.instruction ?? '', 120), minutes = deadlineMs / 60000;
    const before = { handoff: job.handoff ?? '', output: job.output ?? '' }, zh = deadlineText({ task, deadlineMs, language: 'zh', code: job.errorCode }), en = deadlineText({ task, deadlineMs, language: 'en', code: job.errorCode });
    rows.push({ project: String(project.id).slice(0, 8), job: String(job.id).slice(0, 8), status: job.status, errorCode: job.errorCode, ranMinutes: Number.isFinite(ran) ? +(ran / 60000).toFixed(2) : null,
      before: { ...before, sayContextChange: FALSE_DEADLINE_REASON.test(`${before.handoff}\n${before.output}`) },
      after: { zh, en, nameLimit: zh.handoff.includes(`${minutes} 分钟`) && en.handoff.includes(`${minutes}-minute`), sayContextChange: FALSE_DEADLINE_REASON.test(`${zh.handoff}\n${zh.output}\n${en.handoff}\n${en.output}`), oneLine: [zh, en].every(row => row.handoff.length <= 400 && !/\n/.test(row.handoff)), keys: Object.keys(zh).sort().join() } });
  }
  return { rows, probable };
}

/**
 * The checks of a run. Each is true or false, or null when the selection had nothing to compare it on (an empty list of rows,
 * no baseline checkout): a comparison that compared nothing is not a pass. `ok`: every check is true. `notCompared` names the null ones.
 */
export function benchmarkChecks({ rows = [], deadline = { rows: [] }, requests = [], prompt = {} }) {
  const verdict = (list, test) => list.length ? list.every(test) : null;
  const decisionRows = rows.filter(row => row.kind === 'decision'), compared = requests.filter(row => row.decisionIdentical !== null && row.decisionIdentical !== undefined);
  const checks = {
    channelExists: decisionRows.length ? decisionRows.some(row => row.reused >= 3) : null,
    deadlineRowsFixed: verdict(deadline.rows, row => row.before.sayContextChange && row.after.nameLimit && !row.after.sayContextChange && row.after.oneLine && row.after.keys === 'handoff,output'),
    decisionsCarryNoNote: verdict(requests, row => !row.decisionHasNote && !row.decisionIsolatedHasNote),
    decisionsUnchanged: verdict(compared, row => row.decisionIdentical === true && row.decisionIsolatedIdentical === true),
    plainBriefsCarryNoNote: verdict(requests, row => !row.plainBriefHasNote),
    plainBriefsUnchanged: verdict(compared, row => row.plainBriefIdentical === true),
    isolatedBriefOnlyGains: verdict(requests, row => row.isolatedAddsOnlyTheNote && row.volatileIdentical),
    isolatedBriefMatchesBaseline: verdict(compared, row => row.isolatedMatchesBaseline === true),
    promptSentenceReplaced: Boolean(prompt.sentenceReplaced && prompt.handoffContractKept && prompt.noteNamesHandoffLine && prompt.baselineHadSentence !== false),
  };
  const values = Object.values(checks);
  return { ...checks, ok: values.every(value => value === true), failed: Object.keys(checks).filter(name => checks[name] === false), notCompared: Object.keys(checks).filter(name => checks[name] === null) };
}

/** Loads the projects (and a state around them) from an Rna state file or a JSON array of projects. */
export async function loadProjects(file) {
  const text = readFileSync(file, 'utf8');
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not plain JSON */ }
  if (Array.isArray(parsed)) return { projects: parsed, state: { projects: parsed, sessions: [], settings: {}, configuration: { providers: [] } } };
  if (parsed && Array.isArray(parsed.projects)) return { projects: parsed.projects, state: parsed };
  const { readStateFile } = await import('../state-shards.mjs'), read = readStateFile(file);
  if (!read?.state?.projects) throw new Error(`${file} holds no projects`);
  return { projects: read.state.projects, state: read.state };
}

/** A controller over a state, without a store behind it: what snapshot() and workerBrief() read. */
async function controllerOf(root, state, now) {
  const cc = `${root}/prototypes/control-center`;
  const { ProjectInitiativeController } = await import(pathToFileURL(`${cc}/project-initiative-controller.mjs`).href);
  const { ProjectScheduleService } = await import(pathToFileURL(`${cc}/project-schedule-service.mjs`).href);
  const { mindBackgroundView } = await import(pathToFileURL(`${cc}/project-mind.mjs`).href);
  const mind = { backgroundContext: (projectId, { query = '' } = {}) => { const view = mindBackgroundView(state.projects.find(row => row.id === projectId), { now, query }); return view ? JSON.stringify(view) : null; } };
  const store = { state, file: null, usageLedger: null, configurationService: { secrets: {}, secretValues: () => [] }, presences: new Map(), mind };
  const controller = Object.create(ProjectInitiativeController.prototype);
  Object.assign(controller, { store, now: () => now, independentLearning: true, interactions: {}, decisions: { enabled: () => true }, scheduleService: new ProjectScheduleService(store, { now: () => now }), evolutionService: { running: new Map() }, background: { ready: () => false } });
  return controller;
}
const bytes = text => Buffer.byteLength(text, 'utf8');
/**
 * What a controller renders for a project: the decision snapshot with the project's isolation answer false and true (a
 * decision is made either way: production has the answer true wherever worktrees are on), and the worker brief for a run in
 * the project folder (answer false, `copy` false) and for a run in its own worktree (answer true, `copy` true).
 */
export function renders(controller, project) {
  const under = (isolated, render) => { controller.isolatedProject = () => isolated; try { return render(isolated); } finally { delete controller.isolatedProject; } };
  const decision = isolated => under(isolated, () => JSON.stringify(controller.snapshot(project, null, null)));
  const brief = isolated => under(isolated, copy => { const value = controller.workerBrief(project, { evidence: [], query: '', copy }); return { stable: JSON.stringify(value.stable), volatile: JSON.stringify(value.volatile), parsed: value.stable }; });
  return { decision: decision(false), decisionIsolated: decision(true), plain: brief(false), isolated: brief(true) };
}

/** C. Decision snapshots and worker briefs, now (and before W1 when a baseline checkout is given). */
export async function requestRows(projects, state, { prefix = '', baseline = null, now = Date.parse('2026-10-05T14:00:00Z') } = {}) {
  const current = await controllerOf(codeRoot, structuredClone(state), now), old = baseline ? await controllerOf(resolve(baseline), structuredClone(state), now) : null;
  const rows = [];
  for (const project of projects.filter(row => String(row.id).startsWith(prefix) && !row.archivedAt && row.initiativeRuntime?.sdkState)) {
    const after = renders(current, structuredClone(project)), before = old ? renders(old, structuredClone(project)) : null;
    // The isolated brief with its one added key taken out is the plain brief: nothing else moved, nothing was removed.
    const { workspace, ...workWithout } = after.isolated.parsed.work, withoutNote = JSON.stringify({ ...after.isolated.parsed, work: workWithout });
    rows.push({ project: String(project.id).slice(0, 8), name: project.name,
      decisionBytes: bytes(after.decision), decisionHasNote: after.decision.includes(WORKER_COPY_NOTE), decisionIdentical: before ? before.decision === after.decision : null,
      decisionIsolatedBytes: bytes(after.decisionIsolated), decisionIsolatedHasNote: after.decisionIsolated.includes(WORKER_COPY_NOTE), decisionIsolatedIdentical: before ? before.decisionIsolated === after.decisionIsolated : null,
      briefBytes: bytes(after.plain.stable), plainBriefIdentical: before ? before.plain.stable === after.plain.stable && before.plain.volatile === after.plain.volatile : null, plainBriefHasNote: after.plain.stable.includes(WORKER_COPY_NOTE),
      isolatedAddsOnlyTheNote: workspace === WORKER_COPY_NOTE && withoutNote === after.plain.stable, isolatedBriefBytes: bytes(after.isolated.stable), addedBytes: bytes(after.isolated.stable) - bytes(after.plain.stable), volatileIdentical: after.plain.volatile === after.isolated.volatile,
      isolatedMatchesBaseline: before ? withoutNote === before.isolated.stable : null });
  }
  return rows;
}

/** D. The worker's prompt in the controller's source (and the baseline's), as text: the sentence replaced, the handoff contract kept. */
export function promptRows(baseline = null) {
  // The prompt is in the controller's source in a baseline checkout and in work-run-text.mjs since the model-text unification: read both.
  const read = root => { const files = ['project-initiative-controller.mjs', 'work-run-text.mjs'].map(name => `${root}/prototypes/control-center/${name}`).filter(file => existsSync(file)); return files.length ? files.map(file => readFileSync(file, 'utf8')).join('\n') : null; };
  const now = read(codeRoot), before = baseline ? read(resolve(baseline)) : null;
  const old = '下次唤醒只读这一行，不读过程。';
  return { sentenceReplaced: !now.includes(old) && now.includes('${WORKER_REPLY_NOTE}'), baselineHadSentence: before === null ? null : before.includes(old),
    handoffContractKept: ['The last line must be a one-sentence handoff that starts with "HANDOFF:"', 'The handoff line is shown to the user too'].every(text => now.includes(text)), noteNamesHandoffLine: /and that handoff line/.test(WORKER_REPLY_NOTE), noteChars: WORKER_REPLY_NOTE.length };
}

async function main(argv) {
  const flags = new Set(argv.filter(arg => ['--rows', '--json'].includes(arg))), option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; };
  const file = argv.find((arg, index) => !arg.startsWith('--') && !['--project', '--baseline'].includes(argv[index - 1]));
  if (!file) { console.error('Usage: handoff-vs-output.mjs <state.json | projects.json copy> [--project <id prefix>] [--baseline <code root>] [--rows] [--json]'); return 2; }
  const prefix = option('--project') ?? '', baseline = option('--baseline');
  const { projects, state } = await loadProjects(file);
  const rows = reuseRows(projects, { prefix }), summary = reuseSummary(rows), deadline = deadlineRows(projects, { prefix }), requests = await requestRows(projects, state, { prefix, baseline }), prompt = promptRows(baseline);
  const checks = benchmarkChecks({ rows, deadline, requests, prompt });
  const report = { file, prefix: prefix || null, baseline: baseline ?? null, channel: summary, deadline, requests, prompt, checks };
  if (flags.has('--json')) console.log(JSON.stringify({ ...report, ...(flags.has('--rows') ? { rows } : {}) }, null, 2));
  else {
    if (flags.has('--rows')) { console.log('project  created          job      kind       next   |out| |ho|  outOnly reused  hoFeat hoReused'); for (const row of rows) console.log([row.project, row.created, row.job, row.kind.padEnd(9), String(row.next).padEnd(6), row.outputChars, row.handoffChars, row.onlyOutput, row.reused, row.handoffFeatures, row.handoffReused, JSON.stringify(row.examples)].join(' ')); }
    console.log(`A. channel: ${summary.jobsCited} jobs cited by a later decision; ${summary.readPastHandoff3} of them reused 3 or more features found only in the final reply (${summary.readPastHandoff1} reused 1 or more)`);
    console.log(`   decision-started jobs with a handoff line: ${summary.decisionStartedWithHandoff.readPastHandoff3} of ${summary.decisionStartedWithHandoff.jobs} read past it (${summary.decisionStartedWithHandoff.ids.join(', ')}); scheduled: ${summary.scheduledWithHandoff.readPastHandoff3} of ${summary.scheduledWithHandoff.jobs}`);
    console.log(`B. deadline wording: ${deadline.rows.length} action_timeout jobs; ${deadline.probable.length} probable deadline stops with a tool unfinished (cause not recorded: ${deadline.probable.map(row => `${row.job} ${row.ranMinutes} min`).join(', ') || 'none'})`);
    for (const row of deadline.rows) console.log(`   ${row.job} ${row.status}/${row.errorCode} ran ${row.ranMinutes} min\n     before: ${oneLine(row.before.handoff.slice(-70))} | ${row.before.output}\n     after zh: ${row.after.zh.handoff} | ${row.after.zh.output}\n     after en: ${row.after.en.handoff}`);
    console.log(`C. requests (${baseline ? `against ${baseline}` : 'current code only'}): ${requests.length} projects; decision snapshots identical ${requests.map(row => row.decisionIdentical === null ? 'n/a' : row.decisionIdentical).join('/')} (isolation answer true: ${requests.map(row => row.decisionIsolatedIdentical === null ? 'n/a' : row.decisionIsolatedIdentical).join('/')}); worker briefs (not isolated) identical ${requests.map(row => row.plainBriefIdentical === null ? 'n/a' : row.plainBriefIdentical).join('/')}; in a worktree +${requests.map(row => row.addedBytes).join('/')} bytes (the one key)`);
    console.log(`D. prompt: sentence replaced ${prompt.sentenceReplaced}, handoff contract kept ${prompt.handoffContractKept}, note ${prompt.noteChars} characters`);
    console.log(`checks: ${JSON.stringify(checks)}`);
    if (checks.notCompared.length) console.log(`not compared (null, not a pass): ${checks.notCompared.join(', ')}`);
  }
  return checks.failed.length ? 1 : checks.ok ? 0 : 3;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
