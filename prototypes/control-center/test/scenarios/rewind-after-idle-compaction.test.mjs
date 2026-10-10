// D4 scenario (plan A3, compaction review): two idle compactions, then the user edits the third-from-last message,
// which cuts the newer compaction's boundary. The conversation falls back to the older compaction whose boundary
// survives (pi buildContextEntries) instead of replaying the raw history: the next request carries the older summary,
// not the cut one and not the turns that summary stands for. Crosses the idle compaction service (plan, summary on the
// real provider path to the faux model's HTTP endpoint, sidecar, commit), the rewind route, the runtime's journal replay
// and the foreground turn. Model only is fake (no paid call).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { CacheSurvival } from '../../usage-cache-service.mjs';

const COLD_MS = 10 * 60000;
// About 6K estimated tokens per answer: three turns put a 64K window past the idle share (half), well under the
// in-turn triggers, so only the idle service compacts.
const chapter = index => `Chapter ${index}. ${'夜色里的灯一盏盏亮起来。'.repeat(500)}`;

test('editing the third-from-last message after two idle compactions falls back to the older summary', async t => {
  const world = await createWorld(t, { idleCompaction: true });
  const s = scenario(world);
  // The cold-gap estimate idle compaction waits for, learned as the host learns it (warm after a minute, cold after ten).
  const key = CacheSurvival.key(world.provider.id, 'faux-model'), at = Date.now();
  world.store.usageLedger.survival.add(key, { gapMs: 60000, warm: true, prompt: 20000, at });
  world.store.usageLedger.survival.add(key, { gapMs: COLD_MS, warm: false, prompt: 20000, at });
  assert.equal(world.store.usageLedger.survival.learned(key).coldAfterMs, COLD_MS);

  const idle = summary => s.step(`idle compaction (${summary.slice(0, 12)})`, async () => {
    const before = world.session().context?.lastCompactionId ?? null;
    world.faux.script('http', summary);
    world.clock.advance(COLD_MS + 60000); world.tick();
    return until(() => {
      const record = world.session().context?.idleCompaction;
      if (['failed', 'skipped', 'discarded'].includes(record?.status)) throw new Error(`idle compaction ${record.status}: ${record.code}`);
      return record?.status === 'committed' && world.session().context.lastCompactionId !== before ? record : null;
    }, 'the idle summary to commit', 30000).catch(error => {
      const session = world.session();
      throw Object.assign(error, { message: `${error.message}; turns ${session.turns.map(turn => turn.status).join(',')}; context ${JSON.stringify({ tokens: session.context?.usage?.estimatedInputTokens ?? session.context?.tokens, capacity: session.context?.usage?.capacity ?? session.context?.capacity, idle: session.context?.idleCompaction })}` });
    });
  });
  const userItem = text => world.session().items.find(item => item.kind === 'user' && item.text === text);

  for (let index = 1; index <= 3; index++) await s.send(`Write chapter ${index}.`, { reply: chapter(index) });
  const first = await idle('SUMMARY-ONE: chapter 1 was written.');
  await first.expect({ requests: rows => assert.match(rows.find(row => row.tag === 'http')?.wire ?? '', /Write chapter 1\./, 'the first summary covers chapter 1') });
  for (let index = 4; index <= 5; index++) await s.send(`Write chapter ${index}.`, { reply: chapter(index) });
  const second = await idle('SUMMARY-TWO: chapters 1 to 3 were written.');
  await second.expect({ requests: rows => {
    const wire = rows.find(row => row.tag === 'http')?.wire ?? '';
    assert.match(wire, /SUMMARY-ONE/); assert.match(wire, /Write chapter 3\./); assert.doesNotMatch(wire, /Write chapter 4\./);
  } });

  // The edit: the third-from-last user message. The newer summary's boundary (the end of chapter 3's turn) leaves with
  // it; the older one's (the end of chapter 1's turn) survives.
  await s.revert({ item: userItem('Write chapter 3.').id, reason: 'user_edit' });
  const edited = await s.send('Write chapter 3 again, shorter.', { reply: 'Chapter 3, shorter.' });
  await edited.expect({ requests: rows => {
    assert.deepEqual(rows.map(row => row.tag), ['foreground'], 'one request: no summary call, no other model call');
    const wire = rows[0].wire;
    assert.match(wire, /SUMMARY-ONE/, 'the older summary stands');
    assert.doesNotMatch(wire, /SUMMARY-TWO/, 'the cut summary is gone');
    assert.doesNotMatch(wire, /Write chapter 1\./, 'the turn the older summary stands for is not replayed');
    assert.match(wire, /Write chapter 2\.[\s\S]*Write chapter 3 again, shorter\./);
    assert.doesNotMatch(wire, /Write chapter [45]\./);
  } });
});
