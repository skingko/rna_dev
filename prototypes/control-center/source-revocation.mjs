import { closeInvitation } from './session-invitations.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { reconcileReason, recordRevocation, ensureMind, MIND_CONTEXT_KEYS } from './project-mind.mjs';

// What a deleted conversation (or a rewound part of one) leaves behind in the
// project's mind and evolution genes (review MIND-8, X-6). Deletion and rewind
// share one matcher, so both withdraw the same rows:
// - open agenda/plan rows and pending commitments the mind derived from the
//   source (its own source, or every evidence entry it has) end, and the cards
//   and invitations that ask about them close;
// - verbatim excerpts the source left on any row go (their ids stay);
// - genes keep working, but lose the user's quote and the ids of the message.
// Lesson text stays on deletion: the deletion notice promises extracted
// project memory is kept. A rewind retires the lessons, as it did before, and takes back (C4, a `lesson_revoked`
// revocation) what grew from them.
// A note whose source (or every source) is in scope is dropped; one that keeps some sources loses the links into the
// scope and waits for one batch judgment of whether what is left still says it (revocation-dispatcher.mjs).
// `withdrawSources` is the first step of revocation for these two events (OpenViking resource_memory_link_service.py:355-430:
// what came wholly from the source goes mechanically; what mixed sources is judged; then an assertion, `assertRevoked`).

/**
 * The revocation scope: a whole deleted conversation (`itemIds`/`turnIds` omitted), the items and turns a rewind removed
 * from one, or (privacy_revoked) the background actions of a project scope that no longer holds (`actionIds`, no
 * conversation). `sourceIds` are the opaque ids the conversations' context copies carry for it (SDK `contextSources`).
 * @param {{ sessionId?: string, itemIds?: Iterable<string> | null, turnIds?: Iterable<string> | null, actionIds?: Iterable<string> | null }} input
 */
export function sourceScope({ sessionId, itemIds = null, turnIds = null, actionIds = null } = {}) {
  const actions = new Set(actionIds ?? []);
  const whole = itemIds === null && turnIds === null && actions.size === 0, items = new Set(itemIds ?? []), turns = new Set(turnIds ?? []);
  const ref = entry => Boolean(entry && typeof entry === 'object' && (sessionId !== undefined && entry.sessionId === sessionId && (whole || items.has(entry.itemId) || turns.has(entry.turnId)) || actions.size && typeof entry.actionId === 'string' && actions.has(entry.actionId)));
  const every = list => Array.isArray(list) && list.length > 0 && list.every(ref);
  // Derived from the scope: its own source is in it, or every piece of evidence (or every source link) it has is.
  const derived = row => Boolean(row) && (ref(row.source) || every(row.evidence) || every(row.sources));
  // A lesson stands on its source and on each time the user confirmed it (evidence). One whose source is in the scope but that was
  // confirmed somewhere else too (the user said it again in another conversation) is MIXED, not derived: it stays, and loses only
  // the excerpts of what left; retiring it would also retire the rules it grew (the plan: mixed sources are judged, not withdrawn).
  const named = entry => Boolean(entry && typeof entry === 'object' && ['sessionId', 'itemId', 'turnId', 'actionId', 'factId'].some(key => typeof entry[key] === 'string' && entry[key]));
  const derivedLesson = row => derived(row) && ![row.source, ...(Array.isArray(row.evidence) ? row.evidence : [])].some(entry => named(entry) && !ref(entry));
  return { sessionId, whole, items, turns, actions, ref, derived, derivedLesson, sourceIds: [...actions].map(id => `action:${id}`) };
}

const ACTIVE_CARD = new Set(['pending', 'interrupted']);
/** Cancel the question card an ended mind row was asked through (in a conversation that still exists). */
function closeCard(state, row, { at, redact, text }) {
  const card = row.interaction;
  if (!card || typeof card !== 'object') return false;
  const session = state.sessions?.find(entry => entry.id === card.sessionId);
  if (!session) return false;
  if (card.via === 'invitation') return Boolean(card.invitationId && closeInvitation(session, card.invitationId, 'expired', { now: Date.parse(at) }));
  const record = session.items?.find(item => item.interaction?.id === card.interactionId)?.interaction;
  if (!record) return false;
  let changed = false;
  if (redact) for (const question of record.questions ?? []) if (!card.questionId || question.id === card.questionId) { question.question = text; delete question.options; changed = true; }
  if (ACTIVE_CARD.has(record.status)) { Object.assign(record, { status: 'cancelled', canRespond: false, cancelReason: 'source_removed', updatedAt: at }); changed = true; }
  return changed;
}

/**
 * Withdraw what the project mind derived from a removed source. Mutates a Store transaction only (`state` is the draft);
 * safe to repeat.
 * @param {object} state
 * @param {object} project
 * @param {ReturnType<typeof sourceScope>} scope
 * @param {{ mode?: 'deleted' | 'rewound' | 'privacy', now?: number }} [options]
 * @returns {{ withdrawn: number, stripped: number, closed: number, notes: number, pruned: { list: string, id: string }[], excerpts: string[] }} `pruned`: notes that kept some sources and lost the links into the scope; `excerpts`: the passages stripped (never stored: for the assertion that none was copied elsewhere)
 */
export function revokeMindSources(state, project, scope, { mode = 'deleted', now = Date.now() } = {}) {
  const mind = project?.mind, result = { withdrawn: 0, stripped: 0, closed: 0, notes: 0, pruned: [], excerpts: [] };
  if (!mind || typeof mind !== 'object') return result;
  const at = new Date(now).toISOString(), language = interfaceLanguageOf(state), privacy = mode === 'privacy', deleted = mode !== 'rewound';
  const reason = inLanguage(language, privacy ? { zh: '项目范围已变化，来源已撤销', en: 'The project scope changed; its source was revoked' } : deleted ? { zh: '来源对话已删除', en: 'Its source conversation was deleted' } : { zh: '来源消息已被编辑或删除', en: 'Its source message was edited or deleted' });
  const removed = inLanguage(language, privacy ? { zh: '（来源已撤销）', en: '(source revoked)' } : { zh: '（来源对话已删除）', en: '(source conversation deleted)' });
  const quoteRemoved = deleted ? removed : inLanguage(language, REWOUND_MARKER);
  const rows = key => Array.isArray(mind[key]) ? mind[key] : [];
  const ended = [];
  // A rewind retires the lessons it derived (text kept); so does a privacy change (the old scope's conclusions are revoked). A deleted conversation keeps them (the notice).
  if (mode !== 'deleted') for (const row of rows('lessons')) if (row.status === 'active' && scope.derivedLesson(row)) {
    Object.assign(row, { status: 'retired', retiredReason: 'source_removed', updatedAt: at }); result.withdrawn++; ended.push(['lessons', row]);
    // What grew from the lesson goes with it (genes, notes and plan items that restate it).
    recordRevocation(mind, { type: 'lesson_revoked', lessonId: row.id, cause: privacy ? 'privacy_revoked' : 'source_removed', text: row.text }, { now });
  }
  for (const row of rows('agenda')) if (row.status === 'open' && scope.derived(row)) { Object.assign(row, { status: 'dropped', reason, updatedAt: at }); delete row.blocking; result.withdrawn++; ended.push(['agenda', row]); }
  for (const row of rows('commitments')) if (row.status === 'pending' && scope.derived(row)) { Object.assign(row, { status: 'dismissed', reason, updatedAt: at }); result.withdrawn++; ended.push(['commitments', row]); }
  // A deleted conversation is not kept in a second projection: rows that were entirely its words lose their text
  // (whatever their status; a finished plan item is still shown to the model), answers given in it go too.
  if (deleted) {
    for (const row of rows('agenda')) {
      if (scope.derived(row) && !row.sourceDeleted) { row.text = removed; row.sourceDeleted = true; delete row.answer; row.updatedAt = at; }
      else if (row.answer !== undefined && scope.ref(row.resolvedBy)) { delete row.answer; row.updatedAt = at; }
    }
    for (const row of rows('commitments')) if (scope.derived(row) && !row.sourceDeleted) { row.request = removed; row.sourceDeleted = true; row.updatedAt = at; }
  } else {
    // A rewound message no longer stands behind what it settled: an undo of the work must not bring it back as owed
    // (review X2). Its text stays, as rewind keeps withdrawn text.
    for (const [key, settled] of [['agenda', 'done'], ['commitments', 'resolved']]) for (const row of rows(key)) if (row.status === settled && scope.derived(row) && !row.sourceRemoved) { row.sourceRemoved = 'message_rewound'; row.updatedAt = at; }
  }
  // What the source said when it settled a row (review D2-2): the reconcile verdict's quote, or the user's own answer,
  // goes with it, in both modes; the row keeps that it was settled and by what.
  for (const key of ['agenda', 'commitments']) for (const row of rows(key)) if (scope.ref(row.resolvedBy)) {
    let changed = false;
    if (typeof row.reason === 'string' && row.reason !== quoteRemoved && row.reason !== reason) { row.reason = quoteRemoved; changed = true; }
    if (row.answer !== undefined) { delete row.answer; changed = true; }
    if (changed) { row.updatedAt = at; result.stripped++; }
  }
  // Verbatim quotes the source left as evidence: the excerpt goes, the ids (and so the link) stay.
  for (const key of ['lessons', 'agenda', 'commitments']) for (const row of rows(key)) for (const entry of Array.isArray(row.evidence) ? row.evidence : []) if (scope.ref(entry) && entry.excerpt !== undefined) { if (typeof entry.excerpt === 'string') result.excerpts.push(entry.excerpt); delete entry.excerpt; result.stripped++; }
  // Notes: one wholly derived from the scope goes; one that keeps other sources loses the links into the scope (the text of
  // what it was written from is not kept) and is judged once against what is left (`pruned`; the dispatcher's source step).
  for (const key of ['facts', 'preferences']) if (Array.isArray(mind.notes?.[key])) {
    const kept = mind.notes[key].filter(row => !scope.derived(row));
    if (kept.length !== mind.notes[key].length) { result.notes += mind.notes[key].length - kept.length; mind.notes[key] = kept; mind.notes.updatedAt = at; }
    for (const row of mind.notes[key]) if (Array.isArray(row.sources) && row.sources.some(scope.ref)) { row.sources = row.sources.filter(entry => !scope.ref(entry)); result.pruned.push({ list: key, id: row.id }); mind.notes.updatedAt = at; }
  }
  // Cards and invitations that ask about what ended close; a commitment may be offered in any conversation of the project.
  for (const [key, row] of ended) {
    if (closeCard(state, row, { at, redact: deleted, text: removed })) result.closed++;
    if (key === 'commitments' || key === 'lessons') for (const session of state.sessions ?? []) if (session.projectId === project.id) {
      for (const invitation of [...(session.invitations ?? [])]) if (key === 'commitments' ? invitation.kind === 'commitment' && invitation.commitmentId === row.id : invitation.kind === 'lesson' && invitation.lessonId === row.id) {
        if (closeInvitation(session, invitation.id, 'expired', { now })) result.closed++;
      }
    }
  }
  return result;
}

const REWOUND_MARKER = { zh: '（来源消息已被编辑或删除）', en: '(source message edited or deleted)' };
// What reconcile wrote before 0.65: the verdict with a verbatim passage of the conversation (review D2-2).
const RECONCILE_QUOTE = /^(对话中已有答复或结果|已被后续工作取代)：「[\s\S]*」$/;
const genesOrigin = gene => gene?.origin && typeof gene.origin === 'object' ? gene.origin : null;
const normal = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clipped = (text, max) => { const value = normal(text); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
/**
 * A legacy gene quote of the user's words without any link to where they came from (written before origins recorded
 * their sources). The rule's own text is not one: a skill merge quotes its summary, and so does a contrast rule built
 * from no turn's words (its quote is its summary).
 */
const unlinkedQuote = gene => {
  const origin = genesOrigin(gene);
  if (!origin || !['correction', 'contrast'].includes(origin.kind) || typeof origin.quote !== 'string' || !origin.quote || origin.sessionId || origin.itemId || (Array.isArray(origin.sources) && origin.sources.length) || origin.sourceRemoved) return false;
  return !String(gene.id ?? '').startsWith('skill-merge:') && !gene.body?.mergedFrom && normal(origin.quote) !== clipped(gene.summary, 300);
};
/**
 * Quotes of conversations the state kept from before their sources were tracked (reviews D2-2, D2-4), on every start
 * (idempotent; a rollback that writes them again is cleaned on the next upgrade). Mutates a state that is not sealed
 * yet (Store constructor) or a draft.
 * - Reconcile reasons lose the passage they quoted; a reason whose resolving message is gone (the conversation
 *   deleted, or the message rewound) gives way to the removed marker.
 * - A correction or contrast rule's quote with no source link is traced, segment by segment, to the user's messages
 *   it was cut from (the same clipping the gene lanes used) and linked to them; segments no message matches any more
 *   (their conversation is gone) leave the quote, which goes entirely when none is left.
 * A quote that is the rule's own summary (skill merges, contrast rules from no turn's words) is left alone.
 * @returns {{ reasons: number, genes: number }}
 */
export function scrubLegacySourceQuotes(state, { now = Date.now() } = {}) {
  const result = { reasons: 0, genes: 0 }, language = interfaceLanguageOf(state), at = new Date(now).toISOString();
  const sessions = new Map((state.sessions ?? []).map(session => [session.id, session]));
  for (const project of state.projects ?? []) {
    const mind = project?.mind;
    if (mind && typeof mind === 'object') for (const key of ['agenda', 'commitments']) for (const row of Array.isArray(mind[key]) ? mind[key] : []) {
      if (typeof row?.reason !== 'string') continue;
      const by = row.resolvedBy, session = by?.sessionId ? sessions.get(by.sessionId) : null;
      let next = row.reason;
      if (RECONCILE_QUOTE.test(next)) next = reconcileReason(language, next.startsWith('对话中已有答复或结果'));
      // The message that settled it (a reconcile passage, or the user's answer) is gone.
      if (['reconcile', 'answer'].includes(by?.kind) && by.sessionId) {
        if (!session) next = inLanguage(language, { zh: '（来源对话已删除）', en: '(source conversation deleted)' });
        else if (by.itemId && !(session.items ?? []).some(item => item.id === by.itemId)) next = inLanguage(language, REWOUND_MARKER);
      }
      if (next !== row.reason) { row.reason = next; row.updatedAt = at; result.reasons++; }
    }
    const genes = Array.isArray(project?.genes?.genes) ? project.genes.genes.filter(unlinkedQuote) : [];
    if (!genes.length) continue;
    // The user's messages of the project, by their text as the gene lanes clipped it (corrections 300 characters,
    // contrast segments 400): a quote segment is linked to the message it was cut from.
    const messages = (state.sessions ?? []).filter(session => session.projectId === project.id).flatMap(session => (session.items ?? []).filter(item => item?.kind === 'user' && typeof item.text === 'string' && item.text.trim()).map(item => ({ sessionId: session.id, itemId: item.id, turnId: item.turnId ?? null, 300: clipped(item.text, 300), 400: clipped(item.text, 400) })));
    const find = (segment, max, partial) => messages.find(row => partial ? row[max].startsWith(segment) : row[max] === segment);
    for (const gene of genes) {
      const origin = gene.origin, quote = normal(origin.quote);
      // A contrast quote joins clipped corrections and requests with ' / ', then is clipped to 300 itself: its last
      // segment may be cut (it ends with '…').
      const segments = origin.kind === 'contrast' ? quote.split(' / ') : [quote];
      const kept = [], sources = [];
      segments.forEach((segment, index) => {
        const last = index === segments.length - 1, cut = last && segment.endsWith('…') && quote.length >= 300;
        const text = cut ? segment.slice(0, -1) : segment;
        const found = text && (origin.kind === 'correction' ? find(text, 300, false) ?? (text.endsWith('…') ? find(text.slice(0, -1), 300, true) : null) : find(text, 400, cut) ?? (text.endsWith('…') ? find(text.slice(0, -1), 400, true) : null));
        if (found) { kept.push(segment); sources.push({ sessionId: found.sessionId, ...(found.turnId ? { turnId: found.turnId } : {}), itemId: found.itemId }); }
      });
      if (origin.kind === 'correction' && sources.length) Object.assign(origin, { sessionId: sources[0].sessionId, itemId: sources[0].itemId });
      else if (sources.length) origin.sources = sources.filter((row, index) => sources.findIndex(other => other.sessionId === row.sessionId && other.itemId === row.itemId) === index);
      if (!kept.length) { delete origin.quote; Object.assign(origin, { sourceRemoved: 'session_deleted', sourceRemovedAt: at }); }
      else if (kept.length !== segments.length) origin.quote = kept.join(' / ');
      result.genes++;
    }
  }
  return result;
}

/**
 * Genes keep working when their source goes, but the user's verbatim quote and the ids of the message leave their
 * origin. A lesson captured from the same message keeps finding the rule that carries it through `origin.lessonId`.
 * A correction still waiting for lane B (project.genes.reviews, EVO-9) whose message, turn or answered reply is in scope
 * goes too: it can no longer be reviewed, and it should not outlive the conversation while evolution is off.
 * @param {object} project
 * @param {ReturnType<typeof sourceScope>} scope
 * @param {{ mode?: 'deleted' | 'rewound', now?: number }} [options]
 * @returns {number} the genes scrubbed
 */
export function revokeGeneSources(project, scope, { mode = 'deleted', now = Date.now() } = {}) {
  const reviews = project?.genes?.reviews;
  if (Array.isArray(reviews)) project.genes.reviews = reviews.filter(row => !(scope.ref(row) || row?.targetItemId && scope.ref({ sessionId: row.sessionId, itemId: row.targetItemId })));
  const genes = project?.genes?.genes;
  if (!Array.isArray(genes)) return 0;
  const at = new Date(now).toISOString(); let scrubbed = 0;
  for (const gene of genes) {
    const origin = gene?.origin;
    // A correction names its message; a contrast rule quotes several turns and lists them as `sources`: one of them in
    // scope is enough for the joined quote to go.
    const sources = Array.isArray(origin?.sources) ? origin.sources : [];
    if (!origin || typeof origin !== 'object' || !(scope.ref(origin) || sources.some(scope.ref))) continue;
    if (!origin.lessonId && origin.itemId && scope.ref(origin)) {
      const lesson = (project.mind?.lessons ?? []).find(row => row.source?.itemId === origin.itemId || (row.evidence ?? []).some(entry => entry?.itemId === origin.itemId));
      if (lesson?.id) origin.lessonId = lesson.id;
    }
    if (sources.length) origin.sources = sources.filter(entry => !scope.ref(entry));
    delete origin.quote;
    if (scope.ref(origin)) { delete origin.sessionId; delete origin.itemId; }
    Object.assign(origin, { sourceRemoved: mode === 'rewound' ? 'message_rewound' : 'session_deleted', sourceRemovedAt: at });
    scrubbed++;
  }
  return scrubbed;
}

/**
 * The file writes of a revoked source: its apply records in `project.git.applies` (who wrote which paths, and when),
 * queried where they live and never copied into a second provenance store (C4: the file-write layer IS that list; the
 * apply routes, the workspace events and the turn digest read the same rows). The files themselves stay when a
 * conversation goes — they are the project's — so these rows are what a revocation reports, not what it removes; derived
 * rows (a plan item a change settled) hold only the apply id.
 * @param {object} project
 * @param {ReturnType<typeof sourceScope>} scope
 * @returns {object[]} the apply rows whose source is inside the scope (read-only views of the stored rows)
 */
export function writesOf(project, scope) {
  return (project?.git?.applies ?? []).filter(row => scope.ref(row?.source));
}

/**
 * The final assertion of revocation (OpenViking `_assert_resource_unlinked`): after `withdrawSources`, in the project's
 * mind and genes, no live row has all of its sources inside the scope, no row of any status still holds a raw excerpt of
 * it, and no link into it is left on a note or a gene. Pure; returns the violations (empty when the invariant holds).
 * A deleted conversation keeps lessons (the deletion notice promises it): they are checked for excerpts, not for being live.
 * @param {object} project
 * @param {ReturnType<typeof sourceScope>} scope
 * @param {{ mode?: 'deleted' | 'rewound' | 'privacy' }} [options]
 * @returns {{ subsystem: 'mind' | 'genes', collection: string, id: string, why: string }[]}
 */
export function assertRevoked(project, scope, { mode = 'deleted', excerpts = [] } = {}) {
  const out = [], add = (subsystem, collection, id, why) => out.push({ subsystem, collection, id: String(id ?? ''), why });
  const mind = project?.mind;
  if (mind && typeof mind === 'object') {
    for (const [key, live] of [['lessons', row => mode !== 'deleted' && row.status === 'active'], ['agenda', row => row.status === 'open'], ['commitments', row => row.status === 'pending']]) for (const row of Array.isArray(mind[key]) ? mind[key] : []) {
      if (live(row) && (key === 'lessons' ? scope.derivedLesson(row) : scope.derived(row))) add('mind', key, row.id, 'live_row_derived_from_scope');
      for (const entry of Array.isArray(row.evidence) ? row.evidence : []) if (scope.ref(entry) && entry.excerpt !== undefined) add('mind', key, row.id, 'excerpt_left');
    }
    for (const key of ['facts', 'preferences']) for (const row of Array.isArray(mind.notes?.[key]) ? mind.notes[key] : []) {
      if (scope.derived(row)) add('mind', `notes.${key}`, row.id, 'live_row_derived_from_scope');
      else if (Array.isArray(row.sources) && row.sources.some(scope.ref)) add('mind', `notes.${key}`, row.id, 'link_left');
    }
  }
  // The outbox: a revocation entry keeps what it needs to settle (fingerprints, ids), never a passage of the revoked source. A passage
  // just stripped from a row that shows up in an entry (or an entry holding readable quotes) is a copy that outlived the revocation.
  for (const entry of Array.isArray(mind?.revocations) ? mind.revocations : []) {
    const held = JSON.stringify({ ...entry, text: undefined }); // `text` is the revoked lesson's own words: they stay on the lesson row (a rewind keeps withdrawn text)
    if (Array.isArray(entry?.link?.quotes) && entry.link.quotes.length || excerpts.some(text => text.length >= 8 && held.includes(JSON.stringify(text).slice(1, -1)))) add('mind', 'revocations', entry.id, 'excerpt_in_revocation');
  }
  for (const row of Array.isArray(project?.genes?.reviews) ? project.genes.reviews : []) if (scope.ref(row) || row?.targetItemId && scope.ref({ sessionId: row.sessionId, itemId: row.targetItemId })) add('genes', 'reviews', row.id, 'review_of_scope_left');
  for (const gene of Array.isArray(project?.genes?.genes) ? project.genes.genes : []) {
    const origin = gene?.origin, sources = Array.isArray(origin?.sources) ? origin.sources : [];
    if (!origin || typeof origin !== 'object') continue;
    if (scope.ref(origin) || sources.some(scope.ref)) add('genes', 'genes', gene.id, 'origin_link_left');
  }
  return out;
}

/**
 * Revocation step one for a deleted conversation or a rewound part of one, in the caller's Store transaction: what the
 * mind derived from the removed source is withdrawn, its quotes and links leave the mind and the genes, and what must
 * still be judged is recorded as a revocation entry (`message_rewound` / `session_deleted`, in `mind.revocations`): the
 * notes that kept some sources (judged once against what is left), and the conversations' context copies of what was
 * withdrawn (folded at once, reason `revoked`, at each conversation's next request). Then `assertRevoked`; a violation is
 * withdrawn once more and, if it still stands, reported (never thrown: a deletion must finish).
 * @param {object} state
 * @param {object} project
 * @param {ReturnType<typeof sourceScope>} scope
 * @param {{ mode?: 'deleted' | 'rewound' | 'privacy', now?: number }} [options]
 * @returns {{ withdrawn: number, stripped: number, closed: number, notes: number, genes: number, pruned: number, violations: object[], entry: object | null, writes: number }} `writes`: the apply records the source wrote (they stay; see writesOf)
 */
export function withdrawSources(state, project, scope, { mode = 'deleted', now = Date.now() } = {}) {
  const mind = revokeMindSources(state, project, scope, { mode, now }), genes = revokeGeneSources(project, scope, { mode, now });
  let violations = assertRevoked(project, scope, { mode, excerpts: mind.excerpts });
  if (violations.length) {
    // A row a first pass missed (a state written by an older version, a link added meanwhile) is withdrawn again before anything is reported.
    const again = revokeMindSources(state, project, scope, { mode, now }); revokeGeneSources(project, scope, { mode, now });
    mind.withdrawn += again.withdrawn; mind.stripped += again.stripped; mind.closed += again.closed; mind.notes += again.notes; mind.pruned.push(...again.pruned); mind.excerpts.push(...again.excerpts);
    violations = assertRevoked(project, scope, { mode, excerpts: mind.excerpts });
  }
  const changed = mind.withdrawn + mind.stripped + mind.notes + mind.pruned.length > 0;
  let entry = null;
  if (project?.mind && (mind.pruned.length || changed || (mode === 'privacy' && scope.sourceIds.length))) {
    // The file writes of the revoked source are read where they are recorded (project.git.applies) and named by id, never copied.
    const applies = writesOf(project, scope).map(row => row.id).filter(value => typeof value === 'string').slice(0, 20);
    entry = recordRevocation(ensureMind(project, now), { type: mode === 'privacy' ? 'privacy_revoked' : mode === 'rewound' ? 'message_rewound' : 'session_deleted', ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}), ...(applies.length ? { applies } : {}), ...(mode === 'privacy' ? { actionIds: [...scope.actions] } : {}), ...(mind.pruned.length ? { candidates: mind.pruned } : {}), context: { keys: changed ? Object.values(MIND_CONTEXT_KEYS) : [], sourceIds: mode === 'privacy' ? scope.sourceIds.slice(0, 64) : [] } }, { now });
    // Nothing to judge: the entry only carries the context request, which each conversation applies when it next asks the model.
    if (!mind.pruned.length) { entry.settledAt = new Date(now).toISOString(); entry.steps = { context: 'requested' }; }
  }
  return { withdrawn: mind.withdrawn, stripped: mind.stripped, closed: mind.closed, notes: mind.notes, genes, pruned: mind.pruned.length, violations, entry, writes: writesOf(project, scope).length };
}
