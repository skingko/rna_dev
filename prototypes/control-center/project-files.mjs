import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// A project's private host state beside the state file: its genome versions,
// evolution records, initialization data and observation log. Deleting the
// project removes these; its workspace files and memory already extracted to
// the memory service are the user's and stay. Only entries named by a project
// id are touched, and never through a symbolic link.
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// [suffix, extension, namespace?]. '.rna' + 'effort-probe': the opt-in captures of its internal model calls
// (internal-reasoning.mjs captureRoot), inside the journal root so no new top-level sidecar exists.
const ROOTS = [['.genomes', ''], ['.evolution', ''], ['.initialization', ''], ['.observations', '.json'], ['.rna', '', 'effort-probe']];
// What its background runs left (X-3): run journals with full transcripts, archived action/decision/inbox receipts,
// learning reviews and skill-foundation drafts, one folder per project id under a namespace. These are removed only
// once the project's conversation deletions settled: their cleanup reads (and removes) the journals linked to them.
// `.archive/memory/<id>` holds the receipts of its settled memory evidence records (MEM-11, MemorySync
// compactEvidenceHistory). Never `.rna` or `.archive` themselves: conversation journals sit directly under `.rna/<session id>`.
export const RUN_ROOTS = Object.freeze([['.rna', 'initiative'], ['.archive', 'initiative'], ['.archive', 'learning'], ['.archive', 'inbox'], ['.archive', 'observations'], ['.archive', 'memory'], ['.skill-foundation', '']]);
// A live project's run journal stays while its action or job row is in state (a paused run resumes from it, the
// background panel reads it) and goes this long after that row left state (archived), the same 30 days a removed
// worktree's last state stays in Git.
export const RUN_JOURNAL_RETENTION_DAYS = 30;
const DAY_MS = 86400000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

async function remove(path) {
  let info; try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await rm(path, { recursive: !info.isSymbolicLink(), force: true });
  return true;
}
/** A namespace folder only when it is a real directory (never followed through a link). */
async function realDirectory(path) {
  let info; try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  return info.isDirectory() && !info.isSymbolicLink();
}
const runRoot = (stateFile, suffix, namespace) => namespace ? join(`${stateFile}${suffix}`, namespace) : `${stateFile}${suffix}`;

/** Remove one deleted project's private folders; returns the paths removed. */
export async function removeProjectFiles(stateFile, projectId) {
  if (!PROJECT_ID.test(String(projectId))) return [];
  const removed = [];
  for (const [suffix, extension, namespace] of ROOTS) {
    // A namespace inside a shared root is reached only through real folders (never a link).
    if (namespace && (!await realDirectory(`${stateFile}${suffix}`) || !await realDirectory(runRoot(stateFile, suffix, namespace)))) continue;
    const path = join(runRoot(stateFile, suffix, namespace), `${projectId}${extension}`); if (await remove(path)) removed.push(path);
  }
  return removed;
}

/** Remove what a deleted project's background runs left (RUN_ROOTS); call once its conversation deletions settled. */
export async function removeProjectRunFiles(stateFile, projectId) {
  if (!PROJECT_ID.test(String(projectId))) return [];
  const removed = [];
  for (const [suffix, namespace] of RUN_ROOTS) {
    const root = runRoot(stateFile, suffix, namespace);
    if (!await realDirectory(`${stateFile}${suffix}`) || !await realDirectory(root)) continue;
    const path = join(root, projectId); if (await remove(path)) removed.push(path);
  }
  return removed;
}

/**
 * Remove folders left by projects that no longer exist (deleted before this cleanup existed). `keep` names deleted
 * projects whose conversation deletions have not settled yet: their run roots stay until they do.
 */
export async function sweepProjectFiles(stateFile, liveProjectIds, { keep = [] } = {}) {
  const live = new Set(liveProjectIds), held = new Set([...live, ...keep]), removed = [];
  for (const [suffix, extension, namespace] of ROOTS) {
    if (namespace && (!await realDirectory(`${stateFile}${suffix}`) || !await realDirectory(runRoot(stateFile, suffix, namespace)))) continue;
    const root = runRoot(stateFile, suffix, namespace);
    let names; try { names = await readdir(root); } catch { continue; }
    for (const name of names) {
      const id = extension && name.endsWith(extension) ? name.slice(0, -extension.length) : name;
      if (!PROJECT_ID.test(id) || live.has(id) || extension && !name.endsWith(extension)) continue;
      const path = join(root, name);
      if (await remove(path)) removed.push(path);
    }
  }
  for (const [suffix, namespace] of RUN_ROOTS) {
    const root = runRoot(stateFile, suffix, namespace);
    if (!await realDirectory(`${stateFile}${suffix}`) || !await realDirectory(root)) continue;
    for (const name of await readdir(root)) {
      if (!PROJECT_ID.test(name) || held.has(name)) continue;
      const path = join(root, name);
      if (await remove(path)) removed.push(path);
    }
  }
  return removed;
}

/** When each archived action or job of a project left state: the first time its receipt was archived (file mtime). */
async function archivedAt(stateFile, projectId) {
  const at = new Map();
  for (const kind of ['actions', 'jobs']) {
    const directory = join(`${stateFile}.archive`, 'initiative', projectId, kind);
    if (!await realDirectory(directory)) continue;
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(directory, name);
      try {
        const info = await lstat(path); if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
        const id = JSON.parse(await readFile(path, 'utf8'))?.id;
        if (typeof id === 'string' && (!at.has(id) || info.mtimeMs < at.get(id))) at.set(id, info.mtimeMs);
      } catch { /* an unreadable receipt dates nothing */ }
    }
  }
  return at;
}
/** The newest write in a run journal folder (its journal, sidecars and execution logs), or null. */
async function lastWrite(path) {
  let newest = null;
  const walk = async directory => {
    for (const name of await readdir(directory)) {
      const info = await lstat(join(directory, name));
      if (info.isSymbolicLink()) continue;
      newest = Math.max(newest ?? 0, info.mtimeMs);
      if (info.isDirectory()) await walk(join(directory, name));
    }
  };
  try { await walk(path); } catch { return null; }
  return newest;
}
/** A journal whose writer still holds its lock (a run in progress, maybe in another process). */
async function locked(path) {
  let names; try { names = await readdir(path); } catch { return false; }
  for (const name of names) if (name.endsWith('.rna.jsonl.lock')) {
    try { const lock = JSON.parse(await readFile(join(path, name), 'utf8')); if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1) return true; process.kill(lock.pid, 0); return true; }
    catch (error) { if (error.code !== 'ESRCH') return true; }
  }
  return false;
}

/**
 * Retention for a live project's run journals (`<state>.rna/initiative/<project>/<action>`, X-3): a journal stays while
 * its action or job row is in state, and is removed RUN_JOURNAL_RETENTION_DAYS after that row was archived (by the
 * archive receipt's time; a journal with no row anywhere, by its own last write). Locked journals are never touched.
 * @param {string} stateFile
 * @param {object} project the live project row (its initiativeRuntime actions and jobs)
 * @param {{ now?: number, retentionDays?: number }} [options]
 * @returns {Promise<string[]>} the journal folders removed
 */
export async function pruneRunJournals(stateFile, project, { now = Date.now(), retentionDays = RUN_JOURNAL_RETENTION_DAYS } = {}) {
  if (!PROJECT_ID.test(String(project?.id))) return [];
  const root = join(`${stateFile}.rna`, 'initiative', project.id);
  if (!await realDirectory(`${stateFile}.rna`) || !await realDirectory(join(`${stateFile}.rna`, 'initiative')) || !await realDirectory(root)) return [];
  const retained = new Set([...(project.initiativeRuntime?.sdkState?.actions ?? []), ...(project.jobs ?? [])].map(row => row?.id).filter(id => typeof id === 'string'));
  const cutoff = now - retentionDays * DAY_MS, removed = [];
  let archived = null;
  for (const name of await readdir(root)) {
    if (!SAFE_ID.test(name) || retained.has(name)) continue;
    const path = join(root, name), info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    archived ??= await archivedAt(stateFile, project.id);
    const since = archived.get(name) ?? await lastWrite(path) ?? (await stat(path)).mtimeMs;
    if (since > cutoff || await locked(path)) continue;
    if (await remove(path)) removed.push(path);
  }
  return removed;
}
