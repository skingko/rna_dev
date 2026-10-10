import { catalogModel, catalogInputCapability } from './provider-presets.mjs';
import { discoveredReasoning } from './reasoning-capability.mjs';
const limit = (value, min = 1) => Number.isSafeInteger(value) && value >= min && value <= 10000000 ? value : undefined;
const firstLimit = (values, min) => values.map(value => limit(value, min)).find(value => value !== undefined);
const validInput = value => Array.isArray(value) && value.includes('text') && value.every(part => ['text', 'image'].includes(part)) && new Set(value).size === value.length ? [...value] : undefined;
export const inputBinding = (provider, modelId) => ({ providerId: provider.id, modelId, baseUrl: String(provider.baseUrl ?? '').replace(/\/+$/, ''), protocol: provider.protocol, authMode: provider.authMode ?? 'api_key', ...(provider.authProvider ? { authProvider: provider.authProvider } : {}) });
const sameBinding = (left, right) => left && ['providerId', 'modelId', 'baseUrl', 'protocol', 'authMode', 'authProvider'].every(key => left[key] === right[key]);
export function retainedInputEvidence(provider, model) {
  const evidence = model?.discoveredInput;
  return sameBinding(evidence?.binding, inputBinding(provider, model?.id)) ? evidence : undefined;
}
/** Image input observed from the model's own response (vision-probe), bound to the endpoint that answered. */
export function retainedProbeEvidence(provider, model) {
  const evidence = model?.probedInput;
  return sameBinding(evidence?.binding, inputBinding(provider, model?.id)) && validInput(evidence.input) ? evidence : undefined;
}
/** Sources are selected once for public display and actual future requests.
 * An observed upstream response outranks catalogs and listings. */
export function resolveInputCapability(provider, model) {
  const probed = retainedProbeEvidence(provider, model);
  if (probed) return { status: 'known', source: 'probe', input: validInput(probed.input), checkedAt: probed.checkedAt, ...(probed.evidence ? { evidence: probed.evidence } : {}) };
  const known = catalogModel(provider, model.id);
  if (known?.input) return catalogInputCapability(known);
  const evidence = retainedInputEvidence(provider, model);
  if (evidence) {
    const input = validInput(evidence.input);
    const configured = validInput(model.input);
    return { status: input ? 'known' : 'unknown', source: input ? 'provider' : configured ? 'configured' : 'unknown', ...(input || configured ? { input: input ?? configured } : {}), ...(evidence.sourceUrl ? { sourceUrl: evidence.sourceUrl } : {}), ...(evidence.checkedAt ? { checkedAt: evidence.checkedAt } : {}) };
  }
  if (model.discoveredInput || model.catalogVersion && !known) return { status: 'unknown', source: 'unknown' };
  // Keep the existing explicit SDK/API declaration contract, but do not label
  // an old user selection as automatic recognition or a verified capability.
  const configured = validInput(model.input);
  return configured ? { status: 'unknown', source: 'configured', input: configured } : { status: 'unknown', source: 'unknown' };
}
export function discoveredInputCapability(provider, item, { checkedAt, sourceUrl } = {}) {
  const known = catalogModel(provider, item.id);
  if (known?.input) return catalogInputCapability(known);
  const modalities = [item.input_modalities, item.architecture?.input_modalities, item.modalities?.input, Array.isArray(item.modalities) ? item.modalities : undefined, item.capabilities?.input_modalities].find(value => Array.isArray(value) && value.length && value.every(part => typeof part === 'string'));
  const vision = [item.capabilities?.vision, item.vision, item.supports_vision].find(value => typeof value === 'boolean');
  // An explicit false is useful evidence; missing/empty/malformed declarations
  // are not proof that a model is text-only. Project only SDK-supported inputs.
  const input = modalities ? modalities.includes('text') ? modalities.includes('image') ? ['text', 'image'] : ['text'] : undefined : vision === true ? ['text', 'image'] : vision === false ? ['text'] : undefined;
  return { status: input ? 'known' : 'unknown', source: input ? 'provider' : 'unknown', ...(input ? { input } : {}), ...(sourceUrl ? { sourceUrl } : {}), ...(checkedAt ? { checkedAt } : {}) };
}
export const bindInputEvidence = (provider, model) => {
  const capability = model.inputCapability;
  if (!capability || !['provider', 'unknown'].includes(capability.source)) return undefined;
  return { binding: inputBinding(provider, model.id), ...(capability.status === 'known' && validInput(capability.input) ? { input: validInput(capability.input) } : {}), ...(capability.sourceUrl ? { sourceUrl: capability.sourceUrl } : {}), ...(capability.checkedAt ? { checkedAt: capability.checkedAt } : {}) };
};
/** Parse only declared capabilities. An ID, a name, or a catalog entry's existence
 * is not evidence for tool support, account authorization, or an unknown limit. */
export function normalizeDiscoveredModel(provider, item, { checkedAt, sourceUrl } = {}) {
  if (typeof item?.id !== 'string' || !item.id.trim() || item.id.length > 200) return null;
  const known = catalogModel(provider, item.id);
  const reportedContext = firstLimit([item.context_length, item.context_window, item.max_input_tokens, item.limit?.context, item.limits?.context_window], 1024);
  const reportedOutput = firstLimit([item.top_provider?.max_completion_tokens, item.max_output_tokens, item.max_tokens, item.limit?.output, item.limits?.max_output_tokens]);
  const contextWindow = reportedContext ?? known?.contextWindow;
  const modelMaxOutputTokens = reportedOutput ?? known?.modelMaxOutputTokens;
  const toolCall = typeof item.tool_call === 'boolean' ? item.tool_call : typeof item.capabilities?.tool_calling === 'boolean' ? item.capabilities.tool_calling : Array.isArray(item.supported_parameters) ? item.supported_parameters.includes('tools') : known ? true : null;
  const inputCapability = discoveredInputCapability(provider, item, { checkedAt, sourceUrl });
  const input = inputCapability.input;
  // Declared levels (supported_reasoning_levels / reasoning_options / default
  // level) become discovery-sourced capability; names never imply a level.
  const reasoningFound = discoveredReasoning(item);
  const reasoning = reasoningFound ? [...reasoningFound.efforts, ...(reasoningFound.canDisable ? ['off'] : [])] : known?.reasoning;
  const limitsSource = {
    contextWindow: reportedContext !== undefined ? 'provider-catalog' : known?.contextWindow ? 'verified-preset' : 'unknown',
    modelMaxOutputTokens: reportedOutput !== undefined ? 'provider-catalog' : known?.modelMaxOutputTokens ? 'verified-preset' : 'unknown'
  };
  const readyForConfiguration = Boolean(contextWindow && modelMaxOutputTokens);
  return {
    ...(known ?? {}), id: item.id, name: String(item.display_name ?? item.name ?? known?.name ?? item.id).slice(0, 160),
    ...(contextWindow ? { contextWindow } : {}), ...(modelMaxOutputTokens ? { modelMaxOutputTokens, maxOutputTokens: Math.min(known?.maxOutputTokens ?? 8192, modelMaxOutputTokens, contextWindow ?? Infinity) } : {}),
    ...(input ? { input } : {}), inputCapability, ...(reasoning ? { reasoning } : {}), ...(reasoningFound ? { reasoningDiscovery: { ...reasoningFound, ...(checkedAt ? { checkedAt } : {}) } } : {}), toolCall, limitsSource,
    discoverySource: { url: sourceUrl, checkedAt }, readyForConfiguration,
    readyForAgent: readyForConfiguration && toolCall === true,
    unavailableReason: !readyForConfiguration ? 'missing-capacity' : toolCall === false ? 'no-tool-calling' : toolCall !== true ? 'unknown-tool-calling' : null
  };
}
