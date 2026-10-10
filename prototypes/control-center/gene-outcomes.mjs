import { providerDiagnostic } from '../../packages/sdk/src/provider-diagnostics.mjs';
import { workChangeOutcome } from './project-mind.mjs';
import { outcomeFacts, actionOutcome } from './work-outcome.mjs';

// The evolution's background outcome lane (P2 batch D, D3; plan §2.2 D3, §1.3 F): what became of each thing the project agent
// did on its own — a scheduled occurrence, a decided run, a message it delivered — as ONE row per action, so the evolution
// can learn from the work that nobody chats about. Everything here is a pure function of records that already exist (the
// C2 work-outcome view, the schedule occurrences, the conversation items and what the user's messages said about them):
// nothing is persisted, nothing is asked of a model, and a row is never a calibration label.
// Who reads the rows: the harm reading, the scoreboard, the per-generation outcomes and the observability counts read the whole row
// (a vote on a delivery and a change the user took back included). The contrast analysis and its pairs (`pairOccurrences`) read the
// user's MESSAGES about the work, through the evolution service's `outcomeScan` — what it contrasts is words, and a vote or an undo
// has none — plus the runs that failed for the project's own reasons.
//
// Three ideas are taken from ModularRSI's confirm.py (self_evo/confirm.py), whose "free fitness signal" is the same shape:
//  - compare PAIRED on the same task: the composer picks a new variant for hard tasks, so a raw rate is biased; only the
//    tasks where both sides ran are compared, and each task weighs equally. Rna's only true same-task repetition is the
//    occurrences of one schedule (`scheduleId`);
//  - ask for a minimum shared sample and a generous margin before concluding anything (min_shared=3, margin=.34: a margin
//    just over one step of 1/3 at the minimum sample, so one flipped result never decides it). Rna's shared sample is the
//    matched occurrences of ONE schedule, so the minimum applies to each schedule that is compared (confirm.py counts distinct
//    tasks): a schedule with fewer matched pairs than that is not compared at all, and with every compared schedule at least
//    three pairs deep and weighing the same, no single result can move the delta by more than a third;
//  - judge live variants only, and let the verdict be a rollback invitation rather than a rollback: the other genes change
//    at the same time (the comparison is confounded, as confirm.py says of its helpers), so the user decides.
// rrsi's `loop.py:159-176` scoreboard scores each edit's prediction against what happened; `scoreboard` below does the
// same with a patch's `expectation`, from recorded outcomes only.

/** ModularRSI confirm.py defaults: matched samples needed on both sides, and the margin (in correction rate) the later side must exceed; and the most settled occurrences per schedule on each side of a generation. */
export const HARM_MIN_SHARED = 3, HARM_MARGIN = 0.34, HARM_WINDOW = 8;

/** Failed turns and runs whose cause is the model service or the network (provider-diagnostics categories) or an aborted request: the system strand, never lane C's trouble (ModularRSI router.py:53-58 infra_only). */
export const INFRA_GROUPS = Object.freeze({ connection: 'network', timeout: 'network', rate_limit: 'capacity', quota_exhausted: 'capacity', server_unavailable: 'service', provider_failure: 'service', authentication: 'access', permission: 'access', model_access_denied: 'access', model_unavailable: 'access', redirect_rejected: 'access' });
/** The infrastructure group of a failed background run, from the failure it recorded (`code`, `httpStatus`: the provider diagnostic's own mapping), or null. */
export const infraOfFailure = failure => {
  if (!failure || typeof failure !== 'object') return null;
  const category = providerDiagnostic({ code: failure.code, status: failure.httpStatus })?.category;
  return category ? INFRA_GROUPS[category] ?? null : null;
};

const ms = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : null; };
const retained = row => Boolean(row) && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
/** What a reaction is worth, strongest first: one correction outweighs an approval of the same delivery (the foreground rule). */
const PRIORITY = Object.freeze({ corrected: 3, approved: 2, accepted: 1 });
/** Outcomes a pair can be built from: the user's correction, undo or thumbs-down is the bad side, an approval (a thumbs-up too) or a reply that did not correct the good one. Unanswered counts neither way (mu: "unsure counts neither"). */
const BAD = new Set(['corrected', 'undone', 'disliked']), GOOD = new Set(['approved', 'accepted']);
export const SETTLED = Object.freeze([...BAD, ...GOOD]);
/** The user's vote on a delivered message as a reaction (`feedback.vote`: up | down), or null. */
const voteOn = item => item?.feedback?.vote === 'up' ? { outcome: 'approved', at: ms(item.feedback.at), vote: true } : item?.feedback?.vote === 'down' ? { outcome: 'disliked', at: ms(item.feedback.at), vote: true } : null;

/** Fold one reaction (corrected | approved | accepted) of a user message into the per-delivery map, strongest first. */
export function addReaction(map, itemId, reaction) {
  if (typeof itemId !== 'string' || !PRIORITY[reaction?.outcome]) return map;
  const have = map.get(itemId);
  if (!have || PRIORITY[reaction.outcome] > PRIORITY[have.outcome]) map.set(itemId, reaction);
  return map;
}

// ---------------------------------------------------------------------------------- rows
/**
 * One row per action the project did on its own, newest last:
 *  - every scheduled occurrence that ran (the host's schedule firing; C2's view has no outcome for these on purpose);
 *  - every action the project mind decided that C2's view reads (`actionOutcome`).
 * `outcome`: corrected | approved | accepted (a message about its delivery said so: `reactions`, by delivery item id), or the user's vote on it (approved, disliked) |
 * unanswered (delivered, nobody reacted: counts neither way) | undone (the user took its changes back: a strong negative) |
 * failed | infra (the model service or the network failed it: not the project's method) | pending | none.
 * @param {object} project
 * @param {object[]} sessions the project's conversations
 * @param {{ now?: number, state?: object|null, reactions?: Map<string, { outcome: string, at?: number|null, messageId?: string }> }} context
 * @returns {{ id: string, kind: string, actionId: string, scheduleId?: string, occurrenceKey?: string, itemId?: string, sessionId?: string, at: number, outcome: string, reason?: string, reaction?: { outcome: string, at?: number|null }, change?: string }[]}
 */
export function outcomeRows(project, sessions = [], { now = Date.now(), state = null, reactions = new Map() } = {}) {
  const rows = [], items = new Map();
  for (const session of sessions) for (const item of session.items ?? []) if (item?.id) items.set(item.id, { item, session });
  const facts = outcomeFacts(project, sessions, { state, now });
  const sdkAction = id => (project?.initiativeRuntime?.sdkState?.actions ?? []).find(row => row?.id === id) ?? null;
  // What the user said about a delivery: a message about it (a correction, an approval, a reply), else their vote on it (a thumbs-up is an approval, a thumbs-down a rejection: an action of theirs, never the model's reading).
  const reaction = itemId => reactions.get(itemId) ?? voteOn(items.get(itemId)?.item);

  // A scheduled occurrence: the schedule's own run, one row per occurrence key.
  for (const occurrence of project?.scheduleRuntime?.occurrences ?? []) {
    if (!occurrence?.key || !occurrence.scheduleId) continue;
    const base = { id: occurrence.key, kind: 'scheduled', actionId: occurrence.actionId ?? occurrence.key, scheduleId: occurrence.scheduleId, occurrenceKey: occurrence.key };
    const changed = workChangeOutcome(project, occurrence.actionId), reverted = occurrence.actionId ? facts.undone(occurrence.actionId) : null;
    const undone = changed.status === 'undone' || Boolean(reverted);
    if (occurrence.status === 'delivered') {
      const found = occurrence.deliveryItemId ? items.get(occurrence.deliveryItemId) : null;
      // The delivery was a message in a conversation that is gone or revoked: nobody can say how it was received.
      if (occurrence.deliveryItemId && (!found || !retained(found.item))) continue;
      const said = occurrence.deliveryItemId ? reaction(occurrence.deliveryItemId) : null;
      const at = ms(occurrence.deliveredAt) ?? ms(occurrence.scheduledAt); if (at === null) continue;
      rows.push({ ...base, ...(occurrence.deliveryItemId ? { itemId: occurrence.deliveryItemId, sessionId: found.session.id } : {}), at, outcome: undone ? 'undone' : said ? said.outcome : 'unanswered', ...(said ? { reaction: { outcome: said.outcome, at: said.at ?? null } } : {}), ...(changed.status !== 'none' ? { change: undone ? 'undone' : changed.status } : {}) });
    } else if (occurrence.status === 'failed') {
      const failure = sdkAction(occurrence.actionId)?.failure ?? (project?.jobs ?? []).find(job => job?.id === occurrence.actionId)?.failure ?? null, group = infraOfFailure(failure);
      rows.push({ ...base, at: ms(occurrence.updatedAt) ?? ms(occurrence.claimedAt) ?? ms(occurrence.scheduledAt) ?? now, outcome: group ? 'infra' : 'failed', reason: group ?? occurrence.errorCode ?? 'run_failed', ...(failure?.message ? { error: String(failure.message).slice(0, 300) } : {}) });
    } else if (['queued', 'running', 'delivery_pending', 'needs_review'].includes(occurrence.status)) rows.push({ ...base, at: ms(occurrence.claimedAt) ?? ms(occurrence.scheduledAt) ?? now, outcome: 'pending' });
  }

  // An action the project mind decided (a run, a share, a question, a schedule it made).
  for (const id of new Set([...facts.sdk.keys(), ...facts.recent, ...facts.items.keys(), ...facts.entries.keys()])) {
    const record = actionOutcome(project, id, now, { facts });
    if (!record) continue;
    const delivered = (facts.items.get(id) ?? [])[0] ?? null, said = delivered ? reaction(delivered.id) : null;
    const base = { id, kind: record.kind, actionId: id, at: record.at, ...(delivered ? { itemId: delivered.id } : {}) };
    if (record.outcome === 'visible') rows.push({ ...base, outcome: said ? said.outcome : 'unanswered', ...(said ? { reaction: { outcome: said.outcome, at: said.at ?? null } } : {}), ...(record.reason ? { reason: record.reason } : {}) });
    else if (record.outcome === 'undone') rows.push({ ...base, outcome: 'undone', reason: record.reason });
    else if (record.outcome === 'failed') {
      const failure = sdkAction(id)?.failure ?? facts.jobs.get(id)?.failure ?? null, group = infraOfFailure(failure);
      rows.push({ ...base, outcome: group ? 'infra' : 'failed', reason: group ?? record.reason });
    } else if (record.neutral !== true) rows.push({ ...base, outcome: record.outcome === 'pending' ? 'pending' : 'none', reason: record.reason });
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** Settled rows (a reaction or an undo says how it went) grouped by schedule, each oldest first. */
export function scheduleGroups(rows) {
  const groups = new Map();
  for (const row of rows) if (row.scheduleId && SETTLED.includes(row.outcome)) { const list = groups.get(row.scheduleId) ?? []; list.push(row); groups.set(row.scheduleId, list); }
  for (const list of groups.values()) list.sort((a, b) => a.at - b.at);
  return groups;
}

/**
 * Lane C's pairs (ModularRSI confirm.py: "paired on the SAME task"): within one schedule, each corrected occurrence is set
 * against the good one (approved, or the user replied without correcting) closest to it in time, each good one used once
 * while any are left. What differs between two runs of the same task is the cleanest contrast the evolution has.
 * @returns {{ scheduleId: string, bad: object, good: object }[]}
 */
export function pairOccurrences(rows) {
  const pairs = [];
  for (const [scheduleId, list] of scheduleGroups(rows)) {
    const bad = list.filter(row => row.outcome === 'corrected'), good = list.filter(row => GOOD.has(row.outcome)), used = new Set();
    for (const row of bad) {
      const near = [...good].sort((a, b) => Number(used.has(a.id)) - Number(used.has(b.id)) || Math.abs(a.at - row.at) - Math.abs(b.at - row.at))[0];
      if (near) { used.add(near.id); pairs.push({ scheduleId, bad: row, good: near }); }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------------- harm
const rate = list => (list.length ? list.filter(row => BAD.has(row.outcome)).length / list.length : null);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
/**
 * Whether the work of the schedules got worse after `since` (a generation's time), PAIRED on the same schedule
 * (ModularRSI confirm.py `paired_delta` / `find_regressions`): only schedules with settled occurrences on both sides count,
 * each schedule's before rate and after rate is the share of its settled occurrences the user corrected, took back or voted
 * down, and each compared schedule weighs equally. The sides are equal windows of `n` occurrences, `n` the smaller side, at most
 * HARM_WINDOW: the last `n` BEFORE the generation (so ancient history does not dilute the baseline) against the `n` right AFTER
 * it (`onset`: what the rule's appearance did) and the last `n` (`after`: what is happening now). It is `harmful` only when work
 * was worse in both: a rule is not blamed for a regression that began long after it, when older rules would otherwise be judged on
 * the same recent window as the newest one, and a recovery shows (the early rough period is not the baseline). A schedule is compared
 * only with at least `minShared` matched pairs of its own (confirm.py counts shared TASKS; Rna's repetition is the occurrence of one
 * schedule), so with at least `minShared` of them one flipped result moves the delta by at most a third, below the margin. `shared` is
 * the number of matched pairs summed over the compared schedules; it is `harmful` only with a delta above `margin` on both windows.
 * Occurrences nobody answered, runs that failed and the weather are counted on neither side.
 * `latestAt`: the newest occurrence in the windows; `latestBadAt`: the newest corrected / undone / voted-down one in them — a later
 * reading has more evidence of harm only when this moved (a clean occurrence of some other schedule is no evidence).
 * @returns {{ shared: number, schedules: number, before: { rate: number|null, settled: number }, onset: { rate: number|null }, after: { rate: number|null, settled: number }, delta: number|null, onsetDelta: number|null, latestAt: number|null, latestBadAt: number|null, harmful: boolean }}
 */
export function harmAssessment(rows, since, { minShared = HARM_MIN_SHARED, margin = HARM_MARGIN, window = HARM_WINDOW } = {}) {
  const compared = [];
  for (const list of scheduleGroups(rows).values()) {
    const before = list.filter(row => row.at < since), after = list.filter(row => row.at >= since), n = Math.min(before.length, after.length, window);
    if (n > 0 && n >= minShared) compared.push({ before: before.slice(-n), onset: after.slice(0, n), after: after.slice(-n) });
  }
  if (!compared.length) return { shared: 0, schedules: 0, before: { rate: null, settled: 0 }, onset: { rate: null }, after: { rate: null, settled: 0 }, delta: null, onsetDelta: null, latestAt: null, latestBadAt: null, harmful: false };
  const before = mean(compared.map(row => rate(row.before))), onset = mean(compared.map(row => rate(row.onset))), after = mean(compared.map(row => rate(row.after))), delta = after - before, onsetDelta = onset - before;
  const shared = compared.reduce((sum, row) => sum + row.before.length, 0), seen = compared.flatMap(row => [...row.onset, ...row.after]), bad = seen.filter(row => BAD.has(row.outcome));
  return { shared, schedules: compared.length, before: { rate: before, settled: shared }, onset: { rate: onset }, after: { rate: after, settled: shared }, delta, onsetDelta, latestAt: Math.max(...seen.map(row => row.at)), latestBadAt: bad.length ? Math.max(...bad.map(row => row.at)) : null, harmful: shared >= minShared && delta > margin && onsetDelta > margin };
}

// ------------------------------------------------------------------- generations and the scoreboard
const tally = events => {
  const out = { corrected: 0, undone: 0, disliked: 0, approved: 0, accepted: 0, failed: 0 };
  for (const row of events) if (row.outcome in out) out[row.outcome]++;
  const bad = out.corrected + out.undone + out.disliked, known = bad + out.approved + out.accepted;
  return { ...out, bad, known, rate: known ? bad / known : null };
};
/**
 * What happened to the work while each generation was the newest one (a project-wide, honest line: confounded by anything
 * else that changed, so it only raises questions): the share of reacted work the user corrected between one generation and
 * the next, against the epoch before it. `events`: { at (ms), outcome } of foreground turns and of deliveries of runs.
 */
export function generationOutcomes(generations, events, { now = Date.now(), limit = 12 } = {}) {
  const list = [...(generations ?? [])].filter(row => ms(row?.at) !== null).sort((a, b) => ms(a.at) - ms(b.at));
  const epochs = list.map((row, index) => {
    const from = ms(row.at), to = index + 1 < list.length ? ms(list[index + 1].at) : now;
    return { n: row.n, at: row.at, summary: row.summary ?? '', trigger: row.trigger ?? null, ...tally(events.filter(event => event.at >= from && event.at < to)) };
  });
  return epochs.map((row, index) => ({ ...row, before: index > 0 ? { bad: epochs[index - 1].bad, known: epochs[index - 1].known, rate: epochs[index - 1].rate } : null }))
    .slice(-limit).reverse();
}
/** The schedules a gene was written for (the run its correction was about, or the runs a contrast analysis was built from). */
export const geneScope = gene => (Array.isArray(gene?.origin?.scheduleIds) ? [...new Set(gene.origin.scheduleIds.filter(id => typeof id === 'string' && id))] : []);
/**
 * rrsi's prediction scoreboard (loop.py:159-176, `attribute`: each edit's prediction scored against what then happened),
 * from recorded outcomes only. A patch says what the user should see change (`expectation`) and which task it is for; the
 * row sets the settled occurrences of that task before and after its generation side by side. `held`: it was exposed or
 * caught something and nothing was corrected again; `again`: a correction on the task or on the same point came after it;
 * `pending`: nothing has happened yet. (Whether the words of the expectation came true is not judged here.)
 */
export function scoreboard(project, rows, { limit = 20 } = {}) {
  const generations = new Map((project?.genes?.generations ?? []).map(row => [row.n, row]));
  const out = [];
  for (const gene of project?.genes?.genes ?? []) {
    if (!(gene?.layer === 'skill' && /^skill-patch:/.test(String(gene.id)) || gene?.layer === 'guard') || !['active', 'trial', 'retired'].includes(gene.status) || !Number.isSafeInteger(gene.generation)) continue;
    const at = ms(generations.get(gene.generation)?.at ?? gene.createdAt); if (at === null) continue;
    const scope = geneScope(gene), mine = scope.length ? rows.filter(row => scope.includes(row.scheduleId) && SETTLED.includes(row.outcome)) : [];
    const before = tally(mine.filter(row => row.at < at)), after = tally(mine.filter(row => row.at >= at));
    const stats = gene.stats ?? {}, again = (stats.missed ?? 0) > 0 || after.bad > 0;
    const held = !again && ((stats.applied ?? 0) > 0 || (stats.real ?? 0) > 0 || after.known > 0);
    out.push({ geneId: gene.id, layer: gene.layer, title: gene.title ?? '', generation: gene.generation, at: generations.get(gene.generation)?.at ?? gene.createdAt, status: gene.status, expectation: gene.body?.expectation ?? '', ...(scope.length ? { scope: { kind: 'schedule', ids: scope }, before: { bad: before.bad, known: before.known }, after: { bad: after.bad, known: after.known } } : { scope: { kind: 'foreground' } }),
      applied: stats.applied ?? 0, real: stats.real ?? 0, missed: stats.missed ?? 0, verdict: again ? 'again' : held ? 'held' : 'pending' });
  }
  return out.sort((a, b) => b.generation - a.generation).slice(0, limit);
}

// ------------------------------------------------------------------------------ dispositions
/**
 * What became of a lesson that was routed (ModularRSI dispositions.py, "what became of a finding that never became a
 * proposal"): a terminal verdict about it (`covered`, `profile_only`, `conflicts_rule`, `author_skipped`, `rejected`,
 * `schedule`), a retryable stop that the weather caused (`author_error`, `interrupted`, `guard_cap`), still waiting
 * (`awaiting`: not routed yet or waiting for a confirmation), or `gene` — it became a rule, with the rule's id and status.
 * Only verdicts are terminal: a failed author call or a restart is retryable, never a verdict on the lesson. Derived from the
 * route the lesson carries (`lesson.geneRoute`) and the rules in the registry; nothing is stored for it.
 * @returns {{ kind: 'gene'|'terminal'|'retryable'|'pending', code: string, geneId?: string, status?: string, attempts?: number }}
 */
export function lessonDisposition(project, lesson) {
  const route = lesson?.geneRoute ?? {}, registry = project?.genes?.genes ?? [];
  const tries = registry.filter(row => row.origin?.lessonId === lesson?.id), gene = route.geneId ? registry.find(row => row.id === route.geneId) : null;
  const live = [gene, ...tries].find(row => row && ['active', 'trial'].includes(row.status));
  if (live) return { kind: 'gene', code: live.layer === 'guard' ? 'guard' : 'practice', geneId: live.id, status: live.status };
  if (route.coveredBy) return { kind: 'terminal', code: 'covered' };
  if (route.consolidated === 'duplicate') return { kind: 'terminal', code: 'covered', ...(route.geneId ? { geneId: route.geneId } : {}) };
  if (route.conflictsWith || route.disposition === 'conflicts_rule') return { kind: 'terminal', code: 'conflicts_rule' };
  if (route.retry) return { kind: 'retryable', code: route.retry.code ?? 'author_error', attempts: route.retry.attempts ?? 0 };
  if (route.guardCapAt && !route.geneId) return { kind: 'retryable', code: 'guard_cap' };
  if (route.scheduleOfferedAt) return { kind: 'terminal', code: 'schedule' };
  if (route.version === undefined) return { kind: 'pending', code: lesson?.needsConfirmation ? 'awaiting_confirmation' : 'not_routed' };
  if (route.guard === false && route.method === false) return { kind: 'terminal', code: 'profile_only' };
  const last = [gene, ...tries].filter(Boolean).at(-1);
  if (last?.status === 'rejected') return last.rejection?.retryable === true ? { kind: 'retryable', code: last.rejection.code ?? 'rejected', geneId: last.id } : { kind: 'terminal', code: 'rejected', ...(last.rejection?.code ? { reason: last.rejection.code } : {}), geneId: last.id };
  if (last?.status === 'retired') return { kind: 'terminal', code: 'retired', geneId: last.id };
  if (typeof route.disposition === 'string') return { kind: 'terminal', code: route.disposition };
  if (route.method === true || route.guard === true) return { kind: 'pending', code: 'to_write' };
  return { kind: 'terminal', code: 'profile_only' };
}
/** Lessons that are routable and their dispositions, counted (the doctor's and the evolution page's line), with the newest few not yet rules: ids and codes only, never the lesson's words. */
export function dispositionSummary(project, { limit = 8 } = {}) {
  const counts = { gene: {}, terminal: {}, retryable: {}, pending: {} }, open = [];
  for (const lesson of project?.mind?.lessons ?? []) {
    if (!['constraint', 'preference', 'pitfall'].includes(lesson.kind)) continue;
    // A lesson that left has its own verdict: the user said the opposite later (`contradicted`: C4, mu's "the latest word"), a later
    // lesson took its place, the user revoked it, or it ran out.
    if (lesson.status !== 'active') {
      const left = lesson.status === 'superseded' ? (['contradicts', 'user_chose'].includes(lesson.supersededReason) ? 'contradicted' : 'superseded') : lesson.status === 'retired' ? (lesson.retiredReason === 'expired' ? 'expired' : 'revoked') : null;
      if (left) counts.terminal[left] = (counts.terminal[left] ?? 0) + 1;
      continue;
    }
    const row = lessonDisposition(project, lesson);
    counts[row.kind][row.code] = (counts[row.kind][row.code] ?? 0) + 1;
    if (row.kind !== 'gene') open.push({ lessonId: lesson.id, at: lesson.updatedAt ?? lesson.createdAt ?? null, ...row });
  }
  open.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return { counts, recent: open.slice(0, limit) };
}
/**
 * What became of the rules that are no longer in force (ModularRSI dispositions.py: typed, and only verdicts are terminal): the
 * retired by how they left (`retiredAs`, project-genes.mjs GENE_FATES; `unrecorded` for one retired before it was written
 * down) and the rejected by the gate that stopped them (`rejection.code`; a stop the weather caused is `retryable`, never a verdict).
 * Counts only; the system strand's records are problems, not rules.
 */
export function geneFates(project) {
  const retired = {}, rejected = {}, retryable = {};
  for (const gene of project?.genes?.genes ?? []) {
    if (!gene || gene.layer === 'system' || !(['skill', 'guard'].includes(gene.layer) || /^skill-(patch|merge):/.test(String(gene.id)))) continue;
    if (gene.status === 'retired') { const fate = gene.retiredAs ?? 'unrecorded'; retired[fate] = (retired[fate] ?? 0) + 1; }
    else if (gene.status === 'rejected') { const code = gene.rejection?.code ?? 'unrecorded', group = gene.rejection?.retryable === true ? retryable : rejected; group[code] = (group[code] ?? 0) + 1; }
  }
  return { retired, rejected, retryable };
}
