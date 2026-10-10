// Design invariant I1 (docs/planning/p1-specs-20261004/claude.md §3): two consecutive Anthropic request bodies of one
// session, with `cache_control` stripped, differ only by appended content, unless a thinking rebase was journaled
// between them.
import assert from 'node:assert/strict';

export const stripCacheControl = value => Array.isArray(value) ? value.map(stripCacheControl) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, stripCacheControl(item)])) : value;
const isThinking = block => block?.type === 'thinking' || block?.type === 'redacted_thinking';
export const thinkingBlocks = messages => messages.flatMap(message => message.role === 'assistant' ? message.content.filter(isThinking) : []);

/**
 * `prevResponse`: the content blocks the previous request returned (it must reappear verbatim as the next assistant
 * message, unless that request failed). `rebase`: a rebase was journaled between the two requests — 'tail' when it
 * reaches the previous request's last message, 'response' when it also covers the previous response; then only the
 * floor is checked: no thinking remains in the covered messages.
 */
export function assertAppendOnly(prevBody, curBody, { prevResponse, rebase } = {}) {
  const prev = stripCacheControl(prevBody), cur = stripCacheControl(curBody), k = prev.messages.length;
  if (rebase) {
    const covered = cur.messages.slice(0, rebase === 'response' ? k + 1 : k);
    assert.deepEqual(thinkingBlocks(covered), [], 'no thinking remains at or before the floor');
    return;
  }
  assert.deepEqual(cur.system, prev.system, 'top-level system is byte-identical');
  assert.deepEqual(cur.tools, prev.tools, 'tool set is byte-identical');
  assert.ok(cur.messages.length >= k, 'history only grows');
  for (let index = 0; index < k - 1; index++) assert.deepEqual(cur.messages[index], prev.messages[index], `messages[${index}] unchanged`);
  const last = prev.messages[k - 1], same = cur.messages[k - 1];
  assert.equal(same.role, last.role, 'the previous last message keeps its role');
  assert.deepEqual(same.content.slice(0, last.content.length), last.content, 'the previous last message only gains trailing blocks');
  if (prevResponse && same.content.length === last.content.length) {
    const next = cur.messages[k];
    assert.equal(next?.role, 'assistant', 'the previous response is the next assistant message');
    assert.deepEqual(next.content.slice(0, prevResponse.length), stripCacheControl(prevResponse), 'the previous response is replayed verbatim');
  }
}
