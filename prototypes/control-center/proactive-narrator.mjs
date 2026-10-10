import { createHash, randomUUID } from 'node:crypto';
import { oneLine, normalizedMessageKey } from '../../packages/sdk/src/proactive-message.mjs';
import { agendaUserText } from './agenda-text.mjs';
import { pacingSignals, pacingThreshold, candidateValue, pacingDecision, derivePacing, recordPacingDecision, timeSensitive, noteShared, conversationTimeline, heldItems } from './proactive-pacing.mjs';

// Narrator (proactive v2 §3 item 5, K2 v2): the single exit for proactive
// user-facing text. Like Pi and DeepSeek Harness, the user-facing text IS the
// agent's own final response; the host never rewrites, strips or truncates it.
// The host adds only deterministic safety (secret redaction, done by the
// controller; exact normalized-duplicate suppression here) and bookkeeping
// (threads, findings, pacing). Quality and value are judged by JEV only:
// `message.check` (writing contract, before delivery; a violation earns the
// agent one self-revision) and `message.value` (new vs already told incl.
// paraphrases, continued thread, relevance, urgency, decision needed). With
// no judge backend the message is delivered on pacing alone.
// Owns `project.mind.threads/findings/pacing` (contract §8); reads K1 fields.

export const NARRATOR_VERSION = 2;
export const VALUE_CHECK_BUDGET_MS = 3000;
export const THREAD_CANDIDATES = 5;
const THREADS_KEPT = 120, FINDINGS_KEPT = 240, HELD_KEPT = 12, THREAD_ITEMS_KEPT = 60, FINDING_TEXT = 600;
const DAY = 86400000;
const iso = value => new Date(value).toISOString();
const at = value => typeof value === 'number' ? value : Date.parse(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Identity of a message text for exact-duplicate suppression (case, width, spacing, punctuation ignored). */
export const textHash = text => hash(normalizedMessageKey(text)).slice(0, 24);
/** The label of a thread with no usable title; the user reads it in welcome-back and thread-close text, so it follows the interface language. */
export const untitledThread = (language = 'zh') => language === 'en' ? 'New topic' : '新话题';
/** A short label for a new thread: the message's first non-empty line. Display only; never used for matching. `fallback` is the label when the text has no line (default Chinese). */
export const firstLine = (text, limit = 60, fallback = untitledThread()) => oneLine((String(text ?? '').split('\n').find(line => line.trim()) ?? '').replace(/^[#>*\-\s]+/, ''), limit) || fallback;

/** The generic writing contract given to the agent that writes (and, when the judge flags it, revises) its own message. */
export const WRITING_CONTRACT = 'The user reads this later, without your context. Lead with the result, the requested content itself, or the question. Use plain words; include file names, paths, commands or identifiers only when this user needs them to act or open something (the kind of project decides: a failing test location matters in a coding project, the delivered file in a design project). Length is whatever the content needs. No status report without a result, no repeat of something already told, no process narration, praise opener, sign-off or offer of more help.';
/** Scheduled occurrence: the worker's final response is what the user receives (Pi/Harness), so it is written for them. */
export const SCHEDULED_DELIVERY_INSTRUCTION = `Your final response is delivered to the user as written (this replaces the internal report format for this occurrence). ${WRITING_CONTRACT} Give what the schedule above asks the user to receive, in the form it asks for (for example the report text, the build health result, the design or the analysis itself), not an account of producing it. If the user should open files you produced, declare them with project_present (usually one or two, each with a one-line description) instead of listing them. Keep the one-line handoff as your last line; the host removes it before delivery.`;
/** The longest message the reviser is given: a longer one is delivered as written, never revised from a cut copy. */
export const REVISION_TEXT_LIMIT = 24000;
/** Prompt for the agent's single self-revision turn after `message.check` flagged its message. */
export function revisionPrompt({ text, violations = [], deliverable = null, lessons = [] }) {
  return [`Revise your message for the user. The judge flagged: ${violations.map(row => `${row.code}: ${row.repair}`).join(' | ')}.`, deliverable ? `What the user asked to receive: ${oneLine(deliverable, 800)}` : '', lessons.length ? `The user's standing preferences: ${lessons.map(row => oneLine(row.text, 200)).join(' | ')}` : '', `Your message:\n${String(text).slice(0, REVISION_TEXT_LIMIT)}`, 'Reply with the revised message only.'].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- mind
export function ensureMind(project) {
  const mind = project.mind && typeof project.mind === 'object' ? project.mind : (project.mind = {});
  // §8 defaults for the K1-owned lists, so a mind first created here is a complete contract object.
  for (const key of ['lessons', 'agenda', 'commitments']) if (!Array.isArray(mind[key])) mind[key] = [];
  if (!Array.isArray(mind.threads)) mind.threads = [];
  if (!Array.isArray(mind.findings)) mind.findings = [];
  if (!mind.pacing || typeof mind.pacing !== 'object') mind.pacing = {};
  return mind;
}
const openAgenda = mind => (Array.isArray(mind.agenda) ? mind.agenda : []).filter(row => row && (row.status ?? 'open') === 'open' && typeof row.text === 'string');
const openCommitments = mind => (Array.isArray(mind.commitments) ? mind.commitments : []).filter(row => row && (row.status ?? 'pending') === 'pending' && typeof row.request === 'string');
export const evidenceHash = (evidenceIds = [], extra = null) => evidenceIds.length || extra ? hash([[...evidenceIds].sort(), extra]).slice(0, 24) : null;
const emptyReactions = () => ({ replied: 0, acted: 0, dismissed: 0, ignored: 0, up: 0, down: 0 });
function newThread({ title, kind, ref = null, reason = null, now, language = 'zh' }) {
  return { id: randomUUID(), title: oneLine(title || untitledThread(language), 60), kind, ...(ref ? { ref } : {}), ...(reason ? { reason: oneLine(reason, 200) } : {}), status: 'open', messageItemIds: [], messageSessions: {}, lastMessageAt: null, lastSummary: null, held: [],
    reactions: emptyReactions(), createdAt: iso(now), updatedAt: iso(now), source: { kind: 'narrator' } };
}
/**
 * Structural thread attachment (no text matching): an explicit thread, the
 * schedule's thread, the commitment/agenda item the action `resolves`, or a
 * thread that already told the same evidence. Otherwise `null`, and the judge
 * picks among open threads (message.value `continues_thread`).
 */
export function structuralThread(mind, candidate, { now = Date.now(), language = 'zh' } = {}) {
  const threads = Array.isArray(mind.threads) ? mind.threads : [];
  const known = id => threads.find(row => row.id === id);
  if (candidate.threadId && known(candidate.threadId)) return { thread: known(candidate.threadId), created: false, via: 'explicit' };
  if (candidate.kind === 'schedule' && candidate.schedule?.id) {
    const found = threads.find(row => row.ref?.scheduleId === candidate.schedule.id);
    return found ? { thread: found, created: false, via: 'schedule' } : { thread: newThread({ title: candidate.schedule.title, kind: 'schedule', ref: { scheduleId: candidate.schedule.id }, reason: 'A registered schedule delivers here.', now, language }), created: true, via: 'schedule' };
  }
  const refThread = (ref, title, kind, via) => { const found = threads.find(row => row.ref && Object.entries(ref).every(([key, value]) => row.ref[key] === value)); return found ? { thread: found, created: false, via } : { thread: newThread({ title, kind, ref, reason: `Follows ${kind} "${oneLine(title, 60)}".`, now, language }), created: true, via }; };
  const resolves = [candidate.resolves].flat().filter(Boolean);
  if (resolves.length) {
    const commitment = openCommitments(mind).find(row => resolves.includes(row.id)), item = openAgenda(mind).find(row => resolves.includes(row.id));
    if (commitment) return refThread({ commitmentId: commitment.id }, commitment.request, 'commitment', 'resolves');
    if (item) return item.threadId && known(item.threadId) ? { thread: known(item.threadId), created: false, via: 'resolves' } : refThread({ agendaId: item.id }, agendaUserText(item, language), 'agenda', 'resolves');
  }
  const evidence = new Set(candidate.evidenceIds ?? []);
  const byEvidence = evidence.size ? (Array.isArray(mind.findings) ? mind.findings : []).findLast(row => (row.evidenceIds ?? []).some(id => evidence.has(id)) && known(row.threadId)) : null;
  return byEvidence ? { thread: known(byEvidence.threadId), created: false, via: 'evidence' } : null;
}
/** Open threads the judge may choose from, most recent first. */
export function threadCandidates(mind, { now = Date.now() } = {}) {
  return (Array.isArray(mind.threads) ? mind.threads : []).filter(row => row.status === 'open' || row.status === 'muted' || row.status === 'resolved' && now - at(row.updatedAt) < 7 * DAY)
    .sort((a, b) => String(b.lastMessageAt ?? b.updatedAt ?? '').localeCompare(String(a.lastMessageAt ?? a.updatedAt ?? ''))).slice(0, THREAD_CANDIDATES);
}
function threadFactor(thread) {
  const r = thread?.reactions ?? {}, positive = (r.replied ?? 0) + (r.acted ?? 0) + (r.up ?? 0), negative = (r.dismissed ?? 0) + (r.down ?? 0) + .5 * (r.ignored ?? 0);
  return negative >= 2 && negative > positive ? .1 : positive >= 2 && positive > negative ? -.05 : 0;
}
const withTimeout = (promise, ms) => { let timer; return Promise.race([Promise.resolve(promise).catch(() => null), new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer)); };

/**
 * Plan one proactive message. `candidate.text` is the agent's own final text
 * (already redacted by the host); it is delivered exactly as written.
 * candidate: { kind: share|ask|schedule, text, evidenceIds, reason, actionId, requestedTier, schedule?, occurrenceKey?, resolves?, threadId?, deliverable? }
 * decisions: the judge service (`messageValue`, `enabled`); absent → pacing only.
 * projectKind: { title, taskTypes[], deliverable? } for the judge.
 * language: the interface language, only for the label of a thread that has no title of its own (default Chinese).
 */
export async function narrate({ project, sessions = [], candidate, decisions = null, now = Date.now(), presence = null, lastSeenAt = null, recentTexts = [], evidenceTimes = [], lifecycle = null, projectKind = null, language = 'zh', signal } = {}) {
  const mind = project.mind ?? {}, scheduled = candidate.kind === 'schedule', text = String(candidate.text ?? '').trim();
  const structural = structuralThread(mind, candidate, { now, language });
  const candidates = structural ? [structural.thread] : threadCandidates(mind, { now });
  const items = new Map(sessions.flatMap(session => (session.items ?? []).map(item => [item.id, item])));
  const threadView = thread => ({ title: thread.title, messages: (thread.messageItemIds ?? []).slice(-2).map(id => items.get(id)?.text).filter(Boolean), lastMessageAt: thread.lastMessageAt });
  // Deterministic safety: an exact (normalized) repeat of something already delivered is never sent twice.
  const key = textHash(text), findings = Array.isArray(mind.findings) ? mind.findings : [];
  const duplicate = !scheduled && candidate.kind !== 'ask' && (findings.some(row => row.textHash === key) || recentTexts.some(value => textHash(value) === key));
  const timeline = conversationTimeline(sessions), lastUser = timeline.filter(row => row.kind === 'user' && row.text).at(-1);
  const signals = pacingSignals(project, sessions, { now, presence, lastSeenAt, evidenceTimes, lifecycle });
  let judged = null;
  if (!duplicate && !scheduled && typeof decisions?.messageValue === 'function' && decisions.enabled?.('message.value') !== false) {
    const threadIds = new Set(candidates.map(row => row.id));
    judged = await withTimeout(decisions.messageValue(project, { text, kind: candidate.kind, threads: candidates.map(threadView), openItems: [...openCommitments(mind).map(row => row.request), ...openAgenda(mind).filter(row => !row.stale).map(row => row.text)].slice(0, 6), // C4: a stale row (it leans on what was withdrawn) is not open work to the judge; settling one by `resolves` still works
      findings: findings.filter(row => threadIds.has(row.threadId) || now - at(row.lastSharedAt) < 7 * DAY).slice(-8), lastUserAt: lastUser?.at, currentTopic: lastUser?.text, project: projectKind, signal }), VALUE_CHECK_BUDGET_MS);
  }
  const chosen = !structural && Number.isInteger(judged?.threadIndex) ? candidates[judged.threadIndex] : null;
  const attached = structural ?? (chosen ? { thread: chosen, created: false, via: 'judge' } : { thread: newThread({ title: firstLine(text, 40, untitledThread(language)), kind: 'topic', reason: candidate.reason || 'A new subject not covered by an open thread.', now, language }), created: true, via: 'new_topic' });
  const thread = attached.thread, muted = thread.status === 'muted', continuing = !attached.created && (thread.messageItemIds?.length ?? 0) > 0;
  // A question is structurally a request for a decision; everything else is the judge's call.
  const probabilities = { ...(candidate.kind === 'ask' ? { needs_user_decision: 1 } : {}), ...(judged?.probabilities ?? {}) };
  // Questions are deduplicated by the question slot (one pending card), not by the findings ledger.
  const reported = !scheduled && candidate.kind !== 'ask' && judged?.alreadyReported === true;
  const threshold = pacingThreshold(signals), factor = threadFactor(thread);
  if (factor) { threshold.factors.push({ name: 'thread_reactions', delta: factor }); threshold.threshold = Math.round(Math.min(.9, Math.max(.25, threshold.threshold + factor)) * 1000) / 1000; }
  const value = candidateValue(probabilities);
  const decision = pacingDecision({ value, threshold: threshold.threshold, probabilities, signals, kind: candidate.kind, scheduled, muted, reported, duplicate, continuing });
  // attention.now: while the user is in focused work, a message that would go out now and is not urgent waits for a natural pause.
  if (decision.outcome === 'send' && !scheduled && candidate.kind !== 'ask' && signals.present && !timeSensitive(probabilities) && typeof decisions?.attentionNow === 'function' && decisions.enabled?.('attention.now') !== false) {
    const userAts = timeline.filter(row => row.kind === 'user').map(row => row.at), recent = userAts.filter(value => now - value < 10 * 60000).length, lastAt = userAts.at(-1);
    const pace = recent >= 4 ? 'rapid_exchange' : recent >= 2 ? 'steady' : recent === 1 ? 'occasional' : 'idle';
    const sinceLast = !Number.isFinite(lastAt) ? 'never' : now - lastAt < 120000 ? 'just_now' : now - lastAt < 600000 ? 'minutes_ago' : 'a_while_ago';
    const judged = await withTimeout(decisions.attentionNow(project, { typing: signals.typing === true, pace, sinceLast, recent: timeline.slice(-4).map(row => `[${row.kind}] ${oneLine(row.text ?? '', 180)}`), signal }).catch(() => null), 1500);
    if (judged?.focused) { decision.outcome = 'hold'; decision.reasons = ['user_focused']; }
  }
  return {
    version: NARRATOR_VERSION, outcome: decision.outcome, reasons: decision.reasons, text,
    thread: structuredClone(thread), threadCreated: attached.created, via: attached.via, continuing,
    finding: { summary: oneLine(text, FINDING_TEXT), textHash: key, evidenceHash: evidenceHash(candidate.evidenceIds ?? [], scheduled ? candidate.occurrenceKey ?? null : null), evidenceIds: [...(candidate.evidenceIds ?? [])].slice(0, 12) },
    value, threshold: threshold.threshold, factors: threshold.factors, probabilities, valueSource: judged ? 'jev' : 'pacing', ledgerId: judged?.ledgerId ?? null,
    timeSensitive: timeSensitive(probabilities), context: { away: signals.away, night: signals.night, present: signals.present, unrepliedChain: signals.unrepliedChain }, signals, kind: candidate.kind, actionId: candidate.actionId ?? null,
    ...(candidate.deliverables?.length ? { deliverables: candidate.deliverables } : {}), ...(candidate.revision ? { revision: candidate.revision } : {}),
  };
}
/** Compact, UI-safe record of a narration on the delivered item (`item.initiative.narrated`). */
export const narratedView = plan => ({ version: plan.version, value: plan.value, threshold: plan.threshold, valueSource: plan.valueSource, outcome: plan.outcome, reasons: plan.reasons, continuing: plan.continuing, via: plan.via, context: plan.context, ...(plan.revision ? { revision: plan.revision } : {}) });
/** Pacing decision record (inbox entry `pacing`, `mind.pacing.decisions[]`): one `outcome` (send|hold|inbox|drop) and `reasons[]` codes. */
export const pacingRecord = (plan, now) => ({ at: iso(now), actionId: plan.actionId, kind: plan.kind, threadId: plan.thread.id, outcome: plan.outcome, reasons: plan.reasons, value: plan.value, threshold: plan.threshold, factors: plan.factors, valueSource: plan.valueSource, context: plan.context });

/** Append a delivered item; `messageSessions` lets the UI open earlier thread messages across conversations. */
function addThreadMessage(thread, itemId, sessionId, now) {
  thread.messageItemIds = [...(thread.messageItemIds ?? []), itemId].slice(-THREAD_ITEMS_KEPT);
  const kept = new Set(thread.messageItemIds);
  thread.messageSessions = Object.fromEntries(Object.entries({ ...(thread.messageSessions ?? {}), ...(sessionId ? { [itemId]: sessionId } : {}) }).filter(([id]) => kept.has(id)));
  thread.lastMessageAt = iso(now);
}
function upsertThread(mind, snapshot, now) {
  let thread = mind.threads.find(row => row.id === snapshot.id);
  if (!thread) { thread = structuredClone(snapshot); mind.threads.push(thread); }
  thread.held ??= []; thread.messageItemIds ??= []; thread.reactions ??= emptyReactions(); thread.updatedAt = iso(now);
  if (mind.threads.length > THREADS_KEPT) { const drop = mind.threads.filter(row => row.status !== 'open' || !row.held?.length && !row.heldAsks?.length).slice(0, mind.threads.length - THREADS_KEPT).map(row => row.id); mind.threads = mind.threads.filter(row => !drop.includes(row.id)); }
  return thread;
}
function recordFinding(mind, thread, finding, { now, itemId = null }) {
  const existing = finding.evidenceHash ? mind.findings.findLast(row => row.threadId === thread.id && row.lastEvidenceHash === finding.evidenceHash) : null;
  if (existing) Object.assign(existing, { summary: finding.summary, textHash: finding.textHash, lastSharedAt: iso(now), evidenceIds: [...new Set([...(existing.evidenceIds ?? []), ...finding.evidenceIds])].slice(-12), shareCount: (existing.shareCount ?? 1) + 1, updatedAt: iso(now), ...(itemId ? { lastItemId: itemId } : {}) });
  else mind.findings.push({ id: randomUUID(), topicKey: hash([thread.id, finding.textHash]).slice(0, 16), summary: finding.summary, textHash: finding.textHash, firstSharedAt: iso(now), lastSharedAt: iso(now), lastEvidenceHash: finding.evidenceHash, evidenceIds: finding.evidenceIds, threadId: thread.id, shareCount: 1, createdAt: iso(now), updatedAt: iso(now), source: { kind: 'narrator', ...(itemId ? { itemId } : {}) } });
  if (mind.findings.length > FINDINGS_KEPT) mind.findings = mind.findings.slice(-FINDINGS_KEPT);
}
/**
 * Commit a plan inside the store transaction. `itemId`/`entryId` identify the
 * delivered conversation item and/or inbox receipt; a hold stores the message
 * in its thread for the welcome-back message.
 */
export function applyNarration(project, plan, { itemId = null, entryId = null, sessionId = null, now = Date.now(), delivered = plan.outcome === 'send' || plan.outcome === 'inbox' } = {}) {
  const mind = ensureMind(project), thread = upsertThread(mind, plan.thread, now);
  // Link the agenda item to its thread (K1's `agenda[].threadId`) the first time a message attaches to it.
  if (thread.ref?.agendaId) { const item = mind.agenda.find(row => row.id === thread.ref.agendaId); if (item && !item.threadId) { item.threadId = thread.id; item.updatedAt = iso(now); } }
  if (plan.outcome === 'hold') {
    // A message held for a resolved thread (the judge may continue one resolved within 7 days; an evidence match ignores
    // status) reopens it, as one delivered there does: held rows are read from open threads only, so otherwise a held
    // message was never delivered and a held question lost its record and was narrated again (system review F5(b)).
    if (thread.status === 'resolved') { thread.status = 'open'; delete thread.resolvedAt; }
    const row = { id: randomUUID(), actionId: plan.actionId, kind: plan.kind, text: plan.text, value: plan.value, reasons: plan.reasons, finding: plan.finding, ...(plan.deliverables ? { deliverables: plan.deliverables } : {}), createdAt: iso(now) };
    // A held question (F4) keeps its own field and its message.value ledger row, so the card that goes out from this
    // record later labels that judgment like any other delivery (proactive-pacing heldAsks).
    if (plan.kind === 'ask') thread.heldAsks = [...(Array.isArray(thread.heldAsks) ? thread.heldAsks : []), { ...row, ...(plan.ledgerId ? { ledgerId: plan.ledgerId } : {}) }].slice(-HELD_KEPT);
    else thread.held = [...thread.held, row].slice(-HELD_KEPT);
  } else if (delivered) {
    if (itemId) addThreadMessage(thread, itemId, sessionId, now);
    if (entryId) thread.entryIds = [...(thread.entryIds ?? []), entryId].slice(-THREAD_ITEMS_KEPT);
    thread.lastSummary = plan.finding.summary; if (thread.status === 'resolved') { thread.status = 'open'; delete thread.resolvedAt; }
    if (plan.kind === 'ask' || plan.probabilities?.needs_user_decision >= .7) thread.awaitingUser = true;
    recordFinding(mind, thread, plan.finding, { now, itemId });
  }
  mind.pacing = derivePacing(mind.pacing, plan.signals, { threshold: plan.threshold, factors: plan.factors });
  recordPacingDecision(mind.pacing, pacingRecord(plan, now));
  if (plan.outcome === 'send') mind.pacing.wake = noteShared(mind.pacing.wake);
  return thread;
}

// ------------------------------------------------------- welcome back
/** Held items become one "welcome back" message when the user is here again (and it is not night). */
export function welcomeBackDue(project, signals) {
  const held = heldItems(project.mind ?? {});
  if (!held.length || signals.night || signals.typing) return [];
  const oldest = Math.min(...held.map(row => at(row.createdAt)));
  return signals.present || Number.isFinite(signals.lastUserAt) && signals.lastUserAt > oldest ? held : [];
}
export const WELCOME_BACK_TOPICS = 5;
/**
 * One message carrying the held messages as the agent wrote them, grouped by
 * thread, most valuable first. Structured `topics` (display order) are the
 * contract for clients; `text` is the same content for older clients. Topics
 * beyond the first five are filed to the inbox (`overflowCount`). The header and
 * the overflow line follow `language` (default Chinese); the topics' own text is
 * what the agent wrote and is never rewritten.
 */
export function composeWelcomeBack(held, language = 'zh') {
  const byThread = new Map(); for (const row of held) { const list = byThread.get(row.threadId) ?? []; list.push(row); byThread.set(row.threadId, list); }
  const groups = [...byThread.values()].map(rows => ({ rows, value: Math.max(...rows.map(row => row.value ?? 0)) })).sort((a, b) => b.value - a.value);
  const shown = groups.slice(0, WELCOME_BACK_TOPICS), rest = groups.slice(WELCOME_BACK_TOPICS);
  const topics = shown.map(({ rows }) => ({ threadId: rows[0].threadId, title: rows[0].threadTitle, text: rows.map(row => row.text).join('\n\n'), heldIds: rows.map(row => row.id), ...(rows.some(row => row.deliverables?.length) ? { deliverables: rows.flatMap(row => row.deliverables ?? []) } : {}) }));
  const overflowCount = rest.reduce((sum, group) => sum + group.rows.length, 0);
  const en = language === 'en', quoted = title => en ? `"${oneLine(title, 40)}"` : `「${oneLine(title, 40)}」`;
  const header = en ? `While you were away (${topics.length} ${topics.length === 1 ? 'topic' : 'topics'}):` : `你不在时的进展（${topics.length} 个话题）：`;
  const overflow = en ? `${overflowCount} more ${overflowCount === 1 ? 'message was' : 'messages were'} filed in the inbox.` : `另有 ${overflowCount} 条放进了收件箱。`;
  const text = [header, ...topics.map((topic, index) => `${index + 1}. ${quoted(topic.title)}\n${topic.text}`), ...(overflowCount ? [overflow] : [])].join('\n\n');
  return { text, topics, overflowCount, shown: shown.flatMap(group => group.rows), filed: rest.flatMap(group => group.rows) };
}
export function applyWelcomeBack(project, held, { itemId, sessionId = null, now = Date.now() }) {
  const mind = ensureMind(project), ids = new Set(held.map(row => row.id));
  for (const thread of mind.threads) {
    const taken = (thread.held ?? []).filter(row => ids.has(row.id)); if (!taken.length) continue;
    for (const row of taken) recordFinding(mind, thread, row.finding, { now, itemId });
    thread.held = thread.held.filter(row => !ids.has(row.id)); addThreadMessage(thread, itemId, sessionId, now); thread.lastSummary = oneLine(taken.at(-1).text, FINDING_TEXT); thread.updatedAt = iso(now);
  }
  mind.pacing.wake = noteShared(mind.pacing.wake);
  recordPacingDecision(mind.pacing, { at: iso(now), kind: 'welcome_back', outcome: 'send', reasons: ['welcome_back'], count: held.length, itemId });
}

// ------------------------------------------------ resolution & reactions
/**
 * Threads follow their agenda item / commitment. A resolved source resolves
 * the thread; held items are dropped. A brief close is proposed only when the
 * thread left the user waiting (an open question or an agent promise).
 * Each row is `{ threadId, close, status, title, resolution }`: `close` is the
 * message in `language` (default Chinese) or null; `title` and `resolution`
 * (string | null) are the same facts structured, so a client can render its own
 * wording without parsing `close`.
 */
export function resolveThreads(project, { now = Date.now(), language = 'zh' } = {}) {
  const mind = project.mind ?? {}, closes = [];
  if (!Array.isArray(mind.threads)) return closes;
  const agenda = new Map((Array.isArray(mind.agenda) ? mind.agenda : []).map(row => [row.id, row])), commitments = new Map((Array.isArray(mind.commitments) ? mind.commitments : []).map(row => [row.id, row]));
  for (const thread of mind.threads) {
    if (thread.status !== 'open' || !thread.ref) continue;
    const source = thread.ref.commitmentId ? commitments.get(thread.ref.commitmentId) : thread.ref.agendaId ? agenda.get(thread.ref.agendaId) : null;
    if (!source || !['done', 'dropped', 'resolved', 'dismissed'].includes(source.status)) continue;
    const resolution = typeof source.resolvedBy === 'string' ? source.resolvedBy : source.reason, en = language === 'en';
    const detail = resolution ? oneLine(resolution, 200) : null;
    // `title` is cut the same way as in `close`, so a client rendering from it shows what the text row shows.
    const title = oneLine(thread.title, 30);
    const close = (thread.awaitingUser || source.trigger === 'agent_promise') && thread.messageItemIds?.length && ['done', 'resolved'].includes(source.status)
      ? (en ? `"${title}" is done${resolution ? `: ${detail}` : '.'}` : `「${title}」已完成${resolution ? `：${detail}` : '。'}`) : null;
    closes.push({ threadId: thread.id, close, status: source.status, title, resolution: detail || null });
  }
  return closes;
}
export function applyResolution(project, rows, { now = Date.now(), itemIds = {}, sessionId = null } = {}) {
  const mind = ensureMind(project);
  for (const row of rows) {
    const thread = mind.threads.find(value => value.id === row.threadId); if (!thread || thread.status !== 'open') continue;
    Object.assign(thread, { status: 'resolved', resolvedAt: iso(now), updatedAt: iso(now), held: [], awaitingUser: false });
    if (itemIds[row.threadId]) addThreadMessage(thread, itemIds[row.threadId], sessionId, now);
  }
}
/** replied/acted/dismissed/ignored from inbox receipts, up/down from item feedback (K1). */
export function threadReactions(project, sessions) {
  const mind = project.mind ?? {}, result = new Map();
  if (!Array.isArray(mind.threads)) return result;
  const items = new Map(sessions.flatMap(session => (session.items ?? []).map(item => [item.id, item])));
  for (const thread of mind.threads) {
    const reactions = emptyReactions(), entryIds = new Set(thread.entryIds ?? []), itemIds = new Set(thread.messageItemIds ?? []);
    for (const entry of project.inbox ?? []) if ((entry.threadId === thread.id || entryIds.has(entry.id)) && entry.feedback?.outcome && reactions[entry.feedback.outcome] !== undefined) reactions[entry.feedback.outcome]++;
    for (const id of itemIds) { const vote = items.get(id)?.feedback?.vote; if (vote === 'up' || vote === 'down') reactions[vote]++; }
    if (JSON.stringify(reactions) !== JSON.stringify(thread.reactions ?? {})) result.set(thread.id, reactions);
    if (thread.awaitingUser && [...itemIds].some(id => (project.inbox ?? []).some(entry => entry.itemId === id && ['replied', 'acted'].includes(entry.feedback?.outcome)))) result.set(thread.id, { ...(result.get(thread.id) ?? reactions), awaitingUser: false });
  }
  return result;
}
export function applyReactions(project, updates, now = Date.now()) {
  const mind = ensureMind(project);
  for (const [id, reactions] of updates) { const thread = mind.threads.find(row => row.id === id); if (!thread) continue; const { awaitingUser, ...counts } = reactions; thread.reactions = counts; if (awaitingUser === false) thread.awaitingUser = false; thread.updatedAt = iso(now); }
}
