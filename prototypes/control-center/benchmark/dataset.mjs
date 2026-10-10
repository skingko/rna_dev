import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsageLedger } from '../usage-cache-service.mjs';
import { heuristicLabels, applyManualLabels, fileMentions, hashMentions, hasDeliverableManifest, addendumOpener } from './labels.mjs';

// K4 benchmark: one normalized, read-only view of a project ("dataset") built
// from live host state (plus the optional immutable archive and usage ledger).
// Fixtures are sanitized datasets; metrics consume datasets only, so the same
// code scores live state, production fixtures and synthetic examples.
export const DATASET_SCHEMA = 'rna-bench-dataset/1';
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const AWAY_MS = 30 * 60000, OVERDUE_MS = 4 * 3600000;
const time = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : null; };
const iso = value => time(value) === null ? null : new Date(time(value)).toISOString();
const retained = row => row && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
const EVOLUTION_SOURCES = new Set(['autonomous-project-evolution', 'explicit-authoring-retry', 'retry-project-genome', 'reviewed-evaluation-revision', 'project-evolution', 'evolution']);
/** Local hour (0–23) in an IANA time zone. */
export function localHour(at, timeZone = DEFAULT_TIME_ZONE) {
  const value = time(at); if (value === null) return null;
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(value))) % 24; } catch { return new Date(value).getUTCHours(); }
}
export const isNight = (hour, { start = 23, end = 7 } = {}) => hour !== null && (start > end ? hour >= start || hour < end : hour >= start && hour < end);

/** Read-only archive readers (immutable content-addressed JSON receipts). */
export function readArchive(stateFile, namespace) {
  const directory = join(`${stateFile}.archive`, namespace); if (!existsSync(directory)) return [];
  const rows = [];
  for (const name of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) { try { rows.push(JSON.parse(readFileSync(join(directory, name), 'utf8'))); } catch { /* a torn receipt is skipped, never repaired here */ } }
  return rows;
}
export function readUsageLedger(stateFile) {
  const file = `${stateFile}.usage-cache.jsonl`; if (!existsSync(file)) return [];
  return parseUsageLedger(readFileSync(file, 'utf8'));
}
/** Archive + ledger for one project (read-only). */
export function projectSideData(stateFile, projectId) {
  if (!stateFile) return {};
  return { archivedDecisions: readArchive(stateFile, `initiative/${projectId}/decisions`), wakeFailures: readArchive(stateFile, `initiative/${projectId}/failures`), usageRows: readUsageLedger(stateFile).filter(row => row.projectId === projectId) };
}

function turnView(session, turn, items) {
  const own = items.filter(item => item.turnId === turn.id), tools = own.filter(item => item.tool);
  const started = time(turn.startedAt ?? turn.createdAt), ended = time(turn.completedAt);
  const usage = turn.usage ?? own.filter(item => item.usage).reduce((sum, item) => ({ totalTokens: sum.totalTokens + (item.usage.totalTokens ?? 0), cacheRead: sum.cacheRead + (item.usage.cacheRead ?? 0), input: sum.input + (item.usage.input ?? 0) }), { totalTokens: 0, cacheRead: 0, input: 0 });
  return { id: turn.id, sessionId: session.id, userItemId: turn.userItemId ?? own.find(item => item.kind === 'user')?.id ?? null, status: turn.status, createdAt: iso(turn.createdAt), startedAt: iso(turn.startedAt), completedAt: iso(turn.completedAt),
    durationMs: started !== null && ended !== null ? ended - started : null, tokens: usage.totalTokens ?? 0, cacheRead: usage.cacheRead ?? 0, inputTokens: usage.input ?? 0,
    toolCalls: tools.length, toolFailures: tools.filter(item => item.tool.status === 'failed').length, runtimeAttempts: turn.runtimeAttempts ?? 1, errorCode: turn.errorCode ?? null };
}
const channelOf = item => item.source === 'initiative' ? (item.initiative?.kind === 'scheduled' || item.scheduleId ? 'scheduled' : item.initiative?.kind === 'digest' ? 'digest' : 'proactive') : item.kind === 'question' ? 'ask' : 'foreground';

/**
 * Normalized dataset for one project. `side` = { archivedDecisions, wakeFailures, usageRows } (see projectSideData).
 * Options: labels (manual label file object), timeZone, now.
 */
export function projectDataset(state, projectId, { side = {}, labels = null, timeZone, now = Date.now() } = {}) {
  const project = state.projects?.find(row => row.id === projectId);
  if (!project) throw Object.assign(new Error(`Unknown project ${projectId}`), { code: 'bench_project_missing' });
  const zone = timeZone ?? project.schedules?.find(row => row.rule?.timeZone)?.rule.timeZone ?? DEFAULT_TIME_ZONE;
  const sessions = (state.sessions ?? []).filter(row => row.projectId === projectId && row.simulated !== true);
  const messages = [], turns = [];
  for (const session of sessions) {
    const items = (session.items ?? []).filter(retained), turnById = new Map((session.turns ?? []).map(turn => [turn.id, turn]));
    for (const turn of (session.turns ?? []).filter(retained)) turns.push(turnView(session, turn, items));
    const lastAssistant = new Map(); for (const item of items) if (item.kind === 'assistant' && !item.source && item.turnId) lastAssistant.set(item.turnId, item.id);
    for (const item of items) {
      if (item.kind === 'user' && (!item.source || item.source === 'interaction-answer')) {
        const heuristic = heuristicLabels(item.text, { source: item.source }), labelled = applyManualLabels(item.id, heuristic, labels);
        messages.push({ id: item.id, sessionId: session.id, at: iso(item.createdAt), role: 'user', channel: item.source === 'interaction-answer' ? 'answer' : 'foreground', turnId: item.turnId ?? null, text: String(item.text ?? ''), ...labelled });
      } else if (item.kind === 'assistant' && item.source === 'initiative') {
        messages.push({ id: item.id, sessionId: session.id, at: iso(item.createdAt), role: 'agent', channel: channelOf(item), kind: item.initiative?.kind ?? 'insight', tier: item.initiative?.reach ?? 'inline', text: String(item.text ?? ''), scheduleId: item.scheduleId ?? null, actionId: item.initiativeActionId ?? null, threadId: item.threadId ?? item.initiative?.threadId ?? null });
      } else if (item.kind === 'question' && item.interaction) {
        const interaction = item.interaction;
        messages.push({ id: item.id, sessionId: session.id, at: iso(item.createdAt), role: 'agent', channel: interaction.actionId ? 'proactive' : 'ask', kind: 'question', tier: 'inline', text: (interaction.questions ?? []).map(row => row.question).join('\n'), turnId: item.turnId ?? null, answeredAt: iso(interaction.answeredAt), status: interaction.status ?? null });
      } else if (item.kind === 'assistant' && !item.source && item.turnId && lastAssistant.get(item.turnId) === item.id) {
        messages.push({ id: item.id, sessionId: session.id, at: iso(item.createdAt), role: 'agent', channel: 'foreground', kind: 'reply', turnId: item.turnId, turnStatus: turnById.get(item.turnId)?.status ?? null, text: String(item.text ?? '') });
      }
    }
  }
  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  turns.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const users = messages.filter(row => row.role === 'user');
  const lastUserBefore = at => { let found = null; for (const row of users) { if (row.at < at) found = row; else break; } return found; };
  const nextUserAfter = (at, sessionId) => users.find(row => row.at > at && (!sessionId || row.sessionId === sessionId)) ?? null;

  const proactive = messages.filter(row => row.role === 'agent' && ['proactive', 'scheduled', 'digest'].includes(row.channel)).map(row => {
    const previous = lastUserBefore(row.at), next = nextUserAfter(row.at, row.sessionId), hour = localHour(row.at, zone);
    const sinceUser = previous ? time(row.at) - time(previous.at) : null;
    return { itemId: row.id, sessionId: row.sessionId, at: row.at, scheduled: row.channel === 'scheduled', channel: row.channel, kind: row.kind, tier: row.tier, text: row.text, chars: row.text.length,
      shape: { fileMentions: fileMentions(row.text), hashMentions: hashMentions(row.text), manifest: hasDeliverableManifest(row.text), addendum: addendumOpener(row.text) },
      presence: { localHour: hour, night: isNight(hour), away: sinceUser === null || sinceUser > AWAY_MS, minutesSinceUser: sinceUser === null ? null : Math.round(sinceUser / 60000) },
      context: { previousUserItemId: previous?.id ?? null, previousUserAt: previous?.at ?? null },
      next: next ? { userItemId: next.id, at: next.at, delayMs: time(next.at) - time(row.at), labels: next.labels, text: next.text } : null,
      answeredAt: row.answeredAt ?? null, threadId: row.threadId ?? null, actionId: row.actionId ?? null };
  });

  const inbox = (project.inbox ?? []).filter(row => !row.contextRevoked).map(row => ({ id: row.id, itemId: row.itemId ?? null, actionId: row.actionId ?? null, tier: row.tier, createdAt: row.createdAt, scheduled: Boolean(row.scheduled), outcome: row.feedback?.outcome ?? null, dismissedAt: row.dismissedAt ?? null }));

  const seen = new Set(), decisions = [];
  for (const [origin, rows] of [['archive', side.archivedDecisions ?? []], ['state', project.decisions ?? []]]) for (const row of rows) {
    if (!row?.id || seen.has(row.id) || row.simulated === true) continue; seen.add(row.id);
    const at = iso(row.at), previous = at ? lastUserBefore(at) : null;
    decisions.push({ id: row.id, at, origin, action: row.action, status: row.status ?? null, reason: String(row.reason ?? ''), content: String(row.content ?? ''), evidenceCount: (row.evidenceIds ?? []).length, nextReviewAfterMs: row.nextReviewAfterMs ?? null,
      rhythm: row.rhythm ? { lifecycle: row.rhythm.lifecycle ?? null, initiativeMode: row.rhythm.initiative?.mode ?? null } : null, scheduleOperation: row.schedule?.operation ?? null, questions: (row.questions ?? []).length,
      context: { localHour: localHour(at, zone), minutesSinceUser: previous ? Math.round((time(at) - time(previous.at)) / 60000) : null, lastUserItemId: previous?.id ?? null } });
  }
  decisions.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // Outcome: a share/ask decision is "delivered" when a proactive item follows within 2h.
  for (const row of decisions.filter(row => ['share', 'ask'].includes(row.action))) { const hit = proactive.find(p => !p.scheduled && p.at >= row.at && time(p.at) - time(row.at) <= 2 * 3600000); row.outcome = { delivered: Boolean(hit), itemId: hit?.itemId ?? null }; }

  const wakeFailures = (side.wakeFailures ?? []).map(row => ({ id: row.id, at: iso(row.at), phase: row.phase ?? null, code: row.code ?? null, retryable: row.retryable ?? null }));
  const usage = (side.usageRows ?? []).map(row => ({ at: row.at, purpose: row.purpose, modelId: row.modelId ?? null, input: row.input ?? 0, output: row.output ?? 0, cacheRead: row.cacheRead ?? 0, cacheWrite: row.cacheWrite ?? 0, cacheReported: row.cacheReported === true, durationMs: row.durationMs ?? null }));
  const backgroundWork = (project.jobs ?? []).filter(row => row.simulated !== true).map(row => ({ id: row.id, kind: row.kind, lane: row.lane ?? null, status: row.status, createdAt: iso(row.createdAt), completedAt: iso(row.completedAt ?? row.resolvedAt), scheduled: String(row.id).startsWith('schedule-work-') }));

  const mind = project.mind && typeof project.mind === 'object' ? project.mind : null;
  // Commitments: contract data (project.mind.commitments) when present, else a
  // heuristic episode per user request/decision resolved by the next agent reply.
  const replies = messages.filter(row => row.role === 'agent' && (row.channel === 'proactive' || row.channel === 'ask' || row.channel === 'foreground' && row.turnStatus === 'completed'));
  const commitments = mind?.commitments ? mind.commitments.map(row => ({ id: row.id, source: 'mind', trigger: row.trigger ?? null, request: String(row.request ?? ''), createdAt: iso(row.createdAt), overdueAt: iso(row.overdueAt), status: row.status, resolvedAt: row.status === 'resolved' ? iso(row.resolvedAt ?? row.updatedAt) : null }))
    : users.filter(row => row.labels.includes('pending_request') || row.labels.includes('decision')).map(row => {
      const reply = replies.find(agent => agent.at > row.at);
      return { id: `c_${row.id}`, source: 'heuristic', trigger: row.labels.includes('decision') ? 'user_decision' : 'user_request', requestItemId: row.id, request: row.text, createdAt: row.at, overdueAt: iso(time(row.at) + OVERDUE_MS), status: reply ? 'resolved' : 'pending', resolvedAt: reply?.at ?? null, resolvedBy: reply ? reply.channel : null };
    });

  const versions = project.versions ?? [], candidates = versions.filter(row => EVOLUTION_SOURCES.has(row.source?.kind ?? row.source) || (!row.source && row.state !== 'baseline' && row.evaluation));
  // `versions…adopted` describe the retired whole-genome candidates; `genes` is evolution v3 (the gene tree), where growth happens now.
  const geneRows = project.genes?.genes ?? [];
  const evolution = { versions: versions.length, nonBaseline: versions.filter(row => row.state !== 'baseline').length, candidates: candidates.length, passed: candidates.filter(row => row.evaluation?.gatePassed === true).length, adopted: candidates.filter(row => ['active', 'trial'].includes(row.state) && row.evaluation?.gatePassed === true).length,
    genes: { generation: project.genes?.generations?.at(-1)?.n ?? 0, active: geneRows.filter(row => row.status === 'active' && row.origin).length, trial: geneRows.filter(row => row.status === 'trial').length, retired: geneRows.filter(row => row.status === 'retired').length, rejected: geneRows.filter(row => row.status === 'rejected').length } };

  return { schema: DATASET_SCHEMA, projectId, name: project.name ?? null, timeZone: zone, now: iso(now), messages, turns, proactive, decisions, wakeFailures, usage, backgroundWork, commitments, inbox, evolution,
    scheduled: proactive.filter(row => row.scheduled).map(row => ({ itemId: row.itemId, at: row.at, chars: row.chars, shape: row.shape, text: row.text, next: row.next })),
    openQuestions: (project.openQuestions ?? []).map(String), mind };
}
