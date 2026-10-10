import { createHash, randomBytes } from 'node:crypto';
import { LIMITS, MERGE_LABELS, REFS, USER_ONLY_CONFLICTS } from './contract.mjs';
import { engineError } from './env.mjs';
import { merge } from './merge.mjs';
import { composeTree, diffTrees, lsTree, parentsOf, peelTree, readRef, toRoot, toTree } from './tree.mjs';

// Rollback (design §5.2). Owner: T1.
//
// A three-way rollback: merge(base = after, current = the folder now, incoming = before). Later changes that do
// not overlap stay; overlapping files are skipped and listed. Two steps like the panel's discard: the first answers
// what would happen and a one-time token bound to those paths' current state (LIMITS.rollbackTokenMs); the second
// carries `confirm` (and optionally `force: [paths]`, "restore these anyway"). The rollback is itself an apply record
// (kind `rollback`, `undoes`), so it can be undone. Needs the project's foreground write permission.

/**
 * @typedef {object} RollbackPreview  first step
 * @property {string} confirm
 * @property {string} expiresAt
 * @property {{ path: string, action: 'restore'|'delete'|'recreate' }[]} files
 * @property {{ path: string, reason: 'changed_after'|'conflict'|'unattributable' }[]} skipped
 * @property {string} [note]  Direct-mode turns: other writes into the folder at the same time cannot be told apart.
 *
 * @typedef {object} RollbackResult  second step
 * @property {string} applyId  The new rollback record.
 * @property {string[]} restored
 * @property {{ path: string, reason: string }[]} skipped
 * @property {'verified'|'unverified'} verify
 */

const mergeId = () => randomBytes(8).toString('hex');
const actionOf = change => (change.old && change.next ? 'restore' : change.old ? 'delete' : 'recreate');

/** before and after of one apply record, from its hold ref (parents [before, after]). Null when the ref is gone. */
export async function recordCommits(context, applyId) {
  const hold = await readRef(context, REFS.apply(applyId));
  if (!hold) return null;
  const [before, after] = await parentsOf(context, hold);
  return before && after ? { hold, before, after } : null;
}

/**
 * Plan a rollback of one or more apply records (newest first: a worktree session's turn has several), or of a
 * direct-mode turn's checkpoint (`turn`: REFS.turn(turnId) [start, end] limited to its attributable paths).
 * `current` (options) is the target folder's snapshot tree now. Besides the preview it answers `plan` (the entries
 * the writer takes: forced paths included) and `tree`, the folder as the rollback leaves it.
 * @param {import('./snapshot.mjs').EngineContext} context
 * @param {{ applies?: import('./records.mjs').ApplyRow[], turn?: { start: string, end: string, paths: string[], excluded?: { path: string, applyId: string }[] } }} target
 * @param {{ current: string, paths?: string[], force?: string[], forceOnly?: boolean }} options  `forceOnly`: a record
 *   rolled back already — only its skipped files can be restored (forced); nothing else is planned again.
 * @returns {Promise<{ files: RollbackPreview['files'], skipped: RollbackPreview['skipped'], fingerprint: string, plan: import('./writer.mjs').PlanEntry[] }>}
 */
export async function planRollback(context, { applies = [], turn = null } = {}, { current, paths, force = [], forceOnly = false } = {}) {
  const now = await peelTree(context, current), steps = [], skipped = new Map();
  for (const row of applies) {
    const commits = await recordCommits(context, row.id);
    if (!commits) throw engineError('apply_expired', `The checkpoint of ${row.id} is gone.`);
    steps.push({ base: await peelTree(context, commits.after), incoming: await peelTree(context, commits.before), labels: MERGE_LABELS.rollback(row.id) });
  }
  if (turn) {
    const [start, end] = await Promise.all([peelTree(context, turn.start), peelTree(context, turn.end)]);
    // The turn's own paths go back to their start; every other path keeps its end state (it is not this turn's).
    const own = (turn.paths ?? []).map(path => toTree(context, path)), starts = await lsTree(context, start, own);
    const incoming = await composeTree(context, end, own.map(path => (starts.has(path) ? { path, mode: starts.get(path).mode, oid: starts.get(path).oid } : { path, delete: true })));
    steps.push({ base: end, incoming, labels: MERGE_LABELS.rollback(turn.id ?? 'turn') });
    for (const row of turn.excluded ?? []) skipped.set(row.path, 'unattributable');
  }
  let tree = now;
  for (const step of steps) {
    const result = await merge(context, { base: step.base, current: tree, incoming: step.incoming }, { mid: mergeId(), labels: step.labels });
    for (const conflict of result.conflicts) skipped.set(conflict.path, USER_ONLY_CONFLICTS.includes(conflict.kind) ? 'conflict' : 'changed_after');
    tree = await composeTree(context, tree, result.writes.map(write => (write.delete ? { path: toTree(context, write.path), delete: true } : { path: toTree(context, write.path), mode: write.mode, oid: write.oid })));
  }
  const wanted = paths?.length ? new Set(paths) : null;
  const changes = forceOnly ? [] : (await diffTrees(context, now, tree)).map(change => ({ ...change, local: toRoot(context, change.path) })).filter(change => change.local !== null && (!wanted || wanted.has(change.local)) && !skipped.has(change.local));
  const skippedRows = [...skipped].filter(([path]) => !wanted || wanted.has(path)).map(([path, reason]) => ({ path, reason }));
  // The token binds what these paths hold now.
  const held = await lsTree(context, now, [...changes.map(change => change.path), ...skippedRows.map(row => toTree(context, row.path))]);
  const fingerprint = createHash('sha256').update(JSON.stringify([changes.map(change => [change.local, change.old, change.next]), skippedRows.map(row => [row.path, row.reason, held.get(toTree(context, row.path)) ?? null])])).digest('hex');
  const plan = changes.map(change => ({ path: change.local, expect: change.old, next: change.next }));
  const forced = (force ?? []).filter(path => skipped.has(path) && (!wanted || wanted.has(path)));
  if (forced.length) {
    // "Restore these anyway": the content before the oldest record (or at the turn's start).
    const source = turn ? await peelTree(context, turn.start) : steps.at(-1).incoming, entries = await lsTree(context, source, forced.map(path => toTree(context, path)));
    for (const path of forced) {
      const present = held.get(toTree(context, path)), then = entries.get(toTree(context, path));
      const expect = present && present.type !== 'tree' ? { mode: present.mode, oid: present.oid } : null, next = then && then.type !== 'tree' ? { mode: then.mode, oid: then.oid } : null;
      if (JSON.stringify(expect) !== JSON.stringify(next)) plan.push({ path, expect, next });
    }
  }
  return { files: changes.map(change => ({ path: change.local, action: actionOf(change) })), skipped: skippedRows.filter(row => !forced.includes(row.path)), fingerprint, plan, tree, forced };
}

/**
 * One-time confirmation tokens, bound to project, target, paths and fingerprint. Unanswered tokens are few; past
 * the cap the oldest lapses (as the panel's discard).
 */
export class RollbackTokens {
  constructor({ ttlMs = LIMITS.rollbackTokenMs, now = Date.now, max = 32 } = {}) { Object.assign(this, { ttlMs, now, max, rows: new Map() }); }
  /** @returns {{ confirm: string, expiresAt: string }} */
  issue(row) {
    for (const [token, item] of this.rows) if (item.expiresAt <= this.now()) this.rows.delete(token);
    if (this.rows.size >= this.max) this.rows.delete(this.rows.keys().next().value);
    const confirm = randomBytes(16).toString('hex'), expiresAt = this.now() + this.ttlMs;
    this.rows.set(confirm, { ...row, expiresAt });
    return { confirm, expiresAt: new Date(expiresAt).toISOString() };
  }
  /** The row the token was issued for, consumed; null when unknown, expired or used. */
  take(confirm) {
    if (typeof confirm !== 'string') return null;
    const row = this.rows.get(confirm);
    if (!row) return null;
    this.rows.delete(confirm);
    return row.expiresAt > this.now() ? row : null;
  }
}
