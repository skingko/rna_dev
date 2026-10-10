import { catalogModel, EFFORT_LABELS, legacyReasoning } from './provider-presets.mjs';

// Reasoning capability per provider/model (host contract v2 §4). Priority:
// provider discovery > cited preset > protocol inference. Harness semantics:
// 'default' preserves the provider's own default by omitting the effort.
export const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const REASONING_MODES = Object.freeze(['auto', 'default', 'off']);
export const REASONING_SELECTION_VERSION = 2;
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const efforts = (ids, labels = {}) => EFFORT_ORDER.filter(id => ids.includes(id)).map(id => ({ id, label: labels[id] ?? EFFORT_LABELS[id] }));
export { legacyReasoning };

/** Only declared levels count; 'none' is the provider spelling of off. */
export function discoveredReasoning(item) {
  const raw = [item?.supported_reasoning_levels, item?.supported_reasoning_efforts, item?.reasoning_options, item?.reasoning?.efforts].find(Array.isArray);
  if (!raw) return undefined;
  const levels = raw.slice(0, 20).map(level => typeof level === 'string' ? level : level?.effort ?? level?.id).filter(level => typeof level === 'string');
  const ids = EFFORT_ORDER.filter(id => levels.includes(id)), canDisable = levels.includes('off') || levels.includes('none');
  if (!ids.length && !canDisable) return undefined;
  const fallback = [item.default_reasoning_level, item.default_reasoning_effort, item.reasoning?.default_effort, item.reasoning?.defaultEffort].find(value => typeof value === 'string');
  return { efforts: ids, canDisable, providerDefault: ids.includes(fallback) ? fallback : null };
}
export function validReasoningDiscovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.efforts) || value.efforts.length > EFFORT_ORDER.length || value.efforts.some(id => !EFFORT_ORDER.includes(id)) || typeof value.canDisable !== 'boolean' || value.providerDefault !== null && !value.efforts.includes(value.providerDefault)) return undefined;
  return { efforts: EFFORT_ORDER.filter(id => value.efforts.includes(id)), canDisable: value.canDisable, providerDefault: value.providerDefault, ...(typeof value.checkedAt === 'string' ? { checkedAt: value.checkedAt.slice(0, 40) } : {}) };
}

function inferred(provider, model) {
  const legacy = Array.isArray(model?.reasoning) ? model.reasoning : ['off'], ids = EFFORT_ORDER.filter(id => legacy.includes(id)), compat = model?.compat ?? {};
  const base = { canDisable: legacy.includes('off') || !ids.length, providerDefault: null, source: 'protocol' };
  let host = ''; try { host = new URL(provider?.baseUrl).hostname; } catch {}
  if (provider?.protocol === 'demo' || !ids.length) return { ...base, control: 'none', efforts: [], canDisable: true, visibility: 'hidden' };
  if (provider?.protocol === 'anthropic') return { ...base, control: compat.adaptiveThinking ? 'adaptive' : 'budget', efforts: efforts(ids), visibility: compat.thinkingDisplay === 'omitted' ? 'hidden' : 'summary' };
  if (provider?.protocol === 'openai-codex') return { ...base, control: 'effort', efforts: efforts(ids), visibility: 'summary' };
  if (host === 'api.deepseek.com') return { ...base, control: 'effort', efforts: efforts(['high', 'max']), providerDefault: 'high', visibility: 'full' };
  if (['qwen', 'toggle'].includes(compat.thinkingFormat)) return { ...base, control: 'toggle', efforts: efforts(['high'], { high: '开启思考' }), visibility: 'full' };
  if (compat.thinkingFormat === 'zai') return { ...base, control: 'effort', efforts: efforts(ids), canDisable: false, visibility: 'full' };
  return { ...base, control: 'effort', efforts: efforts(ids), visibility: compat.thinkingFormat === 'openai' || compat.requiresReasoningContent ? 'full' : 'hidden' };
}

/** Capability used for display, validation and routing of future requests. */
export function resolveReasoningCapability(provider, model) {
  const preset = catalogModel(provider, model?.id)?.reasoningCapability;
  const base = preset ? structuredClone(preset) : inferred(provider, model);
  const discovered = validReasoningDiscovery(model?.reasoningDiscovery);
  if (!discovered) return base;
  // Toggle models expose one "on" level; a directory list cannot add strengths.
  if (base.control === 'toggle') return { ...base, canDisable: discovered.canDisable || base.canDisable, source: 'discovery' };
  return { ...base, control: base.control === 'none' ? (provider?.protocol === 'anthropic' ? 'budget' : 'effort') : base.control, efforts: efforts(discovered.efforts), canDisable: discovered.canDisable || !discovered.efforts.length, providerDefault: discovered.providerDefault, source: 'discovery' };
}

/** Selection values: auto | default | off (only when canDisable) | effort id.
 * Unsupported values are configuration errors, never silent downgrades. */
export function validateReasoningSelection(capability, value) {
  if (value === undefined || value === null) return 'auto';
  if (value === 'auto' || value === 'default') return value;
  if (value === 'off') { if (!capability.canDisable) fail('该模型不能关闭思考；可选择“自动”、“供应商默认”或具体档位'); return value; }
  if (typeof value === 'string' && capability.efforts.some(effort => effort.id === value)) return value;
  fail('模型不支持所选推理档位');
}
/** 'auto' is resolved per turn; until then the wire value is the provider default. */
export const wireReasoning = selection => selection === 'auto' ? 'default' : selection;

/** One-time migration to reasoning selection v2. The old UI and CLI always
 * materialized the model's first listed level, so an explicit pick of that
 * level is indistinguishable from "never chosen": both migrate to auto. Any
 * other stored level is kept as an explicit user choice. */
export function migrateReasoningSelections(state) {
  const configuration = state?.configuration;
  if (!configuration || configuration.reasoningSelectionVersion === REASONING_SELECTION_VERSION) return false;
  const row = selection => configuration.providers?.find(provider => provider.id === selection?.providerId)?.models?.find(model => model.id === selection?.modelId);
  const valid = (selection, value) => {
    const provider = configuration.providers?.find(item => item.id === selection?.providerId), model = row(selection);
    if (!provider || !model) return false;
    try { validateReasoningSelection(resolveReasoningCapability(provider, model), value); return true; } catch { return false; }
  };
  const migrate = selection => {
    if (!selection || typeof selection !== 'object') return false;
    const implicit = selection.reasoning === undefined || selection.reasoning === row(selection)?.reasoning?.[0] || !valid(selection, selection.reasoning);
    if (implicit) selection.reasoning = 'auto';
    return implicit;
  };
  if (configuration.defaultModel) configuration.defaultModel.reasoning = 'auto';
  for (const session of state.sessions ?? []) if (migrate(session.modelSelection) && session.modelConfig && !session.activeTurnId) Object.assign(session.modelConfig, { reasoning: 'default', reasoningSelection: 'auto' });
  for (const project of state.projects ?? []) migrate(project.initiative?.modelSelection);
  configuration.reasoningSelectionVersion = REASONING_SELECTION_VERSION;
  return true;
}
