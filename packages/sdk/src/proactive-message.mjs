// Proactive communication contract (Headlong-style "How to write a message to
// a person"), delivery reach tiers and the one-line run handoff. Pure helpers:
// no IO, no model calls. Hosts decide where a message goes; these functions
// only classify text the model already wrote.

/** Ordered from least to most intrusive. JEV/host caps may only move left. */
export const REACH_TIERS = Object.freeze(['digest', 'inbox', 'inline', 'notify']);
export const reachRank = tier => REACH_TIERS.indexOf(tier);
export const lowerReach = (...tiers) => tiers.filter(tier => reachRank(tier) >= 0).reduce((low, tier) => reachRank(tier) < reachRank(low) ? tier : low, 'notify');
/** inbox/digest never interrupt: typing, active turns, quiet time, mute and cooldown do not hold them. */
export const quietReach = tier => tier === 'inbox' || tier === 'digest';

export const PROACTIVE_MESSAGE_GUIDANCE = `Writing share/ask content (the host delivers your text as written): the user reads it later without your context. Result first, in plain everyday words, then only what the user needs; length is whatever the content needs. Name files, paths or identifiers only when this user needs them to act or open something (for example the failing test in a coding project or the delivered design file); otherwise describe things plainly. No status pings, no re-answers, no second follow-up on the same finding: communication.sentLast24h lists what was delivered in 24h with the user's reaction; a judge drops anything already told. Do not narrate your machinery. No praise opener, sign-off or offer of more help.`;
export const REACH_GUIDANCE = `Set urgency on share: inline (conversation, see soon), inbox (quiet, read later; the only tier delivered while muted: muting holds inline and notify shares and asks, and pauses scheduled tasks), notify (inline plus desktop alert, time-sensitive, only if reach.tiers lists it), digest (next daily summary). Pick the least intrusive tier that serves the user; the host may lower it, never raise it. An ask always shows in the conversation.`;

const normalized = text => String(text ?? '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
function bigrams(text) { const counts = new Map(); for (let index = 0; index < text.length - 1; index++) { const key = text.slice(index, index + 2); counts.set(key, (counts.get(key) ?? 0) + 1); } return counts; }
/** Dice coefficient over character bigrams; language-neutral (CJK and Latin). */
export function messageSimilarity(a, b) {
  const left = normalized(a), right = normalized(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const x = bigrams(left), y = bigrams(right); let shared = 0;
  for (const [key, count] of x) shared += Math.min(count, y.get(key) ?? 0);
  return 2 * shared / (left.length - 1 + right.length - 1);
}

const REPAIR = {
  near_duplicate: 'This exact message was already delivered recently. Do not resend it; share only genuinely new information, or choose wait.'
};
/** Normalized-text identity: case, width, whitespace and punctuation do not count. */
export const normalizedMessageKey = text => normalized(text);
/**
 * Deterministic safety only: an exact (normalized) repeat of a recently
 * delivered message. Content quality is judged by JEV `message.check`, never
 * by host regex rules. recent: [{ text }] delivered in the last 24h.
 */
export function proactiveMessageViolations(text, { recent = [] } = {}) {
  const key = normalized(text);
  if (key.length < 2) return [];
  return (Array.isArray(recent) ? recent : []).some(row => typeof row?.text === 'string' && normalized(row.text) === key) ? [{ code: 'near_duplicate', repair: REPAIR.near_duplicate }] : [];
}
export const describeViolations = violations => violations.map(row => `${row.code}: ${row.repair}`).join(' ');

/** A one-line durable handoff: done, left, where, next concrete step. */
export const HANDOFF_MAX = 400;
export const oneLine = (value, limit = HANDOFF_MAX) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const HANDOFF_LINE = /^[ \t>*_-]*(?:FINAL|HANDOFF|交接)[ \t*_]*[:：][ \t]*(.+)$/gim;
/** Extracts the worker's explicit last handoff line, or null. */
export function extractHandoff(text) {
  const matches = [...String(text ?? '').matchAll(HANDOFF_LINE)];
  const line = matches.at(-1)?.[1]?.replace(/^["'“]+|["'”]+$/g, '');
  return line && line.trim() ? oneLine(line) : null;
}
/**
 * The follow-up a run declares about itself: one line `FOLLOW-UP: none` (nothing needs a later check) or
 * `FOLLOW-UP: <one concrete task>` (a bounded check to run next). The host reads it like the handoff line: it is the agent's own
 * statement, not text the host interprets, and anything that is neither is no declaration (the host then reviews the run as
 * before). A task over FOLLOW_UP_MAX characters, or under 8, is not a task.
 */
export const FOLLOW_UP_MAX = 600;
const FOLLOW_UP_LINE = /^[ \t>*_-]*FOLLOW[ -]?UP[ \t*_]*[:：][ \t]*(.+)$/gim;
export function extractFollowUp(text) {
  const raw = [...String(text ?? '').matchAll(FOLLOW_UP_LINE)].at(-1)?.[1]?.replace(/^["'“*_\s]+|["'”*_\s]+$/g, '').replace(/\s+/g, ' ');
  if (!raw) return null;
  if (/^none\.?$/i.test(raw)) return { kind: 'none' };
  return raw.length >= 8 && raw.length <= FOLLOW_UP_MAX ? { kind: 'task', task: raw } : null;
}
/** The worker's final response without its host-protocol lines (the handoff line and any follow-up declaration: the lines the
 * host asked for and reads itself); the rest is delivered as written. */
export function stripHandoff(text) {
  const value = String(text ?? ''), matches = [...value.matchAll(HANDOFF_LINE)], last = matches.at(-1);
  const body = last ? value.slice(0, last.index) + value.slice(last.index + last[0].length) : value;
  return body.replace(FOLLOW_UP_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
}
