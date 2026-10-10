import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function processBirth(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  // Windows has no ps(1): the creation time and image name come from the process table, in the same "when + what" shape.
  if (process.platform === 'win32') {
    try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.CreationDate.ToFileTimeUtc()) $($p.Name)" }`], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim() || null; } catch { return null; }
  }
  // Native managers commonly start with locale C. On macOS ps then renders
  // non-ASCII executable paths as M-... escapes, producing a different identity
  // from the same CLI process under UTF-8. Pin ps's full locale, not just CTYPE
  // (an inherited LC_ALL would override it). Preserve TZ and the existing
  // timestamp + command format so current UTF-8 ownership records still match.
  const locale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: locale } }).trim() || null; } catch { return null; }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** SQLite's OS advisory lock is released on SIGKILL too. PID files alone have
 * a stale-delete race between two simultaneous restart attempts. No secrets or
 * application state are stored in this database. Only use on a local disk. */
export async function acquireProcessLease(path, metadata = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(`${path}.sqlite`);
  chmodSync(`${path}.sqlite`, 0o600);
  const token = randomUUID(); let acquired = false;
  try {
    db.exec('PRAGMA busy_timeout = 750; BEGIN EXCLUSIVE;');
    let old;
    try { old = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (old !== undefined) {
      let owner;
      try { owner = JSON.parse(old); } catch { throw new Error('进程锁格式损坏，请核实拥有者后再恢复。'); }
      const pid = typeof owner === 'number' ? owner : owner?.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('进程锁没有有效的进程身份，已停止自动接管。');
      const currentBirth = processAlive(pid) ? processBirth(pid) : null;
      const staleBirth = typeof owner === 'object' && owner.birth && currentBirth && owner.birth !== currentBirth;
      if (processAlive(pid) && !staleBirth) throw new Error(`同一服务或状态文件已有进程运行（PID ${pid}）`);
      unlinkSync(path);
    }
    writeFileSync(path, JSON.stringify({ ...metadata, pid: process.pid, token, birth: processBirth(process.pid), startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    acquired = true;
  } catch (error) {
    db.close();
    if (/database is locked/.test(error.message)) throw new Error('同一服务或状态文件已有进程持有排他锁。');
    throw error;
  }
  let released = false;
  return () => {
    if (released) return; released = true;
    if (acquired) try { const owner = JSON.parse(readFileSync(path, 'utf8')); if (owner.token === token) unlinkSync(path); } catch { /* The advisory lock is still released below. */ }
    db.close();
  };
}
