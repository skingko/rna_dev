import { isTurnStart, prefixEstimates } from './context.mjs';

// Break-even of an edit to a warm prefix cache (plan C5; replaces the fixed SETTLE_SHARE = 0.25).
//
// Editing history that sits before the end of the cached prefix (settling a written file, pruning or forgetting a tool
// result) breaks the provider's prefix cache from the first edited message on: the next request pays the uncached rate
// (the cache-write rate on a provider that bills writes) for everything after it, instead of the cache-read rate. The
// edit pays for itself only when the tokens it removes are read, at the read rate, by enough later requests.
//
// Per token, relative to any one unit (only ratios matter): `r` = cache read, `w` = cache write (the uncached input rate
// when the provider has no separate write price). With `C` tokens in context, `f` of them removed, and `N` requests that
// will read the shrunk context while the cache it starts is warm:
//   without the edit:  N · C · r
//   with the edit:     (C − f) · w  +  (N − 1) · (C − f) · r     (the first request re-reads everything after the edit
//                                                                 at the write rate; the edit is assumed to sit at the
//                                                                 start of the edited range, the worst case)
// The edit wins when  f / C  >  (w − r) / (w + (N − 1) · r).  That right-hand side is the share.
//
// `N` is the session's own: the median number of requests per completed user turn (assistant messages between two
// turn starts), over the turns after the last compaction boundary (all turns before one). The decision sits at the
// first request of a run, so the run still to come is what the saving is counted over; later runs would add to it while
// the cache stays warm, which makes the share an upper bound (the safe side). A session with no completed turn counts
// one request: the share is then 1 − r/w, which rules a warm edit out unless the cache is nearly free to re-read.
//
// A model whose prices the host does not know has no break-even: the warm cache is left alone (cold-break and
// context-pressure economies are unchanged). Nothing here guesses a price.

/** A usable price entry: positive uncached input and a non-negative cache-read rate (the write rate is optional). */
export function validCachePrices(prices) {
  return Boolean(prices) && typeof prices === 'object' && Number.isFinite(prices.input) && prices.input > 0 && Number.isFinite(prices.cacheRead) && prices.cacheRead >= 0
    && (prices.cacheWrite === undefined || prices.cacheWrite === null || Number.isFinite(prices.cacheWrite) && prices.cacheWrite > 0);
}

/** Cache read and write rates as multiples of the uncached input rate (write = the input rate when no write price exists). */
export function cachePriceShares(prices) {
  if (!validCachePrices(prices)) return null;
  return { read: prices.cacheRead / prices.input, write: (prices.cacheWrite ?? prices.input) / prices.input };
}

/**
 * The share of the context an edit must free to repay the cache it breaks, over `requests` reads of the saving:
 * `(w − r) / (w + (requests − 1) · r)`, 0 when the cache is no cheaper to read than to write (any saving pays).
 * Null without a usable price.
 */
export function settleBreakEven({ prices, requests = 1 } = {}) {
  const shares = cachePriceShares(prices);
  if (!shares) return null;
  const n = Number.isFinite(requests) && requests >= 1 ? requests : 1, extra = shares.write - shares.read;
  if (extra <= 0) return { share: 0, ...shares, requests: n };
  return { share: Math.min(1, extra / (shares.write + (n - 1) * shares.read)), ...shares, requests: n };
}

const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };

/**
 * Requests per run of this conversation: the median count of assistant messages between two user turn starts, over the
 * turns that have an answer. Turns after `compaction`'s boundary when there are any (the shape of the present work),
 * else every turn. 1 when no turn has an answer yet.
 */
export function requestsPerRun(messages = [], compaction = null) {
  const counts = []; let current = null, start = 0;
  messages.forEach((message, index) => {
    if (isTurnStart(message)) { if (current !== null) counts.push({ start, answers: current }); current = 0; start = index; }
    else if (current !== null && message.role === 'assistant') current++;
  });
  if (current !== null) counts.push({ start, answers: current });
  const boundary = compaction ? messages.findIndex(message => message.id === compaction.throughMessageId) : -1;
  const answered = counts.filter(row => row.answers > 0), recent = answered.filter(row => row.start > boundary);
  const used = recent.length ? recent : answered;
  return used.length ? Math.max(1, median(used.map(row => row.answers))) : 1;
}

/**
 * Context growth per run of this conversation, in the byte-estimate tokens context() counts before a receipt scales
 * them: the median, over the answered turns (the same turns as `requestsPerRun`), of what a user turn and everything
 * that followed it added to the messages. It is measured on the journal as written: a later settle or prune only makes
 * a turn leave less, so this is an upper bound of what one more run leaves. 0 when no turn has an answer yet.
 *
 * The deferred compaction (session.mjs compactAutomatically) asks it for the margin economies must leave under the
 * trigger before they stand in for a summary: a saving that merely dips under it is crossed again by the next run, which
 * pays a second break; that depends on how fast this conversation grows, not on what a cache read costs.
 */
export function growthPerRun(messages = [], compaction = null) {
  const sizes = prefixEstimates(messages), turns = []; let current = null;
  messages.forEach((message, index) => {
    if (isTurnStart(message)) { if (current) turns.push(current); current = { start: index, end: messages.length, answered: false }; }
    else if (current && message.role === 'assistant') current.answered = true;
    if (current && isTurnStart(messages[index + 1])) current.end = index + 1;
  });
  if (current) turns.push(current);
  const boundary = compaction ? messages.findIndex(message => message.id === compaction.throughMessageId) : -1;
  const answered = turns.filter(turn => turn.answered), recent = answered.filter(turn => turn.start > boundary), used = recent.length ? recent : answered;
  return used.length ? Math.max(0, Math.round(median(used.map(turn => sizes[turn.end] - sizes[turn.start])))) : 0;
}
