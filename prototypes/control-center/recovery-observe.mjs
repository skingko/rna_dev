import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

// Plan §2.5 item 8: when a step's outcome is uncertain after an interruption,
// the host looks at what that step touched and says so in one sentence
// ("I'm not sure ch8.md was fully written; it now has 212 lines"), instead of
// a verification dialog. Read-only and bounded; never inside the state
// transaction.
const MAX_READ = 2_000_000;

function observe(workspace, tool) {
  const path = typeof tool?.arguments?.path === 'string' ? tool.arguments.path : null;
  if (!path) return null;
  const full = resolve(workspace, path), within = relative(workspace, full);
  if (!within || within.startsWith('..') || isAbsolute(within)) return null;
  try {
    const info = statSync(full);
    if (!info.isFile()) return { path, exists: true, kind: 'directory' };
    let lines = null, lastLine = null;
    if (info.size <= MAX_READ) { const rows = readFileSync(full, 'utf8').split('\n'); lines = rows.length; lastLine = rows.filter(row => row.trim()).at(-1)?.trim().slice(0, 80) ?? null; }
    return { path, exists: true, bytes: info.size, lines, lastLine, modifiedAt: info.mtime.toISOString() };
  } catch { return { path, exists: false }; }
}

/** The recovery record with what each uncertain step's target looks like now. */
export function observeUncertain(workspace, recovery) {
  if (!workspace || !recovery?.uncertainTools?.length) return recovery;
  return { ...recovery, uncertainTools: recovery.uncertainTools.map(tool => { const observed = observe(workspace, tool); return observed ? { ...tool, observed } : tool; }) };
}
