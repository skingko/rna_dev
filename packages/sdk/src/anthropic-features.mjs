// Anthropic Messages API features that depend on the official endpoint and the
// model (docs: preserved thinking, mid-conversation system messages, effort).
// Third-party Anthropic-protocol services (Kimi Coding and other proxies) keep
// the plain request shape: nothing here is inferred from a familiar model name
// at another host. Every flag can be set explicitly with a boolean
// `model.compat` flag of the same name.

/** Beta that permits `thinking.block_binding` and adds `input_transformations` to responses. */
export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
/** Accepted `compat.thinkingBindingMode` values. 'unset' sends the beta header without the field (monitoring only);
 * 'off' sends neither. The default is 'drop_block': a broken binding degrades and is rebased, never fails the turn. */
export const THINKING_BINDING_MODES = Object.freeze(['drop_block', 'error', 'unset', 'off']);

// Mid-conversation `role: "system"` text messages (GA, no header). Not Claude Sonnet 5.
const MID_CONVERSATION_SYSTEM = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1', 'claude-sonnet-5-5']);
// Per-message effort (beta mid-conversation-output-config-2026-07-01).
const PER_MESSAGE_EFFORT = new Set(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// Thinking cannot be disabled: `disabled` (and a budget) is a 400 at every effort level.
const ALWAYS_THINKS = new Set(['claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1']);
// Omitting `thinking` runs adaptive thinking on these models; `disabled` is accepted only where noted by the
// model's own compat flag (`canDisableThinking`). Claude Sonnet 5.5 rejects `disabled` outright.
const THINKS_WHEN_OMITTED = new Set([...ALWAYS_THINKS, 'claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5-5']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const BUDGETS = { minimal: 1024, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };

const flag = (model, key, fallback) => typeof model?.compat?.[key] === 'boolean' ? model.compat[key] : fallback;

/** `https:` + api.anthropic.com + no port: the only endpoint whose documented behaviour this module relies on. */
export function officialAnthropicEndpoint(model) {
  if (model?.protocol !== 'anthropic') return false;
  try { const url = new URL(model.baseUrl); return url.protocol === 'https:' && url.hostname === 'api.anthropic.com' && url.port === '' && !url.username && !url.password; } catch { return false; }
}

/** The request's `thinking` and `output_config` for an Anthropic model (wire shape, before `block_binding`).
 * 'default' keeps the provider's own effort (no output_config); 'minimal' is not an Anthropic level and maps to
 * 'low'; 'off' on a model that cannot stop thinking keeps adaptive thinking at 'low' effort. Budget models keep
 * the budget table. Throws a plain Error with `code` for an impossible configuration (the caller wraps it). */
export function anthropicThinking(model, { cap = Infinity } = {}) {
  const effort = model?.reasoning ?? 'off', compat = model?.compat ?? {}, official = officialAnthropicEndpoint(model);
  const display = compat.thinkingDisplay ? { display: compat.thinkingDisplay } : {};
  const capability = model?.reasoningCapability;
  const always = flag(model, 'alwaysThinks', official && ALWAYS_THINKS.has(model?.modelId) || capability?.canDisable === false && compat.adaptiveThinking === true);
  const adaptive = compat.adaptiveThinking === true || always || official && THINKS_WHEN_OMITTED.has(model?.modelId);
  const adaptiveWith = level => ({ thinking: { type: 'adaptive', ...display }, ...(level ? { outputConfig: { effort: level } } : {}) });
  if (effort === 'off') {
    if (compat.canDisableThinking === true && !always) return { thinking: { type: 'disabled' } };
    // A model that thinks anyway: say so and keep it short, so the binding controls can still be attached.
    if (always || official && THINKS_WHEN_OMITTED.has(model?.modelId)) return adaptiveWith('low');
    return {};
  }
  if (effort === 'default') return adaptive ? adaptiveWith(null) : {};
  const level = effort === 'minimal' ? 'low' : effort;
  if (adaptive) return adaptiveWith(EFFORT_LEVELS.has(level) ? level : null);
  const budget = BUDGETS[effort];
  if (!budget || cap <= 1024) throw Object.assign(new Error('Anthropic 思考模式需要输出上限大于 1024；或显式配置 adaptiveThinking'), { code: 'configuration' });
  return { thinking: { type: 'enabled', budget_tokens: Math.min(budget, cap - 1) } };
}

/**
 * Feature gates for one Anthropic request.
 * - thinkingBindingControls: send the binding beta (and `block_binding` unless the mode is 'unset').
 * - appendOnly: the session keeps the provider-visible history append-only (no settle/prune/fold/flip without a
 *   journaled thinking rebase). The other history-editing code paths consult this flag.
 * - midConversationSystem / perMessageEffort: documented model support.
 * - toolChoiceNone: `tool_choice: {type: "none"}` is accepted.
 */
export function anthropicFeatures(model) {
  const official = officialAnthropicEndpoint(model), id = model?.modelId;
  let thinking = false;
  try { const shape = anthropicThinking(model).thinking; thinking = Boolean(shape && shape.type !== 'disabled'); } catch { thinking = false; }
  const mode = model?.compat?.thinkingBindingMode ?? 'drop_block';
  const controls = flag(model, 'thinkingBindingControls', official && thinking && mode !== 'off');
  return {
    official,
    thinking,
    thinkingBindingControls: controls,
    bindingMode: controls ? (THINKING_BINDING_MODES.includes(mode) && mode !== 'off' ? mode : 'drop_block') : null,
    appendOnly: flag(model, 'appendOnly', official && thinking),
    midConversationSystem: flag(model, 'midConversationSystem', official && MID_CONVERSATION_SYSTEM.has(id)),
    perMessageEffort: flag(model, 'perMessageEffort', official && PER_MESSAGE_EFFORT.has(id)),
    alwaysThinks: flag(model, 'alwaysThinks', official && ALWAYS_THINKS.has(id)),
    toolChoiceNone: official
  };
}

/** How a session may edit provider-visible history for this model: 'append-only' (Anthropic preserved thinking:
 * every projection change waits for, and is journaled with, a thinking rebase) or 'free'. */
export function historyEditing(model) {
  return model?.protocol === 'anthropic' && anthropicFeatures(model).appendOnly ? 'append-only' : 'free';
}
