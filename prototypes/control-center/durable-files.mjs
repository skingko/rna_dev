import { mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Flush a directory's entries (a created, renamed or removed file) to disk. Windows cannot fsync a directory handle
 * (EPERM); there a rename is already written through, so the call succeeds without doing more. `platform` is a test seam. */
export function syncDirectory(path, platform = process.platform) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  catch (error) { if (!(platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'EACCES'].includes(error.code))) throw error; }
  finally { closeSync(fd); }
}

/** Never replace a state file with a partially written payload. A post-rename
 * error explicitly reports that the new value is already visible on disk. */
export function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd, committed = false;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path); committed = true;
    syncDirectory(dirname(path));
  } catch (error) {
    error.committed = committed;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!committed) try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') { /* Original write error takes precedence. */ } }
  }
}

export function readJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
