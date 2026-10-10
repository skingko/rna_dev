// Turn-start reasoning routing for requested 'auto' (contract v2 §3, plan
// §1.2). Zero-latency rules first; then chat.route within a hard budget; any
// timeout, abstention or missing backend falls back to the provider default.
import { inLanguage } from './interface-language.mjs';

export const ROUTE_BUDGET_MS = 900;
const CAREFUL = /(?:仔细|认真|深入|慎重|好好|详细)(?:地)?(?:想|思考|考虑|分析|推敲|推理)|想清楚|想透|三思|\bthink(?:ing)? (?:hard(?:er)?|carefully|deeply|it through|step by step)\b|\bultrathink\b|\breason carefully\b/i;
const GREETING = /^\s*(?:hi|hello|hey|yo|thanks|thank you|thx|ok(?:ay)?|cool|好的?|嗯+|哦+|你好|您好|嗨|哈喽|谢谢|多谢|感谢|在吗|在不在|早上好|下午好|晚上好|早安|晚安|收到|明白了?)[\s!！。.,，~～?？]*$/i;
const ids = capability => (capability?.efforts ?? []).map(effort => effort.id);

/** Moves along the model's own effort order; never leaves the supported set. */
export function stepEffort(capability, from, delta) {
  const list = ids(capability); if (!list.length) return undefined;
  const index = list.indexOf(from), base = index >= 0 ? index : Math.floor((list.length - 1) / 2);
  return list[Math.max(0, Math.min(list.length - 1, base + delta))];
}
const anchor = capability => { const list = ids(capability); return list.includes(capability.providerDefault) ? capability.providerDefault : list.includes('high') ? 'high' : list[Math.floor((list.length - 1) / 2)]; };

// Why a rule chose the level, shown in the model tooltip in the interface language.
const RATIONALES = {
  careful: { zh: '用户明确要求仔细思考', en: 'you asked for careful thinking' },
  retry: { zh: '上一轮失败后的重试，提高一档', en: 'a retry after the last turn failed, one level higher' },
  plan: { zh: '计划模式，提高思考档位', en: 'plan mode, a higher thinking level' },
  greeting: { zh: '简单问候或确认，使用最低档位', en: 'a simple greeting or acknowledgement, the lowest level' }
};
/** Returns { effective, rationale } or null when no rule applies. Only models
 * with at least two efforts are routed; others use the provider default. */
export function ruleReasoning({ capability, mode, prompt = '', previousTurn, language = 'zh' } = {}) {
  const list = ids(capability); if (list.length < 2) return null;
  const text = String(prompt), why = key => inLanguage(language, RATIONALES[key]);
  if (CAREFUL.test(text)) return { effective: list.includes('high') ? 'high' : list.at(-1), rationale: why('careful') };
  if (previousTurn?.status === 'failed') {
    const prior = list.includes(previousTurn.modelConfig?.reasoning) ? previousTurn.modelConfig.reasoning : anchor(capability);
    return { effective: stepEffort(capability, prior, 1), rationale: why('retry') };
  }
  if (mode === 'plan') return { effective: capability.providerDefault && list.includes(capability.providerDefault) ? stepEffort(capability, capability.providerDefault, 1) : anchor(capability), rationale: why('plan') };
  if (text.length <= 40 && GREETING.test(text)) return { effective: list[0], rationale: why('greeting') };
  return null;
}

/** Resolves after `ms` with `fallback`; never rejects the host turn. */
export function withBudget(promise, ms = ROUTE_BUDGET_MS, fallback = null) {
  let timer;
  return Promise.race([Promise.resolve(promise).catch(() => fallback), new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]).finally(() => clearTimeout(timer));
}
