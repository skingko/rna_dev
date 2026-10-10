// The open conversation on the wire (docs/specs/stream-protocol-v2.md §1 GET /api/v2/sessions/:id, §2 session stream):
// what GET /api/v2/sessions/:id, the paging route and the session stream carry of a stored session.
//
// - The session record and its turns are explicit allowlists, as the index rows are (index-schema.mjs): a host field
//   reaches a client only once it is named here. The memory pipeline's bookkeeping (turn.memoryContext and
//   memoryWrite, session.memoryEvidenceOutbox, 843 + 121 + 197 KB of the novel conversation in 0.67) stays on the host.
// - Items are the conversation itself and travel as stored (§3 fields): the web reads most of them, the CLI the rest.
// - A conversation opens on a tail window and pages backward (deepseek-harness session-controller history.ts:38,
//   392-425: at least 50 messages and 2 turns, at most 500 messages; zcode protocol v4 snapshot.ts:451-458 rows window
//   with totalCount/firstRowId, transport.ts:511-533 rows/range with limit ≤ 200).
//
// Pure module without imports: the web's contract tests load it as it is.

/** Session fields on the wire: what the web (SessionMeta), the CLI (chat, run, recovery) and the spec read. */
export const SESSION_FIELDS = Object.freeze([
  'id', 'title', 'projectId', 'kind', 'parentSessionId', 'status', 'pauseReason', 'mode', 'model', 'modelSelection', 'modelConfig',
  'context', 'usage', 'activeTurnId', 'workspace', 'inbox', 'plan', 'createdAt', 'updatedAt', 'archivedAt', 'simulated', 'runtime',
  'appRecovery', 'sideChat', 'sideContext', 'invitations', 'worktree',
]);

/**
 * Turn fields on the wire: the web's Turn, the CLI's run (status, userItemId) and the spec's §3 turn. `route` is the
 * router's small advice record (skills, clarify, background, model tier; the turn footer's hints, §3 H5).
 */
export const TURN_FIELDS = Object.freeze([
  'id', 'status', 'source', 'mode', 'model', 'createdAt', 'startedAt', 'firstTokenAt', 'completedAt', 'userItemId', 'modelConfig',
  'timing', 'usage', 'activeMs', 'attemptStartedAt', 'pausedAt', 'retryHistory', 'autoRetry', 'errorCode', 'blockingActionId',
  'blockingDraining', 'apply', 'checkpoint', 'route',
]);

/** The opening window (harness DEFAULT_MAX_MESSAGES and its turn window): whole turns, ≥50 messages and ≥2 turns, ≤500 messages. */
export const TAIL_WINDOW = Object.freeze({ minMessages: 50, minTurns: 2, maxMessages: 500 });
/** Items per page back (zcode rowsRangeMaxLimit). */
export const PAGE_LIMIT = 200;

const MESSAGE_KINDS = new Set(['user', 'assistant']);

/** The named own fields of `source`, in list order (undefined values dropped, as JSON does). */
function pickFields(source, fields) {
  const row = {};
  for (const key of fields) if (Object.hasOwn(source, key) && source[key] !== undefined) row[key] = source[key];
  return row;
}
/** A session's record on the wire, without items and turns. */
export const sessionMeta = session => pickFields(session, SESSION_FIELDS);
/** A turn on the wire. */
export const turnView = turn => pickFields(turn, TURN_FIELDS);
/**
 * A card waiting for the user: a question or permission request still pending (or interrupted) that can be answered.
 * The index row counts them (`waiting`); the tail window carries those older than itself as `pinned`.
 */
export const waitingForUser = item => {
  const interaction = item?.interaction;
  return Boolean(interaction && (interaction.status === 'pending' || interaction.status === 'interrupted') && interaction.canRespond !== false);
};

/**
 * Where history can be cut without splitting a turn: `bounds[i]` is 1 when every turn with an item before index i has
 * its last item before i too (items without a turn, such as a proactive message delivered mid-turn, never end one).
 * `referenced` holds every turn id an item names.
 */
export function turnBoundaries(items) {
  const last = new Map();
  for (let index = 0; index < items.length; index++) { const turnId = items[index]?.turnId; if (turnId) last.set(turnId, index); }
  const bounds = new Uint8Array(items.length + 1);
  let reach = -1;
  for (let index = 0; index < items.length; index++) {
    if (reach < index) bounds[index] = 1;
    const turnId = items[index]?.turnId;
    if (turnId) reach = Math.max(reach, last.get(turnId));
  }
  bounds[items.length] = 1;
  return { bounds, referenced: new Set(last.keys()) };
}

/**
 * The tail window's first index (harness history.ts paginate): walking back from the newest item, the first turn
 * boundary where at least `minMessages` user/assistant items and `minTurns` whole turns are covered; at `maxMessages`
 * messages it stops wherever it is. 0 when the whole conversation is smaller.
 */
export function tailStart(items, { minMessages, minTurns, maxMessages } = TAIL_WINDOW, bounds = turnBoundaries(items).bounds) {
  let messages = 0;
  const turns = new Set();
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (MESSAGE_KINDS.has(item?.kind)) messages++;
    if (item?.turnId) turns.add(item.turnId);
    if (bounds[index] && messages >= minMessages && turns.size >= minTurns) return index;
    if (messages >= maxMessages) return index;
  }
  return 0;
}

/**
 * A page back: at most `limit` items before `end`, starting at a turn boundary when one lies inside the page (the
 * partial turn at its top comes whole with the next page); a turn longer than the page is cut where the page ends.
 */
export function pageStart(items, end, limit = PAGE_LIMIT, bounds = turnBoundaries(items).bounds) {
  let start = Math.max(0, end - limit);
  if (start > 0 && !bounds[start]) {
    let next = start;
    while (next < end && !bounds[next]) next++;
    if (next < end) start = next;
  }
  return start;
}
