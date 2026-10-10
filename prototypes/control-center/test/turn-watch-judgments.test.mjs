import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TurnWatcher, DRIFT_EVERY } from '../turn-watch.mjs';

// In-turn judgments (turn.drift, turn.rewind) are kept on the turn so the next user message can label them.
test('the drift judgment made inside a turn is recorded on the turn with its ledger id and verdict', async () => {
  const recorded = [];
  const decisions = { turnDrift: async () => ({ drifting: false, ledgerId: 'd1' }), turnRewind: async () => ({ deadEnd: false, ledgerId: 'r1' }) };
  const watcher = new TurnWatcher({ decisions, getProject: () => ({ id: 'p' }), workspace: '/nowhere', request: '写第一章', record: entry => recorded.push(entry) });
  for (let index = 0; index < DRIFT_EVERY; index++) { watcher.onStart({ toolCallId: `c${index}`, toolName: 'project_read', args: { path: 'a.md' } }); watcher.onEnd({ toolCallId: `c${index}`, toolName: 'project_read', result: 'ok' }); }
  await delay(20);
  assert.deepEqual(watcher.judgments, [{ point: 'turn.drift', ledgerId: 'd1', drifting: false }]);
  assert.deepEqual(recorded, watcher.judgments);
  assert.deepEqual(watcher.drain(), [], 'on track: nothing to tell the model');
  // A recorder that throws never breaks the turn.
  const fragile = new TurnWatcher({ decisions, getProject: () => ({ id: 'p' }), workspace: '/nowhere', request: 'x', record: () => { throw new Error('disk'); } });
  fragile.recordJudgment({ point: 'turn.drift', ledgerId: 'd2', drifting: true }); assert.equal(fragile.judgments.length, 1);
});
