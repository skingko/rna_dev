// D4 scenario harness: live-shaped state (plan A7 gates; align-studies "Data-loading invariants": 2,000 items, 60
// outbox rows, 12 rhythm history rows). Shapes and sizes follow the live bootstrap measured read-only on 2026-10-05
// (novel conversation: 2,010 items, ~3.2 KB each; memoryEvidenceOutbox 58 rows, ~3.3 KB each; project rows 64–106 KB
// with rhythmRuntime/rhythmStatus ~10 KB each from 12 history rows, memorySummary ~19 KB, schedule receipts ~14 KB).
// All text is synthetic. The rows are written straight into the store, as earlier releases left them.
import { createHash } from 'node:crypto';
import { projectRhythmEvidenceKey } from '../../project-rhythm.mjs';

const hex = (seed, length = 64) => { let out = ''; for (let i = 0; out.length < length; i++) out += createHash('sha256').update(`${seed}:${i}`).digest('hex'); return out.slice(0, length); };
const uuid = seed => { const h = hex(seed, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const PHRASES = ['The chapter keeps its pacing steady while the second thread waits.', '第二条线索在这一章暂时不推进，节奏保持平稳。', 'Revision notes: tighten the opening, keep the names consistent.', '人物关系表已经核对，章节之间没有矛盾。', 'Draft paragraph with dialogue, description and a closing beat.'];
/** Deterministic synthetic prose of about `length` characters. */
export const prose = (seed, length) => { let out = '', i = seed; while (out.length < length) out += `${PHRASES[i++ % PHRASES.length]} `; return out.slice(0, length); };

/** Conversation items and turns: user, assistant, tool, assistant per turn, about `itemBytes` of JSON each on average. */
export function conversationRows({ items = 2000, itemBytes = 3200, start = Date.parse('2026-09-01T00:00:00Z'), prefix = 'live', memoryContextBytes = 1600 } = {}) {
  const rows = [], turns = [];
  for (let index = 0; rows.length < items; index++) {
    const turnId = `${prefix}-turn-${index}`, at = new Date(start + index * 600000).toISOString(), done = new Date(start + index * 600000 + 90000).toISOString();
    const userId = `${prefix}-u-${index}`;
    rows.push({ id: userId, turnId, kind: 'user', text: prose(index, Math.round(itemBytes * 0.25)), createdAt: at, simulated: false });
    rows.push({ id: `${prefix}-a-${index}`, turnId, kind: 'assistant', text: prose(index + 1, Math.round(itemBytes * 0.9)), createdAt: at, simulated: false, streaming: false });
    rows.push({ id: `${prefix}-t-${index}`, turnId, kind: 'tool', createdAt: at, simulated: false, tool: { name: 'project_write', status: 'succeeded', callId: `${prefix}-call-${index}`, arguments: { path: `chapters/${index}.md`, content: prose(index + 2, Math.round(itemBytes * 1.3)) }, output: `Wrote chapters/${index}.md` } });
    rows.push({ id: `${prefix}-f-${index}`, turnId, kind: 'assistant', text: prose(index + 3, Math.round(itemBytes * 0.6)), createdAt: done, simulated: false, streaming: false });
    turns.push({ id: turnId, status: 'completed', createdAt: at, startedAt: at, completedAt: done, userItemId: userId, modelConfig: { execution: 'rna', providerId: 'live-shaped', modelId: 'live-shaped' }, usage: { input: 52000, output: 1800, totalTokens: 53800 },
      memoryContext: { status: 'recalled', query: prose(index, 120), results: [{ uri: `viking://resources/fixture/${index}`, level: 2, abstract: prose(index + 4, Math.max(20, memoryContextBytes - 200)) }] } });
  }
  return { items: rows.slice(0, items), turns };
}

/**
 * memoryEvidenceOutbox rows in the shape memory-evidence-outbox.mjs leaves after completion (~3.3 KB each). Their
 * delivery documents are already gone (resourceIndex 'deleted', a code no restore path reacts to), so memory sync leaves
 * them alone: they reference sources this fixture does not create, and a live row would be withdrawn and deleted.
 */
export function outboxRows({ count = 60, projectId, sessionId, at = '2026-09-20T00:00:00.000Z' } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1, sourceContext: { actionKind: 'share', evidence: [{ actionId: uuid(`a${index}`), status: 'completed', receipts: Array.from({ length: 10 }, (__, n) => `receipt-${n}`), coverage: prose(index, 168) }] },
    id: uuid(`outbox${index}`), kind: 'evidence', sourceKind: 'autonomous_delivery', projectId, status: 'completed', createdAt: at, nextMessage: 0, connectionFingerprint: hex(`c${index}`),
    sourceRefs: [{ itemId: uuid(`item${index}`), sourceHash: hex(`s${index}`) }], sourceHash: hex(`h${index}`), sourceMessageCount: 2, sourceCharacters: 900, retention: { keep_recent_count: 0 }, identityKey: hex(`i${index}`),
    resourceIndex: { status: 'deleted', namespace: hex(`n${index}`), uri: `viking://resources/rna/${hex(`u${index}`, 120)}/evidence/${uuid(`r${index}`)}.md`, connectionFingerprint: hex(`c${index}`), mode: 'create',
      restore: { version: 1, at, reason: 'source_restored_fixture', previous: { status: 'deleted', code: 'MEMORY_SOURCE_DELETED', deletedAt: at } }, updatedAt: at, userId: 'scenario', contentHash: hex(`ch${index}`), dispatchedAt: at,
      receipt: { userId: 'scenario', contentHash: hex(`ch${index}`), uri: `viking://resources/rna/${hex(`u${index}`, 120)}/evidence/${uuid(`r${index}`)}.md`, mode: 'create', writtenBytes: 1800, contentUpdated: true, semanticStatus: 'complete', vectorStatus: 'complete', queueErrors: 0, receivedAt: at, contentVerified: true, complete: true }, code: 'MEMORY_EVIDENCE_RETIRED_FIXTURE' },
    messageCount: 2, updatedAt: at, sessionId: `rna-${sessionId}-${index}`.slice(0, 40), pollFailures: 0, code: null, upstreamStatus: null, stage: null, message: 'Evidence archived in memory', nextPollAt: null, batchStart: 0, batchCount: 2,
    taskId: uuid(`task${index}`), archived: true, taskStatus: 'completed', memoriesExtracted: 1, extractionCounts: { memory_write: 1 },
    tokenUsage: { llm: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, cached_tokens: 0, reasoning_tokens: 0 }, embedding: { total_tokens: 400 }, total: { total_tokens: 1900, cached_tokens: 0, reasoning_tokens: 0 } },
  }));
}

/**
 * A live-shaped project: automatic rhythm with an assessment, 12 history rows and no initiative review yet (so its
 * status carries a review that is due now), a memory summary with its manifest, 30 schedule receipts. Mutates `row`.
 */
export function liveShapedProject(state, row, { rhythmHistory = 12, at = Date.parse('2026-09-20T00:00:00Z') } = {}) {
  row.rhythm = { ...(row.rhythm ?? {}), control: 'auto' };
  row.initiative.enabled = true;
  const assessment = { lifecycle: 'active', reason: prose(7, 199), evidenceIds: ['evidence:fixture:1', 'evidence:fixture:2', 'evidence:fixture:3'], scheduleIds: [], initiative: { mode: 'adaptive', reviewAfterMs: 3600000 }, evolution: { mode: 'evidence', maxPerDay: 2, maxPerWeek: 6, minIntervalMs: 3600000 } };
  row.rhythmRuntime = { assessment, assessmentSourceIds: ['source:fixture:assessment'], assessedAt: at, lastInitiativeAt: null, decisionIdentity: hex('decision'),
    history: Array.from({ length: rhythmHistory }, (_, index) => ({ at: at - index * 3600000, lifecycle: 'active', reason: prose(index, 294), initiativeMode: 'adaptive', evolutionMode: 'evidence', evidenceIds: [`evidence:${index}:a`, `evidence:${index}:b`, `evidence:${index}:c`], sourceIds: [`source:${index}`], source: 'model' })),
    learningAttempts: Array.from({ length: 7 }, (_, index) => ({ id: uuid(`attempt${index}`), at: at - index * 86400000, source: 'automatic', status: 'finished' })), lastLearningAt: at - 86400000 };
  row.rhythmRuntime.evidenceKey = projectRhythmEvidenceKey(state, row);
  row.memorySummary = { schemaVersion: 1, id: uuid('summary'), revision: 12, connectionFingerprint: hex('conn'), endpoint: 'http://127.0.0.1:1', userId: 'scenario', actorPeerId: `forge-${row.id}`, uri: `viking://resources/rna/${hex('ns', 48)}/summary`, createdAt: new Date(at).toISOString(),
    lastSourceTaskId: uuid('lasttask'), sourceFingerprint: hex('sf'), updatedAt: new Date(at).toISOString(), status: 'completed', code: null, message: 'Summary verified', nextPollAt: null, pollFailures: 0, operationId: uuid('op'), targetRevision: 12, targetFingerprint: hex('tf'),
    expectedFiles: Array.from({ length: 130 }, (_, index) => `viking://resources/rna/${hex('ns', 48)}/summary/${hex(`f${index}`, 40)}.md`), expectedDirectories: Array.from({ length: 14 }, (_, index) => `viking://resources/rna/${hex('ns', 48)}/summary/${hex(`d${index}`, 20)}`),
    manifestFingerprint: hex('mf'), submittedAt: new Date(at).toISOString(), taskId: uuid('stask'), taskStatus: 'completed', completedAt: new Date(at).toISOString(), verifiedRevision: 12, verifiedFingerprint: hex('vf'),
    verification: { directories: 14, files: 130, layers: 3, manifestFingerprint: hex('mf'), at: new Date(at).toISOString() }, result: { scannedRecords: 144, rebuiltRecords: 144, failedRecords: 0 }, lastFailure: { code: 'MEMORY_SUMMARY_TIMEOUT_FIXTURE', at: new Date(at).toISOString(), taskId: uuid('failtask') } };
  row.scheduleManagementReceipts = Array.from({ length: 30 }, (_, index) => ({ actionId: uuid(`sma${index}`), requestHash: hex(`rq${index}`), operation: 'create', scheduleId: `schedule-${hex(`sid${index}`, 32)}`, purposeKey: `purpose-${hex(`pk${index}`, 16)}`, revision: 1, committedAt: new Date(at).toISOString(), alreadyRegistered: false, summary: prose(index, 69), nextRunAt: new Date(at + 86400000).toISOString() }));
  return row;
}

/**
 * Fills the world's state with the live shape: the conversation's items and outbox, and the project's heavy fields.
 * Item size is a knob: on a slow disk every 16 KB of state is one more shard file to write. `lastText` replaces the
 * newest item's text (a marker a client can look for).
 */
export function fillLiveShaped(world, { items = 2000, outbox = 60, rhythmHistory = 12, sessionId = world.sessionId, itemBytes, memoryContextBytes, lastText } = {}) {
  const rows = conversationRows({ items, ...(itemBytes ? { itemBytes } : {}), ...(memoryContextBytes ? { memoryContextBytes } : {}) });
  if (lastText) rows.items.at(-1).text = lastText;
  world.store.mutate(state => {
    const session = state.sessions.find(row => row.id === sessionId), project = state.projects.find(row => row.id === session.projectId);
    session.items = rows.items; session.turns = rows.turns;
    session.memoryEvidenceOutbox = outboxRows({ count: outbox, projectId: project.id, sessionId });
    liveShapedProject(state, project, { rhythmHistory });
  });
  return rows;
}
