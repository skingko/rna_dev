// D4 data-loading gates for the index and the bootstrap (plan A7, align §1.3 H: denylist rows of 64–212 KB, a
// `nextAt = now` that changes the index while nothing happened, a streamed turn that reloads the bootstrap at every
// display tick; fixed by A5). One live-shaped world (fixtures.mjs: 2,000 entries, 60 outbox rows, 12 rhythm history
// rows), a browser tab that follows web/src/store/sync.ts, the scenario clock for idle time. Gates that fail today
// because A5 has not landed carry `todo: 'A5'`; the main session removes the marks when A5 merges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { fillLiveShaped } from '../harness/fixtures.mjs';
import { medianOf, budgetMs } from '../harness/budget.mjs';

const KB = 1024;
/** zcode sessions-index.ts:29-56 / harness list.ts:107-118: a list row is a few scalars, counts and a short preview. */
const ROW_BYTES = 16 * KB;
/** A5 acceptance: the whole bootstrap of the live-shaped state. */
const BOOTSTRAP_BYTES = 150 * KB;
/**
 * Expected times on the reference machine (this Mac under the suite's load, 2026-10-05, the live-shaped state below):
 * GET /api/v2/bootstrap 4–6 ms warm (252 KB today), one diffIndex after a one-field change 2.6–3.7 ms. Budgets scale
 * them by budgetMs (load × headroom).
 */
const BOOTSTRAP_EXPECTED_MS = 6, DIFF_INDEX_EXPECTED_MS = 4;
const BOOTSTRAP_BUDGET_MS = budgetMs(BOOTSTRAP_EXPECTED_MS), DIFF_INDEX_BUDGET_MS = budgetMs(DIFF_INDEX_EXPECTED_MS);

const rowSize = row => Buffer.byteLength(JSON.stringify(row));
const heaviest = row => Object.entries(row).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value) ?? '')]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, bytes]) => `${key} ${Math.round(bytes / KB)} KB`).join(', ');

test('index and bootstrap gates on a live-shaped state (A5 gates, performance budgets)', async t => {
  const world = await createWorld(t);
  // Entries are kept small (the row gates do not depend on their size; each 16 KB of state is a shard file to write).
  fillLiveShaped(world, { items: 2000, itemBytes: 300, memoryContextBytes: 300 });
  const s = scenario(world);

  await t.test(`every index row is at most ${ROW_BYTES / KB} KB`, async () => {
    const { body } = await world.getJson('/api/v2/bootstrap');
    const over = [...body.projects.map(row => ['project', row]), ...body.sessions.map(row => ['session', row])].filter(([, row]) => rowSize(row) > ROW_BYTES);
    assert.deepEqual(over.map(([kind, row]) => `${kind} ${row.id}: ${Math.round(rowSize(row) / KB)} KB (${heaviest(row)})`), []);
  });

  await t.test(`the bootstrap of the live-shaped state is at most ${BOOTSTRAP_BYTES / KB} KB`, async () => {
    const { bytes } = await world.getJson('/api/v2/bootstrap');
    assert.ok(bytes <= BOOTSTRAP_BYTES, `bootstrap ${Math.round(bytes / KB)} KB`);
  });

  await t.test('30 s of idle with a connected index stream emits no index or resync event', async () => {
    const index = await world.sse('/api/v2/stream');
    await until(() => index.of('hello').length, 'hello');
    await new Promise(done => setTimeout(done, 300));
    const revision = world.store.state.revision;
    const step = await s.idle(30000);
    // Nothing happened: an event now could only come from a value derived from the clock.
    assert.equal(world.store.state.revision, revision, 'the host changed no state while idle (precondition)');
    const events = step.frames.filter(frame => ['index', 'resync'].includes(frame.event));
    assert.deepEqual(events.map(frame => `${frame.event} ${frame.event === 'index' ? (frame.data.projects ?? []).map(row => row.id).concat((frame.data.sessions ?? []).map(row => row.id)).join(',') : JSON.stringify(frame.data)}`).slice(0, 4), [], `${events.length} index/resync events while idle`);
    index.close();
  });

  await t.test('a streamed turn makes the open tab reload the bootstrap at most once', async () => {
    const step = await s.stream('Continue the chapter.', { reply: 'The next paragraph arrives in pieces. '.repeat(30), chunks: 20, chunkMs: 60 });
    assert.ok(step.frames.some(frame => frame.event === 'delta'), 'the reply streamed (precondition)');
    assert.ok(step.outcome.bootstrapGets <= 1, `${step.outcome.bootstrapGets} bootstrap reloads (${Math.round(step.outcome.gets.filter(row => row.kind === 'bootstrap').reduce((sum, row) => sum + row.bytes, 0) / KB)} KB) during one streamed turn`);
    step.outcome.tab.close();
  });

  await t.test(`bootstrap build: median of 5 ≤ ${BOOTSTRAP_BUDGET_MS} ms`, async () => {
    const { median, samples } = await medianOf(() => world.getJson('/api/v2/bootstrap'));
    assert.ok(median <= BOOTSTRAP_BUDGET_MS, `median ${median.toFixed(1)} ms; samples ${samples.join(', ')}`);
  });

  await t.test(`diffIndex after one change: median of 5 ≤ ${DIFF_INDEX_BUDGET_MS} ms`, async () => {
    const index = await world.sse('/api/v2/stream');
    await until(() => index.of('hello').length, 'hello');
    let change = 0;
    const { median, samples } = await medianOf(() => world.app.apiV2.hub.diffIndex(), { before: () => world.store.mutate(state => { state.sessions.find(row => row.id === world.sessionId).title = `Chapter draft ${change++}`; }) });
    assert.ok(median <= DIFF_INDEX_BUDGET_MS, `median ${median.toFixed(2)} ms; samples ${samples.join(', ')}`);
    index.close();
  });
});

// The same rule at the moment a schedule comes due, with nothing else going on (the initiative is off, so no work
// changes state): the project row must not change on its own. rhythmStatus.schedule.dueCount, computed from the clock,
// flipped 0 → 1 at the due instant (seen as a race in idle-schedule-due.test.mjs); the row now carries the anchors only.
test('a schedule coming due changes no index row by itself (A5 gate)', async t => {
  const world = await createWorld(t, { jev: false, start: '2026-10-05T01:00:00.000Z' });
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'due-gate', title: 'Daily check', task: 'Check the notes.', rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201);
  const index = await world.sse('/api/v2/stream');
  await until(() => index.of('hello').length, 'hello');
  await new Promise(done => setTimeout(done, 300));
  await t.test('two idle hours across the due time emit no index or resync event', async () => {
    const revision = world.store.state.revision, mark = index.frames.length;
    await world.idle(2 * 3600000, { stepMs: 10 * 60000 });
    assert.equal(world.store.state.revision, revision, 'the host changed no state (precondition)');
    const events = index.frames.slice(mark).filter(frame => ['index', 'resync'].includes(frame.event));
    assert.deepEqual(events.map(frame => `${frame.event} ${JSON.stringify(frame.data.projects?.[0]?.rhythmStatus?.schedule ?? frame.data).slice(0, 160)}`), []);
  });
});
