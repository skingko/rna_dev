#!/usr/bin/env node
// Read-only replay of one conversation journal for the cold-break context economy (spec p1 compaction §11): what is
// superseded, what a fold or an idle compaction would free, how big the mind and collaboration blocks are per turn,
// and the cache survival its served requests show. The journal is COPIED to a temporary directory first; nothing is
// written next to the original, no provider is called (a provider call fails the run).
//
//   node benchmark/context-economy-replay.mjs <journal.rna.jsonl> [--window 1000000] [--max-output 32000] [--keep 2]
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { readJournalRecords } from '../../../packages/sdk/src/journal.mjs';
import { foldTargets, foldSavingTokens } from '../../../packages/sdk/src/context.mjs';
import { requestContinuity, survivalSample, survivalFromSamples } from '../../../packages/sdk/src/cache-survival.mjs';

const MIND_KEYS = /^project-mind(?:-rules|-notes|-turn)?$/, COLLABORATION_KEYS = /^project-collaboration(?::.*|-pending|-guide)?$/;
const isTurnStart = message => message?.role === 'user' && ['user', 'followUp'].includes(message.source);
const bytes = value => Buffer.byteLength(JSON.stringify(value ?? ''), 'utf8');

/** One streaming pass over the journal: record counts, keyed context bytes per turn, survival samples. */
export function journalStats(file) {
  const counts = {}, rejected = {}, perTurn = { mind: [], collaboration: [] }, samples = [];
  const messages = [], ids = new Set(); let turn = { mind: 0, collaboration: 0 }, turns = 0;
  const note = message => { if (!message?.id || ids.has(message.id)) return; ids.add(message.id); messages.push(message);
    if (isTurnStart(message)) { if (turns++) { perTurn.mind.push(turn.mind); perTurn.collaboration.push(turn.collaboration); } turn = { mind: 0, collaboration: 0 }; }
    if (message.contextKey && MIND_KEYS.test(message.contextKey)) turn.mind += bytes(message.context);
    if (message.contextKey && COLLABORATION_KEYS.test(message.contextKey)) turn.collaboration += bytes(message.context); };
  for (const { type, data } of readJournalRecords(file, { verify: false, wantEvent: () => true })) {
    const kind = type === 'event' ? `event:${data?.type}` : type;
    if (['context_fold', 'context_settle', 'context_forget', 'context_compaction', 'compaction_prepared', 'compaction_prepared_discarded', 'compaction_fork_rejected', 'event:context_economy', 'tool_calls_rejected'].includes(kind)) counts[kind] = (counts[kind] ?? 0) + 1;
    if (type === 'tool_calls_rejected') rejected[`${data?.reason}${data?.retry ? ':retry' : ''}`] = (rejected[`${data?.reason}${data?.retry ? ':retry' : ''}`] ?? 0) + 1;
    if (type === 'message' || type === 'inbox_claimed' || type === 'tool_completed' || type === 'finish_review') { note(data?.message); continue; }
    if (type === 'context_rewind') { const cut = messages.findIndex(row => row.id === data?.beforeMessageId); if (cut >= 0) for (const row of messages.splice(cut)) ids.delete(row.id); continue; }
    if (type !== 'request_completed' || data?.discarded === true || !data?.message) continue;
    const message = data.message, previous = messages.findLast(row => row.role === 'assistant' && row.usageReported === true && row.contextPrefixHash);
    if (message.usageReported === true && message.contextPrefixHash) { const sample = survivalSample({ continuity: requestContinuity(previous, message), cacheReported: message.usage?.cacheUsageReported === true, cacheRead: message.usage?.cacheRead, at: message.timestamp }); if (sample) samples.push({ ...sample, model: `${message.provider}|${message.model}` }); }
    note(message);
  }
  if (turns) { perTurn.mind.push(turn.mind); perTurn.collaboration.push(turn.collaboration); }
  const models = [...new Set(samples.map(row => row.model))];
  const sum = rows => rows.reduce((total, value) => total + value, 0);
  return { counts, rejected, turns, perTurn: { mindBytes: sum(perTurn.mind), collaborationBytes: sum(perTurn.collaboration), mindPerTurn: turns ? Math.round(sum(perTurn.mind) / turns) : 0, collaborationPerTurn: turns ? Math.round(sum(perTurn.collaboration) / turns) : 0 },
    survival: Object.fromEntries(models.map(model => [model, survivalFromSamples(samples.filter(row => row.model === model), { now: Math.max(...samples.map(row => row.at)) + 1, maxAgeMs: Infinity })])) };
}

/** Open a COPY with the SDK (no provider): projection now, what a fold frees, and an idle compaction plan. */
export async function projectionReport(file, { window = 1000000, maxOutput = 32000, keep = 2 } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-economy-replay-'))), copy = join(directory, basename(file));
  try {
    copyFileSync(file, copy);
    let header = null, last = null;
    for (const { type, data } of readJournalRecords(copy, { verify: false, wantEvent: () => false })) { if (type === 'session_header') header = data; if (type === 'request_started' && data?.model?.modelId) last = data.model; }
    if (!header || !last) throw new Error('Not a served session journal.');
    const model = { providerId: last.providerId, modelId: last.modelId, protocol: last.protocol ?? 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: window, maxOutputTokens: maxOutput };
    const session = await createSession({ sessionId: header.sessionId, projectId: header.projectId ?? undefined, cwd: directory, stateDir: directory, sessionFile: copy, model, autoCompaction: false, preparedCompactionFile: join(directory, 'none.json'), provider: async function* () { throw new Error('The replay never calls a provider.'); } });
    try {
      const snapshot = session.snapshot(), messages = snapshot.messages, byId = new Map(messages.map(message => [message.id, message]));
      const folds = foldTargets(messages, { compaction: snapshot.compaction, folded: new Map() });
      const superseded = folds.reduce((total, row) => total + foldSavingTokens(byId.get(row.messageId), row.kind), 0);
      const byKey = {}; for (const row of folds) byKey[row.contextKey.replace(/:.*/, ':*')] = (byKey[row.contextKey.replace(/:.*/, ':*')] ?? 0) + 1;
      const plan = session.prepareCompaction({ keepUserTurns: keep });
      return { model: { providerId: model.providerId, modelId: model.modelId, window }, estimatedInputTokens: snapshot.contextUsage.estimatedInputTokens, heuristic: snapshot.cache.estimatedInputTokens,
        fold: { copies: folds.length, byKey, freedTokens: superseded, afterFoldTokens: snapshot.contextUsage.estimatedInputTokens - superseded },
        idleCompaction: plan ? { keepUserTurns: keep, beforeTokens: plan.beforeTokens, afterWithoutSummaryTokens: plan.floorTokens, summarySourceTokens: plan.request.estimatedInputTokens, archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, partial: plan.partial } : null };
    } finally { await session.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('context-economy-replay.mjs')) {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) { console.error('usage: context-economy-replay.mjs <journal.rna.jsonl> [--window N] [--max-output N] [--keep N]'); process.exit(2); }
  const option = (name, fallback) => { const index = flags.indexOf(name); return index >= 0 ? Number(flags[index + 1]) : fallback; };
  const stats = journalStats(file), projection = await projectionReport(file, { window: option('--window', 1000000), maxOutput: option('--max-output', 32000), keep: option('--keep', 2) });
  console.log(JSON.stringify({ journal: basename(file), ...stats, projection }, null, 2));
}
