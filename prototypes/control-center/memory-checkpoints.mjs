import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceItem = (item, turn) => item.turnId === turn.id && ['user', 'assistant'].includes(item.kind) && typeof item.text === 'string' && item.text.trim();
const checkpointItem = (item, turn) => sourceItem(item, turn) && item.streaming !== true && !(item.kind === 'assistant' && ['error', 'aborted', 'length'].includes(item.stopReason));
export const memoryWriteRecords = turn => [
  ...(turn.memoryWrite ? [{ id: null, write: turn.memoryWrite }] : []),
  ...(turn.memoryCheckpoints ?? []).map(write => ({ id: write.id, write }))
];
export const checkpointRetention = Object.freeze({ retention_mode: 'turn_budget', keep_recent_turn_count: 1, retained_message_token_budget: 2048, min_raw_tail_steps: 1 });

export function memoryMessagesOf(session, turn, write) {
  let items = session.items.filter(item => sourceItem(item, turn));
  if (write?.schemaVersion === 1 && Array.isArray(write.sourceRefs)) {
    items = write.sourceRefs.map(ref => {
      const item = session.items.find(item => item.id === ref.itemId);
      if (!item || !checkpointItem(item, turn) || hash([item.kind, item.text]) !== ref.textHash) throw Object.assign(new Error('Frozen memory source changed'), { code: 'MEMORY_SOURCE_CHANGED' });
      return item;
    });
  }
  const messages = [];
  for (const item of items) {
    let content = '', part = 0;
    const append = () => { if (content.trim()) messages.push({ role: item.kind, content, sourceMessageId: `${item.id}:${part++}` }); content = ''; };
    for (const character of item.text) { if (content.length + character.length > 12000) append(); content += character; }
    append();
  }
  if (write?.sourceHash && hash(messages) !== write.sourceHash) throw Object.assign(new Error('Frozen memory source changed'), { code: 'MEMORY_SOURCE_CHANGED' });
  return messages;
}

/** The segments a record's commit archives together with it (B2): the contiguous run of 'retained' checkpoints right
 * before it in the same remote session. A 'retained' receipt left their messages in that session's live context, and
 * the next commit there archives them with its own — the user anchor sits in the first of them. Records whose
 * retained predecessors were already handed to a re-extraction name them in `reextract.covers`. */
export function coveredCheckpoints(turn, write) {
  const records = turn?.memoryCheckpoints ?? [];
  if (Array.isArray(write?.reextract?.covers)) return write.reextract.covers.map(id => records.find(row => row.id === id) ?? null);
  const at = records.findIndex(row => row.id === write?.id), covered = [];
  if (at < 0 || !write.sessionId) return covered;
  for (let index = at - 1; index >= 0 && records[index].status === 'retained' && records[index].sessionId === write.sessionId; index--) covered.unshift(records[index]);
  return covered;
}
/** What a re-extraction of `write` uploads to a fresh remote session: its covered retained segments, then its own
 * messages, each checked against its own frozen source (MEMORY_SOURCE_CHANGED when one changed or is gone). */
export function reextractMessagesOf(session, turn, write) {
  const covered = coveredCheckpoints(turn, write);
  if (covered.some(row => !row)) throw Object.assign(new Error('Covered memory segment is gone'), { code: 'MEMORY_SOURCE_CHANGED' });
  return [...covered.flatMap(row => memoryMessagesOf(session, turn, row)), ...memoryMessagesOf(session, turn, write)];
}

// Invoked only at an SDK-confirmed settled slice or normal completed turn.
// Persist references, never a second transcript. All enrolled references,
// including failed/uncertain records, remain watermarks against paid replay.
export function enqueueMemoryCheckpoint(session, turn, { connectionFingerprint, now = Date.now(), final = false, boundary = 'settled_slice', minIntervalMs = 1800000, minCharacters = 512, messageThreshold = 40 } = {}) {
  if (turn.modelConfig?.execution !== 'rna' || !connectionFingerprint || turn.memoryWrite || !['settled_slice', 'completed_turn'].includes(boundary)) return null;
  const records = turn.memoryCheckpoints ?? [];
  const seen = new Set(records.flatMap(row => row.sourceRefs.map(ref => ref.itemId)));
  const items = session.items.filter(item => checkpointItem(item, turn) && !seen.has(item.id));
  if (!items.length && !(final && records.length && records.at(-1).kind !== 'final')) return null;
  const baseline = Date.parse(records.at(-1)?.createdAt ?? turn.startedAt ?? turn.createdAt);
  const characters = items.reduce((sum, item) => sum + item.text.length, 0);
  if (!final && items.length < messageThreshold && !(Number.isFinite(baseline) && now - baseline >= minIntervalMs && characters >= minCharacters)) return null;
  // A checkpoint can contain only new assistant messages. Its role remains
  // assistant: OpenViking may update working memory without extracting any
  // peer memories. Never manufacture a user message or a positive count.
  const record = { schemaVersion: 1, id: randomUUID(), kind: final ? 'final' : 'incremental', boundary, status: 'pending', createdAt: new Date(now).toISOString(), nextMessage: 0, connectionFingerprint,
    sourceRefs: items.map(item => ({ itemId: item.id, textHash: hash([item.kind, item.text]) })), sourceMessageCount: items.length, sourceCharacters: characters,
    retention: final ? { keep_recent_count: 0 } : { ...checkpointRetention } };
  record.sourceHash = hash(memoryMessagesOf(session, turn, record));
  turn.memoryCheckpoints ??= []; turn.memoryCheckpoints.push(record);
  return record;
}
