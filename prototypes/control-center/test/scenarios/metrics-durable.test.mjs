// D4 scenario (plan B7): metrics persist outside the hot state, and a "7 days" view covers seven days. Crosses a real
// conversation turn (the metered provider into the usage ledger; the JEV judgments it asks for into the decision
// service), the initiative's wake history in state (folded into the wake rollup on commit), the usage ledger's
// retention (rows folded into the daily rollup before they leave) and the report routes, on the scenario clock. Only the
// model, JEV and OpenViking are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createWorld } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { decisionLedgerFile } from '../../decision-ledger.mjs';
import { rollupFile } from '../../host-metrics.mjs';

const DAY = 86400000, HOUR = 3600000;

test('a week of metrics: judgments in the ledger file, wakes and usage in daily rollups, 7-day and 30-day views that cover their days', async t => {
  // No background controller: the wakes below are written into the pacing history the way it records them (one per
  // commit, newest last, the last 50 kept), so the week is exactly known.
  const world = await createWorld(t, { initiative: false, start: '2026-10-05T01:00:00.000Z' });
  const s = scenario(world);
  const ledgerRows = () => existsSync(decisionLedgerFile(world.stateFile)) ? readFileSync(decisionLedgerFile(world.stateFile), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(line => line.t === 'row').map(line => line.row) : [];

  await t.test('a conversation turn: its judgments go to the ledger file, never into the persisted state', async () => {
    const turn = await s.send('Summarize the README.', { reply: 'The README names the scenario project.' });
    await turn.expect({
      judgments: calls => assert.ok(calls.length >= 1, 'the turn asked JEV'),
      state: state => {
        assert.deepEqual(state.decisionKernelRuntime?.recent ?? [], [], 'no judgment row in state');
        assert.equal(state.decisionKernelRuntime?.index, undefined); assert.equal(state.decisionKernelRuntime?.labels, undefined);
      },
      sidecars: (suffixes, w) => { assert.ok(w.sidecarEntries('.rna').includes('metrics'), 'inside the journal root'); assert.deepEqual(w.unknownSidecars(), []); },
    });
    assert.ok(ledgerRows().length >= 1, 'the judgments are in <state>.rna/metrics/decision-ledger.jsonl');
    const page = await world.get('/api/v2/decision-kernel/ledger?limit=200');
    const onDisk = new Set(ledgerRows().map(row => row.id));
    assert.equal(page.status, 200); assert.ok(page.body.rows.length >= 1); assert.ok(page.body.rows.every(row => onDisk.has(row.id)), 'the route reads the ledger file\'s rows');
  });

  await t.test('a week of wakes: the 7-day report counts all of them, not the 50 the history keeps', async () => {
    const now = world.clock.now(), earlier = Array.from({ length: 70 }, (_, index) => ({ at: new Date(now - (140 - index * 2) * HOUR).toISOString(), outcome: index % 4 ? 'thought' : 'work', floor: false }));
    // As the pacing records them, one wake per commit, keeping the last 50.
    const step = await s.step('seventy wakes over six days', async () => {
      for (const row of earlier) world.store.mutate(state => { const mind = state.projects.find(value => value.id === world.projectId).mind ??= {}, pacing = mind.pacing ??= {}, wake = pacing.wake ??= {}; wake.history = [...(wake.history ?? []), row].slice(-50); });
      return { wakes: earlier.length };
    });
    await step.expect({ state: state => assert.equal(state.projects.find(value => value.id === world.projectId).mind.pacing.wake.history.length, 50) });
    const report = await world.get('/api/v2/experience?days=7');
    assert.equal(report.status, 200);
    const wakes = report.body.projects.find(row => row.projectId === world.projectId).wakes;
    assert.ok(wakes.total >= 70, `${wakes.total} wakes in the 7-day report`);
    assert.equal(report.body.days, 7);
  });

  await t.test('eight days later: the first turn\'s usage left the 7-day ledger for the rollup; the 30-day report still counts it', async () => {
    const before = (await world.get('/api/v2/usage/cache?window=24h')).body.byPurpose.foreground?.requests ?? 0;
    assert.ok(before >= 1);
    await s.advanceClock(8 * DAY + 2 * HOUR, { label: 'eight days pass' });
    await s.send('And now?', { reply: 'Still the scenario project.' });
    const week = (await world.get('/api/v2/usage/cache?window=7d')).body, month = (await world.get('/api/v2/usage/cache?window=30d')).body;
    assert.equal(month.byPurpose.foreground.requests, week.byPurpose.foreground.requests + before, 'the old turn is in the 30-day view only');
    assert.equal(month.rollup?.firstDay, '2026-10-05', 'the first day is served from the rollup');
    // Shutdown writes the rollups (a rollup file is also written before the ledger file drops a row).
    await world.app.close();
    assert.ok(existsSync(rollupFile(world.stateFile, 'usage'))); assert.ok(existsSync(rollupFile(world.stateFile, 'wakes')));
    assert.ok(JSON.parse(readFileSync(rollupFile(world.stateFile, 'wakes'), 'utf8')).days['2026-09-29'], 'the oldest of the week\'s wakes is in the rollup');
  });
});
