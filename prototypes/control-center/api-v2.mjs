import { planView } from './project-mind.mjs';
import { createHash } from 'node:crypto';
import { DomainError } from './store.mjs';
import { liveBus } from './live-bus.mjs';
import { registeredWorkspacePath } from './workspace-directories.mjs';
import { projectRhythmStatus } from './project-rhythm.mjs';
import { projectInitiativeAvailability } from './project-initiative-availability.mjs';
import { describeEvolutionAssessment } from './project-evolution-assessment.mjs';
import { publicSessionDeletions } from './session-deletion.mjs';
import { projectMemorySyncStatus } from './memory-sync-status.mjs';
import { mindCounts, mindSummary } from './project-mind.mjs';
import { genesForming } from './project-genes.mjs';
import { scheduleReceiptsView } from './project-schedule-service.mjs';
import { interfaceLanguageOf } from './interface-language.mjs';
import { backgroundWorkView } from './project-background-controls.mjs';
import { PENDING as MEMORY_WRITE_PENDING } from './memory-sync-status.mjs';
import {
  INDEX_PROTOCOL, SESSION_SUMMARY_FIELDS, PROJECT_SUMMARY_FIELDS, ARCHIVED_PROJECT_SUMMARY_FIELDS, MEMORY_SUMMARY_FIELDS, INITIALIZATION_FIELDS,
  SKILL_FOUNDATION_FIELDS, INITIATIVE_RUNTIME_FIELDS, SCHEDULE_FIELDS, pick, rhythmStatusRow, scheduleRuntimeRow,
} from './index-schema.mjs';
import { SESSION_FIELDS, TAIL_WINDOW, PAGE_LIMIT, sessionMeta, turnView, turnBoundaries, tailStart, pageStart, waitingForUser } from './session-schema.mjs';

// Host interface v2 (docs/specs/stream-protocol-v2.md §1–2). Read-only views and a typed SSE stream; every reader
// (web, CLI, desktop) uses them. /api/state, /api/projects, /api/sessions and /api/stream are legacy (server.mjs).
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const digest = json => createHash('sha1').update(json ?? 'undefined').digest('base64');
const bytes = value => Buffer.byteLength(value);
// Provider presets serve the settings catalog (GET /api/configuration); keep them out of every bootstrap/index payload.
const publicConfiguration = store => { const { providerPresets: _presets, ...rest } = store.configurationService.public(); return rest; };
// Left out of GET /api/v2/projects/:id unless asked for with ?include= (index rows are allowlists: index-schema.mjs).
export const PROJECT_HEAVY = ['versions', 'jobs', 'decisions', 'learningRuntime', 'observations', 'memorySessions', 'facts', 'inbox', 'mind', 'genes', 'taskMarks', 'schedulePauseAsks', 'backgroundChanges', 'diagnostics'];
const PROJECT_INCLUDE = new Set([...PROJECT_HEAVY, 'initiativeRuntime']);
export const MAX_EVENT_BYTES = 64 * 1024;
const DELTA_CHUNK = 8000; // ≤ 8000 UTF-16 units stays far below 64KB even with JSON escaping.

// A conversation's subagents for the tasks panel (layout plan H5), counted over its latest 20 turns that delegated;
// the rows themselves come from GET /api/v2/sessions/:id/agents when a group is opened.
const AGENT_TURNS = 20;
function sessionAgents(turns = []) {
  const agents = { running: 0, total: 0, tokens: 0, latestTurnId: null };
  for (let index = turns.length - 1, seen = 0; index >= 0 && seen < AGENT_TURNS; index--) {
    const rows = turns[index].delegations;
    if (!Array.isArray(rows) || !rows.length) continue;
    seen++; agents.latestTurnId ??= turns[index].id;
    for (const row of rows) { agents.total++; if (row.status === 'running') agents.running++; agents.tokens += Math.max(0, Number(row.usage?.totalTokens) || 0); }
  }
  return agents;
}
// Index rows (stream-protocol-v2 §1): explicit allowlists from index-schema.mjs, each a function of committed state.
// The committed state is frozen, so a row is cached by its record's identity, as itemDigest/turnEntry are below:
// an untouched session or project is neither projected nor serialized again on the next diff.
const memoryWrites = outbox => {
  let pending = 0, failed = 0;
  for (const write of outbox) { if (MEMORY_WRITE_PENDING.has(write?.status)) pending++; else if (write?.status === 'failed') failed++; }
  return { total: outbox.length, pending, failed };
};
function sessionRow(session) {
  const items = session.items ?? [], last = items.at(-1), runtime = session.runtime;
  // The newest settled message: a reply still streaming changes with each display tick, which the index never sees.
  const message = items.findLast(item => (item.kind === 'user' || item.kind === 'assistant') && item.streaming !== true && typeof item.text === 'string' && item.text.trim());
  // For the sidebar dot (plan §2.4): cards still waiting for the user, and when the last proactive message arrived.
  let waiting = 0; for (const item of items) if (waitingForUser(item)) waiting++;
  const initiative = items.findLast(item => item.source === 'initiative' && !item.sourceDeleted);
  const derived = {
    kind: session.kind === 'side' ? 'side' : 'main', parentSessionId: session.parentSessionId ?? null, activeTurnId: session.activeTurnId ?? null,
    runtime: runtime ? { engine: runtime.engine ?? null, sdkVersion: runtime.sdkVersion ?? null, projectVersionId: runtime.projectVersionId ?? null, updatedAt: runtime.updatedAt ?? null } : null,
    itemCount: items.length, lastItemAt: last?.createdAt ?? null, preview: message ? message.text.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
    inboxCount: (session.inbox ?? []).length, waiting, lastInitiativeAt: initiative?.createdAt ?? null, agents: sessionAgents(session.turns),
    // The memory pipeline's evidence outbox (51% of the 0.67 bootstrap) as counts; its rows stay on the host.
    memoryEvidence: Array.isArray(session.memoryEvidenceOutbox) && session.memoryEvidenceOutbox.length ? memoryWrites(session.memoryEvidenceOutbox) : undefined,
  };
  const row = {};
  for (const key of SESSION_SUMMARY_FIELDS) { const value = Object.hasOwn(derived, key) ? derived[key] : session[key]; if (value !== undefined) row[key] = value; }
  return row;
}
const sessionRows = new WeakMap();
function sessionEntry(session) {
  let entry = sessionRows.get(session);
  if (entry) return entry;
  const row = sessionRow(session);
  entry = { row, json: JSON.stringify(row) };
  if (Object.isFrozen(session)) sessionRows.set(session, entry);
  return entry;
}
/** A session's index row (shared and read-only: serialize it, never edit it). */
export const sessionSummary = session => sessionEntry(session).row;

// Parts shared by the index row and the project route.
function projectCounts(project, now) {
  const versions = project.versions ?? [], jobs = project.jobs ?? [];
  return { versions: versions.length, jobs: jobs.length, openTasks: jobs.filter(job => ['queued', 'running', 'paused'].includes(job.status)).length, observations: Array.isArray(project.observations) ? project.observations.length : 0, decisions: Array.isArray(project.decisions) ? project.decisions.length : 0, facts: Array.isArray(project.facts) ? project.facts.length : 0, inbox: Array.isArray(project.inbox) ? project.inbox.length : 0, inboxUnread: Array.isArray(project.inbox) ? project.inbox.filter(row => row.status === 'unread' && !row.contextRevoked).length : 0, ...mindCounts(project, { now }) };
}
const workspacePathOf = project => { try { return registeredWorkspacePath(project.workspace); } catch { return null; } };
const activeVersionOf = project => { const active = (project.versions ?? []).find(version => version.id === project.activeVersionId); return active ? { id: active.id, version: active.version ?? null, title: active.title ?? null } : null; };
// Background change sets (plan §4.4), slim: what changed and whether it can still be reverted.
// 0.63: a set from a background worktree (`kind: 'git'`) rolls back through its apply records and may wait (deferred)
// or hold conflicts (merge_conflicted). The line needs why it waits (`hold`: deferred | blocked | read_only) and
// whether its card was already handed to a conversation (`handedTo`); the rest of its bookkeeping (handoff, card,
// retryAt, report, …) stays on the host.
const backgroundChangesView = project => (project.backgroundChanges ?? []).slice(-12).map(row => ({ id: row.id, actionId: row.actionId, at: row.at, status: row.status, count: row.files?.length ?? 0, paths: (row.files ?? []).slice(0, 8).map(file => file.path),
  ...(row.kind === 'git' ? { kind: 'git', applyId: row.applyId ?? null, applyIds: Array.isArray(row.applyIds) ? row.applyIds.filter(id => typeof id === 'string').slice(0, 20) : row.applyId ? [row.applyId] : [], worktreeId: row.worktreeId ?? null,
    ...(Array.isArray(row.conflicts) && row.conflicts.length ? { conflicts: row.conflicts.slice(0, 50).map(item => ({ path: item.path, kind: item.kind })) } : {}),
    ...(typeof row.hold === 'string' ? { hold: row.hold } : {}), ...(typeof row.handedTo === 'string' ? { handedTo: row.handedTo } : {}) } : {}) }));
// Isolation (worktree design 0.63 §11): only the composer switch's default and the git-init receipt; apply records
// and worktree rows (hundreds of rows) are read through …/applies and …/worktrees.
const gitView = project => { const git = project.git; return { sessionWorktreeDefault: git?.sessionWorktreeDefault === true, init: git?.init ? { at: git.init.at, by: git.init.by, commit: git.init.commit, branch: git.init.branch } : null }; };
// Current initiative state: scalars plus the model selection and the admission, never SDK history.
function initiativeView(state, project) {
  const runtime = project.initiativeRuntime ?? {}, initiative = Object.fromEntries(Object.entries(runtime).filter(([, value]) => value === null || typeof value !== 'object'));
  if (runtime.modelSelection) initiative.modelSelection = clone(runtime.modelSelection);
  let availability;
  if (project.decisionMode === 'rna-model') { availability = projectInitiativeAvailability(state, project); initiative.availability = availability; if (availability.state === 'blocked') initiative.status = 'blocked'; }
  return { initiative, availability, runtime };
}

/** A project's index row: the allowlist of index-schema.mjs (an archived project's short one). */
export function projectSummary(store, project, { now = Date.now() } = {}) {
  const state = store.state, derived = { workspacePath: workspacePathOf(project), counts: projectCounts(project, now) };
  if (project.archivedAt) {
    const row = {};
    for (const key of ARCHIVED_PROJECT_SUMMARY_FIELDS) { const value = Object.hasOwn(derived, key) ? derived[key] : project[key]; if (value !== undefined) row[key] = value; }
    return row;
  }
  const language = interfaceLanguageOf(state), part = (value, fields) => value && typeof value === 'object' ? pick(value, fields) : value;
  // Background runs for the tasks panel (layout plan H2): running ones and the last day's finished ones, slim.
  const work = backgroundWorkView(project, { now, language }), runs = [...(work?.running ?? []), ...(work?.recent ?? [])];
  Object.assign(derived, {
    activeVersion: activeVersionOf(project),
    // A gene being formed or checked (geneTree.forming), so the evolution tab can show it without fetching the tree.
    genesForming: genesForming(project, now),
    initialization: part(project.initialization, INITIALIZATION_FIELDS), skillFoundation: part(project.skillFoundation, SKILL_FOUNDATION_FIELDS),
    memorySummary: part(project.memorySummary, MEMORY_SUMMARY_FIELDS),
    rhythmStatus: rhythmStatusRow(projectRhythmStatus(state, project, { now })),
    initiativeRuntime: pick(initiativeView(state, project).initiative, INITIATIVE_RUNTIME_FIELDS),
    schedules: Array.isArray(project.schedules) ? project.schedules.map(row => pick(row, SCHEDULE_FIELDS)) : project.schedules,
    scheduleRuntime: project.scheduleRuntime ? scheduleRuntimeRow(project.scheduleRuntime, { runKeys: runs.map(run => run.occurrenceKey).filter(Boolean), runActions: runs.map(run => run.id) }) : project.scheduleRuntime,
    // The working plan (plan layer §4.1): the task page and sidebar stay live without a fetch. Each row names the
    // background run that staged or finished it (a run card's 计划项 x/y).
    plan: planView(project.mind ?? {}, { done: 3, owners: true, stale: true }), work, backgroundChanges: backgroundChangesView(project), git: gitView(project),
  });
  const row = {};
  for (const key of PROJECT_SUMMARY_FIELDS) { const value = Object.hasOwn(derived, key) ? derived[key] : project[key]; if (value !== undefined) row[key] = value; }
  return row;
}
// What a project's row reads besides the project itself: its conversations (rhythm), the admission inputs and the
// interface language. Equal parts by identity mean an equal row, except for values that pass a time boundary
// (a lane falling due, an overdue commitment, a run leaving the last day): `fresh` reads skip the cache for those.
const projectDeps = (state, project) => [state.emergency ?? null, state.configuration, state.settings, state.sessionDeletions, ...state.sessions.filter(row => row.projectId === project.id)];
const projectRows = new WeakMap();
function projectEntry(store, project, { now = Date.now(), fresh = false } = {}) {
  const deps = projectDeps(store.state, project), cached = projectRows.get(project);
  if (!fresh && cached && cached.deps.length === deps.length && cached.deps.every((value, index) => value === deps[index])) return cached;
  const row = projectSummary(store, project, { now }), entry = { deps, row, json: JSON.stringify(row) };
  if (Object.isFrozen(project)) projectRows.set(project, entry);
  return entry;
}

/**
 * GET /api/v2/projects/:id: the project as stored, without the heavy fields unless `include` names them, plus the
 * index row's derived parts at full size (presence, planning receipts, the whole rhythm status and schedule history).
 */
export function projectDetail(store, project, { now = Date.now(), include = [] } = {}) {
  const state = store.state, summary = {};
  for (const [key, value] of Object.entries(project)) if (!PROJECT_HEAVY.includes(key) && key !== 'initiativeRuntime' && key !== 'git') summary[key] = clone(value);
  // Planning receipts read as the user reads them: an older row's next run in local words, not a UTC instant (C2-f).
  if (Array.isArray(project.scheduleManagementReceipts)) summary.scheduleManagementReceipts = clone(scheduleReceiptsView(project, interfaceLanguageOf(state)));
  summary.presence = store.presences?.get(project.id) ?? null;
  summary.workspacePath = workspacePathOf(project);
  summary.rhythmStatus = projectRhythmStatus(state, project, { now });
  summary.plan = planView(project.mind ?? {}, { done: 3, owners: true, stale: true });
  summary.work = backgroundWorkView(project, { now, language: interfaceLanguageOf(state) });
  summary.backgroundChanges = backgroundChangesView(project);
  summary.git = gitView(project);
  const { initiative, availability, runtime } = initiativeView(state, project);
  summary.initiativeRuntime = initiative;
  summary.counts = projectCounts(project, now);
  summary.activeVersion = activeVersionOf(project);
  summary.genesForming = genesForming(project, now);
  for (const key of include) {
    if (key === 'initiativeRuntime') { summary.initiativeRuntime = { ...clone(runtime), ...(availability ? { availability, ...(availability.state === 'blocked' ? { status: 'blocked' } : {}) } : {}) }; continue; }
    if (project[key] === undefined) continue;
    summary[key] = clone(project[key]);
    if (key === 'versions') for (const version of summary.versions ?? []) if (version.simulated !== true) version.assessment = describeEvolutionAssessment(version, { activeVersionId: project.activeVersionId, project });
  }
  return summary;
}
// Deep links (inbox ↔ conversation): where an item sits in its session, and
// which inbox entries point at it (a delivered message, a question card, or a
// daily digest that merged several entries).
export function itemLocation(store, session, index) {
  const item = session.items[index], project = store.state.projects.find(row => row.id === session.projectId);
  const interactionId = item.interaction?.id ?? null, digestIds = item.initiative?.kind === 'digest' && Array.isArray(item.initiative.entryIds) ? item.initiative.entryIds : [];
  const linked = (project?.inbox ?? []).filter(entry => !entry.contextRevoked && (digestIds.includes(entry.id) || entry.digestItemId === item.id || entry.sessionId === session.id && (entry.itemId === item.id || interactionId && entry.interactionId === interactionId)));
  return {
    position: { index, count: session.items.length, turnId: item.turnId ?? null },
    inboxEntries: linked.map(entry => ({ id: entry.id, kind: entry.kind, tier: entry.tier, status: entry.status, relation: digestIds.includes(entry.id) || entry.digestItemId === item.id ? 'digest' : entry.interactionId && entry.interactionId === interactionId ? 'question' : 'message', createdAt: entry.createdAt })),
    ...(digestIds.length ? { digest: { entryIds: [...digestIds] } } : {}),
  };
}
/**
 * GET /api/v2/sessions/:id: the session's record and turns as allowlisted (session-schema.mjs), with every item, or
 * with `window: 'tail'` only the newest whole turns (≥50 messages and ≥2 turns, ≤500 messages) and the turns they need:
 * theirs, the active one, and any turn no item names. `window` says what was left out (zcode rowsWindowSchema).
 * - `from`: the first item a client already holds, when it reads again (a resync, a reconnect): the window reaches
 *   back to it, so the older pages the reader had read stay, fresh. An item no longer there is ignored.
 * - `pinned`: cards older than the window still waiting for the user (the composer's strip points at them; the index
 *   row's `waiting` counts the same ones); absent when there are none.
 */
export function sessionView(store, session, { window = null, from = null } = {}) {
  const items = session.items ?? [];
  let start = 0, referenced = null;
  if (window === 'tail') {
    const cut = turnBoundaries(items); referenced = cut.referenced; start = tailStart(items, TAIL_WINDOW, cut.bounds);
    if (from !== null && start > 0) { const held = items.findIndex(item => item.id === from); if (held >= 0 && held < start) start = held; }
  }
  const shown = start ? items.slice(start) : items, ids = new Set();
  if (start) for (const item of shown) if (item?.turnId) ids.add(item.turnId);
  const turns = (session.turns ?? []).filter(turn => !start || ids.has(turn.id) || turn.id === session.activeTurnId || !referenced.has(turn.id)).map(turn => turnEntry(turn).view);
  const pinned = [];
  for (let index = 0; index < start; index++) if (waitingForUser(items[index])) pinned.push(items[index]);
  return { ...sessionMeta(session), items: shown, turns, revision: store.state.revision, window: { totalCount: items.length, firstItemId: items[0]?.id ?? null, hasMore: start > 0 }, ...(pinned.length ? { pinned } : {}) };
}
/**
 * GET /api/v2/sessions/:id/items?before=&limit=: the page of at most `limit` (≤200) items just before `before` (the
 * newest ones without it), from a turn boundary when one lies inside the page, with the turns its items name.
 */
export function sessionPage(store, session, { before = null, limit = PAGE_LIMIT } = {}) {
  const items = session.items ?? [], end = before === null ? items.length : items.findIndex(item => item.id === before);
  if (end < 0) throw Object.assign(new DomainError('条目不存在', 404), { code: 'item_not_found' });
  const start = pageStart(items, end, limit), page = items.slice(start, end), ids = new Set();
  for (const item of page) if (item?.turnId) ids.add(item.turnId);
  return { revision: store.state.revision, sessionId: session.id, items: page, turns: (session.turns ?? []).filter(turn => ids.has(turn.id)).map(turn => turnEntry(turn).view), hasMore: start > 0, totalCount: items.length };
}
export function bootstrap(store, { maintenance = null, capabilities = { terminal: false, sideChat: false } } = {}) {
  const now = Date.now(), state = store.state;
  // Project rows are read afresh (a time boundary may have passed since the stream last diffed); session rows are pure.
  return { protocol: INDEX_PROTOCOL, revision: state.revision, capabilities, emergency: state.emergency ?? null, maintenance, configuration: publicConfiguration(store), settings: clone(state.settings), projects: state.projects.map(project => projectEntry(store, project, { now, fresh: true }).row), sessions: state.sessions.map(sessionSummary), sessionDeletions: publicSessionDeletions(state) };
}

// A streaming assistant item's text is carried by `delta` events. Excluding
// only those growing strings from its hash avoids resending the whole item
// every display tick; the block-end upsert always carries the full content.
const itemHashJson = item => item.kind === 'assistant' && item.streaming === true ? JSON.stringify({ ...item, text: undefined, thinking: item.thinking ? { ...item.thinking, text: undefined } : undefined }) : JSON.stringify(item);
// Committed items are frozen, so an untouched item keeps its identity and its digest.
const itemDigests = new WeakMap();
// A turn on the wire is its allowlisted view (session-schema.mjs TURN_FIELDS), projected, serialized and hashed once
// per committed turn: a change to host-only bookkeeping (memoryContext, memoryWrite, route, …) sends nothing.
const turnEntries = new WeakMap();
function turnEntry(turn) {
  let entry = turnEntries.get(turn);
  if (entry) return entry;
  const view = turnView(turn), json = JSON.stringify(view);
  entry = { view, json, hash: digest(json) };
  if (Object.isFrozen(turn)) turnEntries.set(turn, entry);
  return entry;
}
const itemDigest = item => { if (!Object.isFrozen(item)) return digest(itemHashJson(item)); let cached = itemDigests.get(item); if (cached === undefined) { cached = digest(itemHashJson(item)); itemDigests.set(item, cached); } return cached; };
// Committed state is immutable and shares unchanged subtrees, so a part's
// digest is cached by object identity (no re-serialization when untouched).
const MIND_PARTS = ['lessons', 'agenda', 'commitments', 'threads', 'findings', 'notes', 'pacing', 'health'], partDigests = new WeakMap();
const partDigest = value => { if (!value || typeof value !== 'object') return digest(JSON.stringify(value ?? null)); let cached = partDigests.get(value); if (!cached) { cached = digest(JSON.stringify(value)); partDigests.set(value, cached); } return cached; };
const mindParts = project => Object.fromEntries(MIND_PARTS.map(key => [key, partDigest(project.mind?.[key])]));
const frame = (seq, event, json) => `${seq === null ? '' : `id: ${seq}\n`}event: ${event}\ndata: ${json}\n\n`;

// One channel per scope (a session id, or '' for index-only). Connections on
// the same scope share its seq, diff baseline and replay ring buffer, so a
// reconnect with Last-Event-ID resumes exactly where the previous one stopped.
class Channel {
  constructor(hub, sessionId) {
    this.hub = hub; this.sessionId = sessionId; this.clients = new Set();
    // Seq starts at a time-derived base so ids from an earlier daemon never alias.
    this.seq = Date.now() * 1000; this.buffer = []; this.bufferBytes = 0;
    this.items = new Map(); this.turns = new Map(); this.fields = new Map(); this.missing = false; this.dirty = false; this.idle = null;
    if (sessionId) this.baseline();
  }
  session() { return this.hub.store.state.sessions.find(session => session.id === this.sessionId); }
  baseline() {
    const session = this.session(); this.items.clear(); this.turns.clear(); this.fields.clear();
    if (!session) { this.missing = true; return; }
    for (const item of session.items) this.items.set(item.id, itemDigest(item));
    for (const turn of session.turns) this.turns.set(turn.id, turnEntry(turn).hash);
    for (const key of SESSION_FIELDS) if (Object.hasOwn(session, key)) this.fields.set(key, digest(JSON.stringify(session[key])));
  }
  push(event, json) {
    const seq = ++this.seq, text = frame(seq, event, json), options = this.hub.options, now = Date.now();
    this.buffer.push({ seq, at: now, text }); this.bufferBytes += text.length;
    // Keep at least the last N events or the last retention window, within hard caps.
    while (this.buffer.length && (this.buffer.length > options.bufferEvents && now - this.buffer[0].at > options.retentionMs || this.buffer.length > options.bufferEvents * 10 || this.bufferBytes > options.bufferBytes)) this.bufferBytes -= this.buffer.shift().text.length;
    for (const client of this.clients) client.write(text);
  }
  resync(reason, extra = {}) { this.push('resync', JSON.stringify({ reason, ...(this.sessionId ? { sessionId: this.sessionId } : {}), ...extra })); }
  replay(lastId) {
    if (lastId === this.seq) return [];
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (!(lastId < this.seq) || lastId < oldest - 1) return null;
    return this.buffer.filter(entry => entry.seq > lastId).map(entry => entry.text);
  }
  // Emit rows in as many events as needed, each ≤ MAX_EVENT_BYTES.
  rows(event, prefix, key, jsons, ids) {
    const overhead = bytes(prefix) + key.length + 8, oversized = [];
    let batch = [], size = overhead;
    const send = () => { if (batch.length) this.push(event, `${prefix}"${key}":[${batch.join(',')}]}`); batch = []; size = overhead; };
    jsons.forEach((json, index) => {
      const length = bytes(json) + 1;
      if (length + overhead > MAX_EVENT_BYTES) { oversized.push(ids[index]); return; }
      if (size + length > MAX_EVENT_BYTES) send();
      batch.push(json); size += length;
    });
    send();
    return oversized;
  }
  diff() {
    this.dirty = false;
    const session = this.session();
    if (!session) { if (!this.missing) { this.missing = true; this.items.clear(); this.turns.clear(); this.fields.clear(); this.resync('session_missing'); } return; }
    if (this.missing) { this.baseline(); this.resync('session_restored'); return; }
    const revision = this.hub.store.state.revision, prefix = `{"revision":${revision},"sessionId":${JSON.stringify(session.id)},`;
    const seen = new Set(), upserts = [], upsertIds = [];
    for (const item of session.items) {
      seen.add(item.id);
      const hash = itemDigest(item);
      if (this.items.get(item.id) === hash) continue;
      this.items.set(item.id, hash); upserts.push(JSON.stringify(item)); upsertIds.push(item.id);
    }
    const removed = [...this.items.keys()].filter(id => !seen.has(id));
    for (const id of removed) this.items.delete(id);
    if (removed.length) for (let index = 0; index < removed.length; index += 1000) this.push('items.remove', `${prefix}"ids":${JSON.stringify(removed.slice(index, index + 1000))}}`);
    const tooLarge = this.rows('items.upsert', prefix, 'items', upserts, upsertIds);
    const turnJsons = [], turnIds = [], turnSeen = new Set();
    for (const turn of session.turns) {
      turnSeen.add(turn.id);
      const entry = turnEntry(turn);
      if (this.turns.get(turn.id) === entry.hash) continue;
      this.turns.set(turn.id, entry.hash); turnJsons.push(entry.json); turnIds.push(turn.id);
    }
    for (const id of [...this.turns.keys()]) if (!turnSeen.has(id)) this.turns.delete(id);
    const turnsTooLarge = this.rows('turns.upsert', prefix, 'turns', turnJsons, turnIds);
    // Only the allowlisted record (session-schema.mjs SESSION_FIELDS): the evidence outbox (197 KB on the novel
    // conversation) used to ride here and, over 64 KB, turn each of its changes into a resync and a full reload.
    const fields = [], fieldKeys = [];
    for (const key of SESSION_FIELDS) {
      if (!Object.hasOwn(session, key)) continue;
      const json = JSON.stringify(session[key]) ?? 'null', hash = digest(json);
      if (this.fields.get(key) === hash) continue;
      this.fields.set(key, hash); fields.push(`${JSON.stringify(key)}:${json}`); fieldKeys.push(key);
    }
    for (const key of [...this.fields.keys()]) if (!Object.hasOwn(session, key)) { this.fields.delete(key); fields.push(`${JSON.stringify(key)}:null`); fieldKeys.push(key); }
    let patch = [], size = bytes(prefix) + 16, fieldsTooLarge = [];
    const sendPatch = () => { if (patch.length) this.push('session.patch', `${prefix}"fields":{${patch.join(',')}}}`); patch = []; size = bytes(prefix) + 16; };
    fields.forEach((json, index) => {
      const length = bytes(json) + 1;
      if (length + bytes(prefix) + 16 > MAX_EVENT_BYTES) { fieldsTooLarge.push(fieldKeys[index]); return; }
      if (size + length > MAX_EVENT_BYTES) sendPatch();
      patch.push(json); size += length;
    });
    sendPatch();
    // An oversized row cannot be split without breaking "complete object"
    // semantics; tell clients exactly what to re-read instead.
    if (tooLarge.length || turnsTooLarge.length || fieldsTooLarge.length) this.resync('event_too_large', { ...(tooLarge.length ? { itemIds: tooLarge } : {}), ...(turnsTooLarge.length ? { turnIds: turnsTooLarge } : {}), ...(fieldsTooLarge.length ? { fields: fieldsTooLarge } : {}) });
  }
  live(event) {
    if (this.dirty) this.diff(); // the item a delta refers to is announced first
    if (event.type === 'turn.phase') return this.push('turn.phase', JSON.stringify({ sessionId: event.sessionId, turnId: event.turnId, phase: event.phase, ...(event.preparing ? { preparing: true } : {}), at: event.at }));
    if (event.type !== 'delta' || typeof event.append !== 'string') return;
    // `tool_args` deltas describe a pending (display-only) tool entry; the
    // metadata rides on every chunk, and a metadata-only change has no append.
    const tool = event.block === 'tool_args' && event.tool ? { tool: event.tool } : {};
    if (!event.append && tool.tool) return this.push('delta', JSON.stringify({ sessionId: event.sessionId, turnId: event.turnId, itemId: event.itemId, block: event.block, offset: event.offset, append: '', ...tool }));
    for (let index = 0; index < event.append.length; index += DELTA_CHUNK) {
      let end = Math.min(event.append.length, index + DELTA_CHUNK);
      // Never split a surrogate pair across events.
      if (end < event.append.length && /[\uD800-\uDBFF]/.test(event.append[end - 1])) end--;
      this.push('delta', JSON.stringify({ sessionId: event.sessionId, turnId: event.turnId, itemId: event.itemId, block: event.block, offset: event.offset + index, append: event.append.slice(index, end), ...tool }));
      index = end - DELTA_CHUNK;
    }
  }
}

export class StreamHub {
  constructor(store, { maintenance = () => null, bufferEvents = 2000, retentionMs = 60000, bufferBytes = 16 * 1024 * 1024, sessionDelayMs = 50, indexDelayMs = 100, idleMs = 60000, pollMs = 5000 } = {}) {
    this.store = store; this.maintenance = maintenance; this.options = { bufferEvents, retentionMs, bufferBytes, sessionDelayMs, indexDelayMs, idleMs };
    this.channels = new Map(); this.index = null; this.sessionTimer = null; this.indexTimer = null; this.closed = false;
    // Session channels follow every change, the display-only streaming ticks included (store.projectRuntimeDisplay);
    // the index follows commits only (a control listener), so a streamed reply never re-diffs every row each 100 ms.
    this.unsubscribe = store.subscribe(() => this.changed());
    this.unsubscribeIndex = store.subscribe(() => this.indexChanged(), { display: false });
    this.unsubscribeLive = liveBus(store).subscribe(event => {
      if (this.closed) return;
      // P3 desktop hook: an opted-in `notify` delivery goes to every connection
      // (index and session). Display-only; the inbox entry is the durable record.
      if (event.type === 'project.notify') { const json = JSON.stringify({ projectId: event.projectId, entryId: event.entryId, sessionId: event.sessionId ?? null, title: String(event.title ?? '').slice(0, 160), body: String(event.body ?? '').slice(0, 400), at: event.at }); for (const channel of this.channels.values()) channel.push('notify', json); return; }
      // A background run started a step (layout plan H3): display only, to every connection; the web reads it from the
      // index stream. Never persisted: after a reconnect the project summary's work.latest stands in.
      if (event.type === 'work.step') { const json = JSON.stringify({ projectId: event.projectId, actionId: event.actionId, toolCallId: event.toolCallId ?? null, name: String(event.name ?? '').slice(0, 128), kind: String(event.kind ?? 'other').slice(0, 32), target: typeof event.target === 'string' ? event.target.slice(0, 160) : null, status: 'running', at: event.at }); for (const channel of this.channels.values()) channel.push('work.step', json); return; }
      this.channels.get(event.sessionId)?.live(event);
    });
    // Maintenance state can change without a Store revision, and a row's time boundaries pass without one (a lane
    // falling due, a run leaving the last day): re-read the rows afresh periodically.
    this.poll = setInterval(() => { if (this.channels.size && !this.indexTimer) this.diffIndex({ fresh: true }); }, pollMs); this.poll.unref();
  }
  changed() {
    if (this.closed || !this.channels.size) return;
    for (const channel of this.channels.values()) if (channel.sessionId) channel.dirty = true;
    this.sessionTimer ??= setTimeout(() => { this.sessionTimer = null; for (const channel of this.channels.values()) if (channel.dirty) channel.diff(); }, this.options.sessionDelayMs);
  }
  indexChanged() {
    if (this.closed || !this.channels.size) return;
    this.indexTimer ??= setTimeout(() => { this.indexTimer = null; this.diffIndex(); }, this.options.indexDelayMs);
  }
  channel(sessionId) {
    let channel = this.channels.get(sessionId);
    if (!channel) { if (!this.channels.size) this.index = null; channel = new Channel(this, sessionId); this.channels.set(sessionId, channel); if (!this.index) this.diffIndex({ baseline: true, fresh: true }); }
    clearTimeout(channel.idle); channel.idle = null;
    return channel;
  }
  release(channel, client) {
    channel.clients.delete(client);
    if (channel.clients.size || this.closed) return;
    // Retain the ring buffer for the resume window, then drop the channel.
    channel.idle = setTimeout(() => { if (!channel.clients.size && this.channels.get(channel.sessionId) === channel) this.channels.delete(channel.sessionId); }, this.options.idleMs); channel.idle.unref?.();
  }
  // `fresh`: re-read project rows instead of reusing them by identity (the periodic poll and a new baseline).
  diffIndex({ baseline = false, fresh = false } = {}) {
    if (this.closed) return;
    const store = this.store, state = store.state, now = Date.now(), previous = this.index, next = { projects: new Map(), sessions: new Map(), extras: new Map(), minds: new Map() };
    const changed = { projects: [], projectIds: [], sessions: [], sessionIds: [], minds: [] }, extras = {};
    for (const project of state.projects) {
      const entry = projectEntry(store, project, { now, fresh }), hash = entry.hash ??= digest(entry.json); next.projects.set(project.id, hash);
      if (previous?.projects.get(project.id) !== hash) { changed.projects.push(entry.json); changed.projectIds.push(project.id); }
      // K1: `project.mind` { projectId, revision, counts, health, changed[], … } whenever the mind changes.
      if (!entry.mind) { const summary = mindSummary(project, { now }); entry.mind = { summary, hash: digest(JSON.stringify(summary)) }; }
      const { summary, hash: mindHash } = entry.mind, parts = mindParts(project), before = previous?.minds?.get(project.id);
      next.minds.set(project.id, { hash: mindHash, parts });
      if (previous && before?.hash !== mindHash && (project.mind || before)) { const { projectId: _id, ...rest } = summary; changed.minds.push(JSON.stringify({ revision: state.revision, projectId: project.id, ...rest, changed: MIND_PARTS.filter(key => before?.parts?.[key] !== parts[key]) })); }
    }
    for (const session of state.sessions) {
      const entry = sessionEntry(session), hash = entry.hash ??= digest(entry.json); next.sessions.set(session.id, hash);
      if (previous?.sessions.get(session.id) !== hash) { changed.sessions.push(entry.json); changed.sessionIds.push(session.id); }
    }
    for (const [key, value] of [['maintenance', this.maintenance()], ['emergency', state.emergency ?? null], ['settings', state.settings], ['configuration', publicConfiguration(store)], ['sessionDeletions', publicSessionDeletions(state)]]) {
      const json = JSON.stringify(value) ?? 'null', hash = digest(json); next.extras.set(key, hash);
      if (previous?.extras.get(key) !== hash) extras[key] = json;
    }
    this.index = next;
    if (baseline || !previous) return;
    const removed = { projects: [...previous.projects.keys()].filter(id => !next.projects.has(id)), sessions: [...previous.sessions.keys()].filter(id => !next.sessions.has(id)) };
    const head = `{"revision":${state.revision},`, oversized = { projects: [], sessions: [], fields: [] };
    const extra = Object.entries(extras).filter(([key, json]) => bytes(json) + bytes(head) + 64 <= MAX_EVENT_BYTES / 2 || !oversized.fields.push(key)).map(([key, json]) => `"${key}":${json}`);
    const removedJson = removed.projects.length || removed.sessions.length ? `"removed":${JSON.stringify({ ...(removed.projects.length ? { projects: removed.projects } : {}), ...(removed.sessions.length ? { sessions: removed.sessions } : {}) })}` : null;
    const payloads = [];
    let parts = [...extra, ...(removedJson ? [removedJson] : [])], lists = { projects: [], sessions: [] }, size = bytes(head) + parts.reduce((sum, part) => sum + bytes(part) + 1, 0) + 32;
    const flush = () => {
      const body = [...parts, ...['projects', 'sessions'].filter(key => lists[key].length).map(key => `"${key}":[${lists[key].join(',')}]`)];
      if (body.length) payloads.push(`${head}${body.join(',')}}`);
      parts = []; lists = { projects: [], sessions: [] }; size = bytes(head) + 64;
    };
    for (const key of ['projects', 'sessions']) changed[key].forEach((json, index) => {
      const length = bytes(json) + 1;
      if (length + bytes(head) + 64 > MAX_EVENT_BYTES) { oversized[key].push(changed[key === 'projects' ? 'projectIds' : 'sessionIds'][index]); return; }
      if (size + length > MAX_EVENT_BYTES) flush();
      lists[key].push(json); size += length;
    });
    flush();
    const tooLarge = oversized.projects.length || oversized.sessions.length || oversized.fields.length ? JSON.stringify({ reason: 'event_too_large', ...(oversized.projects.length ? { projectIds: oversized.projects } : {}), ...(oversized.sessions.length ? { sessionIds: oversized.sessions } : {}), ...(oversized.fields.length ? { fields: oversized.fields } : {}) }) : null;
    for (const channel of this.channels.values()) { for (const json of payloads) channel.push('index', json); if (tooLarge) channel.push('resync', tooLarge); for (const json of changed.minds) channel.push('project.mind', json); }
  }
  close() {
    this.closed = true; this.unsubscribe(); this.unsubscribeIndex(); this.unsubscribeLive(); clearTimeout(this.sessionTimer); clearTimeout(this.indexTimer); clearInterval(this.poll);
    for (const channel of this.channels.values()) { clearTimeout(channel.idle); for (const client of channel.clients) client.close(); }
    this.channels.clear();
  }
}

export function createApiV2({ store, maintenance = () => null, capabilities = () => ({ terminal: false, sideChat: false }), streams = new Set(), maxStreams = 32, heartbeatMs = 15000, backlogBytes = 1024 * 1024, headers = {}, hub: hubOptions = {} } = {}) {
  const hub = new StreamHub(store, { maintenance, ...hubOptions });
  const findSession = id => store.state.sessions.find(session => session.id === id) ?? (() => { throw new DomainError('会话不存在', 404); })();
  function stream(req, res, url) {
    const sessionId = url.searchParams.get('session') ?? '';
    if (sessionId) findSession(sessionId);
    if (streams.size >= maxStreams) throw new DomainError('事件订阅过多', 429);
    const raw = req.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
    const lastId = raw === undefined || raw === null || raw === '' ? undefined : /^\d{1,17}$/.test(String(raw)) ? Number(raw) : NaN;
    res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const channel = hub.channel(sessionId);
    if (channel.dirty) channel.diff();
    // Backpressure: a client that cannot keep up is closed; it reconnects with
    // Last-Event-ID and is replayed from the ring buffer or told to resync.
    const client = {
      write(text) { if (res.destroyed || res.writableEnded) return; if (res.writableLength > backlogBytes) { res.end(); return; } res.write(text); },
      close() { if (!res.writableEnded) res.end(); }
    };
    // `maintenance`: the gate as the connection starts (later changes arrive in `index` events): a client that reads
    // only a conversation's stream, such as `rna watch --jsonl`, knows it without reading the bootstrap.
    client.write(frame(null, 'hello', JSON.stringify({ protocol: INDEX_PROTOCOL, revision: store.state.revision, seq: channel.seq, maintenance: maintenance() ?? null, ...(sessionId ? { sessionId } : {}) })));
    if (lastId !== undefined) {
      const frames = Number.isSafeInteger(lastId) ? channel.replay(lastId) : null;
      if (frames === null) client.write(frame(channel.seq, 'resync', JSON.stringify({ reason: 'resume_unavailable', ...(sessionId ? { sessionId } : {}) })));
      else for (const text of frames) client.write(text);
    }
    channel.clients.add(client); streams.add(res);
    const heartbeat = setInterval(() => { client.write(': hb\n\n'); }, heartbeatMs); heartbeat.unref();
    res.on('close', () => { clearInterval(heartbeat); streams.delete(res); hub.release(channel, client); });
  }
  function handle(req, res, { pathname, url, send }) {
    if (req.method !== 'GET' || !pathname.startsWith('/api/v2/')) return false;
    if (pathname === '/api/v2/bootstrap') { send(200, bootstrap(store, { maintenance: maintenance(), capabilities: capabilities() })); return true; }
    if (pathname === '/api/v2/stream') { stream(req, res, url); return true; }
    const item = pathname.match(/^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/items\/([a-zA-Z0-9_-]+)$/);
    if (item) { const target = findSession(item[1]), index = target.items.findIndex(row => row.id === item[2]); if (index < 0) throw new DomainError('条目不存在', 404); send(200, { revision: store.state.revision, sessionId: item[1], item: clone(target.items[index]), ...itemLocation(store, target, index) }); return true; }
    // Paging back from the tail window (zcode rows/range: limit 1–200).
    const page = pathname.match(/^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/items$/);
    if (page) {
      const target = findSession(page[1]), rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? PAGE_LIMIT : Number(rawLimit), before = url.searchParams.get('before');
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw Object.assign(new DomainError(`limit 必须为 1–${PAGE_LIMIT} 的整数`, 400), { code: 'page_limit_invalid' });
      send(200, sessionPage(store, target, { before: before || null, limit })); return true;
    }
    // A run's line in its conversation, held by the client or not (the tasks panel opens the conversation there): the
    // newest item a background run (`actionId`) or a scheduled run (`occurrenceKey`) reported on. 404 when it posted none.
    const locate = pathname.match(/^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/locate$/);
    if (locate) {
      const target = findSession(locate[1]), actionId = url.searchParams.get('actionId') || null, occurrenceKey = url.searchParams.get('occurrenceKey') || null;
      if (!actionId && !occurrenceKey) throw Object.assign(new DomainError('请提供 actionId 或 occurrenceKey', 400), { code: 'locate_invalid' });
      const index = target.items.findLastIndex(row => (actionId !== null && row.initiative?.backgroundWork?.actionId === actionId) || (occurrenceKey !== null && row.scheduleOccurrenceKey === occurrenceKey));
      if (index < 0) throw Object.assign(new DomainError('条目不存在', 404), { code: 'item_not_found' });
      send(200, { revision: store.state.revision, sessionId: target.id, itemId: target.items[index].id, position: { index, count: target.items.length, turnId: target.items[index].turnId ?? null } }); return true;
    }
    // The committed session is immutable: it is serialized once, by send, and never cloned first.
    const session = pathname.match(/^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)$/);
    if (session) {
      const window = url.searchParams.get('window'), from = url.searchParams.get('from') || null;
      if (window !== null && window !== 'tail') throw Object.assign(new DomainError('window 只支持 tail', 400), { code: 'window_invalid' });
      send(200, sessionView(store, findSession(session[1]), { window, from })); return true;
    }
    const project = pathname.match(/^\/api\/v2\/projects\/([a-zA-Z0-9-]+)$/);
    if (project) {
      const found = store.state.projects.find(row => row.id === project[1]);
      if (!found) throw new DomainError('项目不存在', 404);
      const include = (url.searchParams.get('include') ?? '').split(',').map(value => value.trim()).filter(Boolean);
      const unknown = include.filter(value => value !== 'all' && !PROJECT_INCLUDE.has(value));
      if (unknown.length) throw new DomainError(`不支持的 include：${unknown.join(', ')}`, 400);
      send(200, { ...projectDetail(store, found, { include: include.includes('all') ? [...PROJECT_INCLUDE] : include }), revision: store.state.revision }); return true;
    }
    const memorySync = pathname.match(/^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/memory-sync$/);
    if (memorySync) { const found = store.state.projects.find(row => row.id === memorySync[1]); if (!found) throw new DomainError('项目不存在', 404); send(200, { ...projectMemorySyncStatus(store.state, found), revision: store.state.revision }); return true; }
    if (pathname === '/api/v2/session-deletions') { send(200, { revision: store.state.revision, deletions: publicSessionDeletions(store.state) }); return true; }
    // Other /api/v2 routes (usage, model reasoning) are registered by their own modules later in server.mjs.
    return false;
  }
  return { handle, hub, close: () => hub.close() };
}
