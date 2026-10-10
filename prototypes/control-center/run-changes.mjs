import { objectGit } from './turn-checkpoint.mjs';
import { toolKind } from './live-bus.mjs';
import { inLanguage } from './interface-language.mjs';

/** The source of the one continuation the guard pass may give a run (a finish-feedback observation). */
export const GUARD_SOURCE = 'host-guard-pass';
// Tools whose writes no per-tool hook sees: a command, a generated tool, an MCP tool, and the rest that are not named
// file tools (a worker's merge arrives through agent_delegate). A run that used none of them has nothing for the pass.
const UNHOOKED_KINDS = new Set(['command', 'mcp', 'other']);
/** Whether a run's messages (from index `from`) hold the result of a tool that can write without a file-write call. A code fact, not a judgment. */
export const ranUnhookedTool = (messages, from = 0) => (messages ?? []).slice(Math.max(0, from)).some(row => row?.role === 'toolResult' && UNHOOKED_KINDS.has(toolKind(row.toolName)));

/**
 * Whether a run's messages (from index `from`) hold a guard-pass continuation: a finish-feedback message of ours. The
 * allowance of one is read from the journal, never from a flag set when the feedback is offered: the SDK drops an offer
 * the user's new input overtook (the review records 'superseded'), and a dropped one must not use the allowance up.
 */
export const guardContinued = (messages, from = 0) => (messages ?? []).slice(Math.max(0, from)).some(row => row?.role === 'user' && row.source === 'finish-feedback' && (row.context ?? []).some(item => item?.source === GUARD_SOURCE));

// Where the guard pass at the end of a run (ToolPolicy#sweep, alignment 2026-10-05 §2.2 C1) gets "what this run changed".
// A change source is an async function answering `{ paths, read, materialize }` or null (nothing can be said):
//   paths        the files the run changed, relative to the run's root, as code computes them from the repository;
//   read         (path) => the file's text as the run found it: a string, null (it did not exist), undefined (cannot say);
//   materialize  (dir) => writes the whole folder as the run found it into `dir`, true when it did. A guard may read
//                other files than its own (a rules file, a list of chapters), so what it found in a file before the run is
//                asked of it in that folder, never in one holding only the file.
// Three roots, one answer each:
//   - a direct-mode turn in the project folder: its checkpoint's progress (TurnCheckpoint#progress), limited to the
//     paths attributable() gives it: what another owner's apply record wrote meanwhile is left out. Other writes into the
//     folder at the same time (an editor, another process) leave no record and are not told apart, the limit rollbackTurn
//     states to the user;
//   - a conversation's worktree S, or a background run's worktree B: the root as it is now against its base (the
//     project folder's tree as of the last sync or apply). Both are private to their run, so every difference is its own;
//   - anything else (no repository, no checkpoint, a background run working directly in the project folder): no source.
//     The host has no snapshot to say what such a run changed, and a guess would hand the user's own edits to the model.

/**
 * What the user reads when the guard pass could not get hits fixed in a run (the interface language; the project's own
 * guard titles and paths as they are). `open`: `{ path, title, hits }` rows; `scope`: 'turn' for a conversation's turn,
 * 'background' for a background run's work line.
 */
export function guardOpenText(open, { language = 'zh', scope = 'turn' } = {}) {
  const rows = Array.isArray(open) ? open : [];
  if (!rows.length) return '';
  // A check's title is the project's own words: one wrapped in quotes is quoted again in the reader's style, one that
  // opens with its own quoted term (「守夜」字样检查) is shown as it is, any other is put in quotes.
  const named = (title, open, close) => {
    const text = String(title ?? '').trim(), whole = /^[「『“"《]([^「」『』“”"《》]*)[」』”"》]$/.exec(text)?.[1];
    return whole !== undefined ? `${open}${whole}${close}` : /^[「『“"《]/.test(text) ? text : `${open}${text}${close}`;
  };
  const titles = [...new Set(rows.map(row => String(row.title ?? '').trim()))].slice(0, 2), paths = [...new Set(rows.map(row => row.path))], hits = rows.reduce((sum, row) => sum + (row.hits ?? 0), 0);
  const shown = paths.slice(0, 3).join(', '), more = paths.length - 3;
  const where = scope === 'background' ? { zh: '这次后台工作改的文件里', en: 'the files this background work changed' } : { zh: '这一轮改动的文件里', en: 'the files this turn changed' };
  return inLanguage(language, {
    zh: `${where.zh}，${titles.map(title => named(title, '「', '」')).join('、')}还有 ${hits} 处命中没有处理：${shown}${more > 0 ? ` 等 ${paths.length} 个文件` : ''}。`,
    en: `${hits} hit${hits === 1 ? '' : 's'} from ${titles.map(title => named(title, '“', '”')).join(' and ')} ${hits === 1 ? 'was' : 'were'} left unfixed in ${where.en}: ${shown}${more > 0 ? ` and ${more} more` : ''}.`,
  });
}

/**
 * A direct-mode turn's changes from its start checkpoint.
 * @param {import('./turn-checkpoint.mjs').TurnCheckpoint|null} checkpoints
 * @param {{ projectId: string, turnId: string }} turn
 */
export function checkpointChanges(checkpoints, { projectId, turnId }) {
  if (typeof checkpoints?.progress !== 'function' || !projectId || !turnId) return null;
  return async ({ signal } = {}) => {
    const progress = await checkpoints.progress(projectId, turnId, { signal });
    return progress ? { paths: progress.paths, read: progress.read, ...(typeof progress.materialize === 'function' ? { materialize: progress.materialize } : {}) } : null;
  };
}

/**
 * A worktree root's changes against its base (a session worktree S, a background run's B).
 * @param {{ engine: import('./git-isolation/index.mjs').IsolationEngine|null, projectId: string, root: object, base: string|null }} worktree
 */
export function worktreeChanges({ engine, projectId, root, base }) {
  if (typeof engine?.snapshot !== 'function' || typeof engine?.gitService !== 'function' || !projectId || !root || !base) return null;
  return async ({ signal } = {}) => {
    const git = engine.gitService(), located = await git.locateProject(projectId);
    if (located.repo === 'none') return null;
    const objects = objectGit(git, located), now = await engine.snapshot(projectId, root, { signal });
    return { paths: await objects.changed(base, now.commit), read: path => objects.text(base, path), materialize: (dir, options) => objects.materialize(base, dir, options) };
  };
}
