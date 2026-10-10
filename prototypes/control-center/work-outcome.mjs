import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from './durable-files.mjs';
import { metricsRoot } from './metrics-rollup.mjs';
import { workChangeOutcome, WORK_OUTCOME_HORIZON_MS } from './project-mind.mjs';
import { proactiveRowKind } from './proactive-pacing.mjs';
import { deriveWorkspaceEvents, actionReversion } from './workspace-events.mjs';
import { dayKeyer, localDay } from './metric-windows.mjs';

/**
 * The work-outcome view (plan 2026-10-05 C2, §2.1 P2.2): what became of an action the project mind decided, read from
 * records that already exist and are keyed by the action's id. Headlong's shape, not an event bus: it keeps an
 * append-only log and derived indexes built in one pass (conversation_memory.md:348-394 `deferrals.jsonl`, resolved by
 * `resolves=`; outbound_delivery.md:162-185 the sent ledger `delivered | failed | pending`, "a derived index next to the
 * trajectory"), and it counts only VISIBLE steps (monolith/step:357-373: "something happened outside the head").
 *
 * Six stages, named exactly and distinct (harness schedule.md: "dispatch means queued, not that a model answer
 * succeeded or the user read it"). Each is a fact in a record, never an inference from the one before:
 *   decided    the main model chose the action (its wake row; else the instant the host admitted it)
 *   admitted   the host accepted it: an SDK action row exists (an exact duplicate or covered work is never admitted)
 *   ran        its handler ran (a background run started, a message was composed)
 *   applied    its changes reached the project folder (a change set kept, a direct fix kept)
 *   delivered  something reached the user: a message in the conversation, an inbox entry, a question card, a digest or a
 *              welcome-back that carried it, a schedule made (a held message has not been delivered)
 *   reacted    the user answered, replied, acted, dismissed or voted
 * and one outcome per action, from those facts:
 *   visible    applied or delivered: something happened outside the head
 *   pending    admitted and not settled: queued, running, a change waiting for its apply, a message held for the user's
 *              return or the daily digest
 *   none       settled with nothing outside the head: a read-only run nobody was told about, a message the narrator
 *              dropped, work another run covered, a decision overtaken by new evidence
 *   undone     the user took its changes back (reverted, discarded)
 *   failed     it failed, and nothing visible came of it
 *
 * What is persisted is only the transitions `{ actionId, from, to, at }` (plus the project and the kind of action), and
 * a daily aggregate of them: `actionOutcome` derives everything else from the records, so a restart recomputes the view
 * and a transition already persisted is never emitted twice (see WorkOutcomeLog). Every record it reads outlives the
 * SDK's history compaction (jobs, change sets, direct fixes, the inbox, conversation items, thread rows; the SDK action
 * row only adds the decision's own status while it is live), so a late undo still finds its row, even when every one of
 * those rows is gone (the git apply records outlive them). The host's own schedule occurrences (a due occurrence's run and
 * the share that delivers its result) are the user's schedule firing, not a decision the project mind made: no outcome.
 */
export const STAGES = Object.freeze(['decided', 'admitted', 'ran', 'applied', 'delivered', 'reacted']);
export const OUTCOMES = Object.freeze(['visible', 'pending', 'none', 'undone', 'failed']);
export const outcomeLogFile = stateFile => join(metricsRoot(stateFile), 'work-outcomes.jsonl');
/** Transitions are kept this many days (the decision ledger's retention); older ones are folded into the daily aggregate. */
export const OUTCOME_LOG_DAYS = 31;
/** Where a late undo is still answerable to the action behind it (project-mind.mjs: the initiative snapshot's undo horizon). */
export const OUTCOME_HORIZON_MS = WORK_OUTCOME_HORIZON_MS;
const DAY = 86400000;
const ms = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : null; };
const earliest = (...values) => { const known = values.filter(Number.isFinite); return known.length ? Math.min(...known) : null; };
const push = (map, key, value) => { if (typeof key === 'string' && key) { const rows = map.get(key); if (rows) rows.push(value); else map.set(key, [value]); } };
const retained = row => Boolean(row) && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
/** Inbox actionIds the host makes up for its own receipts (a welcome-back, an overflow row, an expired schedule): not actions. */
const SYNTHETIC = /^(welcome-back:|held:|schedule-expired-)/;
/** A change set's run in its own copy is `<action>-direct` (a finding handled directly): its changes are the finding's. */
const baseId = id => typeof id === 'string' ? id.replace(/-direct$/, '') : id;
/**
 * Which outcome may follow which. A transition from null (first seen) goes anywhere. A later derivation that would go
 * backwards (visible back to pending, none back to failed) is a record that aged out (a change row trimmed, an action
 * archived), not news, and is not emitted.
 */
const NEXT = Object.freeze({ pending: ['visible', 'none', 'undone', 'failed'], visible: ['undone'], none: ['visible'], failed: ['visible'], undone: ['visible'] });
/**
 * The cancellations that ARE a verdict on the decision: new evidence overtook it, or the host found it redundant (the
 * narrator's drops, the duplicate and coverage checks). Every other cancellation (the user's stop, a host restart, a
 * drift in what it was built on, a cancellation no reason was kept for: runs from before reasons were recorded) says
 * nothing about whether the wake was needed, so its outcome is `none` but `neutral`: it gives no label.
 */
const VERDICT_CANCEL = new Set(['new_evidence', 'already_reported', 'below_threshold', 'thread_muted', 'exact_duplicate', 'message_duplicate', 'already_covered', 'not_clearly_better', 'awaiting_user_retry']);

// ----------------------------------------------------------------------- facts
/**
 * The records one pass over a project reads (Headlong builds `deferrals.jsonl` and `sent.jsonl` in one incremental pass):
 * SDK actions, background jobs, the inbox (and the receipts that credit other actions), the conversation items the
 * initiative delivered, the messages held in open threads, and the user's undos. `recent` is every action id a record of
 * the last OUTCOME_HORIZON_MS names.
 */
export function outcomeFacts(project, sessions = [], { state = null, now = Date.now() } = {}) {
  const sdk = new Map(), jobs = new Map(), entries = new Map(), credits = new Map(), items = new Map(), welcome = new Map(), cites = new Map(), held = new Map(), recent = new Set(), scheduled = new Set();
  const inHorizon = value => { const at = ms(value); return at !== null && now - at <= OUTCOME_HORIZON_MS; };
  // The host's own schedule occurrences (a due occurrence's run, and the share that delivers its result) are the user's
  // schedule firing, not a decision the project mind made: no outcome of its own, and no part of the decided-actions rate.
  // Any record naming one marks the id, so it stays out after the SDK has forgotten the action row.
  for (const occurrence of project?.scheduleRuntime?.occurrences ?? []) for (const id of [occurrence?.actionId, occurrence?.deliveryActionId]) if (typeof id === 'string' && id) scheduled.add(id);
  for (const action of project?.initiativeRuntime?.sdkState?.actions ?? []) if (action && typeof action.id === 'string') { if (action.hostSchedule) scheduled.add(action.id); else if (retained(action)) sdk.set(action.id, action); }
  for (const job of project?.jobs ?? []) if (job && typeof job.id === 'string' && job.lane === 'background') { if (job.scheduleId || job.occurrenceKey) scheduled.add(job.id); else if (retained(job)) { jobs.set(job.id, job); if (inHorizon(job.completedAt ?? job.createdAt) && !job.id.endsWith('-direct')) recent.add(job.id); } }
  for (const entry of project?.inbox ?? []) {
    if (!entry || entry.contextRevoked || entry.sourceDeleted) continue;
    if (entry.scheduled === true) { if (typeof entry.actionId === 'string') scheduled.add(entry.actionId); continue; }
    push(entries, entry.actionId, entry);
    for (const id of Array.isArray(entry.creditedActionIds) ? entry.creditedActionIds : []) push(credits, id, entry);
    if (typeof entry.actionId === 'string' && !SYNTHETIC.test(entry.actionId) && inHorizon(entry.createdAt)) recent.add(entry.actionId);
  }
  for (const row of [...(project?.backgroundChanges ?? []), ...(project?.directFixes ?? [])]) if (row && typeof row.actionId === 'string' && inHorizon(row.settledAt ?? row.revertedAt ?? row.at)) recent.add(baseId(row.actionId));
  for (const session of sessions) for (const item of session.items ?? []) {
    if (item?.source !== 'initiative' || !retained(item)) continue;
    const id = item.initiativeActionId;
    if (typeof id === 'string' && id && proactiveRowKind(item) === 'delivery') {
      push(items, id, item);
      // The delivery cites the completions it reports (`action:<id>:completed`): a read-only investigation is credited
      // through the later message that told the user what it found (communicationStatus links them the same way).
      for (const evidence of Array.isArray(item.evidenceIds) ? item.evidenceIds : []) { const found = /^action:(.+):completed$/.exec(String(evidence)); if (found) push(cites, found[1], id); }
    }
    if (item.initiative?.kind === 'welcome_back') for (const id of Array.isArray(item.initiative.actionIds) ? item.initiative.actionIds : []) push(welcome, id, item);
  }
  for (const thread of project?.mind?.threads ?? []) if (thread?.status === 'open') for (const row of [...(Array.isArray(thread.held) ? thread.held : []), ...(Array.isArray(thread.heldAsks) ? thread.heldAsks : [])]) push(held, row?.actionId, { row, thread });
  // The user's undos (a revert is a rollback record before the change row catches up with it): lazily, once per pass.
  let reversions = null;
  const undone = id => { if (!state) return null; reversions ??= deriveWorkspaceEvents(state, project, { since: now - OUTCOME_HORIZON_MS }); return actionReversion(reversions, id); };
  return { project, sdk, jobs, entries, credits, items, welcome, cites, held, recent, scheduled, undone };
}

/** When something reached the user for this action on its own (not through another action's message), or null. */
function ownDelivery(id, F) {
  let best = null;
  const take = (at, via) => { if (at !== null && (best === null || at < best.at)) best = { at, via }; };
  for (const entry of F.entries.get(id) ?? []) {
    // A digest-tier entry waits for the daily digest that carries it; the user has not been told until then.
    if (entry.tier === 'digest' && entry.heldForDigest === true) continue;
    take(entry.tier === 'digest' ? ms(entry.digestedAt) ?? ms(entry.dismissedAt) ?? ms(entry.createdAt) : ms(entry.createdAt), entry.tier === 'digest' && entry.digestedAt ? 'digest' : 'delivery');
  }
  for (const item of F.items.get(id) ?? []) take(ms(item.createdAt), 'delivery');
  // A welcome-back that carried a held message is the delivery of the action that held it, credited to that action
  // (the welcome-back's own receipt, `welcome-back:<id>`, is not an action: no second count).
  for (const item of F.welcome.get(id) ?? []) take(ms(item.createdAt), 'welcome_back');
  for (const entry of F.credits.get(id) ?? []) take(ms(entry.createdAt), 'welcome_back');
  return best;
}
/** Delivery of an action: its own, else the message of another action that cited its completion. */
function deliveryOf(id, F) {
  let best = ownDelivery(id, F);
  for (const citing of F.cites.get(id) ?? []) { const via = ownDelivery(citing, F); if (via && (best === null || via.at < best.at)) best = { at: via.at, via: 'cited' }; }
  return best;
}
/** The user's reaction to what was delivered: an inbox reaction (replied, acted, dismissed, ignored once its window closed) or a vote. */
function reactionOf(id, F) {
  for (const entry of [...(F.entries.get(id) ?? []), ...(F.credits.get(id) ?? [])]) if (entry.feedback?.outcome) return { reaction: entry.feedback.outcome, at: ms(entry.feedback.at) };
  for (const item of F.items.get(id) ?? []) if (item.feedback?.vote === 'up' || item.feedback?.vote === 'down') return { reaction: item.feedback.vote, at: ms(item.feedback.at) };
  return null;
}

// -------------------------------------------------------------------- derive
const RUNNING = new Set(['queued', 'running', 'paused']);
function derive(id, F, now, wake = null) {
  const { project } = F;
  if (F.scheduled.has(id)) return null;
  const sdk = F.sdk.get(id) ?? null, job = F.jobs.get(id) ?? null, entries = F.entries.get(id) ?? [], held = F.held.get(id) ?? [];
  const change = workChangeOutcome(project, id), mine = F.items.get(id) ?? [], reverted = F.undone(id);
  if (!sdk && !job && !entries.length && !held.length && !mine.length && change.status === 'none' && !F.welcome.has(id) && !F.credits.has(id)) {
    // Every row of the action is gone (the SDK archived it, its conversation was deleted and took the job, the change set
    // was trimmed): a late undo still finds it in the git apply records, which outlive all of them.
    return reverted ? { actionId: id, kind: 'work', stages: {}, outcome: 'undone', reason: 'change_undone', at: ms(reverted.at) ?? now } : null;
  }
  const kind = sdk?.action ?? (job ? (job.kind === 'evolution' ? 'learn' : 'work') : entries[0]?.kind ?? held[0]?.row?.kind ?? (change.status !== 'none' ? 'work' : 'share'));
  const delivery = deliveryOf(id, F), reaction = delivery ? reactionOf(id, F) : null;
  const stages = {};
  const admitted = ms(sdk?.createdAt) ?? ms(job?.createdAt) ?? earliest(...entries.map(entry => ms(entry.createdAt)));
  stages.decided = ms(wake?.at) ?? admitted; stages.admitted = admitted;
  if (sdk?.startedAt || job) stages.ran = ms(sdk?.startedAt) ?? ms(job?.createdAt);
  const applied = change.status === 'applied' ? ms(change.change?.at) ?? ms(change.change?.settledAt) : null;
  if (change.status === 'applied') stages.applied = applied;
  if (delivery) stages.delivered = delivery.at;
  if (reaction) stages.reacted = reaction.at;
  const finished = ms(sdk?.finishedAt) ?? ms(sdk?.resolvedAt) ?? ms(job?.completedAt);
  const waiting = change.status === 'waiting' || held.length > 0 || entries.some(entry => entry.tier === 'digest' && entry.heldForDigest === true && !entry.digestedAt)
    || (sdk ? RUNNING.has(sdk.status) || sdk.status === 'needs_review' && !sdk.resolvedAt : job ? ['running', 'queued', 'interrupted', 'needs_review'].includes(job.status) : false);
  const common = { actionId: id, kind, stages, ...(delivery?.via && delivery.via !== 'delivery' ? { via: delivery.via } : {}), ...(reaction ? { reaction: reaction.reaction } : {}) };
  // The user took the changes back: the outcome is theirs, whatever else it also did.
  if (change.status === 'undone' || reverted) return { ...common, outcome: 'undone', reason: change.change?.droppedBy === 'agent' ? 'change_dropped' : 'change_undone', at: ms(change.change?.revertedAt) ?? ms(change.change?.settledAt) ?? ms(reverted?.at) ?? ms(change.change?.at) ?? admitted ?? now };
  if (kind === 'schedule' && sdk?.status === 'completed') return { ...common, outcome: 'visible', reason: 'schedule_created', at: finished ?? admitted ?? now };
  if (kind === 'learn' && (job?.status === 'completed' && job.versionId)) return { ...common, outcome: 'visible', reason: 'candidate_ready', at: ms(job.completedAt) ?? finished ?? now };
  const visibleAt = earliest(applied, delivery?.at);
  if (visibleAt !== null) return { ...common, outcome: 'visible', reason: applied !== null && (delivery === null || applied <= delivery.at) ? 'change_applied' : delivery.via === 'welcome_back' ? 'welcome_back' : delivery.via === 'digest' ? 'digest' : delivery.via === 'cited' ? 'cited_by_delivery' : 'delivered', at: visibleAt };
  if (waiting) return { ...common, outcome: 'pending', reason: change.status === 'waiting' ? 'change_waiting' : held.length ? 'held' : entries.some(entry => entry.tier === 'digest' && entry.heldForDigest === true) ? 'digest_pending' : sdk?.status === 'queued' ? 'queued' : 'running', at: admitted ?? now };
  if (sdk?.status === 'failed' || !sdk && job?.status === 'failed') return { ...common, outcome: 'failed', reason: sdk?.errorCode ?? job?.errorCode ?? 'run_failed', at: finished ?? admitted ?? now };
  const cancelled = sdk?.status === 'cancelled' ? String(sdk.cancellationReason ?? sdk.resolutionOutcome ?? 'cancelled') : null;
  return { ...common, outcome: 'none', reason: cancelled ? `cancelled:${cancelled}` : kind === 'share' || kind === 'ask' ? held.length === 0 && sdk?.deliveryOutcome === 'held' ? 'held_dropped' : 'not_delivered' : kind === 'learn' ? 'candidate_not_ready' : 'nothing_visible',
    ...(cancelled && !VERDICT_CANCEL.has(cancelled) ? { neutral: true } : {}), at: finished ?? admitted ?? now };
}
/**
 * What became of one action, derived from the project's records (plan §2.1 P2.2). Pure: no state is written, no model is
 * called. `context`: `sessions` (the project's conversations; deliveries and the messages that cite a completion are
 * conversation items), `state` (the store state, for the user's undos in the git apply records), `wake` (the wake row
 * that decided it, for the `decided` stage), `facts` (outcomeFacts, when many actions are read in one pass).
 * @returns {null|{ actionId: string, kind: string, outcome: 'visible'|'pending'|'none'|'undone'|'failed', reason: string,
 *   at: number, stages: Partial<Record<'decided'|'admitted'|'ran'|'applied'|'delivered'|'reacted', number|null>>,
 *   reaction?: string, via?: string, neutral?: true }} null when no record names the action.
 */
export function actionOutcome(project, actionId, now = Date.now(), context = {}) {
  if (typeof actionId !== 'string' || !actionId || SYNTHETIC.test(actionId)) return null;
  return derive(actionId, context.facts ?? outcomeFacts(project, context.sessions ?? [], { state: context.state ?? null, now }), now, context.wake ?? null);
}

// -------------------------------------------------------------------- labels
const REACTION_NEEDED = Object.freeze({ replied: true, acted: true, up: true, dismissed: false, ignored: false, down: false });
/**
 * The calibration labels an action's outcome gives the judgments behind the wake that decided it (PDL-7, mu
 * decision.ts:25-31: a judgment stays in shadow until its verdicts are compared with OUTCOMES, never with the model's
 * own next decision). `wake.gate` holds the wake judgment's ledger row and the earlier deferrals of the same situation:
 *  - needed (work, schedule, learn: visible; share, ask: visible and the user replied, acted or voted up):
 *    the wake judgment `wake_needed_<kind>`, each deferral `defer_missed`;
 *  - not needed (none; undone; a message dismissed, ignored or voted down): `wake_unneeded`, each deferral `defer_right`;
 *  - nothing (pending; failed, which says the run broke, not that the wake was unneeded; a cancellation the user or a
 *    restart caused; a delivery nobody reacted to yet).
 * @returns {{ id: string, value: string }[]}
 */
export function outcomeLabels(record, wake) {
  const gate = wake?.gate;
  if (!record || !gate) return [];
  let needed;
  if (record.outcome === 'visible') needed = ['share', 'ask'].includes(record.kind) ? REACTION_NEEDED[record.reaction] : true;
  else if ((record.outcome === 'none' || record.outcome === 'undone') && record.neutral !== true) needed = false;
  if (needed === undefined) return [];
  return [...(typeof gate.ledgerId === 'string' ? [{ id: gate.ledgerId, value: needed ? `wake_needed_${record.kind}` : 'wake_unneeded' }] : []), ...(Array.isArray(gate.deferred) ? gate.deferred : []).map(id => ({ id, value: needed ? 'defer_missed' : 'defer_right' }))];
}

// ----------------------------------------------------------------------- log
/**
 * A transition's aggregate cell. `from` is kept (`new` when it was first seen) so a report can count actions and not
 * transitions: an action that goes none → visible (a later message cited its run) or visible → undone is two transitions
 * and one action. `neutral`: a cancellation that says nothing about whether the decision was needed.
 */
const cellKey = row => ({ projectId: row.projectId, kind: row.kind, from: row.from ?? 'new', to: row.to, ...(row.neutral === true ? { neutral: true } : {}) });
const aggregateCell = row => ({ at: row.at, key: cellKey(row), values: { n: 1 } });
/**
 * The transitions, durable: one append-only JSONL file in `<state>.rna/metrics/` (inside the journal root every release
 * inventories: no new top-level `<state>.<name>` sibling). Counts, ids and codes only.
 *  - A transition is emitted once: its identity is the action and the outcome it moved to. `last` (the newest `to` per
 *    action: the last one emitted, which is the last one in the file, not the one with the latest `at`) is what a restart
 *    replays against, so recomputing the view at startup emits nothing it already persisted. An action may come back to an
 *    outcome it left (an undo the user reversed) because the outcome in between was recorded first; that transition's `at`
 *    is never before the one it follows, so the order of instants and the order of emission agree for one action.
 *  - Transitions older than the retention fold into the daily aggregate (`outcomes-daily.json`, B7's DailyRollup) exactly
 *    once (its watermark), and leave the file; a transition before the watermark is never folded again.
 *  - Lines of a kind this release does not know are kept through rewrites (a later release's rows survive a rollback).
 * Nothing here is a second source of truth: the file is a cache of what the records said and when, and the records
 * (jobs, change sets, the inbox, conversation items) stay the truth.
 */
export class WorkOutcomeLog {
  constructor({ file = null, now = Date.now, rollup = null, retentionDays = OUTCOME_LOG_DAYS } = {}) {
    Object.assign(this, { file, now, rollup, retentionDays });
    this.list = []; this.lastBy = new Map(); this.unknown = []; this.appended = 0;
    if (!file) return;
    let lines = []; try { lines = readFileSync(file, 'utf8').split('\n'); } catch { lines = []; }
    this.load(lines);
    this.prune();
  }
  load(lines) {
    const mark = this.rollup?.mark('outcomes') ?? null;
    for (const line of lines) {
      if (!line) continue;
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value?.t === 'transition' && typeof value.actionId === 'string' && typeof value.projectId === 'string' && OUTCOMES.includes(value.to) && Number.isFinite(value.at)) {
        // Already folded into the aggregate before a crash kept this file from being rewritten.
        if (mark !== null && value.at < mark) continue;
        this.remember(value);
      } else this.unknown.push(line);
    }
    this.list.sort((a, b) => a.at - b.at);
    this.appended += lines.filter(Boolean).length;
    return this;
  }
  remember(row) {
    const { t: _t, ...value } = row;
    // A transition carries the instant its outcome began, which can be older than the one recorded before it.
    const before = this.list.at(-1);
    this.list.push(value);
    if (before && value.at < before.at) this.list.sort((a, b) => a.at - b.at);
    // The newest transition of an action is the last one remembered (the order they were emitted in, which is the order of
    // the file), not the one with the latest `at`: a transition may carry an instant older than the one before it.
    this.lastBy.set(value.actionId, value);
  }
  /** The newest transition of an action, or null. */
  last(actionId) { return this.lastBy.get(actionId) ?? null; }
  /** Every action id the log still follows: unsettled ones, and settled ones a late undo can still reach. */
  trackedIds(projectId, now = this.now()) {
    const ids = [];
    for (const row of this.lastBy.values()) if (row.projectId === projectId && (row.to === 'pending' || now - row.at <= OUTCOME_HORIZON_MS)) ids.push(row.actionId);
    return ids;
  }
  /**
   * Read the project's records and persist what changed since the last read: one transition per action whose outcome
   * moved. `wake(id)`: the wake row that decided an action (the `decided` stage). Returns the new transitions (with the
   * user's reaction, for the label pass) and every record read, by action id.
   */
  reconcile(project, sessions, { now = this.now(), state = null, wake = () => null } = {}) {
    const transitions = [], records = new Map();
    if (!project || project.simulated === true) return { transitions, records };
    const facts = outcomeFacts(project, sessions, { state, now });
    const ids = new Set([...facts.sdk.keys(), ...facts.recent, ...this.trackedIds(project.id, now)]);
    // History older than the log keeps (or already folded into the aggregate) is not news: the SDK holds its last 128
    // actions whatever their age, and a transition for one of them would be counted again each time it left the log.
    const floor = Math.max(now - this.retentionDays * DAY, this.rollup?.mark('outcomes') ?? -Infinity);
    for (const id of ids) {
      if (SYNTHETIC.test(id)) continue;
      const record = derive(id, facts, now, wake(id));
      if (!record) continue;
      records.set(id, record);
      const last = this.lastBy.get(id) ?? null, from = last?.to ?? null;
      // A transition never starts before the one it follows: an undo the user reversed is `visible` again from the old
      // change row's apply time, which is earlier than the `undone` it follows, and it must not read as the older of the two.
      const at = Math.min(now, Math.max(Number.isFinite(record.at) ? record.at : now, last?.at ?? -Infinity));
      if (from === record.outcome || from !== null && !NEXT[from]?.includes(record.outcome) || at < floor) continue;
      const row = { projectId: project.id, actionId: id, kind: record.kind, from, to: record.outcome, at, ...(record.reason ? { reason: record.reason } : {}), ...(record.neutral ? { neutral: true } : {}) };
      this.add(row);
      transitions.push({ ...row, ...(record.reaction ? { reaction: record.reaction } : {}) });
    }
    return { transitions, records };
  }
  add(row) {
    this.remember(row);
    this.write({ t: 'transition', ...row });
    if (this.list.length > 1 && this.list[0].at < this.now() - (this.retentionDays + 1) * DAY || this.appended > 4 * this.list.length + 2000) this.prune({ rewrite: true });
    return row;
  }
  write(value) {
    if (!this.file) return;
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); appendFileSync(this.file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); this.appended++; } catch { /* the view is recomputed from the records: telemetry never blocks a wake */ }
  }
  /** Transitions of a project (all of them without one), oldest first, inside [since, until). */
  rows({ projectId = null, since = -Infinity, until = Infinity } = {}) { return this.list.filter(row => (projectId === null || row.projectId === projectId) && row.at >= since && row.at < until); }
  /**
   * Transitions older than the retention fold into the daily aggregate first (its watermark moves to the cutoff), then
   * leave memory and the file. A rewrite waits until the aggregate holding them is on disk, so a failed flush neither
   * loses a transition nor folds it twice.
   */
  prune({ rewrite = false } = {}) {
    const cutoff = this.now() - this.retentionDays * DAY, leaving = this.list.filter(row => !(row.at >= cutoff));
    if (leaving.length) {
      this.rollup?.fold('outcomes', leaving.map(aggregateCell), cutoff);
      this.list = this.list.filter(row => row.at >= cutoff);
      for (const row of leaving) if (this.lastBy.get(row.actionId) === row) this.lastBy.delete(row.actionId);
    }
    if (leaving.length || rewrite) return this.rewrite();
    return true;
  }
  rewrite() {
    if (!this.file) { this.appended = this.list.length; return true; }
    if (this.rollup && !this.rollup.flush()) return false;
    const cutoff = this.now() - this.retentionDays * DAY;
    const unknown = this.unknown.filter(line => { try { const at = JSON.parse(line)?.at; return !Number.isFinite(at) || at >= cutoff; } catch { return false; } });
    const lines = [...this.list.map(row => JSON.stringify({ t: 'transition', ...row })), ...unknown];
    try { atomicWrite(this.file, lines.length ? `${lines.join('\n')}\n` : ''); this.unknown = unknown; this.appended = lines.length; return true; } catch { return false; }
  }
  /** A deleted project's transitions go with it (counts and ids only, but the deletion promise covers them too). */
  removeProject(projectId) {
    const before = this.list.length;
    this.list = this.list.filter(row => row.projectId !== projectId);
    for (const [id, row] of [...this.lastBy]) if (row.projectId === projectId) this.lastBy.delete(id);
    this.rollup?.removeProject(projectId); this.rollup?.flush();
    if (this.list.length !== before) this.rewrite();
    return before - this.list.length;
  }
  /**
   * Aggregate cells of a project inside a range of local days (metric-windows.mjs): the daily aggregate for the days
   * before the file's oldest transition, then the transitions themselves. `{ key: { kind, from, to, neutral? }, values: { n } }`.
   */
  cells(projectId, range, { timeZone } = {}) {
    const out = [], mark = this.rollup?.mark('outcomes') ?? null;
    if (this.rollup && range.days?.length && mark !== null) {
      const through = localDay(mark - 1, this.rollup.timeZone), days = range.days.filter(day => day <= through);
      if (days.length) for (const cell of this.rollup.cells({ firstDay: days[0], lastDay: days.at(-1), keep: key => key.projectId === projectId })) out.push({ key: cell.k, values: cell.v, day: cell.day });
    }
    const keyOf = dayKeyer(timeZone ?? this.rollup?.timeZone);
    for (const row of this.rows({ projectId, since: range.since ?? -Infinity, until: range.until ?? Infinity })) if (mark === null || row.at >= mark) out.push({ key: cellKey({ ...row, projectId }), values: { n: 1 }, day: keyOf(row.at) });
    return out;
  }
}
/** The transitions of an outcome file, read only (benchmarks read copies through this); [] without one. */
export function readOutcomeLog(file) {
  let text = ''; try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return new WorkOutcomeLog({ retentionDays: Infinity }).load(text.split('\n')).rows();
}
