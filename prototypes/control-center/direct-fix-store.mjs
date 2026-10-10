import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Pre-change snapshots for proactive work the host handled directly, so the
 * user can keep or revert it. Only files changed through the project write/edit
 * tools are covered; each is captured once, before its first change. A revert
 * never overwrites a file changed again afterwards. */
export const DIRECT_FIX_TOOLS = Object.freeze(['project_write', 'project_edit']);
const MAX_FILE_BYTES = 8 * 1024 * 1024, MAX_FILES = 64;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);

export class DirectFixRecorder {
  constructor(root) { this.root = realpathSync(root); this.files = new Map(); this.skipped = []; }
  /** Called before a write/edit tool runs with its `path` argument. */
  capture(input) {
    if (typeof input !== 'string' || !input || input.includes('\0')) return;
    const path = resolve(this.root, input);
    if (!within(this.root, path)) return;
    const key = relative(this.root, path).split(sep).join('/');
    if (this.files.has(key)) return;
    if (this.files.size >= MAX_FILES) { this.skipped.push(key); return; }
    try {
      if (!existsSync(path)) { this.files.set(key, { path: key, existed: false }); return; }
      const info = lstatSync(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) { this.skipped.push(key); return; }
      this.files.set(key, { path: key, existed: true, before: readFileSync(path) });
    } catch { this.skipped.push(key); }
  }
  /** Files whose content actually changed, with their after-hash. */
  changes() {
    const rows = [];
    for (const row of this.files.values()) {
      const path = join(this.root, row.path);
      let after = null; try { after = existsSync(path) ? readFileSync(path) : null; } catch { continue; }
      if (row.existed ? after && Buffer.compare(after, row.before) === 0 : after === null) continue;
      rows.push({ ...row, after, afterSha: after ? sha(after) : null });
    }
    return rows;
  }
}

/** Persist snapshots under `dir/<fixId>/`; returns the manifest stored in state (no file bodies). */
export function saveDirectFix(dir, fixId, changes) {
  const target = join(dir, fixId); mkdirSync(target, { recursive: true, mode: 0o700 });
  return changes.map((row, index) => {
    if (row.existed) writeFileSync(join(target, String(index)), row.before, { mode: 0o600 });
    // The result as the work left it, so its diff stays reviewable after later edits.
    if (row.after) writeFileSync(join(target, `${index}.after`), row.after, { mode: 0o600 });
    return { path: row.path, existed: row.existed, ...(row.existed ? { blob: String(index), beforeSha: sha(row.before) } : {}), ...(row.after ? { afterBlob: `${index}.after` } : {}), afterSha: row.afterSha };
  });
}

const TEXT_LIMIT = 400 * 1024;
/** Text of a snapshot for review: null when missing; binary files are not decoded; long ones are cut. */
function reviewText(bytes) {
  if (!bytes) return { text: null, binary: false, truncated: false };
  if (bytes.subarray(0, 8192).includes(0)) return { text: null, binary: true, truncated: false };
  return { text: bytes.subarray(0, TEXT_LIMIT).toString('utf8'), binary: false, truncated: bytes.length > TEXT_LIMIT };
}
/** Before / after of every file in a change set, for the deliverables list and its review (read-only). */
export function readDirectFix(dir, fixId, root, files) {
  let base = null; try { base = realpathSync(root); } catch { base = null; }
  return files.map(row => {
    const read = name => { try { return name ? readFileSync(join(dir, fixId, name)) : null; } catch { return null; } };
    let after = read(row.afterBlob), current = null;
    const path = base && !isAbsolute(row.path) ? resolve(base, row.path) : null;
    if (path && within(base, path)) try { current = existsSync(path) ? readFileSync(path) : null; } catch { current = null; }
    const currentSha = current ? sha(current) : null;
    // Sets saved before the after-snapshot existed: the file on disk is the result while it is unchanged.
    if (!after && row.afterSha && currentSha === row.afterSha) after = current;
    const before = reviewText(row.existed ? read(row.blob) : null), result = reviewText(after);
    return { path: row.path, created: !row.existed, deleted: row.afterSha === null, changedSince: currentSha !== (row.afterSha ?? null),
      before: before.text, after: result.text, binary: before.binary || result.binary, truncated: before.truncated || result.truncated, available: row.afterSha === null || after !== null };
  });
}

/** Restore every file still exactly as the fix left it. */
export function revertDirectFix(dir, fixId, root, files) {
  const base = realpathSync(root), restored = [], conflicts = [], failed = [];
  for (const row of files) {
    const path = resolve(base, row.path);
    if (isAbsolute(row.path) || !within(base, path)) { failed.push(row.path); continue; }
    try {
      const now = existsSync(path) ? sha(readFileSync(path)) : null;
      if (now !== row.afterSha) { conflicts.push(row.path); continue; }
      if (!row.existed) { if (now !== null) unlinkSync(path); restored.push(row.path); continue; }
      const before = readFileSync(join(dir, fixId, row.blob));
      if (sha(before) !== row.beforeSha) { failed.push(row.path); continue; }
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.rna-revert-${process.pid}`; writeFileSync(temporary, before); renameSync(temporary, path);
      restored.push(row.path);
    } catch { failed.push(row.path); }
  }
  return { restored, conflicts, failed };
}

export function discardDirectFix(dir, fixId) { rmSync(join(dir, fixId), { recursive: true, force: true }); }
