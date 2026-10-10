import { lstat, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LIMITS, REFS, TRASH_DIR, WORKTREE_DIR } from './contract.mjs';
import { PRIVATE_INDEX_NAME } from './snapshot.mjs';
import { objects } from './tree.mjs';

// What Rna's isolation keeps on disk, and how each kind of it is cleaned (B8, review ISO-6, ISO-8; zcode
// packages/services/src/storage/domain/storageCatalog.ts:25-38 — one table maps each kind of stored thing to a
// category and its cleanability — and cleanPlan.ts:21-50 — what may go is a pure function of the facts). The view is
// read only: the daily sweeps (IsolationEngine.sweep, WorktreeService.sweep) delete, by the rules below; doctor and
// GET /api/health only report.
//
// Repositories the user owns are never cleaned beyond Rna's own refs, indexes and folders: `git gc` runs only on a
// repository Rna itself initialized that holds no commit but Rna's first one (`gc --auto`, under the repository
// lock); any other repository's object store is reported, never touched (decided by the user, 2026-10-05).

/**
 * How a category is cleaned: `auto` — by the daily sweep, by retention; `confirm` — only on the user's word (the
 * worktrees panel's apply or discard; Rna removes its own copies when their work settles); `none` — never by Rna,
 * reported only.
 */
export const STORAGE_CLEANABILITY = Object.freeze(['none', 'auto', 'confirm']);
/**
 * The catalog: every kind of thing isolation stores, with its cleanability. `objects` depends on the repository's
 * owner (repositoryOwner): `auto` for a repository Rna initialized and the user never committed to, else `none`.
 */
export const STORAGE_CATALOG = Object.freeze({
  /** `<P>/.rna/worktrees.nosync/*`: conversation, worker and background copies. */
  worktrees: 'confirm',
  /** `<P>/.rna/trash.nosync/*`: files moved out of removed worktrees; gone after LIMITS.trashDays. */
  trash: 'auto',
  /** `<commonDir>/rna/index/*`: snapshot caches; a removed worktree's goes with it, an orphan after LIMITS.retentionDays. */
  privateIndexes: 'auto',
  /** `refs/rna/*`: checkpoints, apply records, worktree seeds and tips; by retention (LIMITS.retentionDays, turnRefDays). */
  hiddenRefs: 'auto',
  /** The repository's object store (what refs/rna pins lives there too). */
  objects: null,
});
/** Hidden ref namespaces as the view counts them (REFS): turn checkpoints, apply records, worktree refs, merge labels. */
const REF_KINDS = Object.freeze({ 'refs/rna/turn/': 'turn', 'refs/rna/apply/': 'apply', 'refs/rna/wt/': 'worktree', 'refs/rna/m/': 'merge' });
const DAY = 86400000;

/** The private index name of a root (the first 16 hex of sha256 of its realpath, snapshot.mjs privateIndexPath). */
export const indexName = root => createHash('sha256').update(root).digest('hex').slice(0, 16);

/**
 * Who owns a repository's history (pure): `rna` when a project on it was initialized by Rna (`project.git.init.by`,
 * with its commit) in the repository's own top folder, and the commits its branches, tags, remote-tracking refs and
 * HEAD reach are that first commit only; `user` otherwise — including when anything could not be read.
 * @param {{ inits: { by?: string, commit?: string, workspace?: string }[], top: string|null, reachable: string[]|null }} facts
 * @returns {'rna'|'user'}
 */
export function repositoryOwner({ inits = [], top = null, reachable = null } = {}) {
  if (!Array.isArray(reachable) || reachable.length !== 1 || !top) return 'user';
  return inits.some(init => init?.by === 'rna' && typeof init.commit === 'string' && init.commit === reachable[0] && init.workspace === top) ? 'rna' : 'user';
}

/**
 * Private index files no live root uses (pure; harness packages/spill/spill-local/src/cleanup.ts:15-23, 211-257: only
 * entries of the exact shape, only regular files, by age). `entries`: { name, file, mtimeMs } of `<commonDir>/rna/index`;
 * `live`: index names (indexName) of every root still in use; an index and its notes both older than `cutoffMs` go.
 * @returns {string[]}  names to delete (index and notes listed separately)
 */
export function orphanIndexes({ entries = [], live = new Set(), cutoffMs }) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry?.file || !PRIVATE_INDEX_NAME.test(entry.name)) continue;
    const key = entry.name.slice(0, 16), group = groups.get(key) ?? [];
    group.push(entry); groups.set(key, group);
  }
  const out = [];
  for (const [key, group] of groups) if (!live.has(key) && group.every(entry => entry.mtimeMs < cutoffMs)) out.push(...group.map(entry => entry.name));
  return out.sort();
}

/** `git count-objects -v` as numbers (sizes in bytes). */
export function parseCountObjects(text) {
  const values = Object.fromEntries(String(text ?? '').split('\n').map(line => line.split(': ')).filter(pair => pair.length === 2).map(([key, value]) => [key.trim(), Number(value)]));
  const n = key => (Number.isFinite(values[key]) ? values[key] : 0);
  return { looseObjects: n('count'), looseBytes: n('size') * 1024, packedObjects: n('in-pack'), packs: n('packs'), packBytes: n('size-pack') * 1024, garbageBytes: n('size-garbage') * 1024 };
}

/** p50 / p95 of a list of numbers (nearest rank), or null when empty. */
const rank = (values, p) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };

/**
 * A project's apply records as aggregates (review ISO-8): per kind the count, p50 / p95 of `ms` and the bytes written
 * (rows that carry them), and how many rows are still `writing` or `interrupted`.
 * @param {object[]} rows  project.git.applies
 */
export function applyAggregates(rows = []) {
  const byKind = {};
  for (const row of rows) {
    const kind = byKind[row.kind] ??= { count: 0, ms: [], bytes: 0 };
    kind.count++;
    if (Number.isFinite(row.ms)) kind.ms.push(row.ms);
    if (Number.isFinite(row.bytes)) kind.bytes += row.bytes;
  }
  return {
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, row]) => [kind, { count: row.count, timed: row.ms.length, p50Ms: rank(row.ms, 0.5), p95Ms: rank(row.ms, 0.95), bytes: row.bytes }])),
    writing: rows.filter(row => row.state === 'writing').length,
    interrupted: rows.filter(row => row.state === 'interrupted').length,
  };
}

/** A project's worktree rows as counts by kind and state (removed rows are history and not counted). */
export function worktreeCounts(rows = []) {
  const out = {};
  for (const row of rows) { if (row.state === 'removed') continue; const kind = out[row.kind] ??= {}; kind[row.state] = (kind[row.state] ?? 0) + 1; }
  return out;
}

/**
 * The live roots of one repository, as private index names: the project folder of every project on it (archived ones
 * included) and every worktree of theirs not removed, by their path as written and as resolved.
 * @param {{ workspace: string, worktrees: object[] }[]} projects  located projects of this repository (workspace a realpath)
 */
export async function liveIndexNames(projects) {
  const names = new Set();
  for (const { workspace, prefix = '', worktrees = [] } of projects) {
    names.add(indexName(workspace));
    for (const row of worktrees) {
      if (row.state === 'removed' || typeof row.dir !== 'string') continue;
      const top = join(workspace, ...row.dir.split('/')), parts = String(row.prefix ?? prefix ?? '').split('/').filter(Boolean);
      names.add(indexName(join(top, ...parts)));
      const real = await realpath(top).catch(() => null);
      if (real) names.add(indexName(join(real, ...parts)));
    }
  }
  return names;
}

/**
 * repositoryOwner of a located repository: what its refs reach (at most two commits are listed, enough to tell one
 * from more) against the Rna git init records of the projects on it.
 * @param {import('./snapshot.mjs').EngineContext} context
 * @param {{ project: object, workspace: string }[]} projects
 * @returns {Promise<'rna'|'user'>}
 */
export async function ownerOf(context, projects) {
  const inits = projects.map(row => ({ ...(row.project.git?.init ?? {}), workspace: row.workspace })).filter(init => init.by === 'rna');
  if (!inits.length) return 'user';
  const reachable = await objects(context, ['rev-list', '--max-count=2', '--branches', '--tags', '--remotes', 'HEAD', '--'], { timeoutMs: 30000 }).then(result => (result.code === 0 ? result.stdout.split('\n').filter(Boolean) : null), () => null);
  return repositoryOwner({ inits, top: context.located.top, reachable });
}

/** Entries of `<commonDir>/rna/index` (lstat, no link followed): { name, file, mtimeMs, bytes }. */
export async function indexEntries(commonDir) {
  const folder = join(commonDir, 'rna', 'index'), out = [];
  for (const name of await readdir(folder).catch(() => [])) {
    const info = await lstat(join(folder, name)).catch(() => null);
    if (info) out.push({ name, file: info.isFile(), mtimeMs: info.mtimeMs, bytes: info.size });
  }
  return out;
}

/** Bytes and top entries of a folder (lstat sums; links are not followed); null when it is not there. */
async function folderBytes(path, { limit = 200000 } = {}) {
  const top = await lstat(path).catch(() => null);
  if (!top?.isDirectory()) return null;
  let bytes = 0, files = 0, seen = 0;
  const walk = async folder => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (++seen > limit) return;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else { const info = await lstat(full).catch(() => null); if (info) { bytes += info.size; files++; } }
    }
  };
  await walk(path);
  return { bytes, files, entries: (await readdir(path).catch(() => [])).length, ...(seen > limit ? { partial: true } : {}) };
}

/**
 * The facts of one repository (read only): its owner, `count-objects -v`, refs/rna by kind, private indexes (live and
 * orphaned). `projects`: the store's rows on this repository, each `{ project, workspace, prefix }` located.
 * @param {import('./snapshot.mjs').EngineContext} context
 */
export async function repositoryFacts(context, projects, { now = Date.now() } = {}) {
  const { commonDir } = context.located;
  const owner = await ownerOf(context, projects);
  const counted = await objects(context, ['count-objects', '-v'], { timeoutMs: 30000 }).catch(() => null);
  const refs = { turn: 0, apply: 0, worktree: 0, merge: 0, other: 0 };
  const listed = await objects(context, ['for-each-ref', '--format=%(refname)', REFS.root], { timeoutMs: 30000 }).catch(() => null);
  for (const ref of listed?.code === 0 ? listed.stdout.split('\n').filter(Boolean) : []) refs[Object.entries(REF_KINDS).find(([prefix]) => ref.startsWith(prefix))?.[1] ?? 'other']++;
  const entries = await indexEntries(commonDir), live = await liveIndexNames(projects.map(row => ({ workspace: row.workspace, prefix: row.prefix, worktrees: row.project.git?.worktrees ?? [] })));
  const orphans = orphanIndexes({ entries, live, cutoffMs: now - LIMITS.retentionDays * DAY });
  const indexes = entries.filter(entry => entry.file && PRIVATE_INDEX_NAME.test(entry.name));
  return {
    owner,
    objects: counted?.code === 0 ? { ...parseCountObjects(counted.stdout), cleanability: owner === 'rna' ? 'auto' : 'none' } : null,
    hiddenRefs: { ...refs, cleanability: STORAGE_CATALOG.hiddenRefs },
    privateIndexes: { files: indexes.filter(entry => !entry.name.endsWith('.json')).length, bytes: indexes.reduce((sum, entry) => sum + entry.bytes, 0), unused: indexes.filter(entry => !live.has(entry.name.slice(0, 16)) && !entry.name.endsWith('.json')).length, orphaned: orphans.filter(name => !name.endsWith('.json')).length, cleanability: STORAGE_CATALOG.privateIndexes },
  };
}

/**
 * The storage view of doctor and GET /api/health (read only, computed in the background and cached for `ttlMs`; the
 * health answer never waits for it). `engine`: IsolationEngine (repository contexts); `worktrees`: WorktreeService
 * (its asynchronous `du` sizes).
 */
export class IsolationStorage {
  constructor({ store, engine, worktrees = null, now = Date.now, ttlMs = 10 * 60000 } = {}) {
    Object.assign(this, { store, engine, worktrees, now, ttlMs });
    this.last = null; this.running = null;
  }
  /** The last view (null fields until the first one is computed); a stale or missing one starts a refresh. */
  view() {
    if (!this.running && (!this.last || this.now() - Date.parse(this.last.at) >= this.ttlMs)) void this.refresh().catch(() => null);
    return this.last ?? { at: null, computing: true, repositories: [], projects: [] };
  }
  /** Compute the view now (one at a time). */
  refresh() {
    if (this.running) return this.running;
    this.running = this.compute().then(view => { this.last = view; return view; }).finally(() => { this.running = null; });
    return this.running;
  }
  async compute() {
    const at = new Date(this.now()).toISOString(), byRepository = new Map(), projects = [];
    for (const project of this.store.state.projects) {
      let context = null;
      if (!project.archivedAt) try { context = await this.engine.context(project.id); } catch { context = null; }
      const rows = project.git?.worktrees ?? [];
      const row = { projectId: project.id, archived: Boolean(project.archivedAt), repository: context?.located.commonDir ?? null, worktrees: { counts: worktreeCounts(rows), cleanability: STORAGE_CATALOG.worktrees }, applies: applyAggregates(project.git?.applies ?? []) };
      if (context) {
        const group = byRepository.get(context.located.commonDir) ?? { context, projects: [] };
        group.projects.push({ project, workspace: context.located.workspace, prefix: context.located.prefix ?? '' });
        byRepository.set(context.located.commonDir, group);
        // Worktree folders: the service's asynchronous `du` (the next view has what it measures now).
        let bytes = 0, measured = 0;
        for (const record of rows.filter(item => item.state !== 'removed')) {
          const size = this.worktrees?.sizes?.get(record.id);
          if (size) { bytes += size.bytes; measured++; }
          try { this.worktrees?.measure?.(record.id, join(context.located.workspace, ...record.dir.split('/'))); } catch { /* measured next time */ }
        }
        row.worktrees.bytes = bytes; row.worktrees.measured = measured;
        const trash = await folderBytes(join(context.located.workspace, ...TRASH_DIR.split('/')));
        row.trash = { ...(trash ?? { bytes: 0, files: 0, entries: 0 }), cleanability: STORAGE_CATALOG.trash };
        row.worktreeFolder = WORKTREE_DIR;
      }
      projects.push(row);
    }
    const repositories = [];
    for (const [commonDir, group] of byRepository) {
      try { repositories.push({ repository: commonDir, projectIds: group.projects.map(row => row.project.id), ...(await repositoryFacts(group.context, group.projects, { now: this.now() })) }); }
      catch (error) { repositories.push({ repository: commonDir, projectIds: group.projects.map(row => row.project.id), error: String(error?.message ?? error).slice(0, 200) }); }
    }
    return { at, catalog: STORAGE_CATALOG, repositories, projects };
  }
}
