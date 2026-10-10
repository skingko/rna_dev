// How services say a request exceeded the model's context window (pi-ai utils/overflow.ts). Many return it as an
// ordinary 400 or a stream error whose only trace is this text, so it is recognized here and handled as
// context_limit (summarize, retry) instead of a generic rejection.
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API, ChatGPT Codex)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai finish reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /range of input length should be/i, // DashScope / Qwen
  /context[_ ]length[_ ]exceeded/i, // generic
  /too many tokens/i, // generic
  /token limit exceeded/i, // generic
];
const NON_OVERFLOW_PATTERNS = [/rate limit/i, /too many requests/i];

/** Whether a provider's error text or code says the request exceeded the context window. */
export function isContextOverflowText(...values) {
  const text = values.filter(value => typeof value === 'string' && value).join(' ');
  return Boolean(text) && !NON_OVERFLOW_PATTERNS.some(pattern => pattern.test(text)) && OVERFLOW_PATTERNS.some(pattern => pattern.test(text));
}

/** The {code, message} of an error a stream reported (Responses `response.failed`, `error` events, Chat errors). */
export function streamErrorOf(event) {
  const error = event?.response?.error ?? event?.error ?? (event?.type === 'error' ? event : null);
  if (!error) return {};
  if (typeof error === 'string') return { message: error };
  return { code: typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : undefined, message: typeof error.message === 'string' ? error.message : undefined };
}
