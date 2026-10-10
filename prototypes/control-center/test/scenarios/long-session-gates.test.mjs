// D4 data-loading gates for a long conversation (plan A7, align §1.3 H "打开会话会整份加载" and "CLI 和桌面端仍读旧的
// 整状态端点", fixed by B9). A 10,000-entry conversation, opened the way the web opens it (a tail window) and watched the
// way `rna watch` watches it (the v2 stream), through the real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createWorld, until } from '../harness/world.mjs';
import { fillLiveShaped } from '../harness/fixtures.mjs';
import { countingProxy } from '../harness/clients.mjs';
import { medianOf, budgetMs } from '../harness/budget.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.mjs');
const KB = 1024;
/** Tail window: what opening a conversation may download (align-studies §2: harness ≥50 messages and ≥2 turns, zcode 60 rows). */
const TAIL_BYTES = 300 * KB;
/**
 * Tail open time: what opening a window of the tail's size costs. Expected: GET /api/v2/sessions/:id of a 300 KB
 * conversation (560 entries) on the reference machine (this Mac, other suites running), 2026-10-05: medians 3.6–4.4 ms,
 * samples 3.4–6.4 ms; 6 ms is the rounded expectation, scaled by budgetMs (load × headroom). Today the 10,000-entry
 * conversation opens whole: 5.4 MB, median 58 ms.
 */
const TAIL_OPEN_EXPECTED_MS = 6, TAIL_OPEN_BUDGET_MS = budgetMs(TAIL_OPEN_EXPECTED_MS);
const ENTRIES = 10000, LAST = `last-entry-${randomUUID()}`;

test('a 10,000-entry conversation opens as a tail and stays watchable (B9 gates)', async t => {
  const world = await createWorld(t, { jev: false });
  // ~200-byte entries keep the fixture to a few hundred shard files (each costs a write on this disk); the gates are
  // about how much is sent, which grows with the entry count.
  fillLiveShaped(world, { items: ENTRIES, itemBytes: 200, memoryContextBytes: 220, outbox: 0, lastText: LAST });
  const session = world.session();
  assert.equal(session.items.length, ENTRIES);

  await t.test('opening the conversation downloads a tail window of at most 300 KB that still ends at the newest entry', async st => {
    const opened = await world.getJson(`/api/v2/sessions/${world.sessionId}?window=tail`);
    assert.equal(opened.status, 200);
    const items = opened.body.items ?? [], turns = opened.body.turns ?? [];
    assert.equal(items.at(-1)?.text, LAST, 'the window ends at the newest entry');
    assert.ok(items.filter(item => ['user', 'assistant'].includes(item.kind)).length >= 50 || items.length === ENTRIES, 'at least 50 messages (harness history.ts:38)');
    assert.ok(new Set(items.map(item => item.turnId).filter(Boolean)).size >= 2 && turns.length >= 2, 'at least two turns with their records');
    st.diagnostic(`tail window: ${items.length} items, ${opened.bytes} B`);
    assert.ok(opened.bytes <= TAIL_BYTES, `opening downloaded ${Math.round(opened.bytes / KB)} KB (budget ${TAIL_BYTES / KB} KB)`);
  });

  await t.test(`opening the tail is fast: median of 5 ≤ ${TAIL_OPEN_BUDGET_MS} ms`, async st => {
    const { median, samples } = await medianOf(() => world.getJson(`/api/v2/sessions/${world.sessionId}?window=tail`));
    st.diagnostic(`tail open median ${median.toFixed(1)} ms; samples ${samples.join(', ')}`);
    assert.ok(median <= TAIL_OPEN_BUDGET_MS, `tail open median ${median.toFixed(1)} ms > ${TAIL_OPEN_BUDGET_MS} ms; samples ${samples.join(', ')}`);
  });

  await t.test('rna watch shows the conversation and then each new entry without re-downloading it', async st => {
    const proxy = await countingProxy(world.port);
    const child = spawn(process.execPath, [CLI, 'watch', world.sessionId], { env: { ...process.env, RNA_AGENT_PORT: String(proxy.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exited = null;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-200000); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => { exited = code; });
    t.after(async () => { child.kill('SIGKILL'); await proxy.close(); });
    const shows = text => until(() => { if (exited !== null) throw new Error(`rna watch exited (${exited}): ${stderr.trim().slice(0, 300)}`); return stdout.includes(text); }, `rna watch to show ${text.slice(0, 30)}`, 60000);
    await shows(LAST);
    const before = proxy.down(), appended = `appended-entry-${randomUUID()}`, started = performance.now();
    world.store.mutate(state => { state.sessions.find(row => row.id === world.sessionId).items.push({ id: `appended-${randomUUID()}`, kind: 'assistant', text: appended, createdAt: new Date().toISOString(), simulated: false }); });
    await shows(appended);
    const sent = proxy.down() - before;
    assert.equal(exited, null, 'rna watch keeps running');
    st.diagnostic(`rna watch: ${before} B to open, ${sent} B for one new entry`);
    assert.ok(sent <= TAIL_BYTES, `one new entry made the host send ${Math.round(sent / KB)} KB to rna watch in ${Math.round(performance.now() - started)} ms (budget ${TAIL_BYTES / KB} KB)`);
  });
});
