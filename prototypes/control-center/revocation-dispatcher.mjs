import { REVOCATION_TYPES, recordRevocation, trimRevocations, grownGenes, lessonLink } from './project-mind.mjs';
import { writesOf } from './source-revocation.mjs';

// The revocation dispatcher (reference alignment §2.1 P2.1 / C4). Not a provenance graph: every reference keeps the links
// on the derived rows themselves and finds dependents by querying them (OpenViking resource refs and memory_diff, mu
// `source{session,turn}`, zcode originSessionId, headlong source_range), so a second store that mirrors them would drift.
// What is shared is the shape of a revocation, as OpenViking does it (resource_memory_link_service.py:355-430):
//   1. what came wholly from the revoked source is withdrawn mechanically (source-revocation.mjs withdrawSources for a
//      deleted or rewound conversation, in the caller's transaction; each subsystem's `settle` for the rest);
//   2. what mixed sources, or only restates it, is judged: ONE batch JEV call per kind of row (mind.judge `stale_<n>`) and
//      a confident answer marks the row stale (out of every model context, shown as stale, deleted by nobody);
//   3. a final assertion: nothing live is left that rests wholly on the revoked source.
// Typed events (REVOCATION_TYPES): session_deleted and message_rewound (a conversation or part of one is gone),
// lesson_revoked (the user took a lesson back, replaced it by a contradicting one, deleted it or rewrote it),
// tool_withdrawn (a check, a skill or a service left), change_reverted (the user undid file changes: the work that
// settled a plan item no longer stands), privacy_revoked (the project's privacy scope changed: what the old scope
// concluded is withdrawn). Each subsystem registers its own handler; a handler may have
//   settle(entry, ctx)            the subsystem's own mechanical withdrawal (async, after the transaction)
//   candidates(entry, ctx)        the rows that mixed sources or only restate the revoked thing: { kind, rows, revoked?, tools? } or null
//   apply(entry, set, stale, ctx) mark the rows the judgment called stale
//   assert(entry, ctx)            violations of "nothing live rests wholly on the revoked source" (the final assertion)
// A `settle` that cannot go on yet for a reason that is not a failure (the application is held for maintenance, a restore is
// under review, an older piece of work must wait for a newer one) throws an error with `defer: true` (`deferral(code)`): the
// entry waits and is looked at again after `retryMs` (default: the first backoff) and the attempt is not counted, so a wait
// of hours never runs an entry out of attempts. Its judge and assertion steps wait too.
// The file-write layer is `project.git.applies` itself (`writesOf`): who wrote which paths is read where it is recorded, never
// copied into a store of its own. A revocation of a conversation or a turn finds the files it wrote there (they stay: they
// are the project's), and a change the user undid (`change_reverted`) is read from the same records (workspace-events.mjs).
// A revocation is a durable entry in `project.mind.revocations` written in the same transaction as the revocation itself
// (a restart between the two finishes the work); its steps are retried with backoff; the conversations' context copies of
// what was withdrawn fold at once, at each conversation's next request (`contextRevocationsFor`).
export { REVOCATION_TYPES };

const iso = value => new Date(value).toISOString();
const RETRY_MS = Object.freeze([120000, 600000, 3600000]), MAX_ATTEMPTS = 5;
/** The error a handler's `settle` throws to say "not now, and that is not a failure" (see the file comment). */
export const deferral = (code, { retryMs = RETRY_MS[0] } = {}) => Object.assign(new Error(code), { code, defer: true, retryMs });
/** A lesson retired this way with a gene still running is a revocation that never reached it (the audit finds them). */
const AUDITED_REASONS = new Set(['user', 'user_revoked', 'source_removed']);

export class RevocationDispatcher {
  /**
   * `decisions`: the DecisionService (`mindStale`, `enabled`). `auditIntervalMs`: the periodic sweep and retry (0: none; tests
   * drive `sweep()`/`drain()` themselves).
   */
  constructor(store, { decisions = null, now = Date.now, auditIntervalMs = 60000 } = {}) {
    Object.assign(this, { store, decisions, now, auditIntervalMs });
    this.handlers = []; this.closed = false; this.running = new Map(); this.queued = new Set(); this.timer = null; this.scheduled = null; this.unsubscribe = null; this.lastError = null; this.abort = new AbortController();
  }
  /** Register a subsystem's handler (see the file comment); a later registration under the same name replaces the earlier. */
  register(handler) {
    if (!handler || typeof handler.name !== 'string' || !Array.isArray(handler.events) || handler.events.some(type => !REVOCATION_TYPES.includes(type))) throw new Error('A revocation handler needs a name and revocation event types.');
    this.handlers = [...this.handlers.filter(row => row.name !== handler.name), handler];
    return this;
  }
  handlersFor(type) { return this.handlers.filter(row => row.events.includes(type)); }
  project(id) { return this.store.state.projects.find(row => row.id === id) ?? null; }
  /** Subscribe to store changes (a revocation written in any transaction is picked up) and start the periodic audit. */
  start() {
    if (this.unsubscribe || this.closed) return this;
    this.unsubscribe = typeof this.store.subscribe === 'function' ? this.store.subscribe(() => this.kick(), { display: false }) : null;
    if (this.auditIntervalMs > 0) { this.timer = setInterval(() => { this.sweep(); this.kick(); }, this.auditIntervalMs); this.timer.unref?.(); }
    this.sweep(); this.kick();
    return this;
  }
  /** Settle what is waiting, soon and once (coalesced). */
  kick() {
    if (this.closed || this.scheduled || !this.pendingEntries().length) return;
    this.scheduled = setImmediate(() => { this.scheduled = null; void this.drain(); });
    this.scheduled.unref?.();
  }
  /** Unsettled entries that are due (not backing off), oldest first, with their project. */
  pendingEntries({ ignoreBackoff = false } = {}) {
    const out = [], at = this.now();
    for (const project of this.store.state.projects) for (const entry of project.mind?.revocations ?? []) {
      if (entry.settledAt || entry.failed && !ignoreBackoff) continue;
      if (!ignoreBackoff && Date.parse(entry.retryAt ?? 0) > at) continue;
      out.push({ projectId: project.id, entryId: entry.id, at: Date.parse(entry.at) || 0 });
    }
    return out.sort((a, b) => a.at - b.at);
  }
  /**
   * Record a revocation in its own transaction (an event that does not come from inside one) and start settling it.
   * Returns the entry. `event.projectId` names the project.
   */
  dispatch(event) {
    if (!REVOCATION_TYPES.includes(event?.type)) throw new Error(`unknown revocation: ${event?.type}`);
    let entry = null;
    this.store.mutate(state => { const project = state.projects.find(row => row.id === event.projectId); if (!project?.mind) return; entry = recordRevocation(project.mind, event, { now: this.now() }); });
    this.kick();
    return entry;
  }
  /** Settle every due entry, one project at a time in order; resolves when none is left to try now. Never throws. */
  async drain() {
    if (this.closed) return [];
    const done = [];
    for (const { projectId, entryId } of this.pendingEntries()) {
      if (this.closed) break;
      // An entry already queued or running is not queued again: a handler that saves progress in the store kicks a drain at
      // each save, and a second run behind the first one would count an attempt of its own (and ignore the first one's backoff).
      if (this.queued.has(`${projectId}:${entryId}`)) continue;
      try { done.push(await this.settle(projectId, entryId)); } catch (error) { this.lastError = error?.code ?? error?.message ?? 'revocation_failed'; }
    }
    return done;
  }
  /** Settle one entry (serialized per project). An entry that is backing off, or ran out of attempts, is left unless `force`. */
  settle(projectId, entryId, { force = false } = {}) {
    const key = projectId, previous = this.running.get(key) ?? Promise.resolve(), mark = `${projectId}:${entryId}`;
    this.queued.add(mark);
    const next = previous.catch(() => {}).then(() => this.settleEntry(projectId, entryId, { force })).finally(() => this.queued.delete(mark));
    this.running.set(key, next); next.finally(() => { if (this.running.get(key) === next) this.running.delete(key); }).catch(() => {});
    return next;
  }
  async settleEntry(projectId, entryId, { force = false } = {}) {
    const find = () => this.project(projectId)?.mind?.revocations?.find(row => row.id === entryId) ?? null;
    let entry = find(); if (!entry || entry.settledAt) return null;
    // Looked at again here, not only when it was picked: a run queued behind another one of the same entry finds that one's
    // backoff (or its last failure) and does nothing.
    if (!force && (entry.failed || Date.parse(entry.retryAt ?? 0) > this.now())) return null;
    const handlers = this.handlersFor(entry.type), signal = this.abort.signal, steps = { ...(entry.steps ?? {}) }, result = { ...(entry.result ?? {}) }; let failed = null, deferred = null;
    const ctx = { store: this.store, dispatcher: this, decisions: this.decisions, now: this.now, signal, project: () => this.project(projectId), projectId };
    // Step 1: each subsystem's own mechanical withdrawal.
    for (const handler of handlers) {
      if (typeof handler.settle !== 'function' || steps[handler.name] === 'done') continue;
      try { result[handler.name] = await handler.settle(structuredClone(entry), ctx) ?? true; steps[handler.name] = 'done'; }
      catch (error) {
        if (signal.aborted) return null;
        if (error?.defer === true) { deferred ??= error; steps[handler.name] = 'pending'; continue; }
        failed = error; steps[handler.name] = 'failed'; this.lastError = error?.code ?? error?.message ?? 'revocation_step_failed';
      }
    }
    // A wait is not a failure, but a failure of another handler is one whatever else waits.
    const waiting = failed ? null : deferred;
    // Step 2: the rows that mixed sources or only restate what was withdrawn, judged in one batch call per kind.
    if (steps.judged !== 'done' && !failed && !waiting) {
      let unanswered = false; const kinds = {};
      for (const handler of handlers) {
        if (typeof handler.candidates !== 'function') continue;
        const set = await handler.candidates(structuredClone(find() ?? entry), ctx);
        if (!set?.rows?.length) continue;
        // Without an active judge nothing is marked: the rows stay as they are (a shadow or off judge is an answer, not a failure).
        if (!this.decisions?.enabled?.('mind.judge')) { kinds[set.kind] = { rows: set.rows.length, judged: 'off' }; continue; }
        const verdict = await this.decisions.mindStale(this.project(projectId), { kind: set.kind, rows: set.rows, ...(set.revoked !== undefined ? { revoked: set.revoked } : {}), ...(set.tools ? { tools: set.tools } : {}), signal }).catch(error => { if (signal.aborted) throw error; return null; });
        if (!verdict) { unanswered = true; kinds[set.kind] = { rows: set.rows.length, judged: 'unavailable' }; continue; }
        const marked = await handler.apply?.(structuredClone(find() ?? entry), set, verdict.stale, ctx) ?? 0;
        kinds[set.kind] = { rows: set.rows.length, stale: marked, ledgerId: verdict.ledgerId ?? null };
      }
      result.judged = kinds;
      // A judge that did not answer is tried again with the entry's backoff; after the last attempt the rows stay unjudged.
      steps.judged = unanswered && (entry.attempts ?? 0) + 1 < 3 ? 'pending' : 'done';
    }
    // Step 3: the assertion.
    const violations = [];
    if (!failed && !waiting) for (const handler of handlers) if (typeof handler.assert === 'function') try { violations.push(...(await handler.assert(structuredClone(find() ?? entry), ctx) ?? [])); } catch (error) { if (signal.aborted) return null; this.lastError = error?.code ?? error?.message ?? 'revocation_assert_failed'; }
    result.violations = violations.length ? violations.slice(0, 20) : 0;
    const complete = !failed && handlers.every(handler => typeof handler.settle !== 'function' || steps[handler.name] === 'done') && steps.judged !== 'pending';
    const attempts = (entry.attempts ?? 0) + (complete || waiting ? 0 : 1), at = this.now();
    this.store.mutate(state => {
      const row = state.projects.find(project => project.id === projectId)?.mind?.revocations?.find(item => item.id === entryId); if (!row) return;
      Object.assign(row, { steps, result, attempts });
      if (waiting) row.waiting = String(waiting.code ?? 'waiting').slice(0, 80); else delete row.waiting;
      if (complete) { row.settledAt = iso(at); delete row.retryAt; delete row.failed; delete row.text; delete row.link; delete row.candidates; }
      else if (waiting) row.retryAt = iso(at + (Number.isFinite(waiting.retryMs) && waiting.retryMs > 0 ? waiting.retryMs : RETRY_MS[0]));
      else if (attempts >= MAX_ATTEMPTS) { row.failed = true; row.failure = String(failed?.code ?? failed?.message ?? 'incomplete').slice(0, 120); }
      else row.retryAt = iso(at + RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)]);
      trimRevocations(state.projects.find(project => project.id === projectId).mind, at);
    });
    if (complete && typeof this.onSettled === 'function') try { this.onSettled({ projectId, entryId, type: entry.type, result }); } catch { /* observers never block */ }
    return { projectId, entryId, type: entry.type, complete, violations: violations.length };
  }
  /**
   * The audit: a lesson retired by the user (or by a rewind) whose evolution rules still run is a revocation that never
   * reached them — written by an older version, or lost. Recorded once per lesson (`lesson.revocation`). Code only.
   * @returns {number} the entries recorded
   */
  sweep() {
    if (this.closed) return 0;
    const found = [];
    for (const project of this.store.state.projects) {
      if (project.simulated === true || !project.mind || !project.genes?.genes?.length) continue;
      for (const lesson of project.mind.lessons ?? []) if (lesson.status === 'retired' && AUDITED_REASONS.has(lesson.retiredReason) && !lesson.revocation && grownGenes(project, lesson, { derived: true }).length) found.push({ projectId: project.id, lessonId: lesson.id });
    }
    if (!found.length) return 0;
    try {
      this.store.mutate(state => {
        for (const { projectId, lessonId } of found) {
          const mind = state.projects.find(row => row.id === projectId)?.mind, lesson = mind?.lessons?.find(row => row.id === lessonId);
          if (lesson && !lesson.revocation) recordRevocation(mind, { type: 'lesson_revoked', lessonId, cause: lesson.retiredReason === 'source_removed' ? 'source_removed' : 'user_revoked', text: lesson.text, lesson }, { now: this.now() });
        }
      });
    } catch (error) { this.lastError = error?.code ?? 'revocation_audit_failed'; return 0; }
    this.kick();
    return found.length;
  }
  /** Resolves once everything started so far has finished (tests). */
  async idle() {
    for (let round = 0; round < 50; round++) {
      await Promise.allSettled([...this.running.values()]);
      if (!this.scheduled && !this.running.size) { if (!this.pendingEntries().length) return; await this.drain(); } else await new Promise(resolve => setImmediate(resolve));
    }
  }
  async close() {
    this.closed = true; this.abort.abort(); clearInterval(this.timer); clearImmediate(this.scheduled); this.unsubscribe?.();
    await Promise.allSettled([...this.running.values()]);
  }
}

// ----------------------------------------------------- conversations' context copies
/**
 * What a conversation's model must stop seeing, as the SDK's request hook takes it (`revokeContext`): the revocations of
 * the project with a context request that this conversation has not applied yet. Each is { id, contextKeys, sourceIds,
 * before }: the copies of those keys made no later than the revocation, and any copy carrying those source ids, fold to one
 * line at the conversation's next request (SDK `context_fold`, reason `revoked`).
 */
export function contextRevocationsFor(project, session, { limit = 16 } = {}) {
  const applied = new Set(session?.revocationsApplied ?? []);
  return (project?.mind?.revocations ?? []).filter(row => row.context && (row.context.keys?.length || row.context.sourceIds?.length) && !applied.has(row.id)).slice(0, limit)
    .map(row => ({ id: row.id, ...(row.context.keys?.length ? { contextKeys: row.context.keys.slice(0, 32) } : {}), ...(row.context.sourceIds?.length ? { sourceIds: row.context.sourceIds.slice(0, 64) } : {}), before: (Date.parse(row.at) || Date.now()) + 1 }));
}
/**
 * key → cut (ms) for every context key a revocation named that this conversation has applied, or is being asked to apply now
 * (`asking`, the list `contextRevocationsFor` just returned): copies of the key made no later than the cut are folded as
 * revoked, so the host must not treat them as what the model can see (host-context-updates.mjs `visibleContext`).
 */
export function revokedCopyCuts(project, session, asking = []) {
  const ids = new Set([...(session?.revocationsApplied ?? []), ...asking.map(row => row.id)]), cuts = new Map();
  for (const row of project?.mind?.revocations ?? []) if (ids.has(row.id)) for (const key of row.context?.keys ?? []) cuts.set(key, Math.max(cuts.get(key) ?? 0, (Date.parse(row.at) || Date.now()) + 1));
  return cuts;
}
/** The SDK handled these revocations for the conversation (its `context_revoke` event): they are not asked again. Inside a transaction. */
export function markContextRevoked(session, ids) {
  if (!session || !Array.isArray(ids) || !ids.length) return;
  session.revocationsApplied = [...new Set([...(session.revocationsApplied ?? []), ...ids.filter(id => typeof id === 'string')])].slice(-200);
}

export { lessonLink, writesOf };
