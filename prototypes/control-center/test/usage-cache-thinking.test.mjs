import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageLedger, meteredProvider, thinkingDropCounts, usageRecord } from '../usage-cache-service.mjs';
import { runtimeFailureMessage } from '../runtime-errors.mjs';
import { providerPresets } from '../provider-presets.mjs';
import { ProviderError } from '../../../packages/sdk/src/providers.mjs';

const model = { providerId: 'claude', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' };

test('ledger rows carry preserved-thinking drops and recoveries only when they happened', async () => {
  assert.equal(thinkingDropCounts([]), undefined);
  assert.deepEqual(thinkingDropCounts([{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch' }, { type: 'thinking_dropped', reason: 'model_binding_mismatch' }, { type: 'thinking_dropped', reason: 'model_binding_mismatch' }, { type: 'thinking_mismatch_allowed', reason: 'prefix_binding_mismatch' }, { type: 'future_type', reason: 'x' }]), { prefix: 1, model: 2, allowed: 1 });
  const plain = usageRecord({ purpose: 'foreground', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  assert.equal('thinkingDropped' in plain, false); assert.equal('thinkingRecovery' in plain, false); assert.equal('keepAlive' in plain, false);
  assert.deepEqual(usageRecord({ purpose: 'foreground', thinkingDropped: { prefix: 0, model: 3, organization: -1 }, thinkingRecovery: 'drop_block' }).thinkingDropped, { model: 3 });
  assert.equal(usageRecord({ purpose: 'foreground', thinkingRecovery: 'something' }).thinkingRecovery, undefined);

  const ledger = new UsageLedger();
  const events = [[{ type: 'input_transformations', items: [] }, { type: 'thinking_rebase', reason: 'binding_rejected', recovery: 'strip' }, { type: 'usage', usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cacheUsageReported: true } }, { type: 'done', stopReason: 'stop' }],
    [{ type: 'thinking_recovery', recovery: 'drop_block' }, { type: 'input_transformations', items: [{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch' }] }, { type: 'usage', usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cacheUsageReported: true } }, { type: 'done', stopReason: 'stop' }],
    [{ type: 'input_transformations', items: [] }, { type: 'usage', usage: { input: 5, output: 2, cacheRead: 9, cacheWrite: 0, cacheUsageReported: true } }, { type: 'done', stopReason: 'stop' }]];
  for (const list of events) {
    const provider = meteredProvider(async function* () { yield* list; }, { ledger, purpose: 'foreground', projectId: 'p', sessionId: 's' });
    await Array.fromAsync(provider({ model, cache: { retention: 'short' } }));
  }
  const rows = ledger.records();
  assert.deepEqual(rows.map(row => [row.thinkingRecovery, row.thinkingDropped]), [['strip', undefined], ['drop_block', { prefix: 1 }], [undefined, undefined]]);
});

test('refusals are worded by the host in the interface language, without the provider text', () => {
  const error = new ProviderError('模型服务拒绝了这次请求', { code: 'provider_termination', providerFinishReason: 'refusal', category: 'refusal', refusalCategory: 'cyber' });
  assert.match(runtimeFailureMessage(error, 'zh'), /安全审查拒绝/);
  assert.match(runtimeFailureMessage(error, 'en'), /safety review declined/);
  assert.equal(error.errorDiagnostic.refusalCategory, 'cyber');
});

test('Claude presets: Opus 5.5 answers with a 64K allowance; adaptive models mark their default usable', () => {
  const anthropic = providerPresets().find(row => row.id === 'anthropic'), opus = anthropic.models.find(row => row.id === 'claude-opus-5-5');
  assert.equal(opus.maxOutputTokens, 64000); assert.equal(opus.modelMaxOutputTokens, 128000);
  assert.equal(opus.reasoningCapability.defaultAdaptive, true); assert.equal(opus.reasoningCapability.providerDefault, 'medium');
  const sonnet = anthropic.models.find(row => row.id === 'claude-sonnet-5');
  assert.equal(sonnet.reasoningCapability.defaultAdaptive, true);
  assert.equal(anthropic.models.find(row => row.id === 'claude-haiku-4-5-20251001').reasoningCapability.defaultAdaptive, undefined, 'budget thinking is not adaptive');
  for (const preset of providerPresets()) if (preset.id !== 'anthropic') for (const row of preset.models) assert.equal(row.reasoningCapability.defaultAdaptive, undefined, `${row.id} unchanged`);
});
