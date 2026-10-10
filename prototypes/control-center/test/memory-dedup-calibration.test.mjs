import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTurnRoute } from '../decision-calibration-report.mjs';

// MIND-13 changed what a memory-seeking turn records: when every recalled passage was already attached, the turn
// attaches only a pointer (execution 'already_attached', no injected entries). The calibration label for needs_memory
// must still read "memory was needed", or chat.preflight / turn.route would learn that such turns need none.
test('the needs_memory label stays true for a turn whose recalled memory was already attached', () => {
  const state = memoryContext => ({ sessions: [{ id: 's', items: [], turns: [{ id: 't', status: 'completed', memoryContext }] }] });
  const row = { scope: { sessionId: 's', turnId: 't' }, predictions: { needs_memory: .9 } };
  const label = memoryContext => observeTurnRoute(state(memoryContext), row).needs_memory;
  assert.equal(label({ execution: 'already_attached', injectedEntries: [], deduplicated: 2, alreadyAttached: ['viking://a', 'viking://b'] }), true);
  assert.equal(label({ execution: 'retrieved', injectedEntries: [{ uri: 'viking://c' }], deduplicated: 1 }), true);
  for (const execution of ['empty', 'budget', 'not_required', 'unavailable']) assert.equal(label({ execution, injectedEntries: [] }), false, execution);
});
