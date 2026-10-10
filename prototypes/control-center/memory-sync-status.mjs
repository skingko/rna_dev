import { memorySyncHealth } from './memory-sync.mjs';
import { memorySummaryResolution } from './memory-summary-sync.mjs';
import { memoryWriteRecords } from './memory-checkpoints.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';

// Per-project memory synchronization status for the memory browser (contract
// v2 §1). Counts only recorded outcomes (turn checkpoints / legacy memoryWrite
// and the evidence outbox); never probes the memory service, never returns
// conversation text or remote URIs.
export const PENDING = new Set(['pending', 'ready', 'creating', 'uploading', 'committing', 'polling']);
// What a recorded issue means for the user, in the interface language; the
// code stays in the row for diagnostics. Unknown codes get the plain line.
const ISSUE_FALLBACK = { zh: '这一段没有同步成功。', en: 'This part did not sync.' };
const ISSUE_TEXT = {
  // The code memory-sync records when a failure carried none of its own: the plain line is all that is known.
  MEMORY_SYNC_FAILED: ISSUE_FALLBACK,
  MEMORY_EXTRACTION_FAILED: { zh: '这一轮对话已归档，但记忆提炼没有成功；归档的原文不受影响，提炼要付费，不会自动重做。', en: 'This turn was archived, but extracting memories from it failed. The archived conversation is unaffected; extraction is paid, so it is not redone automatically.' },
  MEMORY_SOURCE_CHANGED: { zh: '这段对话在同步前被修改或撤回，没有再上传；之前归档的部分不受影响。', en: 'This part of the conversation was edited or withdrawn before it synced, so it was not uploaded; what was archived earlier is unaffected.' },
  MEMORY_WRITE_OUTCOME_UNKNOWN: { zh: '上次同步没有收到确认，无法确定是否已保存；不会重复上传。', en: 'The last sync was not confirmed, so it is unknown whether it was saved; it is not uploaded again.' },
  MEMORY_COMMIT_RECEIPT_INCOMPLETE: { zh: '记忆服务的回执不完整，无法确认是否提炼出记忆。', en: 'The memory service returned an incomplete receipt, so it is unknown whether memories were extracted.' },
  MEMORY_CONNECTION_CHANGED: { zh: '记忆服务的连接或项目范围已更改，旧的同步记录没有发往新服务。', en: 'The memory service connection or project scope changed; older sync records were not sent to the new service.' },
  MEMORY_CONNECTION_UNAVAILABLE: { zh: '记忆服务暂时连不上，稍后会自动重试。', en: 'The memory service is unreachable for now; it will be retried automatically.' },
  MEMORY_TASK_LOOKUP_FAILED: { zh: '暂时查不到记忆提炼的进度，稍后会再查。', en: 'The extraction progress cannot be checked right now; it will be checked again later.' },
  MEMORY_SYNC_PAUSED: { zh: '记忆同步已暂停。', en: 'Memory sync is paused.' },
  MEMORY_EVIDENCE_INDEX_FAILED: { zh: '这份交付资料没有编入项目资料索引。', en: 'This delivery was not added to the project resource index.' },
  MEMORY_EVIDENCE_WRITE_UNCONFIRMED: { zh: '这份交付资料的索引请求没有收到确认。', en: 'The index request for this delivery was not confirmed.' },
  MEMORY_EVIDENCE_SCOPE_CHANGED: { zh: '项目范围已更改，这份交付资料没有编入索引。', en: 'The project scope changed, so this delivery was not indexed.' },
  MEMORY_WRITE_REJECTED: { zh: '记忆服务拒绝了同步请求；对话仍保留，未重复发送。', en: 'The memory service refused the sync request; the conversation is kept and it was not sent again.' },
  MEMORY_EVIDENCE_INDEX_INCOMPLETE: { zh: '这份交付资料已存入项目资料，但语义索引没有完成，搜索可能找不到它。', en: 'This delivery is stored in the project resources, but its semantic index did not complete, so search may not find it.' },
  MEMORY_EVIDENCE_DELETE_UNCONFIRMED: { zh: '这份交付已撤回，但从项目资料索引中移除还没有得到确认，稍后会再核对。', en: 'This delivery was withdrawn, but its removal from the project resource index is not confirmed yet; it will be checked again later.' },
  MEMORY_EVIDENCE_CLEANUP_PAUSED: { zh: '这份交付已恢复，正在核对项目资料索引里的条目，不再移除它。', en: 'This delivery was restored, so its entry in the project resource index is being checked instead of removed.' },
  MEMORY_EVIDENCE_CONTENT_DIFFERS: { zh: '项目资料索引里这份交付的位置存着别的内容，所以没有编入，也不会删除那份内容。', en: 'The project resource index holds other content where this delivery belongs, so it was not indexed and that content is not removed.' },
  MEMORY_COMMIT_NOT_FOUND: { zh: '这一段已上传，但核对确认没有完成归档，也没有提炼记忆。', en: 'This part was uploaded, but a check confirmed it was never archived, so no memories were extracted from it.' },
  MEMORY_UPLOAD_UNCONFIRMED: { zh: '上传这一段时没有收到确认；已上传的部分不会提交，也不会从中提炼记忆。', en: 'Uploading this part was not confirmed; what was uploaded is not committed and no memories are extracted from it.' },
  MEMORY_EVIDENCE_IDENTITY_UNVERIFIED: { zh: '这份交付已撤回，但无法确认索引里的条目就是它，所以没有移除。', en: 'This delivery was withdrawn, but the index entry could not be confirmed as this delivery, so it was not removed.' },
  MEMORY_EVIDENCE_SUPERSEDED: { zh: '这份交付之后被宿主更新过，新的版本取代了它。', en: 'The host updated this delivery afterwards; the newer version replaced it.' },
  MEMORY_TASK_EXPIRED: { zh: '这一轮对话已归档，但记忆服务在读到提炼结果之前清除了任务记录，无法确认是否提炼出记忆；不会自动重做。', en: 'This turn was archived, but the memory service cleared the extraction task before its result was read, so it is unknown whether memories were extracted; it is not redone automatically.' },
  MEMORY_SOURCE_WITHDRAWN: { zh: '这段内容在同步前已被撤回，没有上传。', en: 'This part was withdrawn before it synced, so it was not uploaded.' },
};
// Autonomous deliveries and answers (evidence records) are not conversation turns.
const EVIDENCE_TEXT = {
  MEMORY_EXTRACTION_FAILED: { zh: '这份交付已归档，但记忆提炼没有成功；归档的内容不受影响，提炼要付费，不会自动重做。', en: 'This delivery was archived, but extracting memories from it failed. The archived content is unaffected; extraction is paid, so it is not redone automatically.' },
  MEMORY_SOURCE_CHANGED: { zh: '这份交付在同步前已变化或被撤回，没有上传。', en: 'This delivery changed or was withdrawn before it synced, so it was not uploaded.' },
  MEMORY_WRITE_REJECTED: { zh: '记忆服务拒绝了这份交付的同步请求；交付仍保留，未重复发送。', en: 'The memory service refused to sync this delivery; the delivery is kept and it was not sent again.' },
  MEMORY_TASK_EXPIRED: { zh: '这份交付已归档，但记忆服务在读到提炼结果之前清除了任务记录，无法确认是否提炼出记忆；不会自动重做。', en: 'This delivery was archived, but the memory service cleared the extraction task before its result was read, so it is unknown whether memories were extracted; it is not redone automatically.' },
};
// A delivery's project-resource index runs after its archive completed: "not uploaded" would be wrong there.
const INDEX_TEXT = {
  MEMORY_SOURCE_CHANGED: { zh: '这份交付已归档，但在编入项目资料索引之前发生了变化，没有编入索引。', en: 'This delivery was archived, but it changed before it was added to the project resource index, so it was not indexed.' },
};
const ABANDONED_TEXT = { zh: '这段对话在上传途中被修改或撤回；已上传的部分不会提交，也不会从中提炼记忆。', en: 'This part of the conversation was edited or withdrawn while it was uploading; what was uploaded is not committed and no memories are extracted from it.' };
const BLOCKED_TEXT = { zh: '同一轮较早的一段没有同步成功，这一段因此没有发送。', en: 'An earlier part of this turn did not sync, so this part was not sent.' };
// An abandoned upload whose receipt was lost (B3) has its own line; every other abandoned record was edited or withdrawn mid-upload.
const issueMessage = (issue, language) => inLanguage(language, issue.blockedBy ? BLOCKED_TEXT : issue.status === 'abandoned' && issue.code !== 'MEMORY_UPLOAD_UNCONFIRMED' ? ABANDONED_TEXT
  : (issue.stage && INDEX_TEXT[issue.code]) || (issue.evidenceId && !issue.stage && EVIDENCE_TEXT[issue.code]) || ISSUE_TEXT[issue.code] || ISSUE_FALLBACK);
/** What the user can do about one recorded outcome. A settled loss is history at once and needs nothing (A2, the pi
 * client's captureGap); one nothing was extracted from can optionally be extracted again, paid, after confirmation —
 * offered only when that would upload something (`reextractable`, B2). Unresolved issues are the host's to resolve. */
const actionsOf = issue => issue.resolution === 'settled' && issue.reextractable && !issue.stage && !issue.blockedBy ? ['reextract'] : [];
const present = (language, resolution) => ({ projectId: _project, sessionId: _session, ...issue }) => {
  const { reextractable: _reextractable, ...row } = { ...issue, resolution };
  return { ...row, message: issueMessage(row, language), actions: actionsOf({ ...row, reextractable: _reextractable }) };
};

// The one-time restore of delivery documents deleted by initiative scope drift (MEM-1): what it re-indexed and what stayed withdrawn.
const restoreOf = session => { const marker = session.memoryEvidenceState?.scopeRestore; return marker ? { at: marker.at ?? null, restored: marker.restored ?? 0, stillWithdrawn: marker.stillWithdrawn ?? 0 } : null; };

function sessionRow(session, language = 'zh', project = { id: session.projectId }) {
  // The real project: whether a delivery can be extracted again depends on its actions and jobs.
  const health = memorySyncHealth({ projects: [project], sessions: [session] });
  const writes = (session.turns ?? []).flatMap(turn => memoryWriteRecords(turn).map(row => row.write)).filter(write => write && typeof write === 'object');
  const evidence = (session.memoryEvidenceOutbox ?? []).filter(write => write && typeof write === 'object');
  const pending = writes.filter(write => PENDING.has(write.status)).length + evidence.filter(write => PENDING.has(write.status)).length;
  // Needs a look: only an unknown remote state or a record still retrying. Settled losses are history (A2).
  const attention = health.unresolved;
  return {
    sessionId: session.id, title: typeof session.title === 'string' ? session.title.slice(0, 120) : '', archivedAt: session.archivedAt ?? null,
    status: attention ? 'attention' : pending || health.evidenceIndexPending ? 'syncing' : writes.length + evidence.length ? 'synced' : 'none',
    turns: (session.turns ?? []).length, completedTurns: health.completedTurns,
    writes: writes.length, incremental: writes.filter(write => write.kind === 'incremental' && write.status === 'completed').length,
    pending, attention, unresolved: health.unresolved, settledLoss: health.settledLoss, acknowledged: health.acknowledged, retained: health.retainedPending,
    evidence: { records: health.evidenceRecords, completed: health.evidenceCompleted, extracted: health.evidenceExtracted, indexOnly: health.evidenceIndexOnly, indexed: health.evidenceIndexed, indexPending: health.evidenceIndexPending, indexIssues: health.evidenceIndexIssues, withdrawn: health.evidenceWithdrawn, restore: restoreOf(session), initializedAt: session.memoryEvidenceState?.initializedAt ?? null },
    lastSuccessAt: health.lastSuccessAt,
    issues: health.issues.slice(0, 5).map(present(language, 'unresolved')),
    history: health.settledLosses.slice(0, 5).map(present(language, 'settled')),
  };
}

/** The project's directory-summary maintenance in the same split (A2): `unresolved` (its outcome is still being
 * checked) is what gates health; a `failed` row is a settled gap. A retired row ('skipped', MEM-8: the whole tree is no
 * longer rebuilt) has nothing to report. */
function summaryOf(project) {
  const row = project.memorySummary;
  return row && row.status !== 'skipped' ? { status: row.status ?? null, resolution: memorySummaryResolution(row), updatedAt: row.updatedAt ?? null, completedAt: row.completedAt ?? null, code: row.code ?? null } : null;
}

export function projectMemorySyncStatus(state, project) {
  const sessions = (state.sessions ?? []).filter(session => session.projectId === project.id);
  const health = memorySyncHealth({ projects: [project], sessions });
  const language = interfaceLanguageOf(state), rows = sessions.map(session => sessionRow(session, language, project)).filter(row => row.status !== 'none');
  const totals = rows.reduce((sum, row) => ({ pending: sum.pending + row.pending, attention: sum.attention + row.attention, incremental: sum.incremental + row.incremental }), { pending: 0, attention: 0, incremental: 0 });
  const summary = summaryOf(project);
  return {
    projectId: project.id,
    status: totals.attention ? 'attention' : totals.pending || health.evidenceIndexPending ? 'syncing' : health.total ? 'synced' : 'none',
    health: health.status, completedTurns: health.completedTurns, incremental: totals.incremental, pending: totals.pending, attention: totals.attention,
    unresolved: health.unresolved, settledLoss: health.settledLoss, acknowledged: health.acknowledged, retained: health.retainedPending,
    evidence: { records: health.evidenceRecords, completed: health.evidenceCompleted, extracted: health.evidenceExtracted, indexOnly: health.evidenceIndexOnly, indexed: health.evidenceIndexed, indexPending: health.evidenceIndexPending, indexIssues: health.evidenceIndexIssues, withdrawn: health.evidenceWithdrawn,
      restore: sessions.map(restoreOf).filter(Boolean).reduce((sum, row) => sum ? { at: row.at > sum.at ? row.at : sum.at, restored: sum.restored + row.restored, stillWithdrawn: sum.stillWithdrawn + row.stillWithdrawn } : row, null) },
    counts: health.counts, lastSuccessAt: health.lastSuccessAt, summary,
    sessions: rows.sort((a, b) => (b.attention - a.attention) || (b.pending - a.pending) || String(b.lastSuccessAt ?? '').localeCompare(String(a.lastSuccessAt ?? ''))),
  };
}
