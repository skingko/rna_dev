// W2 shadow `basis` check (design2 §7 W2): when a schedule task's text changes, the model may name the user's own words that
// ask for the change to apply to every future run (`basis`). The host compares them with the project's user messages and
// records the outcome next to the change; it never rejects on it (no reference refuses a write on a quote check: zcode asks
// for approval, DeepSeek has no update). Rna's own precedent is project-schedule-intent.mjs: `requestEvidence` must be a
// substring of a user message. Plain string containment after whitespace normalization, no language heuristic, and no new
// judgment point: the one-off signal is the verdict already stored on the user message (`capture.durable`, a JEV or fast
// model judgment made when the message arrived), read as it is; a message with none (before 10-01, an answer to a question
// card) is simply not judged.

/** quoted: the words are in a user message; one_off: …in a message already judged to concern one occasion only;
 * not_found: …in none of the messages that count; absent: the model gave none. */
export const BASIS_CHECKS = Object.freeze(['quoted', 'not_found', 'absent', 'one_off']);
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
/** The user's own messages of a project's conversations (not archived; a deleted or revoked message does not count), oldest first. */
export function projectUserItems(state, projectId) {
  const rows = [];
  for (const session of state?.sessions ?? []) {
    if (session.projectId !== projectId || session.archivedAt) continue;
    for (const item of session.items ?? []) if (item?.kind === 'user' && typeof item.text === 'string' && !item.sourceDeleted && !item.contextRevoked) rows.push({ id: item.id, sessionId: session.id, text: item.text, at: item.createdAt ?? null, durable: typeof item.capture?.durable === 'string' ? item.capture.durable : null });
  }
  return rows.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
}
/**
 * `basis`: what the model sent; `items`: projectUserItems; `referenced`: for the planner, the ids of the user messages it
 * cites as evidence (`message:<id>` without the prefix) — only those count; null for the foreground tool (any user message
 * of the project counts). The most recent matching message is the one named.
 */
export function scheduleBasisCheck({ basis, items, referenced = null }) {
  const quote = typeof basis === 'string' ? squash(basis) : '';
  if (!quote) return { check: 'absent' };
  const allowed = referenced === null ? null : new Set(referenced);
  const match = [...items].reverse().find(item => (allowed === null || allowed.has(item.id)) && squash(item.text).includes(quote));
  if (!match) return { check: 'not_found', basisChars: quote.length };
  return { check: match.durable === 'one_off' ? 'one_off' : 'quoted', basisChars: quote.length, messageId: match.id, sessionId: match.sessionId, ...(match.durable ? { durable: match.durable } : {}) };
}
/** The user messages an initiative action cites (`message:<id>` evidence ids), as the item ids. */
export const citedMessageIds = evidenceIds => (Array.isArray(evidenceIds) ? evidenceIds : []).filter(id => typeof id === 'string' && id.startsWith('message:')).map(id => id.slice('message:'.length)).filter(Boolean);
