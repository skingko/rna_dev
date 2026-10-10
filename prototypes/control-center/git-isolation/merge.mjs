import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { LIMITS, MERGE_ID, REFS, isSecretPath } from './contract.mjs';
import { engineError } from './env.mjs';
import { commitTree } from './snapshot.mjs';
import { composeTree, diffTrees, folderNames, lsTree, lsTreeUnder, objects, peelTree, readBlobs, toRoot, updateRefs, LIST_OUTPUT } from './tree.mjs';

// Three-way merge (design §3.4). Owner: T1.
//
// merge(base, current, incoming) builds Bc = commit-tree(base), Cc = commit-tree(current, -p Bc) and
// Ic = commit-tree(incoming, -p Bc), so the merge base is exactly Bc (no --merge-base, git 2.38 is enough); labels
// Cc and Ic under REFS.merge(mid, label); runs `git merge-tree --write-tree -z <current ref> <incoming ref>` (exit 0
// clean, 1 conflicts, anything else `engine_failed`); deletes the labels before returning. Conflict markers in the
// result carry the full label ref names (MERGE_LABELS), the base label is Bc's short id.
//
// merge-tree runs against the object store only (GIT_DIR = the common dir, run there): no attribute file of a
// working tree is read, so no merge driver a repository names can run; text is merged as git's own 3-way merge.

/** merge-tree's conflict types → CONFLICT_KINDS (the English description after the type is never parsed). */
export const MERGE_TREE_KINDS = Object.freeze({ 'CONFLICT (contents)': 'content', 'CONFLICT (binary)': 'binary', 'CONFLICT (modify/delete)': 'modify_delete', 'CONFLICT (add/add)': 'add_add', 'CONFLICT (rename/delete)': 'rename', 'CONFLICT (file/directory)': 'type' });
/** When one path has several messages, the more specific kind names it (binary also reports `contents`). */
const PRIORITY = ['binary', 'modify_delete', 'type', 'rename', 'add_add', 'content', 'other'];
const SUBMODULE = '160000', LINK = '120000';

/**
 * @typedef {object} MergeResult
 * @property {boolean} clean      No conflict of any kind (merge-tree's, or one found by code).
 * @property {string} mid
 * @property {string} tree        Result tree R (conflicted text files hold markers in R).
 * @property {{ base: string, current: string, incoming: string }} labels  Marker labels (full ref names; base: Bc's short id).
 * @property {({ path: string, mode: string, oid: string, expect: { mode: string, oid: string }|null }|{ path: string, delete: true, expect: { mode: string, oid: string } })[]} writes
 *   `diff-tree -r -z --no-renames <current> <R>` without the conflicted paths: what writing R into the current side
 *   changes. Root paths (relative to the project folder); `expect` is the current side's entry (null: absent).
 * @property {import('./contract.mjs').Conflict[]} conflicts  Root paths.
 * @property {{ path: string, reason: string }[]} notMerged
 * @property {number} bothChanged  Paths both sides changed relative to base.
 */

/**
 * Merge two trees over an explicit base. Conflicts found by code are added here and never written automatically:
 * `submodule` (a 160000 entry on any side), `case_collision` (paths differing only in case on a case-insensitive
 * volume), `unsafe_symlink` (a new link resolving outside the root), `unsafe_hardlink` (a regular file with
 * nlink > 1 in an isolated root); oversized paths go to `notMerged`.
 *
 * Files that hold secrets (SECRET_FILES, isSecretPath of the root path) never take part (B8): snapshots leave them
 * out, but a tree made before B8 (a conversation's base or a worker's seed, a pinned tip) or a tracked file may still
 * name one. Whatever the sides hold for such a path, the current side keeps its own version: no write, no conflict,
 * the result tree keeps the current entry, and `notMerged` reports it with reason `secret`.
 *
 * `root`: the root the incoming side was snapshotted from (its files are checked for hard links when it is an
 * isolated root). `notMerged`: paths the snapshots skipped (passed through).
 * @param {import('./snapshot.mjs').EngineContext} context
 * @param {{ base: string, current: string, incoming: string }} trees  tree ids (a commit is peeled to its tree)
 * @param {{ mid: string, labels: { current: string, incoming: string }, root?: import('./contract.mjs').RootInfo, notMerged?: { path: string, reason: string }[] }} options
 * @returns {Promise<MergeResult>}
 */
export async function merge(context, trees, { mid, labels, root = null, notMerged = [] } = {}) {
  if (!MERGE_ID.test(mid ?? '')) throw engineError('engine_failed', 'A merge id is lowercase hex.');
  const [base, current, incoming] = await Promise.all([trees.base, trees.current, trees.incoming].map(rev => peelTree(context, rev)));
  const names = { current: REFS.merge(mid, labels.current), incoming: REFS.merge(mid, labels.incoming) };
  const result = { clean: true, mid, tree: current, labels: { base: '', ...names }, writes: [], conflicts: [], notMerged: [...notMerged], bothChanged: 0 };
  // Nothing came in: the current side is the result. Nothing changed here: the incoming side is.
  if (incoming === base || incoming === current) return result;
  const baseCommit = await commitTree(context, base, [], 'Rna merge base');
  const [currentCommit, incomingCommit] = await Promise.all([commitTree(context, current, [baseCommit], 'Rna merge: current'), commitTree(context, incoming, [baseCommit], 'Rna merge: incoming')]);
  result.labels.base = baseCommit.slice(0, 7);
  let output;
  await updateRefs(context, [{ ref: names.current, commit: currentCommit }, { ref: names.incoming, commit: incomingCommit }]);
  try {
    output = await objects(context, ['merge-tree', '--write-tree', '-z', names.current, names.incoming], { maxBytes: LIST_OUTPUT, timeoutMs: 120000 });
  } finally {
    await updateRefs(context, [{ ref: names.current, commit: null }, { ref: names.incoming, commit: null }]).catch(() => {});
  }
  if (output.timedOut || output.truncated || ![0, 1].includes(output.code)) throw engineError('engine_failed', `merge-tree failed (${output.code}): ${output.stderr.trim().slice(0, 500)}`);
  const parsed = parseMergeTree(output.stdout);
  if (!parsed.tree) throw engineError('engine_failed', 'merge-tree gave no result tree.');
  result.tree = parsed.tree;

  // Conflicts merge-tree reported, by tree path, with the kind its message type names.
  const kinds = new Map();
  const mark = (path, kind) => { const had = kinds.get(path); if (!had || PRIORITY.indexOf(kind) < PRIORITY.indexOf(had)) kinds.set(path, kind); };
  for (const message of parsed.messages) if (message.kind.startsWith('CONFLICT (')) for (const path of message.paths) mark(path, MERGE_TREE_KINDS[message.kind] ?? 'other');
  for (const entry of parsed.entries) if (!kinds.has(entry.path)) mark(entry.path, 'other');
  const conflicted = [...kinds.keys()];
  const touches = (path, other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`);
  const [inBase, inCurrent, inIncoming, inResult] = conflicted.length ? await Promise.all([base, current, incoming, result.tree].map(tree => lsTree(context, tree, conflicted))) : [new Map(), new Map(), new Map(), new Map()];
  const entry = (map, path) => { const row = map.get(path); return row ? { mode: row.mode, oid: row.oid } : undefined; };
  /** Tree paths of SECRET_FILES the sides disagree on: kept at the current side's version (B8). */
  const secrets = [];
  for (const path of conflicted) {
    const local = toRoot(context, path);
    // A name git made up to keep both sides of a file/folder clash (`path~label`) exists on no side: not a conflict of its own.
    if (local === null || (!inBase.has(path) && !inCurrent.has(path) && !inIncoming.has(path))) continue;
    if (isSecretPath(local)) { secrets.push({ path, local }); continue; }
    // Both sides added the file (no base entry): merge-tree calls it `contents`; it is an add/add conflict.
    const kind = kinds.get(path) === 'content' && !inBase.has(path) ? 'add_add' : kinds.get(path), row = { path: local, kind, ...(entry(inBase, path) ? { base: entry(inBase, path) } : {}), ...(entry(inCurrent, path) ? { current: entry(inCurrent, path) } : {}), ...(entry(inIncoming, path) ? { incoming: entry(inIncoming, path) } : {}) };
    if (['content', 'add_add'].includes(kind) && inResult.get(path)?.type === 'blob') row.marked = inResult.get(path).oid;
    result.conflicts.push(row);
  }

  // What writing R over the current side changes, conflicts left out (and anything under or over them).
  const changes = (await diffTrees(context, current, result.tree)).filter(change => !conflicted.some(path => touches(change.path, path)));
  const candidates = [];
  for (const change of changes) {
    const local = toRoot(context, change.path);
    if (local === null) continue;
    if (isSecretPath(local)) { secrets.push({ path: change.path, local }); continue; }
    candidates.push({ ...change, local });
  }
  if (secrets.length) result.tree = await keepSecrets(context, { current, result: result.tree, secrets, notMerged: result.notMerged });
  const found = await codeConflicts(context, candidates, { incoming, result: result.tree, root });
  for (const change of candidates) {
    const kind = found.get(change.path);
    if (kind) { result.conflicts.push({ path: change.local, kind, ...(change.old ? { current: change.old } : {}), ...(change.next ? { incoming: change.next } : {}) }); continue; }
    result.writes.push(change.next ? { path: change.local, mode: change.next.mode, oid: change.next.oid, expect: change.old } : { path: change.local, delete: true, expect: change.old });
  }
  result.bothChanged = await bothChanged(context, base, current, incoming);
  result.clean = result.conflicts.length === 0;
  return result;
}

/**
 * The result tree with each secret path (and anything under it) back at the current side's entries (B8: the current
 * side keeps its own version of a file that holds secrets, whatever base and incoming hold), each one reported once in
 * `notMerged` with reason `secret` (root paths). Only trees the store already holds are read: nothing is hashed.
 * @param {import('./snapshot.mjs').EngineContext} context
 * @param {{ current: string, result: string, secrets: { path: string, local: string }[], notMerged: { path: string, reason: string }[] }} input
 * @returns {Promise<string>}  the result tree
 */
async function keepSecrets(context, { current, result, secrets, notMerged }) {
  const paths = [...new Set(secrets.map(row => row.path))].sort();
  const tops = paths.filter(path => !paths.some(other => other !== path && path.startsWith(`${other}/`)));
  const changes = [];
  for (const path of tops) {
    changes.push({ path, delete: true });
    for (const row of await lsTreeUnder(context, current, path)) changes.push({ path: row.path, mode: row.mode, oid: row.oid });
  }
  for (const { local } of secrets) if (!notMerged.some(row => row.path === local)) notMerged.push({ path: local, reason: 'secret' });
  return composeTree(context, result, changes);
}

/** Paths changed on both sides relative to base, inside the project's prefix. */
export async function bothChanged(context, base, current, incoming) {
  if (current === base || incoming === base) return 0;
  const [ours, theirs] = await Promise.all([diffTrees(context, base, current), diffTrees(context, base, incoming)]);
  const mine = new Set(ours.map(row => row.path).filter(path => toRoot(context, path) !== null));
  return theirs.filter(row => mine.has(row.path)).length;
}

/**
 * Conflicts found by code among the writes (design §3.4): submodule, unsafe_symlink, unsafe_hardlink,
 * case_collision. Map tree path → kind.
 */
async function codeConflicts(context, changes, { result, root }) {
  const found = new Map();
  for (const change of changes) if (change.old?.mode === SUBMODULE || change.next?.mode === SUBMODULE) found.set(change.path, 'submodule');
  // A link that would point outside the project folder, into a `.git`, or into Rna's own `.rna`: resolved from the
  // folder it sits in, following the links the result holds on the way (two links that each stay inside can
  // together leave it: `d/up -> ..` and `out -> d/up/..`).
  const links = changes.filter(change => !found.has(change.path) && change.next?.mode === LINK);
  if (links.length) {
    const lookups = new Map(), texts = new Map();
    const entryAt = async local => { const path = `${context.located.prefix ?? ''}${local}`; if (!lookups.has(path)) lookups.set(path, (await lsTree(context, result, [path])).get(path) ?? null); return lookups.get(path); };
    const textOf = async oid => { if (!texts.has(oid)) texts.set(oid, (await readBlobs(context, [oid])).get(oid)?.toString('utf8') ?? ''); return texts.get(oid); };
    for (const change of links) if (await linkEscapes(change.local, await textOf(change.next.oid), { entryAt, textOf })) found.set(change.path, 'unsafe_symlink');
  }
  // A regular file with more than one link in an isolated root may be the same file as one outside it.
  if (root?.isolated) {
    for (const change of changes) {
      if (found.has(change.path) || !change.next || change.next.mode === LINK) continue;
      const info = await lstat(join(root.root, change.local)).catch(() => null);
      if (info?.isFile() && info.nlink > 1) found.set(change.path, 'unsafe_hardlink');
    }
  }
  // On a volume that ignores case, a new name must not differ only in case from another name beside it.
  if (context.ignoreCase) {
    const added = changes.filter(change => !found.has(change.path) && change.next && !change.old);
    const levels = new Map();
    for (const change of added) {
      const parts = change.path.split('/');
      for (let depth = 0; depth < parts.length; depth++) levels.set(`${change.path}\0${depth}`, { change, folder: parts.slice(0, depth).join('/'), name: parts[depth] });
    }
    if (levels.size) {
      const listing = await folderNames(context, result, [...new Set([...levels.values()].map(level => level.folder))]);
      for (const { change, folder, name } of levels.values()) {
        const lower = name.toLowerCase();
        if ((listing.get(folder) ?? []).some(other => other !== name && other.toLowerCase() === lower)) found.set(change.path, 'case_collision');
      }
    }
  }
  return found;
}

/**
 * Whether a link at root path `at` whose text is `target` resolves outside the root (or into a `.git`, or into the
 * top `.rna`), walking its components and following the links the tree holds (at most 40), like the OS would.
 * @param {string} at
 * @param {string} target
 * @param {{ entryAt: (local: string) => Promise<{ mode: string, oid: string }|null>, textOf: (oid: string) => Promise<string> }} tree
 * @returns {Promise<boolean>}
 */
export async function linkEscapes(at, target, { entryAt, textOf }) {
  if (!target || posix.isAbsolute(target) || target.includes('\0')) return true;
  const folder = posix.dirname(at), stack = folder === '.' ? [] : folder.split('/');
  let parts = target.split('/'), hops = 0;
  while (parts.length) {
    const part = parts.shift();
    if (!part || part === '.') continue;
    if (part === '..') { if (!stack.length) return true; stack.pop(); continue; }
    stack.push(part);
    if (part.toLowerCase() === '.git' || (stack.length === 1 && part.toLowerCase() === '.rna')) return true;
    const entry = await entryAt(stack.join('/'));
    if (entry?.mode !== LINK) continue;
    if (++hops > 40) return true;
    const text = await textOf(entry.oid);
    if (!text || posix.isAbsolute(text)) return true;
    stack.pop();
    parts = [...text.split('/'), ...parts];
  }
  return false;
}

/**
 * Parse `merge-tree --write-tree -z` output: the result tree, the conflicted entries (`<mode> <oid> <stage>\t<path>`,
 * stages 1/2/3 = base/current/incoming) and the informational messages (`<count> <paths…> <type> <message>`).
 * @param {string} stdout
 * @returns {{ tree: string, entries: { path: string, mode: string, oid: string, stage: 1|2|3 }[], messages: { paths: string[], kind: string }[] }}
 */
export function parseMergeTree(stdout) {
  const fields = stdout.split('\0'), tree = fields[0]?.trim() ?? '', entries = [], messages = [];
  let index = 1;
  for (; index < fields.length; index++) {
    const field = fields[index];
    if (field === '') { index++; break; }
    const match = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]*)$/.exec(field);
    if (match) entries.push({ mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] });
  }
  while (index < fields.length) {
    const count = Number(fields[index]);
    if (!Number.isInteger(count) || count < 1 || fields[index] === '') break;
    const paths = fields.slice(index + 1, index + 1 + count), kind = fields[index + 1 + count] ?? '';
    messages.push({ paths, kind });
    index += count + 3;
  }
  return { tree, entries, messages };
}

/** Whole lines of `text` within `maxBytes`. */
function cut(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const head = Buffer.from(text).subarray(0, maxBytes).toString('utf8'), end = head.lastIndexOf('\n');
  return { text: end < 0 ? '' : head.slice(0, end + 1), truncated: true };
}
async function markedText(context, conflict) {
  if (!conflict?.marked) return null;
  const blobs = await readBlobs(context, [conflict.marked]);
  return blobs.get(conflict.marked)?.toString('utf8') ?? null;
}

/**
 * The diff3 text of one text conflict (its marked blob in R), cut at whole lines within `maxBytes`
 * (default LIMITS.previewBytes, 6 KB): agent_merge `merge` previews. A conflict without markers (not a text
 * conflict) has no preview: empty text.
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function preview(context, conflict, { maxBytes = LIMITS.previewBytes } = {}) {
  const text = await markedText(context, conflict);
  return text === null ? { text: '', truncated: false } : cut(text, maxBytes);
}

/**
 * One page of a conflicted file's full diff3 (LIMITS.showLinesPerPage lines a page): agent_merge `show`.
 * @returns {Promise<{ text: string, page: number, pages: number }>}
 */
export async function show(context, conflict, { page = 1, lines = LIMITS.showLinesPerPage } = {}) {
  const text = await markedText(context, conflict) ?? '';
  const rows = text.split(/(?<=\n)/), pages = Math.max(1, Math.ceil(rows.length / lines)), at = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  return { text: rows.slice((at - 1) * lines, at * lines).join(''), page: at, pages };
}
