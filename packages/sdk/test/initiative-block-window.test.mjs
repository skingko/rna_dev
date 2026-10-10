import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, blockWindow } from '../src/initiative.mjs';

// Headlong `context --tail-block` (design/wake_prompt_delivery.md): a count-capped window whose start moves only every
// `block` rows, so consecutive requests keep their bytes up to the newest row between moves.
const rows = count => Array.from({ length: count }, (_, index) => index);

test('blockWindow moves the window start in blocks: Headlong\'s own case (tail 20, block 10) and the plain tail', () => {
  // tests/test_context.sh "tail-block/window-start-moves-in-blocks": 93 -> row 70 / 23 rows, 95 -> row 70 / 25, 100 -> row 80 / 20.
  for (const [count, first, length] of [[93, 70, 23], [95, 70, 25], [100, 80, 20]]) {
    const window = blockWindow(rows(count), 20, 10);
    assert.deepEqual([window[0], window.length], [first, length], `${count} rows`);
  }
  assert.deepEqual(blockWindow(rows(93), 20), rows(93).slice(-20), 'block 1 is a plain tail');
  assert.deepEqual(blockWindow(rows(3), 20, 10), rows(3), 'fewer rows than the window: all of them');
  for (const bad of [0, -2, 1.5, Number.NaN]) assert.deepEqual(blockWindow(rows(30), 20, bad), rows(30).slice(-20), `block ${bad} is a plain tail`);
});

const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
const wait = { action: 'wait', reason: 'Nothing new', evidenceIds: [], content: '', nextReviewAfterMs: 60000 };
const event = n => ({ id: `outside:${n}`, type: 'workspace_change', summary: `File ${n} changed.`, at: Date.parse('2026-10-04T08:00:00Z') + n });
async function wakes(policy) {
  const texts = [];
  const coordinator = new InitiativeCoordinator({ project: { id: 'p' }, model, policy, provider: async function* (options) { texts.push(options.messages[0].content[0].text); yield { type: 'text_delta', delta: JSON.stringify(wait) }; yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'stop' }; } });
  const held = [];
  for (let n = 1; n <= 8; n++) { await coordinator.observe(event(n)); await coordinator.tick(); held.push(coordinator.snapshot().events.map(row => row.id.split(':')[1]).join(',')); }
  await coordinator.close();
  return { texts, held };
}

test('eventBlock: the evidence window only appends between its moves, so each wake keeps the previous request through its events and every handle', async () => {
  const { texts, held } = await wakes({ maxEvents: 4, eventBlock: 3 });
  // Holds 4 to 6 events; the seventh drops the oldest three at once.
  assert.deepEqual(held, ['1', '1,2', '1,2,3', '1,2,3,4', '1,2,3,4,5', '1,2,3,4,5,6', '4,5,6,7', '4,5,6,7,8']);
  const throughEvents = text => text.slice(0, text.indexOf('],"allowedEvidenceIds"'));
  for (const [index, text] of texts.entries()) {
    if (index === 0) continue;
    const moved = index === 6;
    assert.equal(text.startsWith(throughEvents(texts[index - 1])), !moved, `wake ${index + 1} ${moved ? 'moves' : 'keeps'} the window`);
  }
  // A plain tail (the default) drops one event per wake once full: every handle moves on every wake.
  const plain = await wakes({ maxEvents: 4 });
  assert.deepEqual(plain.held.slice(-2), ['4,5,6,7', '5,6,7,8']);
  assert.equal(plain.texts[5].startsWith(throughEvents(plain.texts[4])), false);
});
