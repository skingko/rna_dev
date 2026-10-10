import { streamCompletion, resolveJsonOutputContract, ProviderError } from './providers.mjs';

// "Judge model" backend for the decision kernel: a configured fast model fills
// the same answer shape JEV returns. It only scores host-enumerated options;
// the kernel parser, thresholds, circuit breaker and ledger stay authoritative.
export const LLM_JUDGE_PURPOSE = 'jev-llm';
export const LLM_JUDGE_MAX_OUTPUT_TOKENS = 512;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Object.assign(new Error('Judge model returned an invalid answer.'), { code: 'invalid_response' });
const SYSTEM = `You are a fast, calibrated routing judge. You never act, never answer the user, and never invent options.
Read {state, questions}. For every question id return exactly one answer object:
- boolean: {"p_true": probability the true criterion applies, "confidence": 0..1}
- choice: {"choice": one option id from criteria, "probabilities": {every option id: probability, summing to 1}, "confidence": 0..1}
- score: {"score": number between 0 and the last anchor index, "confidence": 0..1}
Prefer "unknown" (or a middling probability with low confidence) when the evidence is weak.
Output only JSON: {"answers": {"<question id>": {...}}}. No prose, no markdown.`;

/** Lowest-cost reasoning for a judge call: off when the model can disable
 * thinking, else its lightest effort, else the provider default. */
export function llmJudgeReasoning(capability) {
  if (!capability || capability.control === 'none' || capability.canDisable) return 'off';
  return capability.efforts?.[0]?.id ?? 'default';
}
function parseJSON(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw invalid();
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { throw invalid(); }
}
/** Translate the model's answer into the JEV wire shape; normalize only
 * near-valid probability sets. Anything else fails kernel validation. */
function toWire(raw, questions) {
  if (!record(raw?.answers)) throw invalid();
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers[id]; if (!record(answer)) throw invalid();
    const confidence = typeof answer.confidence === 'number' ? { confidence: answer.confidence } : {};
    if (question.type === 'boolean') answers[id] = { noul: answer.p_true ?? answer.probability ?? answer.noul, ...confidence };
    else if (question.type === 'choice') {
      const options = Object.keys(question.criteria), given = record(answer.probabilities) ? answer.probabilities : null;
      const values = given ? options.map(key => Number.isFinite(given[key]) && given[key] >= 0 ? given[key] : 0) : null, sum = values?.reduce((a, b) => a + b, 0);
      const probabilities = values && sum > .5 && sum < 1.5 ? Object.fromEntries(options.map((key, index) => [key, Math.round(values[index] / sum * 10000) / 10000])) : undefined;
      if (probabilities) { const drift = 1 - Object.values(probabilities).reduce((a, b) => a + b, 0); const top = options.reduce((best, key) => probabilities[key] > probabilities[best] ? key : best, options[0]); probabilities[top] = Math.round((probabilities[top] + drift) * 10000) / 10000; }
      const choice = probabilities ? options.reduce((best, key) => probabilities[key] > probabilities[best] ? key : best, options[0]) : answer.choice;
      answers[id] = { choice, ...(probabilities ? { probabilities } : {}), ...confidence };
    } else answers[id] = { score: answer.score, ...confidence };
  }
  return { answers };
}

/** Returns a kernel `judge` transport. `model` is a resolved host model
 * snapshot (optionally carrying `reasoningCapability`). */
export function createLlmDecisionJudge({ model, apiKey, provider = streamCompletion, maxOutputTokens = LLM_JUDGE_MAX_OUTPUT_TOKENS, fetch } = {}) {
  if (!model?.modelId || !model?.providerId || typeof provider !== 'function') throw new ProviderError('判断模型未配置', { code: 'configuration' });
  return async ({ state, questions, signal }) => {
    const reasoning = llmJudgeReasoning(model.reasoningCapability);
    // Thinking models that cannot disable reasoning need room before the JSON.
    const wanted = reasoning === 'off' ? maxOutputTokens : Math.max(maxOutputTokens, 2048);
    const judgeModel = { ...structuredClone(model), reasoning, maxOutputTokens: Math.max(1, Math.min(wanted, model.contextWindow - 1)) };
    delete judgeModel.reasoningCapability; delete judgeModel.reasoningSelection; delete judgeModel.reasoningDecision;
    const contract = resolveJsonOutputContract(judgeModel);
    let text = '', usage;
    for await (const event of provider({ model: judgeModel, apiKey, systemPrompt: SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ state, questions }) }] }], tools: [], signal, purpose: LLM_JUDGE_PURPOSE, maxRetries: 0, ...(fetch ? { fetch } : {}), ...contract.requestOptions })) {
      if (event.type === 'text_delta') { text += event.delta; if (text.length > 64000) throw invalid(); }
      else if (event.type === 'usage') usage = event.usage;
    }
    return { ...toWire(parseJSON(text), questions), ...(usage ? { usage: { input_tokens: usage.input + usage.cacheRead + usage.cacheWrite, output_tokens: usage.output } } : {}) };
  };
}
