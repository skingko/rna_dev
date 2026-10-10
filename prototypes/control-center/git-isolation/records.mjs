import { randomBytes } from 'node:crypto';
import { LIMITS } from './contract.mjs';

// Apply records, checkpoints and crash recovery (design §3.6), retention (§5.3). Owner: T1.
//
// Records live in state.json under `project.git.applies[]` (at most LIMITS.appliesPerProject rows, small fields
// only; full file lists come from `diff-tree` when asked). No new sidecar: CHECKPOINT_SIDECARS is unchanged.
//
// Order of one apply: pin `before` (the target snapshot taken under the lock) → persist a `writing` row whose ref
// (REFS.apply(id)) holds [before, R] → write and verify → after = before's tree with only the written paths
// replaced → move the ref to [before, after] → mark `verified` (or `unverified`).
//
// "R" in a writing row's ref is the planned result: before with every planned path changed (conflicted paths are
// never planned), so crash recovery compares each planned path against exactly two contents.

/**
 * @typedef {object} ApplyRow  project.git.applies[] (design §11)
 * @property {string} id
 * @property {'turn'|'worker'|'background'|'resolve'|'rollback'|'user_discard'} kind
 * @property {string} target    APPLY_TARGET: 'project' | 'session:<id>' | 'background:<id>'
 * @property {{ sessionId?: string, turnId?: string, agentId?: string, actionId?: string, worktreeId?: string }} source
 * @property {'writing'|'verified'|'unverified'|'interrupted'|'rolled_back'|'expired'} state
 * @property {number} files
 * @property {number} added
 * @property {number} removed
 * @property {number} bothChanged
 * @property {string[]} sample   At most 20 paths.
 * @property {{ path: string, reason: string }[]} [skipped]  Files left as they were: on a rollback first those its plan
 *   left out (at most 20: `changed_after`, `conflict`, `unattributable`), then the write's own (conflict kinds,
 *   `mismatch`, `changed_during_merge`).
 * @property {string} at
 * @property {string} [undoes]       A rollback: the record it rolled back.
 * @property {string} [rolledBackBy] The rollback record that undid this one.
 * @property {string} [targetWorktreeId] An isolated target: its worktree record (crash recovery finds the folder).
 * @property {string[]} [pending]    A user_discard while writing: the discarded paths (dropped when settled).
 * @property {string} [undoesTurn]   A rollback of a whole turn: that turn.
 * @property {'user'|'agent'|'host'} [initiator]  An undoing record (rollback, a resolve with `undoes`): who asked for it,
 *   from the engine caller's option (APPLY_INITIATORS). Absent on older records and on other kinds.
 * @property {true} [partial]        A rollback limited to some files (`paths`): what it undid stays in effect for the rest.
 * @property {'verified'|'completed'|'interrupted'} [recovered]  Settled by startup recovery.
 * @property {{ sessionId: string, interactionId: string }} [card]  An interrupted row's "上次应用中断了" card.
 * @property {number} [ms]     How long the write took (review ISO-8): from the record's first durable step to its
 *   settling, file writes and the read-back check included (a discard: from its checkpoint to its settling); absent on
 *   rows startup recovery settled and on older rows.
 * @property {number} [bytes]  Content bytes the write put on disk (deletions count 0); absent where unknown (a
 *   discard's checkout, recovery).
 */

const SAMPLE = 20;
const KEEP_STATES = new Set(['writing', 'interrupted']);

/** A new apply id: `a` + 16 hex (a ref segment and a URL segment). */
export const newApplyId = () => `a${randomBytes(8).toString('hex')}`;

/** project.git with its lists (old state, or state T4's load defaults have not reached). */
export function gitOf(project) {
  project.git ??= { sessionWorktreeDefault: false, worktrees: [], applies: [] };
  project.git.applies ??= [];
  project.git.worktrees ??= [];
  return project.git;
}

/** Counts and a sample of a write: `files`, `added` (absent before), `removed`, `sample`. */
export function summarize(changes) {
  const files = changes.length, added = changes.filter(row => !row.old && row.next).length, removed = changes.filter(row => row.old && !row.next).length;
  return { files, added, removed, sample: changes.slice(0, SAMPLE).map(row => row.path) };
}

/**
 * Append a `writing` row (the checkpoint exists before any byte is written: invariant §0.3-1).
 * @param {import('../store.mjs').Store} store
 * @param {string} projectId
 * @param {Omit<ApplyRow, 'id'|'state'|'at'> & { id?: string }} row
 * @returns {string}  the new apply id
 */
export function beginApply(store, projectId, row) {
  const id = row.id ?? newApplyId(), at = new Date().toISOString();
  store.mutate(state => {
    const project = state.projects.find(item => item.id === projectId);
    if (!project) throw Object.assign(new Error('This project no longer exists.'), { status: 404, code: 'project_not_found' });
    const git = gitOf(project);
    git.applies.push({ files: 0, added: 0, removed: 0, bothChanged: 0, sample: [], ...row, id, state: 'writing', at });
    // Past the cap the oldest settled rows go (their refs are swept as orphans after the retention period).
    while (git.applies.length > LIMITS.appliesPerProject) {
      const index = git.applies.findIndex(item => !KEEP_STATES.has(item.state) && item.id !== id);
      if (index < 0) break;
      git.applies.splice(index, 1);
    }
  });
  return id;
}

/** Update a row in place (state, counts, sample, skipped, rolledBackBy). `undefined` values remove the field. */
export function settleApply(store, projectId, applyId, changes) {
  return store.mutate(state => {
    const row = state.projects.find(item => item.id === projectId)?.git?.applies?.find(item => item.id === applyId);
    if (!row) return null;
    for (const [key, value] of Object.entries(changes)) if (value === undefined) delete row[key]; else row[key] = value;
    return { ...row };
  });
}

/** Remove a row (an `all` write that raced and was fully put back leaves nothing to record). */
export function dropApply(store, projectId, applyId) {
  store.mutate(state => {
    const git = state.projects.find(item => item.id === projectId)?.git;
    if (git?.applies) git.applies = git.applies.filter(item => item.id !== applyId);
  });
}

/** One row by id, or null. */
export function applyRow(project, applyId) { return project?.git?.applies?.find(row => row.id === applyId) ?? null; }

/**
 * Rows of a project, newest first, filtered by the source's session / turn.
 * @param {object} project
 * @param {{ sessionId?: string, turnId?: string, limit?: number }} [filter]
 * @returns {ApplyRow[]}
 */
export function applyRows(project, { sessionId, turnId, limit } = {}) {
  const rows = (project?.git?.applies ?? []).filter(row => (!sessionId || row.source?.sessionId === sessionId) && (!turnId || row.source?.turnId === turnId));
  const newest = rows.map((row, index) => ({ row, index })).sort((a, b) => (Date.parse(b.row.at) - Date.parse(a.row.at)) || b.index - a.index).map(item => item.row);
  return Number.isInteger(limit) && limit > 0 ? newest.slice(0, limit) : newest;
}

/**
 * What the routes answer for a row (protocol §8.7 `ApplyRecord`): the row plus `rollback: { available, reason? }`.
 * Internal fields (pending paths, card ids) stay out.
 * @param {ApplyRow} row
 */
export function applyView(row) {
  const { pending: _pending, card: _card, targetWorktreeId: _worktree, ...view } = row;
  const reason = row.state === 'expired' ? 'expired' : row.target !== 'project' ? 'target' : ['writing', 'interrupted'].includes(row.state) ? 'interrupted' : row.state === 'rolled_back' || row.rolledBackBy ? 'rolled_back' : null;
  return { ...structuredClone(view), rollback: reason ? { available: false, reason } : { available: true } };
}

/**
 * Startup recovery of every `writing` row (design §3.6): all paths at R → verified; only before and R present →
 * finish the paths still at before; a third content → `interrupted` and the HOST_CARDS.interrupted card.
 * @param {import('./index.mjs').IsolationEngine} engine
 * @returns {Promise<{ verified: string[], completed: string[], interrupted: string[] }>}
 */
export async function recoverApplies(engine) {
  const outcome = { verified: [], completed: [], interrupted: [] };
  for (const project of engine.store.state.projects) {
    // An archived project is settled once it is restored (its folder may not even be there now).
    if (project.archivedAt) continue;
    const writing = (project.git?.applies ?? []).filter(row => row.state === 'writing');
    for (const row of writing) {
      let settled;
      try { settled = await engine.recoverRow(project.id, row.id); }
      catch (error) { console.warn(`apply recovery ${row.id}: ${error.message}`); settled = await engine.interruptRow(project.id, row.id).catch(() => 'interrupted'); }
      outcome[settled]?.push(row.id);
    }
  }
  return outcome;
}

/**
 * Retention (design §5.3): everything within LIMITS.retentionDays; past it, the newest
 * LIMITS.retentionKeepPerProject per project. The rest lose their ref and become `expired`.
 * @param {ApplyRow[]} rows
 * @param {{ now: number }} options
 * @returns {{ expire: string[] }}
 */
export function retention(rows, { now = Date.now() } = {}) {
  const cutoff = now - LIMITS.retentionDays * 86400000;
  const newest = [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const kept = new Set(newest.slice(0, LIMITS.retentionKeepPerProject).map(row => row.id));
  return { expire: rows.filter(row => !kept.has(row.id) && Date.parse(row.at) < cutoff && !KEEP_STATES.has(row.state) && row.state !== 'expired').map(row => row.id) };
}
