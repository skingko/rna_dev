import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionState } from '../src/decision-state.mjs';

// mind.judge reconciliation state: each open item shows up to three host-selected passages as `[role · age] text`.
// The text is cut to the 420-character passage budget and the label goes on after that, so a full window is shown to its last character.
const now = Date.parse('2026-10-02T00:00:00Z'), at = '2026-10-01T20:00:00Z';
const passagesOf = passages => buildDecisionState('mind.judge', { items: [{ kind: 'todo', text: 'Write the changelog', createdAt: at, passages }] }, { now }).mind.items[0].passages;

test('a full 420-character window is shown whole after its label; the label is not part of the text budget', () => {
  const text = `${'a'.repeat(419)}Z`, [shown] = passagesOf([{ role: 'delivered', at, text }]);
  assert.match(shown, /^\[delivered · [^\]]+\] a{419}Z$/, 'the last character of the window survives');
  assert.ok(shown.endsWith(text));
});

test('text over the budget is cut to 420 characters including the ellipsis, then labelled; whitespace collapsed; at most three passages', () => {
  const [shown] = passagesOf([{ role: 'user', at, text: `${'b'.repeat(500)}` }]);
  assert.match(shown, /^\[user · [^\]]+\] b{419}…$/);
  assert.match(passagesOf([{ role: 'user', at, text: 'x\n\n  y' }])[0], /\] x y$/);
  assert.match(passagesOf([{ at, text: 'no role' }])[0], /^\[message · /);
  assert.equal(passagesOf(Array.from({ length: 5 }, () => ({ role: 'user', at, text: 'p' }))).length, 3);
});
