import test from 'node:test';
import assert from 'node:assert/strict';
import { engagementOf, pacingThreshold, pacingSignals, BASE_THRESHOLD } from '../proactive-pacing.mjs';

// A project whose last proactive messages all went unanswered raises its bar before three reactions exist (plan M8.3).
test('an ignored streak raises the value bar until the user reacts again', () => {
  const now = Date.parse('2026-09-30T12:00:00Z'), ago = h => new Date(now - h * 3600000).toISOString();
  const inbox = outcomes => outcomes.map((outcome, index) => ({ id: `m${index}`, createdAt: ago(10 - index), tier: 'inline', feedback: { outcome } }));
  const two = engagementOf({ inbox: inbox(['ignored', 'ignored']) }, [], { now });
  assert.equal(two.ignoredStreak, 2); assert.equal(two.settled, 2);
  const factors = signals => Object.fromEntries(pacingThreshold(signals).factors.map(row => [row.name, row.delta]));
  const base = { unrepliedChain: 0, engagement: two, replyLatencyMs: null, conversationLive: false, sinceUnrepliedMs: null, pendingCommitments: 0, openAgenda: 0, overdueCommitments: 0, awaitingExternal: false, evidenceVelocity: 0, recentSentValue: null, heldValuable: 0, quietWakes: 0 };
  assert.equal(factors(base).ignored_streak, .08);
  const three = engagementOf({ inbox: inbox(['ignored', 'ignored', 'ignored']) }, [], { now });
  assert.equal(three.ignoredStreak, 3); assert.equal(factors({ ...base, engagement: three }).ignored_streak, .15);
  assert.equal(pacingThreshold({ ...base, engagement: three }).threshold, Math.round((BASE_THRESHOLD + .15 + .1) * 1000) / 1000, 'three reactions also enable the low-engagement factor');
  // A reply ends the streak even when older messages were ignored.
  const replied = engagementOf({ inbox: inbox(['ignored', 'ignored', 'replied']) }, [], { now });
  assert.equal(replied.ignoredStreak, 0); assert.equal(factors({ ...base, engagement: replied }).ignored_streak, undefined);
  // Through the full signal computation as well.
  const signals = pacingSignals({ inbox: inbox(['ignored', 'ignored', 'ignored']), mind: {} }, [], { now });
  assert.equal(signals.engagement.ignoredStreak, 3);
});
