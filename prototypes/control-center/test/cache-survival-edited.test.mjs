import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheSurvival, UsageLedger, usageRecord } from '../usage-cache-service.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';

// ECON-2: in a foreground conversation the first request after a long gap nearly always follows a fold or settle at
// the cold break, so it is never structurally continuous. The SDK reports the part of the previous prompt the edits
// left unchanged (`continuity.edited.comparableTokens`); the ledger keeps it and the survival estimate learns from it,
// live and in the one-time journal backfill, so long gaps keep producing samples.
const MIN = 60000, now = Date.parse('2026-10-04T12:00:00Z');

test('the ledger keeps the unchanged part of an edited request and the survival estimate samples it', () => {
  const continuity = { continuous: false, gapMs: 200 * MIN, previousPromptTokens: 100000, edited: { comparableTokens: 90000 } };
  assert.deepEqual(usageRecord({ at: now, purpose: 'foreground', usage: { cacheUsageReported: true }, continuity }).continuity, continuity);
  assert.equal(usageRecord({ at: now, purpose: 'foreground', continuity: { ...continuity, edited: { comparableTokens: 'x' } } }).continuity.edited, undefined, 'malformed: dropped');
  assert.equal(usageRecord({ at: now, purpose: 'foreground', continuity: { ...continuity, continuous: true } }).continuity.edited, undefined, 'only a discontinuous request carries it');
  const survival = new CacheSurvival({ now: () => now }), ledger = new UsageLedger({ now: () => now, survival });
  const record = (gapMin, cacheRead, comparableTokens) => ledger.record({ purpose: 'foreground', sessionId: 's', providerId: 'zhipu', modelId: 'glm-5.3', usage: { input: 1000, cacheRead, cacheWrite: 0, cacheUsageReported: true }, continuity: { continuous: false, gapMs: gapMin * MIN, previousPromptTokens: 100000, edited: { comparableTokens } } });
  record(2, 99000, 100000); record(150, 85000, 90000); record(400, 0, 95000);
  record(900, 0, 20000);
  assert.deepEqual(survival.estimate({ providerId: 'zhipu', modelId: 'glm-5.3', protocol: 'openai' }), { coldAfterMs: 400 * MIN, warmMaxMs: 150 * MIN, samples: 3, documentedTtlMs: null, source: 'learned' }, 'an edit near the start of the prompt (20% unchanged) is no sample');
});

test('the backfill rebuilds edited samples from the journal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-survival-edited-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'state.json'), model = { providerId: 'zhipu', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 1000000, maxOutputTokens: 1000 };
  let clock = Date.parse('2026-10-01T00:00:00Z'), read = 0, round = 0;
  const provider = async function* (request) { const prompt = Math.ceil(JSON.stringify(request.messages).length / 3); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'usage', usage: { input: prompt - Math.min(prompt, read), output: 10, cacheRead: Math.min(prompt, read), cacheWrite: 0, totalTokens: prompt + 10, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' }; };
  // Each warm turn leaves a turn-scoped note; the cold break (cache survival 137 minutes) folds them.
  const session = await createSession({ sessionId: 'session-a', projectId: 'p', cwd: dir, stateDir: `${stateFile}.rna/session-a`, model, provider, clock: () => clock, cacheSurvivalMs: 137 * MIN,
    beforeRequest: () => round > 1 ? { contextUpdates: [{ key: 'turn-route-hints', source: 'host-turn-routing', scope: 'turn', text: `hints ${round}` }] } : undefined });
  for (const [gap, cacheRead, text] of [[0, 0, `Background: ${'资料'.repeat(4000)}`], [2, 1e9, 'two'], [2, 1e9, 'three'], [200, 1e9, 'four'], [300, 0, 'five']]) { round++; clock += gap * MIN; read = cacheRead; await session.prompt(text); }
  const messages = session.snapshot().messages.filter(message => message.role === 'assistant');
  assert.equal(messages.filter(message => message.contextEdits).length, 2, 'both cold breaks folded the warm turns\' notes');
  await session.dispose();
  const survival = new CacheSurvival({ now: () => Date.parse('2026-10-04T00:00:00Z') });
  assert.deepEqual(await survival.backfill({ stateFile }), { journals: 1, samples: 4 });
  assert.deepEqual(survival.estimate(model), { coldAfterMs: 300 * MIN, warmMaxMs: 200 * MIN, samples: 4, documentedTtlMs: null, source: 'learned' }, 'the 200-minute gap was warm and the 300-minute one cold, though both were edited');
});
