import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeController } from '../runtime-controller.mjs';
import { SessionCommandService } from '../session-command-service.mjs';

// Review EFF-3: an in-turn summary's effort is planned on the effort the conversation sends now (the SDK's sideReasoning
// `model`), not on the turn row the run started from: a turn route (CAREFUL, JEV) may have moved it to max or xhigh.
const deepseek = { providerId: 'deepseek', modelId: 'deepseek-v4-pro', reasoningCapability: { control: 'effort', efforts: [{ id: 'high' }, { id: 'max' }], providerDefault: 'high', canDisable: true }, reasoningSelection: 'auto', reasoning: 'default' };
const codex = { providerId: 'codex', modelId: 'gpt-6-astra', reasoningCapability: { control: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id })), providerDefault: 'medium', canDisable: false }, reasoningSelection: 'auto', reasoning: 'default' };
const glm = { providerId: 'glm', modelId: 'glm-5.3', reasoningCapability: { control: 'effort', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], providerDefault: null, canDisable: false }, reasoningSelection: 'max', reasoning: 'max' };
const host = { decisions: null, store: { state: { configuration: {}, projects: [] } } };
const foreground = (model, input) => RuntimeController.prototype.summaryEffort.call(host, { items: [] }, { userItemId: 'u', modelConfig: model }, null, { estimatedInputTokens: 30000, automatic: true, ...input });

test('a foreground summary after a turn route to the deepest level goes back to the provider default where it is usable', async () => {
  assert.equal(await foreground(deepseek, { model: { reasoning: 'max', reasoningSelection: 'auto', reasoningCapability: deepseek.reasoningCapability } }), 'default', 'DeepSeek routed to max: the summary sends the default');
  assert.equal(await foreground(codex, { model: { reasoning: 'xhigh', reasoningSelection: 'auto', reasoningCapability: codex.reasoningCapability } }), 'default', 'Codex routed to xhigh: the summary sends the default');
  // Planned on the snapshot alone ('default' = 'default'), the hook kept the routed level: the regression.
  assert.equal(await foreground(deepseek, {}), undefined);
  // GLM with an explicit max and routing in shadow keeps the conversation's effort.
  assert.equal(await foreground(glm, { model: { reasoning: 'max', reasoningSelection: 'max', reasoningCapability: glm.reasoningCapability } }), undefined);
});

test('a manual summary is planned on the live effort too', async () => {
  const service = { decisions: null, store: { state: { configuration: {}, projects: [] } } };
  assert.equal(await SessionCommandService.prototype.summaryEffort.call(service, { projectId: null }, deepseek, { args: {} }, { estimatedInputTokens: 30000, model: { reasoning: 'max', reasoningSelection: 'auto' } }), 'default');
  assert.equal(await SessionCommandService.prototype.summaryEffort.call(service, { projectId: null }, glm, { args: {} }, { estimatedInputTokens: 30000, model: { reasoning: 'max' } }), undefined);
});
