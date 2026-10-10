import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheSurvival, UsageLedger, aggregateCacheUsage, cacheSurvivalFile } from '../usage-cache-service.mjs';
import { excludedSibling } from '../state-checkpoint.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';

// Spec p1 compaction §A3: survival samples come from continuous requests after a gap of at least a minute (warm = at
// least half the previous prompt read from cache), persist inside the journal root, and can be backfilled
// once from the session journals.
const MIN = 60000, now = Date.parse('2026-10-04T12:00:00Z');
const row = (gapMin, cacheRead, { continuous = true, prompt = 100000, cacheReported = true, providerId = 'zhipu', modelId = 'glm-5.3' } = {}) => ({ at: new Date(now).toISOString(), providerId, modelId, cacheRead, cacheReported, continuity: { continuous, gapMs: gapMin * MIN, previousPromptTokens: prompt } });

test('observe keeps only informative samples; the estimate prefers a documented TTL the samples do not contradict', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-survival-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json.usage-cache.survival.json'), survival = new CacheSurvival({ file, now: () => now, debounceMs: 0 });
  for (const value of [row(0.5, 0), row(5, 0, { continuous: false }), row(5, 0, { cacheReported: false })]) assert.equal(survival.observe(value), false);
  for (const [gap, read] of [[2, 95000], [30, 99000], [107, 90000], [38, 0], [137, 0], [400, 0]]) assert.equal(survival.observe(row(gap, read)), true);
  assert.deepEqual(survival.estimate({ providerId: 'zhipu', modelId: 'glm-5.3', protocol: 'openai' }), { coldAfterMs: 137 * MIN, warmMaxMs: 107 * MIN, samples: 6, documentedTtlMs: null, source: 'learned' });
  // Anthropic documents 5 minutes: used while no warm sample outlived it; a longer warm sample defers to the learned value.
  survival.observe(row(3, 90000, { providerId: 'claude', modelId: 'opus' }));
  assert.deepEqual(survival.estimate({ providerId: 'claude', modelId: 'opus', protocol: 'anthropic' }), { coldAfterMs: 300000, warmMaxMs: 3 * MIN, samples: 1, documentedTtlMs: 300000, source: 'documented' });
  survival.observe(row(9, 90000, { providerId: 'claude', modelId: 'opus' }));
  assert.equal(survival.estimate({ providerId: 'claude', modelId: 'opus', protocol: 'anthropic' }).coldAfterMs, null, 'warm past the documented TTL and no cold sample above: no estimate');
  assert.equal(survival.estimate({ providerId: 'other', modelId: 'x', protocol: 'openai' }).coldAfterMs, null);
  // Persisted (mode 600) and reloaded.
  survival.close();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(new CacheSurvival({ file, now: () => now }).estimate({ providerId: 'zhipu', modelId: 'glm-5.3', protocol: 'openai' }).coldAfterMs, 137 * MIN);
  assert.equal(excludedSibling('.usage-cache.survival.json'), true); assert.equal(excludedSibling(`.usage-cache.survival.json.${process.pid}.tmp`), true);
  // The ledger feeds it, and the cache report lists it.
  const ledger = new UsageLedger({ now: () => now, survival });
  ledger.record({ purpose: 'foreground', sessionId: 's', providerId: 'zhipu', modelId: 'glm-5.3', usage: { input: 1, cacheRead: 99000, cacheWrite: 0, cacheUsageReported: true }, continuity: { continuous: true, gapMs: 20 * MIN, previousPromptTokens: 100000 } });
  assert.equal(survival.learned('zhipu|glm-5.3').samples, 7);
  assert.equal(aggregateCacheUsage(ledger.rows, { now, survival }).cacheSurvival['zhipu|glm-5.3'].coldAfterMs, 137 * MIN);
});

test('a one-time backfill reads continuous served requests from the session journals (rewinds respected), read-only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-survival-backfill-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'state.json'), model = { providerId: 'zhipu', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 200000, maxOutputTokens: 1000 };
  let clock = Date.parse('2026-10-01T00:00:00Z'), read = 0;
  const provider = async function* () { yield { type: 'text_delta', delta: 'ok' }; yield { type: 'usage', usage: { input: 1000, output: 10, cacheRead: read, cacheWrite: 0, totalTokens: 1010 + read, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' }; };
  const session = await createSession({ sessionId: 'session-a', projectId: 'p', cwd: dir, stateDir: `${stateFile}.rna/session-a`, model, provider, clock: () => clock });
  const gaps = [[0, 0], [10, 1000], [140, 0], [90, 1500], [300, 0]];
  for (const [gap, cacheRead] of gaps) { clock += gap * MIN; read = cacheRead; await session.prompt(`message after ${gap} minutes`); }
  const journal = session.snapshot().sessionFile;
  await session.dispose();
  const before = await readFile(journal);
  const survival = new CacheSurvival({ file: cacheSurvivalFile(stateFile), now: () => Date.parse('2026-10-04T00:00:00Z') });
  const result = await survival.backfill({ stateFile });
  assert.deepEqual(result, { journals: 1, samples: 4 });
  assert.deepEqual(survival.estimate(model), { coldAfterMs: 140 * MIN, warmMaxMs: 90 * MIN, samples: 4, documentedTtlMs: null, source: 'learned' });
  assert.deepEqual(await readFile(journal), before, 'the journal is untouched');
  assert.deepEqual(await survival.backfill({ stateFile }), { journals: 0, samples: 0, skipped: true }, 'once');
  const saved = JSON.parse(await readFile(cacheSurvivalFile(stateFile), 'utf8'));
  assert.equal(typeof saved.backfilledAt, 'string');
});
