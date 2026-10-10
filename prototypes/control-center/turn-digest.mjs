import { toolKind, toolTarget } from './live-bus.mjs';

// One turn as the judges read it (align 2026-10-05 §2.2 B5, §2.3 #1): the request, the first and the last tool
// steps, the paths the turn wrote, and the end of its final reply. mu's turn digest (kyrn-judge memory/phrasing.ts:
// 51-77: request, HEAD_STEPS 6 + TAIL_STEPS 14 steps as `kind target -> ok/error`, closing message), plus the written
// paths: a writing project's prose lives in files, so a reply alone never shows whether a rule was followed.
//
// The only implementation: the mind's lesson accounting (D1), the gene lanes' followed check (EVO-4) and lesson.applied
// read it. Built in code from what the turn left on record (its items, its apply records, its checkpoint's diff);
// nothing here is judged. The mind persists it on the turn when it settles the turn (`turn.digest`), and builds it
// again for a turn that ended while the host was down (catch-up) or that ran again (a retry).

export const TURN_DIGEST_VERSION = 1;
export const DIGEST_HEAD_STEPS = 6, DIGEST_TAIL_STEPS = 14;
// What each part keeps (mu: request 400, step 200, closing message 800). Written paths: as many as an apply record's sample.
const REQUEST_CHARS = 400, STEP_CHARS = 200, REPLY_CHARS = 800, PATH_CHARS = 300, WRITTEN_PATHS = 20;
// Kinds that say what a step did; any other tool is named by its own name (`project_plan`, a guard, an MCP tool).
const NAMED_KINDS = new Set(['read', 'search', 'write', 'edit', 'command', 'web_search', 'web_fetch', 'skill', 'question', 'plan']);
const WRITE_KINDS = new Set(['write', 'edit']);
const OUTCOME = { succeeded: 'ok', failed: 'error' };

const flat = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const tail = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `…${text.slice(text.length - max + 1)}` : text; };
const itemText = item => typeof item?.text === 'string' ? item.text : '';
const relative = path => typeof path === 'string' && path.trim() && !path.includes('\0') ? flat(path, PATH_CHARS) : null;

/** One tool item as a step: `kind target -> ok|error` (any other end state by name: uncertain, interrupted, cancelled). */
export function digestStep(tool) {
  const kind = tool?.kind ?? toolKind(tool?.name), label = NAMED_KINDS.has(kind) ? kind : String(tool?.name ?? kind ?? 'tool');
  const target = tool?.target ?? toolTarget(tool?.name, tool?.args);
  return flat(`${label}${target ? ` ${target}` : ''} -> ${OUTCOME[tool?.status] ?? String(tool?.status ?? 'unknown')}`, STEP_CHARS);
}

/** The turn's tool steps in order, as digestStep lines. */
export function turnSteps(session, turn) {
  return (session?.items ?? []).filter(item => item?.turnId === turn?.id && item.tool && typeof item.tool === 'object').map(item => digestStep(item.tool));
}

/**
 * The paths a turn wrote, from its own record: the write and edit steps that succeeded and the files media tools
 * reported (receipts), the apply records it wrote to the project folder (a conversation worktree's turn, a subagent's
 * merge; their sample), and `checkpoint`: the paths its direct-mode checkpoint attributes to it (TurnCheckpoint
 * #attributable, read by the caller, which covers what commands wrote). Deduplicated in that order.
 */
export function turnWrittenPaths(session, turn, { project = null, checkpoint = null } = {}) {
  const out = new Set(), add = path => { const value = relative(path); if (value) out.add(value); };
  for (const item of session?.items ?? []) {
    if (item?.turnId !== turn?.id || !item.tool || item.tool.status !== 'succeeded') continue;
    const kind = item.tool.kind ?? toolKind(item.tool.name);
    if (WRITE_KINDS.has(kind)) add(typeof item.tool.args?.path === 'string' ? item.tool.args.path : item.tool.target);
    for (const file of Array.isArray(item.tool.files) ? item.tool.files : []) add(file?.path);
  }
  for (const row of project?.git?.applies ?? []) if (row?.target === 'project' && ['turn', 'worker'].includes(row.kind) && row.source?.turnId === turn?.id) for (const path of row.sample ?? []) add(path);
  for (const path of Array.isArray(checkpoint) ? checkpoint : []) add(path);
  return [...out];
}

/** The turn's final reply: its last finished assistant message with text (the one marked final, when there is one). */
export function finalReply(session, turn) {
  const replies = (session?.items ?? []).filter(item => item?.turnId === turn?.id && item.kind === 'assistant' && !item.streaming && itemText(item).trim());
  return replies.findLast(item => item.final) ?? replies.at(-1) ?? null;
}

/**
 * The digest of one terminal turn. `checkpoint`: the paths its checkpoint attributes to it, when the caller read them
 * (null: not read, or the turn has none). Bounded: the request, at most 6 + 14 steps (the count of the rest), at most
 * 20 written paths (and how many there were), the last 800 characters of the reply.
 */
export function buildTurnDigest(session, turn, { project = null, checkpoint = null, now = Date.now() } = {}) {
  const steps = turnSteps(session, turn), head = steps.slice(0, DIGEST_HEAD_STEPS), last = steps.slice(DIGEST_HEAD_STEPS).slice(-DIGEST_TAIL_STEPS);
  const written = turnWrittenPaths(session, turn, { project, checkpoint }), user = (session?.items ?? []).find(item => item?.id === turn?.userItemId);
  return {
    version: TURN_DIGEST_VERSION, status: turn?.status ?? null, endedAt: turn?.completedAt ?? null,
    request: flat(itemText(user), REQUEST_CHARS), steps: [...head, ...last], skipped: steps.length - head.length - last.length,
    written: written.slice(0, WRITTEN_PATHS), writtenTotal: written.length, applies: appliesOf(project, turn),
    // 'checkpoint': the paths include what the turn's checkpoint attributes to it; 'record': its steps and apply records only.
    paths: Array.isArray(checkpoint) ? 'checkpoint' : 'record', ...(turn?.checkpoint?.endedAt ? { checkpointEndedAt: turn.checkpoint.endedAt } : {}),
    reply: tail(itemText(finalReply(session, turn)), REPLY_CHARS), at: new Date(now).toISOString()
  };
}

/** A stored digest of this end of the turn (same version, status and end time): a retry or a resume ends it again. */
const sameEnd = (digest, turn) => Boolean(digest) && digest.version === TURN_DIGEST_VERSION && digest.status === turn?.status && digest.endedAt === (turn?.completedAt ?? null);
/** The turn's apply records to the project folder (a worktree turn's apply can come after the turn ended). */
const appliesOf = (project, turn) => (project?.git?.applies ?? []).filter(row => row?.target === 'project' && ['turn', 'worker'].includes(row.kind) && row.source?.turnId === turn?.id).length;
/**
 * Whether a stored digest still describes the turn: the same end, the same apply records (`project`, when given), and,
 * once the turn's checkpoint holds this end, its paths.
 */
export function digestCurrent(digest, turn, project = null) {
  if (!sameEnd(digest, turn) || (project && (digest.applies ?? 0) !== appliesOf(project, turn))) return false;
  return turn?.checkpoint?.state !== 'taken' || (digest.paths === 'checkpoint' && (digest.checkpointEndedAt ?? null) === (turn.checkpoint.endedAt ?? null));
}

/** The turn's stored digest of its last end, else one built from its record now (without the checkpoint's paths). */
export function turnDigestOf(session, turn, { project = null, now = Date.now() } = {}) {
  return sameEnd(turn?.digest, turn) ? turn.digest : buildTurnDigest(session, turn, { project, now });
}

// What a judge may read of the files a turn wrote (D1): the last few, the start and the end of each.
export const EXCERPT_FILES = 3, EXCERPT_CHARS = 700;
const excerptOf = (text, max) => { const value = String(text ?? '').trim(); return value.length <= max ? value : `${value.slice(0, Math.round(max * .65))}\n…\n${value.slice(value.length - Math.round(max * .3))}`; };
/**
 * What the turn wrote, as text a judge can read: from its own record, when it is judged, and never kept. A writing project's
 * prose lives in the files it writes and the reply only says the chapter is done, so with the paths alone a rule about the prose
 * ("numbers in Han characters", "no filler metaphors") reads as a situation that did not come up — measured:
 * docs/research/jev-rule-use-probe-20261005.md §2.3 — while with the start of what was written it is judged. The last
 * `files` files its successful write and edit steps changed: project_write, the start and the end of what it saved; project_edit,
 * the text its edits put in (several edits to one file are joined). Files written by a command are not here (no text in the record).
 */
export function writtenExcerpts(session, turn, { files = EXCERPT_FILES, chars = EXCERPT_CHARS } = {}) {
  const byPath = new Map();
  for (const item of session?.items ?? []) {
    if (item?.turnId !== turn?.id || !item.tool || item.tool.status !== 'succeeded') continue;
    const kind = item.tool.kind ?? toolKind(item.tool.name);
    if (!WRITE_KINDS.has(kind)) continue;
    const args = item.tool.args && typeof item.tool.args === 'object' ? item.tool.args : {}, path = relative(typeof args.path === 'string' ? args.path : item.tool.target);
    // project_edit takes `edits`, and still the older single oldText/newText form (workspace-tools.mjs folds it in as one more edit).
    const replacements = [...(Array.isArray(args.edits) ? args.edits : []), ...(args.newText !== undefined ? [{ newText: args.newText }] : [])];
    const saved = typeof args.content === 'string' ? args.content : null, edited = replacements.map(edit => typeof edit?.newText === 'string' ? edit.newText : '').filter(Boolean).join('\n');
    const text = saved ?? edited;
    if (!path || !text.trim()) continue;
    const before = byPath.get(path); byPath.delete(path);
    // A save replaces what the file held; an edit adds its text to what the turn already put in this file.
    byPath.set(path, saved !== null || !before ? text : `${before}\n${text}`.slice(-chars * 4));
  }
  return [...byPath].slice(-files).map(([path, text]) => ({ path, text: excerptOf(text, chars) }));
}

/**
 * The digest as the parts a judge reads (D1: the lesson-use judgment's state, decision-state.mjs turnDigestState; the text form
 * below is these parts in order): the request, the first steps, how many steps lie between (as a line), the last steps, the
 * written paths, how a turn that did not complete ended, and the end of the reply. Strings and string lists; nothing is judged.
 * `excerpts` (writtenExcerpts): the start of what the turn wrote, read when the digest is judged; not part of the digest itself.
 */
export function digestParts(digest, { excerpts = [] } = {}) {
  if (!digest) return null;
  const more = digest.writtenTotal - digest.written.length;
  return {
    request: digest.request || '(nothing)', firstSteps: digest.steps.slice(0, DIGEST_HEAD_STEPS), skipped: digest.skipped > 0 ? `(${digest.skipped} more steps)` : '', lastSteps: digest.steps.slice(DIGEST_HEAD_STEPS),
    wrote: digest.written.length ? `${digest.written.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` : '', excerpts, ended: digest.status && digest.status !== 'completed' ? digest.status : '', reply: digest.reply || '(nothing)'
  };
}

/**
 * The digest as judge-readable text (mu turnDigest): `user:`, `step:` lines with `(N more steps)` between the first and
 * the last ones, `wrote:` the paths, `ended:` a turn that did not complete, and `assistant:` the end of the reply.
 */
export function formatTurnDigest(digest) {
  const parts = digestParts(digest);
  if (!parts) return '';
  return [
    `user: ${parts.request}`,
    ...parts.firstSteps.map(step => `step: ${step}`),
    ...(parts.skipped ? [parts.skipped] : []),
    ...parts.lastSteps.map(step => `step: ${step}`),
    ...(parts.wrote ? [`wrote: ${parts.wrote}`] : []),
    ...(parts.ended ? [`ended: ${parts.ended}`] : []),
    `assistant: ${parts.reply}`
  ].join('\n');
}
