import { llmJudgeReasoning } from './decision-llm-judge.mjs';

// Reasoning levels of one model, by its reasoning capability (host contract v2 §4): `efforts` are ordered weakest to
// strongest. 'default' omits the effort on the wire, so the provider's own default applies: its rank is the declared
// `providerDefault`, else the deepest level (an unknown default may be the top one; GLM-5.3 documents max). 'off'
// ranks below every effort. Used by the length guards (step down one level, or the lightest) and by internal routing.
const ids = capability => Array.isArray(capability?.efforts) ? capability.efforts.map(effort => typeof effort === 'string' ? effort : effort?.id).filter(id => typeof id === 'string') : [];
export { llmJudgeReasoning as lightestReasoning };

/** Position of a wire reasoning value among the model's efforts (-1 = off), or null when it is not one of them. */
export function rankEffort(capability, value) {
  const list = ids(capability);
  if (value === 'off') return -1;
  if (value === 'default') {
    // Anthropic budget thinking: omitting the field turns thinking off.
    if (capability?.control === 'budget') return -1;
    const at = list.indexOf(capability?.providerDefault);
    return at >= 0 ? at : list.length ? list.length - 1 : null;
  }
  const at = list.indexOf(value);
  return at >= 0 ? at : null;
}
/** The effort a model request actually runs at: 'default' resolved to the provider default (else the deepest level). */
export function effectiveEffort(model) {
  const capability = model?.reasoningCapability, value = model?.reasoning ?? 'off', list = ids(capability);
  if (value !== 'default') return value;
  if (capability?.control === 'budget') return 'off';
  return list.includes(capability?.providerDefault) ? capability.providerDefault : list.at(-1) ?? 'default';
}
/** One level lighter than the model's current reasoning, or undefined when nothing is lighter (or thinking cannot be
 * stepped: no efforts, off, a toggle). Never leaves the supported set. */
export function stepDownReasoning(model) {
  const capability = model?.reasoningCapability, list = ids(capability), rank = rankEffort(capability, model?.reasoning ?? 'off');
  if (!list.length || capability?.control === 'toggle' || rank === null || rank <= 0) return undefined;
  return list[rank - 1];
}

/**
 * Whether omitting the effort ('default') is already the right internal choice: a toggle or no levels to pick,
 * adaptive thinking (Claude decides the depth per request), or an effort control whose declared default is below its
 * top level (DeepSeek high, Codex medium/low). Not when the default is the top level or unknown (GLM, Kimi, gpt-5.4,
 * Gemini), not for budget thinking (omitting it turns thinking off), and not without a declared capability: nothing is
 * known about that default.
 */
export function defaultReasoningUsable(capability) {
  if (!capability || typeof capability !== 'object') return false;
  if (['none', 'toggle', 'adaptive'].includes(capability.control) || capability.defaultAdaptive === true) return true;
  if (capability.control !== 'effort') return false;
  const list = ids(capability);
  return typeof capability.providerDefault === 'string' && list.includes(capability.providerDefault) && capability.providerDefault !== list.at(-1);
}
/** The chat-level ceiling for internal calls: off, or the deepest effort they may use. */
function chatCeiling(model, capability) {
  const list = ids(capability);
  let selection = model?.reasoningSelection ?? model?.reasoning ?? 'auto';
  // A routed foreground turn (a subtask's parent) carries the level its route chose.
  if (selection === 'auto' && list.includes(model?.reasoning)) selection = model.reasoning;
  if (selection === 'off') return 'off';
  if (list.includes(selection)) return selection;
  // default / auto: the provider default when declared; omitted budget thinking is off; otherwise the deepest level.
  if (capability?.control === 'budget') return 'off';
  return list.includes(capability?.providerDefault) ? capability.providerDefault : list.at(-1) ?? 'default';
}
/**
 * The effort plan of one internal call (spec p1 effort §2/§3.1; user decision 2026-10-04: internal calls stop inheriting
 * the chat's max). The one rule behind every internal effort — the host's routes (prototypes/control-center/
 * internal-reasoning.mjs) and the SDK's own summary default (compaction-request.mjs summaryReasoning):
 *   { mode: 'fixed', effort, source }                         — nothing to choose, or the user chose
 *   { mode: 'route', allowed, preferred?, fallback, ceiling } — a judge may pick a depth; `fallback` is today's wire value
 * `setting`: 'auto', or 'chat' (the user's switch back to the chat's own effort). `projectSelection`: the project's own
 * background model selection; an explicit level there is the user's choice.
 */
export function internalReasoningPlan(model, { setting = 'auto', projectSelection = null } = {}) {
  const capability = model?.reasoningCapability, list = ids(capability), configured = model?.reasoning ?? 'off';
  if (setting === 'chat') return { mode: 'fixed', effort: configured, source: 'setting' };
  const chosen = projectSelection?.reasoning;
  if (typeof chosen === 'string' && chosen !== 'auto' && (chosen === 'off' || chosen === 'default' || list.includes(chosen))) return { mode: 'fixed', effort: chosen, source: 'project' };
  const top = chatCeiling(model, capability);
  // Thinking is off at the chat level (or the model has no levels): today's wire value already is the lightest.
  if (top === 'off' || !list.length) return { mode: 'fixed', effort: configured, source: top === 'off' ? 'chat-off' : 'no-levels' };
  if (defaultReasoningUsable(capability)) {
    // The provider default would think harder than the user's chat level: hold to the chat level instead.
    if (list.includes(capability.providerDefault) && list.indexOf(capability.providerDefault) > list.indexOf(top)) return { mode: 'fixed', effort: top, source: 'chat-ceiling' };
    return { mode: 'fixed', effort: 'default', source: 'provider-default' };
  }
  const allowed = list.slice(0, list.indexOf(top) + 1);
  if (allowed.length < 2) return { mode: 'fixed', effort: allowed[0] ?? configured, source: 'chat-ceiling' };
  const preferred = list.includes(capability.providerDefault) && capability.providerDefault !== allowed.at(-1) && allowed.includes(capability.providerDefault) ? capability.providerDefault : null;
  return { mode: 'route', allowed, ...(preferred ? { preferred } : {}), fallback: configured, ceiling: top };
}
