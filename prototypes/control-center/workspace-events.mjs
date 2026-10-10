// "The user undid X", for the models (rollback awareness). A user's undo is durable state — the apply records of
// project.git.applies, and the legacy background change / direct fix rows a revert marked `reverted` — but nothing
// turned it into model context: the next foreground turn kept trusting its earlier tool results, and background work
// read an intentional undo as a missing apply and proposed to put it back (live, 2026-10-04: a rolled-back turn
// "only in the conversation copy, sync it back"; a reverted change set "was not auto-applied, add it back by hand").
//
// This pure module derives the events in code (nothing here needs a judgment) for two channels that never wake
// anything: the foreground's tail context update (RuntimeController.prepareRequest, key `workspace-reversions`) and
// the initiative decision snapshot (`workspaceEvents`, a VOLATILE key, never an evidence source), which background
// work also reads as its project evidence.
//
// An event, newest first: { id, at, kind, owner: { sessionId?, turnId?, agentId?, actionId? }, target, paths, files,
//   partial?, skipped?, undoes?, undoneLater? }
//   turn_rolled_back     a rollback record with `undoesTurn` (回退本轮)
//   record_rolled_back   a rollback of one applied record (the apply history), or an interrupted apply's
//                        "go back to before" (a resolve record with `undoes`)
//   worker_dropped       a worker's merged records rolled back by dropping it (its delegation is `dropped`)
//   background_reverted  a background change set or direct fix reverted (git records, or legacy `reverted` rows)
//   discarded            the changes panel's discard (`user_discard`)
//   rollback_undone      a rollback of an undoing record: the changes it had undone are back (`undoes` = that event)
// `id` is the undoing record's apply id (`change:<id>` / `fix:<id>` for legacy rows); `target` is project_folder or
// conversation_copy (a worker dropped from a worktree conversation's own copy); `undoneLater` marks an undo the user
// reversed since. Owners whose conversation is gone or archived lose their session fields (apply rows outlive deleted
// conversations; their ids are not evidence any more), and the event stays: the project folder still changed.
//
// Only the user's undos: an undoing record's `initiator` (set by the engine from its caller) must be 'user'. A record
// written before the field existed (0.63.x) counts as the user's: every undo then was, except the model's own
// agent_merge drop, which is recognised by that tool call in the conversation (legacyInitiator).
//
// A direct fix runs as the action `<actionId>-direct` (directHandle), so its records name that id; owners name the
// finding's own action, as the older direct-fix rows do, so the events and the action receipts agree.

export const WORKSPACE_EVENT_KINDS = Object.freeze(['turn_rolled_back', 'record_rolled_back', 'worker_dropped', 'background_reverted', 'discarded', 'rollback_undone']);
export const WORKSPACE_EVENTS_LIMIT = 8;
export const REVERSIONS_CONTEXT_KEY = 'workspace-reversions', REVERSIONS_SOURCE = 'host-workspace-events';
/** How far back the initiative snapshot looks: older undos are settled history, not a reason to hold back work. */
export const SNAPSHOT_HORIZON_MS = 7 * 86400000;
const PATHS = 8, SKIPPED = 8, CHAIN = 8;
const OWNER_KEYS = ['sessionId', 'turnId', 'agentId', 'actionId'];
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
/** The SDK action a record's actionId stands for: a direct fix's `<actionId>-direct` is its finding's action. */
const baseAction = id => id.replace(/-direct$/, '');
const ownerOf = source => Object.fromEntries(OWNER_KEYS.filter(key => typeof source?.[key] === 'string' && source[key]).map(key => [key, key === 'actionId' ? baseAction(source[key]) : source[key]]));
/** A record that itself undid something: undoing it brings that back. Shared with readers that label apply records. */
export const undoingRecord = row => row?.kind === 'rollback' || row?.kind === 'user_discard' || (row?.kind === 'resolve' && Boolean(row.undoes));
export const undoing = undoingRecord;
/** What each apply record undid: the record its `undoes` names, or for a multi-record rollback (none named) one it settled. */
export function undoneLookup(rows) {
  const byId = new Map(rows.map(row => [row.id, row])), settledBy = new Map();
  for (const row of rows) if (row?.rolledBackBy && !settledBy.has(row.rolledBackBy)) settledBy.set(row.rolledBackBy, row);
  return row => (row.undoes ? byId.get(row.undoes) : row.undoesTurn ? null : settledBy.get(row.id)) ?? null;
}
const targetOf = row => (row.target === 'project' ? 'project_folder' : String(row.target ?? '').startsWith('session:') ? 'conversation_copy' : null);
const skippedOf = rows => (Array.isArray(rows) ? rows : []).slice(0, SKIPPED).map(row => ({ path: String(row.path ?? row), reason: String(row.reason ?? 'changed_after') }));

/**
 * The owner of what a record undid: the record named by `undoes` (or, for a multi-record rollback, which names none,
 * a record it settled), followed through rollbacks of rollbacks to the original write (a turn's, a worker's, a
 * background run's); `undoesTurn` names its turn. Older rollbacks kept only sessionId / turnId of what they undid, so
 * the chain is read instead of trusting the rollback's own source alone.
 */
function chainOwner(row, undoneOf) {
  let current = row;
  for (let depth = 0; depth < CHAIN && current; depth++) {
    if (current.undoesTurn) return { ...ownerOf(current.source), turnId: current.undoesTurn };
    const undone = undoneOf(current);
    if (!undone) return ownerOf(current.source);
    if (!undoing(undone)) return { ...ownerOf(current.source), ...ownerOf(undone.source) };
    current = undone;
  }
  return ownerOf(current?.source);
}
function kindOf(row, undone, droppedAgents) {
  if (row.kind === 'user_discard') return 'discarded';
  if (row.kind === 'resolve') return 'record_rolled_back';
  if (row.undoesTurn) return 'turn_rolled_back';
  if (undone && undoing(undone)) return 'rollback_undone';
  const source = undone?.source ?? row.source ?? {};
  if (source.agentId && droppedAgents.has(source.agentId)) return 'worker_dropped';
  // A background run's records carry its actionId (a multi-record revert names only that, without `undoes`).
  if (undone ? undone.kind === 'background' : Boolean(source.actionId)) return 'background_reverted';
  return 'record_rolled_back';
}
/** Workers whose card or agent_merge drop settled them (`merge.status: 'dropped'`), by agent id. */
function droppedWorkers(state, projectId) {
  const dropped = new Set();
  for (const session of state?.sessions ?? []) if (session.projectId === projectId) for (const turn of session.turns ?? []) for (const row of turn.delegations ?? []) if (row?.merge?.status === 'dropped' && row.id) dropped.add(row.id);
  return dropped;
}
/**
 * What the conversations' own agent_merge calls dropped (any status but failed: a refused drop undid nothing): the
 * workers by agent id, and the background change sets handed to a conversation by their records and their run.
 */
function modelDrops(state, project) {
  const agents = new Set(), records = new Set(), actions = new Set(), changes = new Map((project.backgroundChanges ?? []).map(row => [row?.id, row]));
  for (const session of state?.sessions ?? []) if (session.projectId === project.id) for (const item of session.items ?? []) {
    const tool = item?.kind === 'tool' ? item.tool : null;
    if (tool?.name !== 'agent_merge' || tool.args?.action !== 'drop' || tool.status === 'failed') continue;
    if (typeof tool.args.agentId === 'string') agents.add(tool.args.agentId);
    const change = typeof tool.args.changeId === 'string' ? changes.get(tool.args.changeId) : null;
    if (!change) continue;
    for (const id of [change.applyId, ...(Array.isArray(change.applyIds) ? change.applyIds : [])]) if (typeof id === 'string') records.add(id);
    if (typeof change.actionId === 'string') actions.add(change.actionId);
  }
  return { agents, records, actions };
}
/**
 * Who asked for an undoing record written before `initiator` existed (0.63.x): the model when it undid a worker or a
 * background change set that a conversation's own agent_merge drop names, the user otherwise. `drops` is lazy: the
 * conversations are read only when such an old record is in the window.
 */
function legacyInitiator(row, undone, drops) {
  if (row.kind !== 'rollback') return 'user';
  const source = undone?.source ?? row.source ?? {}, { agents, records, actions } = drops();
  if (typeof source.agentId === 'string' && agents.has(source.agentId)) return 'agent';
  if (undone && records.has(undone.id)) return 'agent';
  return (undone ? undone.kind === 'background' : true) && typeof source.actionId === 'string' && actions.has(source.actionId) ? 'agent' : 'user';
}
const legacyEvent = (id, at, owner, files, outcome) => {
  const skipped = [...(outcome?.conflicts ?? []).map(path => ({ path, reason: 'changed_after' })), ...(outcome?.failed ?? []).map(path => ({ path, reason: 'failed' }))];
  const list = Array.isArray(files) ? files : [];
  return { id, at, kind: 'background_reverted', owner, target: 'project_folder', paths: list.slice(0, PATHS).map(row => String(row.path)), files: list.length, ...(skipped.length ? { partial: true, skipped: skippedOf(skipped) } : {}) };
};

/**
 * Every user undo of a project after `since` (ms; null: all retained), newest first, unbounded: the base the
 * bounded views and the turn / action annotations are cut from.
 * @param {object} state  the store state (sessions decide whose owners are live)
 * @param {object} project
 * @param {{ since?: number|null }} [options]
 * @returns {object[]}
 */
export function deriveWorkspaceEvents(state, project, { since = null } = {}) {
  if (!project) return [];
  const rows = project.git?.applies ?? [], droppedAgents = droppedWorkers(state, project.id), undoneOf = undoneLookup(rows);
  const live = new Set((state?.sessions ?? []).filter(session => !session.archivedAt).map(session => session.id));
  const after = at => { const value = time(at); return value !== null && (since === null || value > since); };
  let drops = null; const dropsOf = () => (drops ??= modelDrops(state, project));
  const events = [];
  rows.forEach((row, index) => {
    if (!['rollback', 'user_discard', 'resolve'].includes(row?.kind) || (row.kind === 'resolve' && !row.undoes)) return;
    if (['writing', 'interrupted'].includes(row.state) || (row.initiator ?? 'user') !== 'user' || !after(row.at)) return;
    const target = targetOf(row); if (!target) return;
    const undone = undoneOf(row);
    if (row.initiator == null && legacyInitiator(row, undone, dropsOf) !== 'user') return;
    const kind = kindOf(row, undone, droppedAgents);
    const skipped = skippedOf(row.skipped);
    events.push({ index, event: { id: row.id, at: row.at, kind, owner: kind === 'discarded' ? {} : chainOwner(row, undoneOf), target, paths: (row.sample ?? []).slice(0, PATHS), files: Number.isSafeInteger(row.files) ? row.files : (row.sample ?? []).length,
      ...(row.partial === true || skipped.length ? { partial: true } : {}), ...(skipped.length ? { skipped } : {}), ...(kind === 'rollback_undone' ? { undoes: undone.id } : {}), ...(row.state === 'rolled_back' ? { undoneLater: true } : {}) } });
  });
  // Older change sets and direct fixes (no apply records): their row's own `reverted` mark. A git set's or git fix's
  // undo is its records' rollback above, so those rows are not counted twice.
  for (const change of project.backgroundChanges ?? []) if (change?.kind !== 'git' && change?.status === 'reverted' && after(change.revertedAt)) events.push({ index: -1, event: legacyEvent(`change:${change.id}`, change.revertedAt, ownerOf({ actionId: change.actionId }), change.files, change.outcome) });
  for (const fix of project.directFixes ?? []) if (fix?.kind !== 'git' && fix?.status === 'reverted' && after(fix.settledAt)) events.push({ index: -1, event: legacyEvent(`fix:${fix.id}`, fix.settledAt, ownerOf({ actionId: fix.actionId }), fix.files, fix.outcome) });
  for (const { event } of events) if (event.owner.sessionId && !live.has(event.owner.sessionId)) { const { sessionId: _s, turnId: _t, agentId: _a, ...rest } = event.owner; event.owner = rest; }
  return events.sort((a, b) => (time(b.event.at) - time(a.event.at)) || b.index - a.index).map(row => row.event);
}

/** The newest `limit` user undos after `since`, optionally only those `relevant` answers true for. */
export function workspaceEvents(state, project, { since = null, limit = WORKSPACE_EVENTS_LIMIT, relevant = null } = {}) {
  const events = deriveWorkspaceEvents(state, project, { since });
  return (relevant ? events.filter(relevant) : events).slice(0, limit);
}

/** The newest undo still in effect of one turn's own file changes (not its workers'), as a recentTurns annotation. */
export function turnReversion(events, sessionId, turnId) {
  const event = events.find(row => !row.undoneLater && ['turn_rolled_back', 'record_rolled_back'].includes(row.kind) && row.owner.sessionId === sessionId && row.owner.turnId === turnId && !row.owner.agentId);
  return event ? { at: event.at, kind: event.kind, ...(event.partial ? { partial: true } : {}) } : null;
}
/** The newest revert still in effect of one background run's changes, as an actionReceipts annotation. */
export function actionReversion(events, actionId) {
  const event = events.find(row => !row.undoneLater && row.kind === 'background_reverted' && row.owner.actionId === actionId);
  return event ? { at: event.at, ...(event.partial ? { partial: true } : {}) } : null;
}

const SNAPSHOT_MEANING = 'Undos the user made to project files (host records, newest first, the last 7 days). The files as they are now are what the user wants. A finding, handoff or plan that says these changes are missing, not applied or only in a conversation copy is outdated: do not re-apply, sync back or propose re-adding them unless the user asks. undoneLater: the user reversed that undo, so those changes are back (a rollback_undone event says the same). continuity.recentTurns[].undone and actionReceipts[].changesReverted mark the turns and background runs whose file changes the user undid.';
/**
 * The initiative snapshot's `workspaceEvents` (a VOLATILE key: it changes only when the user undoes something or an
 * undo ages out), or null when there is none. `events` is the deriveWorkspaceEvents list for SNAPSHOT_HORIZON_MS.
 */
export function snapshotWorkspaceEvents(events) {
  if (!events.length) return null;
  return { events: events.slice(0, WORKSPACE_EVENTS_LIMIT).map(({ owner, ...event }) => ({ ...event, ...owner })), ...(events.length > WORKSPACE_EVENTS_LIMIT ? { omitted: events.length - WORKSPACE_EVENTS_LIMIT } : {}), meaning: SNAPSHOT_MEANING };
}

const FOREGROUND_INSTRUCTION = 'After your earlier replies in this conversation, the user undid these file changes (host records, oldest first, times in UTC). The files as they are now are what the user wants. Your earlier tool results, claims and summaries about these paths are outdated: read a file again before relying on it, and do not re-apply, recreate or sync back these changes unless the user asks for them. Kinds: turn_rolled_back = all file changes of one earlier turn; record_rolled_back = one applied change; worker_dropped = a subagent\'s merged work; background_reverted = changes made by background work; discarded = edits discarded in the changes panel; rollback_undone = the user reversed an earlier undo (undoes names it), so those changes are back. partial: only some files were undone; skipped lists files left as they were. target conversation_copy: this conversation\'s own working copy rather than the project folder. This is context, not a new request.';
/** One event as the foreground reads it: whose change it was, relative to this conversation (ids it cannot use are left out). */
function conversationView({ owner, ...event }, sessionId) {
  const whose = owner.sessionId === sessionId ? 'this_conversation' : owner.actionId ? 'background_work' : owner.sessionId ? 'another_conversation' : null;
  return { ...event, ...(whose ? { whose } : {}), ...(whose === 'this_conversation' && owner.agentId ? { agentId: owner.agentId } : {}) };
}

/** The key's value once its window is empty again (see reversionsContextUpdate): one constant text. */
const SETTLED_TEXT = JSON.stringify({ reversions: [], instruction: 'No file changes were undone since your previous reply; earlier undo notices from this source describe past undos, not new ones. This is context, not a new request.' });

/**
 * The undo ids this conversation was already told about: those its earlier `workspace-reversions` messages listed (the
 * SDK journal is what the model was actually sent, and it survives restarts), or null when the key was never sent.
 * @param {object[]} messages  the SDK session's messages (prepareRequest's snapshot.messages)
 * @returns {Set<string>|null}
 */
export function deliveredReversions(messages = []) {
  let delivered = null;
  for (const message of messages ?? []) {
    if (message?.contextKey !== REVERSIONS_CONTEXT_KEY) continue;
    delivered ??= new Set();
    for (const part of message.context ?? []) { try { for (const row of JSON.parse(part?.text ?? '').reversions ?? []) if (typeof row?.id === 'string') delivered.add(row.id); } catch { /* not a reversions text */ } }
  }
  return delivered;
}

/**
 * The foreground's tail context update: the user's undos in this conversation's window that concern it — its own
 * changes (any target), plus every undo in the project folder when the conversation works there (a worktree
 * conversation gets project-folder files through its turn-start sync, and other owners' undos are not its business).
 *
 * The window opens when the turn before the previous one ended (for the conversation's second turn, when its first
 * began), not when the previous turn ended: an undo made while that turn was finishing, after its last request (its
 * final reply streaming, its review, its hand-back), is in no other window. Windows therefore overlap, so the update
 * is sent only when the window holds an undo the conversation was not told about yet (`delivered`); its text is then
 * the whole window, oldest first, a pure function of the records (the SDK appends a text once per key + revision).
 *
 * `delivered` (deliveredReversions): when the key was sent before and its window is empty again, the update is the
 * constant SETTLED_TEXT (appended once): the key's last value is what a compaction restores right after its summary,
 * and an old undo notice there would read as current.
 *
 * The key accumulates (FOLD-1): each copy lists undos no later copy repeats, so a later copy (another window, the
 * settled text) never supersedes it — the notices stay unfolded and in summary records, and the model keeps knowing
 * the user undid those changes after the window moved on.
 * @param {object} state
 * @param {{ sessionId: string, turnId: string, projectFolder?: boolean, delivered?: Set<string>|null }} options
 * @returns {{ key: string, source: string, text: string, accumulates: true }|null}
 */
export function reversionsContextUpdate(state, { sessionId, turnId, projectFolder = true, delivered = null } = {}) {
  const session = state?.sessions?.find(row => row.id === sessionId), project = session && state.projects?.find(row => row.id === session.projectId);
  if (!project) return null;
  const turns = session.turns ?? [], index = turns.findIndex(row => row.id === turnId);
  if (index < 1) return null;
  const from = index > 1 ? turns[index - 2] : null, since = from ? time(from.completedAt ?? from.pausedAt ?? from.createdAt) : time(turns[0].createdAt);
  if (since === null) return null;
  const events = workspaceEvents(state, project, { since, relevant: event => event.owner.sessionId === sessionId || (projectFolder && event.target === 'project_folder') });
  if (!events.length) return delivered ? { key: REVERSIONS_CONTEXT_KEY, source: REVERSIONS_SOURCE, accumulates: true, text: SETTLED_TEXT } : null;
  if (delivered && events.every(event => delivered.has(event.id))) return null;
  return { key: REVERSIONS_CONTEXT_KEY, source: REVERSIONS_SOURCE, accumulates: true, text: JSON.stringify({ reversions: events.reverse().map(event => conversationView(event, sessionId)), instruction: FOREGROUND_INSTRUCTION }) };
}
