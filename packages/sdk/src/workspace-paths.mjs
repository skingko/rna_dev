import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

/** How often a path that exists but did not resolve is resolved again before it counts as a dangling link. */
const RESOLVE_ATTEMPTS = 3;

/**
 * canonicalizeMissingPath over a given `{ realpath, lstat }` (node:fs/promises shape); tests pass a filesystem whose
 * entries appear between the two calls.
 */
export function missingPathCanonicalizer(fs) {
  return async function canonicalize(path) {
    let current = resolve(path), attempts = 0; const missing = [];
    for (;;) {
      try { return resolve(await fs.realpath(current), ...missing); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // A dangling link exists but has no resolvable target. Treating it as a
        // missing directory would choose the wrong future filesystem identity.
        const exists = await fs.lstat(current).then(() => true, failure => { if (failure.code === 'ENOENT') return false; throw failure; });
        // An entry that exists now may only have been created after realpath looked (a sidecar's first append, a
        // lock taken while a turn starts): resolve it again. Only one that still does not resolve is dangling.
        if (exists) { if (++attempts >= RESOLVE_ATTEMPTS) throw error; continue; }
        const parent = dirname(current); if (parent === current) throw error;
        missing.unshift(basename(current)); current = parent; attempts = 0;
      }
    }
  };
}

/** Resolve existing ancestors without requiring the protected leaf to exist.
 * Only ENOENT permits walking upward. Permission failures, non-directories,
 * loops and dangling symlinks fail closed instead of becoming lexical paths. */
export const canonicalizeMissingPath = missingPathCanonicalizer({ realpath, lstat });
