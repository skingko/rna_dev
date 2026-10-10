import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeOutcome } from '../project-initiative-controller.mjs';
import { advanceWake } from '../proactive-pacing.mjs';
import { experienceReport } from '../experience-report.mjs';
import { proactiveMetrics } from '../proactive-metrics.mjs';

// spec p1 effort §3.6: a paid decision superseded by new evidence or a stop is recorded (with its own tokens) as
// `interrupted`, never moving the wake ladder; the wake row carries the effort it ran at.
test('a superseded paid decision is an interrupted wake; one superseded before it was sent records nothing', () => {
  assert.deepEqual(wakeOutcome({ status: 'stale', reason: 'new_evidence', usage: { totalTokens: 42000, estimatedTokens: 42000 } }), { outcome: 'interrupted', reason: 'new_evidence' });
  assert.equal(wakeOutcome({ status: 'stale', reason: 'new_evidence', usage: { totalTokens: 0 } }), null);
  assert.equal(wakeOutcome({ status: 'stale' }), null);
  assert.deepEqual(wakeOutcome({ status: 'decided', decision: { action: 'wait' } }), { outcome: 'thought' });
});

test('interrupted never moves the ladder, the next review, the quiet count or the last outcome', () => {
  const wake = { level: 2, ticksAtLevel: 1, quietWakes: 3, lastAt: '2026-10-04T10:00:00.000Z', nextAt: '2026-10-04T11:00:00.000Z', lastOutcome: 'thought', history: [] };
  const next = advanceWake(wake, 'interrupted', { now: Date.parse('2026-10-04T10:30:00Z'), tokens: 41000, latencyMs: 90000, reason: 'new_evidence', reasoning: { effective: 'max', source: 'fallback', shadow: { effort: 'low' } } });
  assert.deepEqual({ level: next.level, ticksAtLevel: next.ticksAtLevel, quietWakes: next.quietWakes, lastAt: next.lastAt, nextAt: next.nextAt, lastOutcome: next.lastOutcome }, { level: 2, ticksAtLevel: 1, quietWakes: 3, lastAt: wake.lastAt, nextAt: wake.nextAt, lastOutcome: 'thought' });
  assert.deepEqual(next.history, [{ at: '2026-10-04T10:30:00.000Z', outcome: 'interrupted', floor: false, reason: 'new_evidence', tokens: 41000, latencyMs: 90000, reasoning: { effective: 'max', source: 'fallback', shadow: 'low' } }]);
  const decided = advanceWake(wake, 'work', { now: Date.parse('2026-10-04T10:30:00Z'), tokens: 50000, reasoning: { effective: 'low', source: 'jev' } });
  // C2 (option C): an admitted decision is pending, not a reset; the ladder moves with the action's outcome.
  assert.equal(decided.level, 2); assert.equal(decided.history.at(-1).pending, true); assert.deepEqual(decided.history.at(-1).reasoning, { effective: 'low', source: 'jev' });
});

test('reports count interrupted wakes on their own, keep the failure rate over reviews that ended, and split by effort', () => {
  const now = Date.parse('2026-10-04T12:00:00Z'), at = minutes => new Date(now - minutes * 60000).toISOString();
  const history = [
    { at: at(50), outcome: 'work', tokens: 60000, reasoning: { effective: 'max', source: 'fallback' } },
    { at: at(40), outcome: 'failed', reason: 'invalid_decision', tokens: 50000, reasoning: { effective: 'low', source: 'jev' } },
    { at: at(30), outcome: 'interrupted', reason: 'new_evidence', tokens: 30000 },
    { at: at(20), outcome: 'thought', tokens: 20000, reasoning: { effective: 'low', source: 'rule' } },
  ];
  const project = { id: 'p', name: 'Novel', mind: { pacing: { wake: { history } } }, initiativeRuntime: {}, inbox: [] };
  const report = experienceReport({ projects: [project], sessions: [], decisionKernelRuntime: { recent: [] } }, { now, days: 1 });
  const wakes = report.projects[0].wakes;
  assert.equal(wakes.interrupted, 1); assert.equal(wakes.quiet, 0, 'an interrupted wake is not a quiet one');
  assert.equal(wakes.failureRate, 0.333, 'failed over the three reviews that ended');
  assert.deepEqual(wakes.byReasoning, { max: { wakes: 1, failed: 0, tokens: 60000, interrupted: 0, interruptedTokens: 0 }, low: { wakes: 2, failed: 1, tokens: 70000, interrupted: 0, interruptedTokens: 0 } });
  const metrics = proactiveMetrics(project, [], { now, windowMs: 86400000 });
  assert.equal(metrics.wakes.byOutcome.interrupted, 1); assert.equal(metrics.wakes.invalidRate, Math.round(1 / 3 * 1000) / 1000);
});
