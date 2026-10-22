import { workChangeOutcome } from './project-mind.mjs';
import { outcomeFacts, actionOutcome } from './work-outcome.mjs';
import { CALIBRATION_WINDOWS } from './decision-calibration-report.mjs';
import { wakeRowKey } from './wake-log.mjs';
import { countBucket } from '../../packages/sdk/src/decision-state.mjs';
import { WORK_COMPLETION_QUESTIONS } from '../../packages/sdk/src/decision-templates.mjs';

/**
 * The option-B completion gate (plan 2026-10-05 §1.3 E, §2.2 D2; K3 leftover option B). Today every finished background run
 * makes the host send the next review straight to the main model (`bypass_delivery_just_completed`: a paid decision of
 * roughly 20-50K tokens, whether or not the run left anything to decide). mu routes a finished job as now | next_turn | drop
 * (notify-routing.ts:33-60), unjudged defaults to next_turn, and background.ts:108-121 does not wake an idle session.
 *
 * What the host does here is SHADOW ONLY: it works out the route each completion would take, records it in the decision
 * ledger (point `work.completion`) beside the review it still makes, and compares it with what that review came to
 * (`completionReport`, from C2's work-outcome view). Nothing here changes a review; no verdict is acted on.
 *
 * The route is settled in this order, code facts first (mu: facts outrank the closing message; goal-met.ts:7-17):
 *   needs_review       the run did not end cleanly (its job needs a check): review, as today;
 *   unreported         the run ended without a report (its last step was an unsent tool call): review, as today;
 *   schedule_occurrence a scheduled occurrence: no review, the host delivers it itself;
 *   resolves_pending   the run says it fulfils a request or an open item (`resolves`): the user is owed an answer, review;
 *   no_handoff         the worker left no handoff: there is nothing to judge, review;
 *   judge              everything else: the completion template (reports_untold, names_next_step, evidence_relevant),
 *                      combined by combineWorkCompletion; the fallback is `review`, exactly today's behaviour.
 * It never asks whether the work is done or right.
 */
export const COMPLETION_POINT = 'work.completion';
/** The code-fact classes of a completion, in the order they are tried. */
export const COMPLETION_CLASSES = Object.freeze(['needs_review', 'unreported', 'schedule_occurrence', 'resolves_pending', 'no_handoff', 'judge']);
/** The route a code fact settles without the judge: only a scheduled occurrence is not reviewed. */
const FACT_ROUTE = Object.freeze({ needs_review: 'review', unreported: 'review', schedule_occurrence: 'defer', resolves_pending: 'review', no_handoff: 'review' });
const retained = row => Boolean(row) && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const ms = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : null; };

/**
 * The completed work actions no decision has reviewed yet: the SDK's `action_completed` observation (`action:<id>:completed`)
 * newer than the last decision (DecisionService.projection's deliveryJustCompleted is true exactly when this is not empty).
 */
export function unreviewedCompletions(evidence = [], actions = [], decidedAt) {
  const byId = new Map(actions.filter(row => row?.id && row.action === 'work').map(row => [`action:${row.id}:completed`, row]));
  const seen = new Set(), out = [];
  for (const row of evidence) {
    if (row?.type !== 'action_completed' || (Number.isFinite(decidedAt) && Number.isFinite(row.at) && row.at <= decidedAt)) continue;
    const action = byId.get(row.id);
    if (action && !seen.has(action.id)) { seen.add(action.id); out.push(action); }
  }
  return out;
}

/**
 * What the host knows about one finished work action by code: its class, the route a code fact settles (`null` for
 * `judge`), the handoff the judge would read and two facts recorded for the report (how many files its change set holds,
 * and whether the change set is applied, waiting, undone or absent). Records and fields only: no text is interpreted.
 */
export function completionFacts(project, action) {
  const job = (project?.jobs ?? []).find(row => row?.id === action?.id && row.lane === 'background') ?? null;
  const handoff = String(action?.handoff ?? job?.handoff ?? '').trim();
  const change = workChangeOutcome(project, action?.id), files = Array.isArray(change.change?.files) ? change.change.files.length : 0;
  const clean = action?.status === 'completed' && (!job || job.status === 'completed');
  const resolves = Array.isArray(action?.resolves) ? action.resolves.filter(id => typeof id === 'string' && id) : [];
  const kind = !clean ? 'needs_review' : job?.unreported === true ? 'unreported' : action?.hostSchedule ? 'schedule_occurrence' : resolves.length ? 'resolves_pending' : !handoff ? 'no_handoff' : 'judge';
  // What the run declared about its own follow-up (declared-follow-up.mjs), for the report: a run that declared is settled by the host, not reviewed.
  const declared = ['none', 'task'].includes(job?.followUp?.kind) ? job.followUp.kind : null;
  return { class: kind, route: FACT_ROUTE[kind] ?? null, handoff, changed: countBucket(files), change: change.status, resolves: resolves.length, declared };
}

// ------------------------------------------------------------------ the comparison
/**
 * What the review that followed a completion came to, from the records of C2's work-outcome view (never from what the
 * model chose): the run itself and the actions that review admitted (reviewFollowUps).
 *  - productive    something reached the user because of it (a message that cites the run was delivered), or an action its
 *                  review admitted became visible (a change kept, a message that reached the user, a schedule made);
 *  - unproductive  the review admitted actions and none became visible (none, undone, failed);
 *  - pending       an action it led to is not settled (queued, running, held for the user's return, waiting for an apply);
 *  - waited        a review was made and admitted nothing: the main model's own choice, provisional (PDL-7: a label that comes
 *                  from the model's own next step is not an outcome, so it is kept apart and never counted as calibration);
 *  - unreviewed    no decision has followed the completion yet.
 * A follow-up the user cancelled, a restart or a scope change cut (`neutral`) says nothing and is left out.
 */
export function completionLabel({ run = null, followUps = [], reviewed = false, told = finite(run?.stages?.delivered) } = {}) {
  const follow = followUps.filter(row => row.neutral !== true);
  const visible = follow.some(row => row.outcome === 'visible'), pending = follow.some(row => row.outcome === 'pending');
  const label = told || visible ? 'productive' : pending ? 'pending' : !reviewed && !followUps.length ? 'unreviewed' : follow.length ? 'unproductive' : 'waited';
  return { label, told, followedWork: follow.some(row => row.kind === 'work'), followedVisible: visible };
}

/** When a wake row's decision started: its row time is the end of the decision, the latency how long it took. */
const wakeStart = row => (ms(row?.at) ?? NaN) - (finite(row?.latencyMs) ? row.latencyMs : 0);
/**
 * The wake rows that reached a decision of the main model after a completion, oldest first, up to `limit` (not a gate
 * deferral, a wake superseded by new evidence, or a review that failed: none of them read it). The first is the decision a
 * completion woke; the second is the next review that could have read anything else about it.
 */
export function wakesAfter(rows = [], finishedAt, limit = Infinity) {
  const out = [];
  if (!finite(finishedAt)) return out;
  for (const row of rows) {
    if (ms(row?.at) === null || ['deferred', 'interrupted', 'failed'].includes(row.outcome) || wakeStart(row) < finishedAt) continue;
    out.push(row); if (out.length >= limit) break;
  }
  return out;
}
/** The first decision a completion woke: a wake row that started after the run ended and reached a decision of the main model. */
export const wakeAfter = (rows = [], finishedAt) => wakesAfter(rows, finishedAt, 1)[0] ?? null;

/**
 * Whether the review a completion woke is what told the user about the run. C2's view counts a delivery that merely cites the
 * run (`run.via: 'cited'`) as the run's own `delivered` stage, and the main model cites the newest events whatever they are:
 * four hours after a review that waited, a different review shares a message citing this run and the one before it, and the
 * wait would read as productive. With a wake row to read (`wake`), a citing message counts only when that review's own
 * action delivered it, or it reached the user before the next review started (`next`). The run's own delivery (an inbox
 * entry, a digest, a welcome-back) is the run's whatever the review did. Without a wake row nothing can say which review a
 * message came from, and every delivery counts (`attribution: 'citation'`).
 */
export function toldByReview(project, runId, { run = null, wake = null, next = null, facts = null, now = Date.now() } = {}) {
  if (!finite(run?.stages?.delivered)) return false;
  if (!wake || run.via !== 'cited') return true;
  const until = next ? wakeStart(next) : Infinity;
  return (facts?.cites?.get(runId) ?? []).some(citing => citing === wake.actionId || (at => finite(at) && at < until)(actionOutcome(project, citing, now, { facts })?.stages?.delivered));
}

/**
 * Whether any decision has followed a completion: a wake row (when the wake log holds them), else the project's last decision
 * (the SDK keeps only that one), else an action created after it ended (the SDK's action list is chronological).
 */
export function reviewedAfter(project, finishedAt, wakeRows = []) {
  if (!finite(finishedAt)) return false;
  if (wakeAfter(wakeRows, finishedAt)) return true;
  const sdk = project?.initiativeRuntime?.sdkState;
  return Number.isFinite(sdk?.lastDecision?.at) && sdk.lastDecision.at > finishedAt || (sdk?.actions ?? []).some(row => !row.hostSchedule && finite(row.createdAt) && row.createdAt > finishedAt);
}

/** The actions that cite a completion among their evidence: what the review it woke did with it. */
export function followUpsOf(project, runId, facts, now) {
  const evidence = `action:${runId}:completed`;
  return (project?.initiativeRuntime?.sdkState?.actions ?? []).filter(row => row && row.id !== runId && !row.hostSchedule && retained(row) && (row.evidenceIds ?? []).includes(evidence)).map(row => {
    const record = actionOutcome(project, row.id, now, { facts });
    return { id: row.id, kind: row.action, outcome: record?.outcome ?? 'pending', ...(record?.neutral ? { neutral: true } : {}), ...(record?.reason ? { reason: record.reason } : {}) };
  });
}

/**
 * The actions the review a completion woke admitted: that decision's own (`wake.actionId`, C2 records it on the wake row),
 * never a later decision that happens to cite the run: the main model cites the newest events whatever they are, so a
 * chain of work cites each run in turn and "the actions that cite it" over-reads what the review of THIS run did. A wake
 * that admitted nothing (a wait) has no follow-up. Only when no wake row can say (the wake log holds none for that time: a
 * row written before 0.69 has no `actionId`) are the actions that cite the completion read instead (`attribution: 'citation'`).
 */
export function reviewFollowUps(project, runId, { wake = null, facts, now = Date.now() } = {}) {
  if (wake && typeof wake.actionId === 'string' && wake.actionId) {
    const record = actionOutcome(project, wake.actionId, now, { facts });
    return { attribution: 'wake', followUps: [{ id: wake.actionId, kind: record?.kind ?? 'work', outcome: record?.outcome ?? 'pending', ...(record?.neutral ? { neutral: true } : {}), ...(record?.reason ? { reason: record.reason } : {}) }] };
  }
  if (wake && wake.outcome !== 'work') return { attribution: 'wake', followUps: [] };
  return { attribution: 'citation', followUps: followUpsOf(project, runId, facts, now) };
}

const share = (part, whole) => whole ? Math.round(part / whole * 1000) / 1000 : null;
const round = value => Math.round(value * 1000) / 1000;
const mean = values => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const distribution = values => ({ n: values.length, mean: mean(values), min: values.length ? round(Math.min(...values)) : null, max: values.length ? round(Math.max(...values)) : null });
export const COMPLETION_LABELS = Object.freeze(['productive', 'unproductive', 'waited', 'pending', 'unreviewed']);
const emptyLabels = () => Object.fromEntries(COMPLETION_LABELS.map(label => [label, 0]));
/** The completions a verdict was made for: a code fact or the judge (a budget skip or an unavailable judge is no verdict). */
const VERDICT_BASIS = new Set(['code_fact', 'judge']);
/** What the records say about each question, and the names the report gives the two groups of probabilities: the question's probability where the thing happened (yes) against where it did not (no). */
const QUESTION_TRUTH = Object.freeze({
  reports_untold: { yes: 'told', no: 'notTold', of: result => result.told },
  names_next_step: { yes: 'followedWork', no: 'noFollowUp', of: result => result.followedWork },
  evidence_relevant: { yes: 'productive', no: 'notProductive', of: result => result.label === 'productive' },
});

/**
 * `real` values (the real routing a row sits beside, `bypassSignal` or `judged`) for which THIS completion decided whether the
 * main model reviewed: its own bypass signal, or the gate's judgment during a foreground turn. Any other (a due schedule, a
 * result waiting for a check, a question waiting for an answer, a failure) forced the review anyway, so a skip would have
 * saved nothing: those rows are listed apart (`forced`) and never counted in the savings. A row without `real` is counted.
 */
const DECIDED_BY_COMPLETION = new Set(['delivery_just_completed', 'judged']);

/**
 * GET /api/v2/decision-kernel/completion: the shadow verdicts of the window against what the reviews came to.
 * `rows`: the ledger rows of point `work.completion` the caller selected (archived view, project); `wakes`: the WakeLog (or
 * null). Per row, the run's outcome and its follow-ups come from C2's view (actionOutcome), derived now: a late revert
 * moves a row from productive to unproductive. Counts, ids and codes only: no project text.
 *
 *  - `comparison[route][label]`: how many completions would have taken each route (`review` | `defer`) and what the review
 *    that actually followed them came to (completionLabel); `byBasis` the same split by who decided (a code fact or the judge);
 *  - `deferMissed`: of the would-be defers a review judged (productive, unproductive or waited), the share where the review
 *    was productive: the completions a skip would have lost. The number the gate must keep near zero before it acts;
 *  - `reviewWasted`: of the would-be reviews judged, the share that came to nothing (unproductive or waited): what a skip
 *    could still save. `waited` is listed in the counts, because it is the model's own choice and not an outcome;
 *  - `questions`: each template question's probability where the records say the thing happened (a message that cites the
 *    run told the user; a work action followed; the review was productive) against where it did not: the labelled
 *    distribution thresholds are read from;
 *  - `mixed`: completions whose review also read other new evidence (a user message, another run: counted when the row was
 *    written, and again here for every row whose review is the one another completion row's review was): the review's label
 *    is not the completion's alone, so they are left out of the comparison;
 *  - `forced`: completions whose review the host had to make anyway (a due schedule, a check waiting, a question waiting, a
 *    failure: the row's `real`), so a skip would have saved none of it. They count in no rate and no token figure; `forced`
 *    lists them by reason with the same comparison;
 *  - `tokens`: what the reviews woken by the would-be defers cost (the wake row's tokens), the most a skip could have saved.
 * A run whose end time no record holds any more (the SDK dropped the action and the job is gone) cannot be tied to a
 * review: `attribution.unknown`, left out of the comparison.
 */
export function completionReport(state, { rows = [], wakes = null, window = '7d', now = Date.now(), projectId = null, sample = 30 } = {}) {
  const span = CALIBRATION_WINDOWS[window] ?? CALIBRATION_WINDOWS['7d'];
  const all = rows.filter(row => row?.point === COMPLETION_POINT && row.outcome?.actionId && (!projectId || row.scope?.projectId === projectId));
  const selected = all.filter(row => row.at >= now - span).sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
  const comparison = { review: emptyLabels(), defer: emptyLabels() }, byBasis = { code_fact: { review: emptyLabels(), defer: emptyLabels() }, judge: { review: emptyLabels(), defer: emptyLabels() } };
  const forced = { n: 0, reasons: {}, comparison: { review: emptyLabels(), defer: emptyLabels() } };
  const basis = {}, classes = {}, reasons = {}, attributions = {}, detail = [], views = new Map(), readings = new Map();
  const truth = Object.fromEntries(WORK_COMPLETION_QUESTIONS.map(id => [id, { yes: [], no: [] }]));
  let judged = 0, mixed = 0, tokensDefer = 0, tokensReview = 0;
  const viewOf = id => {
    if (views.has(id)) return views.get(id);
    const project = (state?.projects ?? []).find(row => row.id === id) ?? null;
    const sessions = project ? (state?.sessions ?? []).filter(row => row.projectId === id && row.kind !== 'side') : [];
    const view = project ? { project, facts: outcomeFacts(project, sessions, { state, now }), wakeRows: wakes?.rows?.(id) ?? [] } : null;
    views.set(id, view); return view;
  };
  // When a run ended: its action row, else its job (the SDK archives actions past its history; the job outlives them). The
  // ledger row's own time is NOT a stand-in: it was written after the review that read the completion had started.
  const readingOf = row => {
    if (readings.has(row)) return readings.get(row);
    const view = viewOf(row.scope?.projectId), id = row.outcome.actionId;
    let reading = null;
    if (view) {
      const action = (view.project.initiativeRuntime?.sdkState?.actions ?? []).find(item => item.id === id) ?? null, job = (view.project.jobs ?? []).find(item => item?.id === id && item.lane === 'background') ?? null;
      const finishedAt = ms(action?.finishedAt) ?? ms(job?.completedAt), [wake = null, next = null] = wakesAfter(view.wakeRows, finishedAt, 2);
      reading = { view, id, finishedAt, wake, next };
    }
    readings.set(row, reading); return reading;
  };
  // Completions whose reviews are one and the same wake: that review read them all, so none of their outcomes is one run's alone.
  const reviewers = new Map();
  for (const row of all) { const wake = readingOf(row)?.wake; if (wake) { const key = `${row.scope?.projectId}|${wakeRowKey(wake)}`; (reviewers.get(key) ?? reviewers.set(key, new Set()).get(key)).add(row.outcome.actionId); } }
  for (const row of selected) {
    const info = row.outcome, id = info.actionId, route = info.route === 'defer' ? 'defer' : 'review', read = readingOf(row);
    basis[info.basis ?? 'unknown'] = (basis[info.basis ?? 'unknown'] ?? 0) + 1;
    if (info.class) classes[info.class] = (classes[info.class] ?? 0) + 1;
    reasons[info.reason ?? 'unknown'] = (reasons[info.reason ?? 'unknown'] ?? 0) + 1;
    if (!read || !VERDICT_BASIS.has(info.basis)) continue;
    const { view, finishedAt, wake, next } = read, sharing = wake ? Math.max(0, (reviewers.get(`${row.scope?.projectId}|${wakeRowKey(wake)}`)?.size ?? 1) - 1) : 0;
    const others = (Number.isFinite(info.others) ? info.others : 0) + sharing;
    const run = actionOutcome(view.project, id, now, { facts: view.facts });
    let attribution = 'unknown', followUps = [], result = { label: 'unreviewed', told: false, followedWork: false, followedVisible: false };
    if (finite(finishedAt)) {
      ({ attribution, followUps } = reviewFollowUps(view.project, id, { wake, facts: view.facts, now }));
      result = completionLabel({ run, followUps, reviewed: reviewedAfter(view.project, finishedAt, view.wakeRows), told: toldByReview(view.project, id, { run, wake, next, facts: view.facts, now }) });
    }
    attributions[attribution] = (attributions[attribution] ?? 0) + 1;
    const decidedHere = info.real == null || DECIDED_BY_COMPLETION.has(info.real);
    if (attribution === 'unknown') { /* no review can be tied to it */ }
    else if (others > 0) mixed++;
    else if (!decidedHere) { forced.n++; forced.reasons[info.real] = (forced.reasons[info.real] ?? 0) + 1; forced.comparison[route][result.label]++; }
    else {
      comparison[route][result.label]++; byBasis[info.basis][route][result.label]++;
      if (wake && Number.isFinite(wake.tokens)) { if (route === 'defer') tokensDefer += wake.tokens; else tokensReview += wake.tokens; }
      if (info.basis === 'judge' && row.predictions && result.label !== 'unreviewed') {
        judged++;
        for (const questionId of WORK_COMPLETION_QUESTIONS) { const value = row.predictions[questionId]; if (finite(value)) (QUESTION_TRUTH[questionId].of(result) ? truth[questionId].yes : truth[questionId].no).push(value); }
      }
    }
    if (detail.length < sample) detail.push({ at: row.at, projectId: row.scope?.projectId ?? null, actionId: id, route, basis: info.basis, reason: info.reason ?? null, ...(info.class ? { class: info.class } : {}), real: info.real ?? null, ...(others ? { others } : {}), ...(sharing ? { sharedReview: sharing + 1 } : {}), ...(row.predictions ? { probabilities: row.predictions } : {}),
      run: run ? { outcome: run.outcome, reason: run.reason } : null, attribution, followUps: followUps.map(item => ({ kind: item.kind, outcome: item.outcome })), label: attribution === 'unknown' ? null : result.label, wake: wake ? { outcome: wake.outcome, ...(Number.isFinite(wake.tokens) ? { tokens: wake.tokens } : {}) } : null });
  }
  const sum = labels => Object.values(labels).reduce((total, n) => total + n, 0), settled = labels => labels.productive + labels.unproductive + labels.waited;
  const deferMissed = { n: comparison.defer.productive, of: settled(comparison.defer), rate: share(comparison.defer.productive, settled(comparison.defer)) };
  const reviewWasted = { n: comparison.review.unproductive + comparison.review.waited, of: settled(comparison.review), rate: share(comparison.review.unproductive + comparison.review.waited, settled(comparison.review)), waited: comparison.review.waited };
  return { point: COMPLETION_POINT, mode: 'shadow', window: CALIBRATION_WINDOWS[window] ? window : '7d', at: now, rows: selected.length, judged, mixed,
    basis, classes, reasons, attribution: attributions, verdicts: { review: sum(comparison.review), defer: sum(comparison.defer) }, comparison, byBasis, deferMissed, reviewWasted, forced,
    questions: Object.fromEntries(WORK_COMPLETION_QUESTIONS.map(id => [id, { [QUESTION_TRUTH[id].yes]: distribution(truth[id].yes), [QUESTION_TRUTH[id].no]: distribution(truth[id].no) }])),
    tokens: { deferWouldHaveSkipped: tokensDefer, reviewKept: tokensReview }, sample: detail,
    labels: { source: 'work-outcome records (C2): a message that cites the run and reached the user through the review that read it (its own action, or before the next review started), and the action that review admitted (its wake row); only without a wake row, the actions that cite the completion (attribution)', waited: 'the main model\'s own choice (provisional): listed apart, never an outcome label', neutral: 'follow-ups cancelled by the user, a restart or a scope change are left out', mixed: 'completions whose review also read other new evidence, or the same review as another completion, are left out of the comparison', forced: 'completions whose review the host had to make anyway (a due schedule, a check or a question waiting, a failure) are listed apart: a skip would have saved none of it', unknown: 'completions whose end time no record holds any more cannot be tied to a review and are left out' } };
}
