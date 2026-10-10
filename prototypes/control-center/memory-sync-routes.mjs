import { createHash } from 'node:crypto';
import { memoryIndexResolution, memoryWriteResolution, reextractCandidate } from './memory-sync.mjs';
import { projectMemorySyncStatus } from './memory-sync-status.mjs';
import { coveredCheckpoints, reextractMessagesOf } from './memory-checkpoints.mjs';
import { memoryEvidenceMessages } from './memory-evidence-outbox.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';

// What the user can do about recorded memory-sync outcomes (MEM-4; contract v2 §1, next to
// GET /api/v2/projects/:id/memory-sync). Both are user actions on the memory page; no agent tool reaches them.
// POST …/memory-sync/acknowledge { records: [ref] } — kept for compatibility only (A2): a settled loss is history as
//   soon as it settles and nothing asks for it any more; this only stamps acknowledgedAt, which changes no count but
//   `acknowledged`. Unresolved outcomes are the host's to resolve and are refused, as before.
// POST …/memory-sync/reextract { ...ref, confirm? } — an optional paid action on a history row. Two steps: without confirm it changes nothing and returns
//   what would be uploaded with a one-time `confirm`; with it, a record nothing was extracted from (a failed
//   extraction of a committed archive, or an archive proven never committed) is queued again as a full archive in a
//   fresh remote session (paid), together with the retained segments its commit archived (B2). The confirm names the
//   record's current attempt and those segments, so a repeated or stale confirmation never pays twice.
// ref = { sessionId, turnId, checkpointId? } | { sessionId, evidenceId, stage? } (stage: the resource index).
const ROUTE = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/memory-sync\/(acknowledge|reextract)$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STAGES = new Set(['project_resource_index', 'project_resource_cleanup']);
const refusal = (status, code, text) => Object.assign(new Error(text), { status, code });

function refOf(input, say) {
  const invalid = () => { throw refusal(400, 'memory_record_invalid', say({ zh: '记录需要 sessionId，以及 turnId（可带 checkpointId）或 evidenceId（可带 stage）。', en: 'A record needs sessionId and either turnId (optionally checkpointId) or evidenceId (optionally stage).' })); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const { sessionId, turnId, checkpointId, evidenceId, stage } = input;
  if (!ID.test(sessionId ?? '') || Boolean(turnId) === Boolean(evidenceId)) invalid();
  if (turnId !== undefined && !ID.test(turnId) || evidenceId !== undefined && !ID.test(evidenceId)) invalid();
  if (checkpointId !== undefined && (!turnId || !ID.test(checkpointId)) || stage !== undefined && (!evidenceId || !STAGES.has(stage))) invalid();
  return { sessionId, ...(turnId ? { turnId, ...(checkpointId ? { checkpointId } : {}) } : { evidenceId, ...(stage ? { stage } : {}) }) };
}

/** The recorded outcome a ref names inside `state` (a draft during a mutation), or a 404 refusal. */
export function memoryRecordOf(state, projectId, ref, say = text => text.zh) {
  const missing = () => { throw refusal(404, 'memory_record_not_found', say({ zh: '没有找到这条同步记录。', en: 'This sync record was not found.' })); };
  const session = state.sessions.find(row => row.id === ref.sessionId && row.projectId === projectId) ?? missing();
  if (ref.evidenceId) {
    const write = (session.memoryEvidenceOutbox ?? []).find(row => row.id === ref.evidenceId) ?? missing();
    const target = ref.stage ? write.resourceIndex ?? missing() : write;
    return { session, turn: null, write, target, resolution: ref.stage ? memoryIndexResolution(target) : memoryWriteResolution(target) };
  }
  const turn = session.turns.find(row => row.id === ref.turnId) ?? missing();
  const write = (ref.checkpointId ? turn.memoryCheckpoints?.find(row => row.id === ref.checkpointId) : turn.memoryWrite) ?? missing();
  return { session, turn, write, target: write, resolution: memoryWriteResolution(write) };
}

export function acknowledgeMemoryIssues(state, projectId, refs, { now = new Date().toISOString(), say } = {}) {
  // All or nothing: every record is checked before any is marked.
  const found = refs.map(ref => memoryRecordOf(state, projectId, ref, say));
  // Every unresolved outcome has a resolver (retries, the read-only reconciliation of uncertain writes, the index
  // checks); one that no check can ever determine is settled instead, so it can be acknowledged (B3).
  for (const { resolution } of found) if (resolution !== 'settled') throw refusal(409, resolution === 'unresolved' ? 'memory_issue_unresolved' : 'memory_issue_not_found', say(resolution === 'unresolved'
    ? { zh: '这条记录还没有落定：系统会自动重试或核对它，落定后会自动记入历史。', en: 'This record has not settled yet: it is retried or checked automatically and goes to history by itself once it settles.' }
    : { zh: '这条记录没有需要处理的问题。', en: 'This record has no issue to acknowledge.' }));
  let acknowledged = 0;
  for (const { target } of found) if (!target.acknowledgedAt) { target.acknowledgedAt = now; acknowledged++; }
  return acknowledged;
}

/** What a re-extraction would upload, checked against the frozen source (a changed or withdrawn source is refused). */
export function reextractPlan(state, projectId, ref, { say = text => text.zh } = {}) {
  if (ref.stage) throw refusal(409, 'memory_reextract_unavailable', say({ zh: '只能重新提炼对话或交付本身。', en: 'Only a conversation or delivery itself can be extracted again.' }));
  const record = memoryRecordOf(state, projectId, ref, say), { session, turn, write } = record;
  if (write.sourceKind === 'autonomous_delivery') throw refusal(409, 'memory_reextract_unavailable', say({ zh: '主动交付只写入项目资料索引，没有可提炼的记忆，不能重新提炼。', en: 'An autonomous delivery is only indexed as a project resource and has no memories to extract, so it cannot be extracted again.' }));
  if (!reextractCandidate(write)) throw refusal(409, 'memory_reextract_unavailable', say({ zh: '只有记忆提炼失败、或确认没有归档的记录可以重新提炼。', en: 'Only a record whose memory extraction failed, or whose archive was confirmed never committed, can be extracted again.' }));
  // A checkpoint's commit also archived the retained segments right before it (B2): they are uploaded first, so the
  // retained messages and the turn's user anchor are extracted too.
  const covers = ref.evidenceId ? [] : coveredCheckpoints(turn, write);
  let messages;
  try { messages = ref.evidenceId ? memoryEvidenceMessages(state, session.id, write) : reextractMessagesOf(session, turn, write); }
  catch (error) { if (error.code !== 'MEMORY_SOURCE_CHANGED') throw error; throw refusal(409, 'memory_source_changed', say({ zh: '这段内容在归档后已被修改或撤回，不能按原样重新提炼。', en: 'This content was edited or withdrawn after it was archived, so it cannot be extracted again as it was.' })); }
  if (!messages.length) throw refusal(409, 'memory_source_changed', say({ zh: '这段内容已没有可上传的消息。', en: 'This content has no messages left to upload.' }));
  const confirm = createHash('sha256').update(JSON.stringify(['memory-reextract', projectId, ref, write.taskId ?? null, write.sourceHash ?? null, write.reextract?.attempts ?? 0, covers.map(row => row.id)])).digest('hex').slice(0, 32);
  return { ...record, messages, covers, confirm };
}

/** Queue the record again from a clean state (a fresh remote session, full archive); prior attempts are kept, with
 * the archive they left (it stays until its remote session is deleted). The retained segments it covers are marked
 * `coveredBy`, so health counts them as extracted only once it completes. */
export function applyReextract(write, { connectionFingerprint, covers = [], now = new Date().toISOString() }) {
  const previous = { at: write.updatedAt ?? null, sessionId: write.sessionId ?? null, taskId: write.taskId ?? null, code: write.code ?? null, taskStatus: write.taskStatus ?? null, tokenUsage: write.tokenUsage ?? null, acknowledgedAt: write.acknowledgedAt ?? null,
    ...(write.archiveUri ? { archiveUri: write.archiveUri } : {}), ...(write.memoryDiffUri ? { memoryDiffUri: write.memoryDiffUri } : {}) };
  for (const key of ['sessionId', 'taskId', 'taskStatus', 'archived', 'archiveUri', 'memoryDiffUri', 'batchStart', 'batchCount', 'memoriesExtracted', 'extractionCounts', 'tokenUsage', 'code', 'message', 'stage', 'stageAt', 'upstreamStatus', 'nextPollAt', 'pollFailures', 'acknowledgedAt', 'retainedEstimatedTokens', 'retentionBudgetExceeded', 'reconcile']) delete write[key];
  Object.assign(write, { status: 'pending', nextMessage: 0, connectionFingerprint, updatedAt: now,
    reextract: { requestedAt: now, attempts: (write.reextract?.attempts ?? 0) + 1, previous: [...(write.reextract?.previous ?? []), previous].slice(-5), ...(covers.length ? { covers: covers.map(row => row.id) } : {}) } });
  for (const row of covers) row.coveredBy = write.id;
}

export function createMemorySyncRoutes({ store, body, pump = () => {} }) {
  return async function handle(req, { pathname, send }) {
    if (req.method !== 'POST' || !pathname.startsWith('/api/v2/projects/') || !pathname.includes('/memory-sync/')) return false;
    const match = pathname.match(ROUTE);
    if (!match) return false;
    const [, projectId, action] = match, language = interfaceLanguageOf(store.state), say = text => inLanguage(language, text);
    try {
      const project = store.state.projects.find(row => row.id === projectId);
      if (!project) throw refusal(404, 'project_not_found', say({ zh: '项目不存在', en: 'Project not found' }));
      const input = await body(req);
      if (action === 'acknowledge') {
        if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'records') || !Array.isArray(input.records) || !input.records.length || input.records.length > 50) throw refusal(400, 'memory_record_invalid', say({ zh: '请求只能包含 records（1–50 条记录）。', en: 'The request may only contain records (1–50 records).' }));
        const refs = input.records.map(row => refOf(row, say));
        let acknowledged = 0;
        store.mutate(state => { acknowledged = acknowledgeMemoryIssues(state, projectId, refs, { say }); });
        send(200, { acknowledged, sync: projectMemorySyncStatus(store.state, store.state.projects.find(row => row.id === projectId)), revision: store.state.revision }); return true;
      }
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['sessionId', 'turnId', 'checkpointId', 'evidenceId', 'stage', 'confirm'].includes(key)) || input.confirm !== undefined && typeof input.confirm !== 'string') throw refusal(400, 'memory_record_invalid', say({ zh: '请求只能包含一条记录和 confirm。', en: 'The request may only contain one record and confirm.' }));
      const { confirm, ...rest } = input, ref = refOf(rest, say), plan = reextractPlan(store.state, projectId, ref, { say });
      const memory = store.state.configuration.memory;
      if (memory.autoStore === false || store.state.emergency || plan.session.archivedAt || project.archivedAt || plan.session.appRecovery?.required) throw refusal(409, 'memory_reextract_paused', say({ zh: '记忆写入当前已暂停（自动保存关闭、急停、会话或项目已归档），现在不能重新提炼。', en: 'Memory writes are paused right now (automatic saving is off, the emergency stop is on, or the conversation or project is archived), so it cannot be extracted again now.' }));
      const characters = plan.messages.reduce((sum, row) => sum + row.content.length, 0);
      if (confirm === undefined) { send(200, { status: 'confirm_required', paid: true, confirm: plan.confirm, messages: plan.messages.length, characters }); return true; }
      if (confirm !== plan.confirm) throw refusal(409, 'memory_reextract_unconfirmed', say({ zh: '确认已过期或已用过，请重新确认。', en: 'The confirmation expired or was already used; confirm again.' }));
      const connectionFingerprint = store.memoryService.connectionFingerprint(projectId);
      store.mutate(state => {
        const current = reextractPlan(state, projectId, ref, { say });
        if (current.confirm !== confirm) throw refusal(409, 'memory_reextract_unconfirmed', say({ zh: '确认已过期或已用过，请重新确认。', en: 'The confirmation expired or was already used; confirm again.' }));
        applyReextract(current.write, { connectionFingerprint, covers: current.covers });
      });
      pump();
      send(200, { status: 'queued', paid: true, messages: plan.messages.length, characters, sync: projectMemorySyncStatus(store.state, store.state.projects.find(row => row.id === projectId)), revision: store.state.revision }); return true;
    } catch (error) {
      if (!error.status) throw error;
      send(error.status, { error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}) }); return true;
    }
  };
}
