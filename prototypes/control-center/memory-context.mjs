import { prepareContext } from '../../packages/sdk/src/context.mjs';
import { packMemoryRecall, passageHash, memoryRecallContent } from './memory-service.mjs';

// One declaration for every purpose: foreground and background memory tools
// differ only in their handlers, so the provider-visible tools array matches.
export const MEMORY_TOOL_DECLARATIONS = Object.freeze({
  search: { name: 'openviking_search', permission: 'read', effect: 'read', idempotent: true, label: '搜索项目记忆', description: 'Find relevant candidate excerpts across all memory levels of the current project. Returns the actual source and the path that can be expanded; read a directory overview for navigation and the original for exact facts. level is only an optional index filter, not a level of content detail, and is usually omitted. Searches previously stored project memory only; it does not search or crawl the internet, fetch live news, or establish freshness of external information.', parameters: { type: 'object', properties: { query: { type: 'string' }, level: { type: 'string', enum: ['L0', 'L1', 'L2'] } }, required: ['query'], additionalProperties: false } },
  read: { name: 'openviking_read', permission: 'read', effect: 'read', idempotent: true, label: '读取项目记忆', description: 'Expand the current project memory using a viking:// URI (uri/expandUri) from an openviking_search result or from the memory candidates of this turn. Use project_read for file paths of workspace source, documents and the like. A directory L0 summary or L1 overview is for navigation; a memory file L2 original is for facts and details; the original supports offset/limit line paging and by default reads only a bounded fragment. There is no need to read every level of every candidate.', parameters: { type: 'object', properties: { uri: { type: 'string', description: 'A viking:// URI (uri/expandUri) from a current-project memory search result or from the candidates of this turn.' }, level: { type: 'string', enum: ['L0', 'L1', 'L2'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['uri'], additionalProperties: false } }
});

/**
 * MIND-13: the recalled passages this conversation's model can still see, as Map uri → Set of passageHash. A
 * project-memory attachment rides on its user message (`context`, never keyed or folded), so it is visible from the
 * newest compaction boundary on; what lies behind the boundary was summarized and is no longer there verbatim. The
 * boundary is the later of the committed compaction's and a prepared idle summary's (`preparedCompaction`, which the
 * turn's first cold request commits: SDK session economyPoint), so a passage that summary is about to take is not
 * counted. Only a passage attached whole counts: a clipped excerpt (`truncated`) is not the passage. OpenViking's own
 * clients get this from the server's ledger (recall-core sends session_id, dedup_turns and exclude_uris to /search),
 * but /find refuses those fields (search.py CONTEXT_ONLY_FIELDS), so the host reads its own transcript.
 */
export function attachedMemoryPassages(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const at = id => typeof id === 'string' && id ? messages.findIndex(message => message?.id === id) : -1;
  const boundary = Math.max(at(snapshot?.compaction?.throughMessageId), at(snapshot?.preparedCompaction?.throughMessageId));
  const attached = new Map();
  for (const message of messages.slice(boundary + 1)) {
    if (message?.role !== 'user' || !Array.isArray(message.context)) continue;
    for (const item of message.context) {
      if (item?.source !== 'project-memory' || typeof item.text !== 'string') continue;
      let value; try { value = JSON.parse(item.text); } catch { continue; }
      const rows = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
      for (const row of rows) if (typeof row?.uri === 'string' && typeof row.summary === 'string' && row.truncated !== true) {
        if (!attached.has(row.uri)) attached.set(row.uri, new Set());
        attached.get(row.uri).add(passageHash(row.summary));
      }
    }
  }
  return attached;
}

/** The JEV memory.filter hook for one recall (undefined when the point is off): the foreground's (runtime-controller
 * memoryFilter) and the background's (MEM-12) are this one. */
export function memoryFilterHook({ decisions, projectId, sessionId, turnId, prompt, signal }) {
  return decisions?.enabled?.('memory.filter') && typeof decisions.memoryFilter === 'function'
    ? entries => decisions.memoryFilter({ projectId, ...(sessionId ? { sessionId } : {}), turnId, prompt, entries, signal }) : undefined;
}

/** Starts the network part of a recall before the session is composed; the
 * result is fitted to the real context by recallProjectMemory({ prefetched }).
 * Settles to { result } or { error }; never rejects. */
export const FILTER_BUDGET_MS = 700;
export function prefetchProjectMemory({ service, projectId, prompt, policy = {}, signal }) {
  return Promise.resolve().then(() => { signal?.throwIfAborted(); return service.recall(projectId, { query: String(prompt ?? '').slice(0, 1000), budgetTokens: policy.contextBudget ?? 2048, limit: policy.limit, signal }); }).then(result => ({ result }), error => ({ error }));
}
/** One recall contract for foreground and background. Retrieved text is an
 * attachment to this request, never a new instruction or cached system text.
 * A passage the conversation still holds unchanged is not attached again (MIND-13, attachedMemoryPassages): its
 * budget goes to the next candidates, and a pointer names it. */
export async function recallProjectMemory({ service, projectId, prompt, snapshot, model, policy = {}, signal, onProgress = () => {}, prefetched, filter }) {
  signal?.throwIfAborted();
  const projection = { backend: service?.backend === 'embedded' ? 'embedded' : 'openviking', strategy: 'progressive', entries: [], injectedEntries: [] };
  const done = (patch, reference = null) => ({ reference, projection: { ...projection, ...patch } });
  if (policy.autoRecall === false) return done({ execution: 'on-demand', reason: 'auto-disabled' });
  if (!snapshot.tools?.includes('openviking_search')) return done({ execution: 'not-assigned', reason: 'memory-search-not-assigned' });
  const text = String(prompt ?? ''), promptEstimate = Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
  const existing = snapshot.cache?.estimatedInputTokens ?? snapshot.contextUsage?.estimatedInputTokens ?? 0;
  const pending = snapshot.pendingContextTokens ?? 0;
  const budgetTokens = Math.max(0, Math.min(policy.contextBudget ?? 2048, model.contextWindow - model.maxOutputTokens - existing - pending - promptEstimate - 768));
  if (!Number.isFinite(budgetTokens) || budgetTokens < 64) return done({ execution: 'budget', budgetTokens: Number.isFinite(budgetTokens) ? budgetTokens : 0 });
  onProgress({ ...projection, execution: 'retrieving', budgetTokens });
  const plainCost = prepareContext({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] }).estimatedInputTokens;
  // A turn whose input can carry the context past the SDK's blocking trigger (its own contextUsage.blockingTrigger) is
  // compacted before its first request, which may summarize the earlier attachments: then nothing is deduplicated.
  const blocking = snapshot.contextUsage?.automaticEnabled !== false ? snapshot.contextUsage?.blockingTrigger : undefined;
  const compactsFirst = Number.isFinite(blocking) && existing + pending + plainCost + budgetTokens > blocking;
  const exclude = compactsFirst ? new Map() : attachedMemoryPassages(snapshot);
  let result;
  try {
    if (prefetched) { const settled = await prefetched; if (settled.error) throw settled.error; result = settled.result; }
    else result = await service.recall(projectId, { query: text.slice(0, 1000), budgetTokens, limit: policy.limit, signal, ...(exclude.size ? { exclude } : {}) });
  } catch (error) {
    signal?.throwIfAborted();
    const timeout = error?.code === 'memory_timeout';
    return done({ execution: 'unavailable', budgetTokens, ...(timeout ? { reason: 'timeout' } : {}), error: timeout ? '项目记忆检索超时，本次未关联记忆；仍可按需读取。' : '项目记忆暂时无法检索，本次未关联记忆。' }, JSON.stringify({ status: 'unavailable', message: timeout ? 'Project memory lookup did not finish within the turn-start budget. No memory was retrieved; do not claim remembered facts; openviking_search remains available.' : 'Project memory lookup failed. No memory was retrieved; do not claim remembered facts.' }));
  }
  signal?.throwIfAborted();
  // A turn-start prefetch was packed before the transcript was known: when it holds a passage already attached, it is
  // packed again from its full candidate list (no second search), so the freed budget goes to fresh candidates.
  if (prefetched && exclude.size && Array.isArray(result.candidates) && result.candidates.some(entry => exclude.get(entry.uri)?.has(passageHash(entry.summary)))) {
    const repacked = packMemoryRecall(result.candidates, budgetTokens, { exclude });
    result = { ...result, entries: repacked.entries, content: repacked.content, truncated: repacked.truncated, alreadyAttached: repacked.alreadyAttached };
  }
  const alreadyAttached = Array.isArray(result.alreadyAttached) ? result.alreadyAttached : [];
  let entries = structuredClone(result.entries), filtered = 0;
  let content = result.content, clipped = result.truncated;
  // Optional JEV memory.filter (<=700 ms): drop passages confidently judged
  // irrelevant before budgeting. Any failure or timeout keeps every passage.
  if (typeof filter === 'function' && entries.length > 1) {
    let timer;
    const verdict = await Promise.race([Promise.resolve().then(() => filter(structuredClone(entries))).catch(() => null), new Promise(resolve => { timer = setTimeout(() => resolve(null), FILTER_BUDGET_MS); })]).finally(() => clearTimeout(timer));
    signal?.throwIfAborted();
    const keep = Array.isArray(verdict?.keep) ? new Set(verdict.keep) : null;
    if (keep && keep.size < entries.length) { entries = entries.filter((_, index) => keep.has(index)); filtered = result.entries.length - entries.length; content = memoryRecallContent(entries, alreadyAttached); }
  }
  const attachmentCost = () => prepareContext({ messages: [{ role: 'user', content: [{ type: 'text', text }], context: [{ source: 'project-memory', text: content }] }] }).estimatedInputTokens;
  const over = () => attachmentCost() - plainCost > budgetTokens || existing + pending + attachmentCost() + model.maxOutputTokens + 256 > model.contextWindow;
  // Over the real context's budget: the pointers go before any fresh passage does.
  let pointers = alreadyAttached;
  while (entries.length && over()) {
    if (pointers.length) pointers = []; else { entries.pop(); clipped = true; }
    content = memoryRecallContent(entries, pointers);
  }
  // Only pointers left: attached when they fit, as the line saying the relevant passages are already in context.
  if (!entries.length && alreadyAttached.length) { pointers = alreadyAttached; content = memoryRecallContent(entries, pointers); }
  const pointersOnly = !entries.length && pointers.length > 0 && !over();
  const recorded = entries.map(entry => ({ ...entry, id: entry.uri, title: (entry.expandUri ?? entry.uri).split('/').at(-1), content: entry.summary }));
  const execution = entries.length ? 'retrieved' : pointersOnly ? 'already_attached' : result.entries.length || alreadyAttached.length ? 'budget' : 'empty';
  return done({ execution, budgetTokens, entries: recorded, injectedEntries: recorded, estimatedTokens: entries.length || pointersOnly ? attachmentCost() - plainCost : 0, truncated: clipped, ...(filtered ? { filtered } : {}), ...(alreadyAttached.length ? { deduplicated: alreadyAttached.length, alreadyAttached: alreadyAttached.slice(0, 20) } : {}), candidateCount: result.candidateCount, retrievedAt: new Date().toISOString(), stage: result.stage }, entries.length || pointersOnly ? content : null);
}
