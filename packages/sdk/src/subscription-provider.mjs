import { createHash } from 'node:crypto';
import { ProviderError, normalizeUsage } from './providers.mjs';
import { validateMessageImages } from './images.mjs';
import { isContextOverflowText, streamErrorOf } from './provider-overflow.mjs';
import { codexClientVersion } from './codex-client.mjs';

const blocks = message => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
const words = message => blocks(message).filter(block => block.type === 'text').map(block => block.text).join('\n');
const signaturePrefix = 'rna:codex-reasoning:';
const invalid = message => new ProviderError(message, { code: 'provider_protocol' });
export function buildCodexRequest({ model, systemPrompt = '', messages = [], tools = [], cache = {}, maxOutputTokens, responseFormat, toolChoice }) {
  if (!model?.modelId || model.protocol !== 'openai-codex') throw new ProviderError('必须选择 Codex 订阅模型', { code: 'configuration' });
  let endpoint; try { endpoint = new URL(model.baseUrl); } catch { throw new ProviderError('Codex 服务地址无效', { code: 'configuration' }); }
  // A subscription token is audience-bound. Never forward it to a configurable proxy.
  if (endpoint.origin !== 'https://chatgpt.com' || !['/backend-api', '/backend-api/', '/backend-api/codex', '/backend-api/codex/responses'].includes(endpoint.pathname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ProviderError('Codex 订阅仅可连接官方 ChatGPT 服务地址', { code: 'configuration' });
  const max = maxOutputTokens ?? model.maxOutputTokens;
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(model.contextWindow) || max > model.contextWindow) throw new ProviderError('模型输出或上下文上限无效', { code: 'configuration' });
  if (responseFormat !== undefined && (!responseFormat || Object.keys(responseFormat).length !== 1 || responseFormat.type !== 'json_object')) throw new ProviderError('Only an explicit json_object response format is supported.', { code: 'invalid_output_contract' });
  if (responseFormat !== undefined && model.compat?.supportsJsonObject !== true) throw new ProviderError('Codex JSON output requires explicit verified compatibility.', { code: 'unsupported_output_contract' });
  if (toolChoice !== undefined && toolChoice !== 'none') throw new ProviderError('Only explicit toolChoice none is supported.', { code: 'invalid_output_contract' });
  validateMessageImages(messages, model);
  const input = [], pending = new Set();
  for (const message of messages) {
    if (['tool', 'toolResult'].includes(message.role)) {
      const callId = message.toolCallId ?? message.tool_call_id;
      if (!pending.delete(callId)) throw new ProviderError('Codex 工具结果没有对应的调用', { code: 'invalid_tool_group' });
      const content = blocks(message).flatMap(block => block.type === 'image' ? [{ type: 'input_image', image_url: `data:${block.mimeType};base64,${block.data}`, detail: 'auto' }] : block.type === 'text' ? [{ type: 'input_text', text: block.text }] : []);
      input.push({ type: 'function_call_output', call_id: callId, output: content.some(block => block.type === 'input_image') ? content : words(message) });
      continue;
    }
    if (pending.size) throw new ProviderError('Codex 请求不能拆开工具调用与结果批次', { code: 'invalid_tool_group' });
    if (message.role === 'system') { if (words(message)) input.push({ role: 'developer', content: words(message) }); continue; }
    if (message.role === 'user') { input.push({ role: 'user', content: blocks(message).flatMap(block => block.type === 'image' ? [{ type: 'input_image', image_url: `data:${block.mimeType};base64,${block.data}`, detail: 'auto' }] : block.type === 'text' ? [{ type: 'input_text', text: block.text }] : []) }); continue; }
    if (message.role !== 'assistant') continue;
    const signatures = new Set(), toolItems = new Map(); let messageItems = [];
    const sameModel = (!message.model || message.model === model.modelId) && (!message.provider || message.provider === model.providerId);
    for (const block of blocks(message)) if (sameModel && block.type === 'thinking' && typeof block.signature === 'string' && block.signature.startsWith(signaturePrefix) && !signatures.has(block.signature)) {
      signatures.add(block.signature);
      let stored; try { stored = JSON.parse(Buffer.from(block.signature.slice(signaturePrefix.length), 'base64url').toString()); } catch { throw invalid('Codex reasoning receipt 无效'); }
      const receipts = Array.isArray(stored) ? stored : stored?.version === 1 ? stored.reasoning : undefined;
      if (!Array.isArray(receipts) || receipts.length > 64) throw invalid('Codex reasoning receipt 无效');
      if (stored?.version === 1) {
        if (stored.modelId !== model.modelId) continue;
        for (const item of stored.toolItems ?? []) if (typeof item?.callId === 'string' && typeof item.itemId === 'string' && item.itemId.startsWith('fc_')) toolItems.set(item.callId, item.itemId);
        messageItems = Array.isArray(stored.messages) ? stored.messages : [];
      }
      for (const item of receipts) {
        if (item?.type !== 'reasoning' || typeof item.id !== 'string' || typeof item.encrypted_content !== 'string' || !Array.isArray(item.summary)) throw invalid('Codex reasoning receipt 无效');
        input.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: item.summary.filter(part => part?.type === 'summary_text' && typeof part.text === 'string').map(part => ({ type: 'summary_text', text: part.text })) });
      }
    }
    const text = words(message);
    if (text && messageItems.length && messageItems.every(item => typeof item.id === 'string' && typeof item.text === 'string' && [undefined, 'commentary', 'final_answer'].includes(item.phase)) && messageItems.map(item => item.text).join('') === text) {
      for (const item of messageItems) input.push({ type: 'message', role: 'assistant', id: item.id, status: 'completed', ...(item.phase ? { phase: item.phase } : {}), content: [{ type: 'output_text', text: item.text, annotations: [] }] });
    } else if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    for (const block of blocks(message)) if (block.type === 'toolCall') {
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || pending.has(block.id)) throw invalid('Codex 工具调用标识无效');
      input.push({ type: 'function_call', ...(toolItems.has(block.id) ? { id: toolItems.get(block.id) } : {}), call_id: block.id, name: block.name, arguments: JSON.stringify(block.arguments ?? {}) }); pending.add(block.id);
    }
  }
  if (pending.size) throw new ProviderError('Codex 请求仍有未完成工具结果', { code: 'invalid_tool_group' });
  const body = { model: model.modelId, store: false, stream: true, instructions: systemPrompt || 'You are a helpful assistant.', input, include: ['reasoning.encrypted_content'], parallel_tool_calls: true, tool_choice: toolChoice ?? 'auto', text: { verbosity: 'low', ...(responseFormat ? { format: { type: 'json_object' } } : {}) } };
  // Codex currently rejects max_output_tokens. The model catalog remains the
  // admission limit; do not send a Chat Completions field to the Responses route.
  const effort = model.reasoning ?? 'off';
  if (effort === 'default') body.reasoning = { summary: 'auto' };
  else if (effort !== 'off') body.reasoning = { effort: model.compat?.reasoningEffortMap?.[effort] ?? effort, summary: 'auto' };
  if (tools.length) body.tools = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({ type: 'function', name: tool.name, description: tool.description ?? '', parameters: structuredClone(tool.parameters ?? { type: 'object', properties: {} }), strict: false }));
  const sessionId = cache.sessionKey && cache.retention !== 'none' ? createHash('sha256').update(String(cache.sessionKey)).digest('hex') : undefined;
  if (sessionId) body.prompt_cache_key = sessionId;
  return { protocol: 'openai-codex', url: 'https://chatgpt.com/backend-api/codex/responses', body, headers: { 'OpenAI-Beta': 'responses=experimental', ...codexClientHeaders(), ...(sessionId ? { 'session-id': sessionId } : {}) } };
}
/** What every ChatGPT-backend request from Rna presents besides its credential: who it is and the Codex version it speaks. */
export const codexClientHeaders = () => ({ originator: 'rna-agent', 'User-Agent': 'Rna-Agent/0.1', version: codexClientVersion() });

export function codexAuthHeaders(value) {
  if (value?.provider !== 'openai-codex' || typeof value.accessToken !== 'string' || !value.accessToken || /[\r\n\0]/.test(value.accessToken) || typeof value.accountId !== 'string' || !value.accountId || /[\r\n\0]/.test(value.accountId)) throw new ProviderError('Codex 订阅尚未登录或凭据已失效', { code: 'reauth_required' });
  return { Authorization: `Bearer ${value.accessToken}`, 'chatgpt-account-id': value.accountId };
}
/** Reads a Codex Responses stream the way pi does (openai-responses-shared processResponsesStream): each output
 * item is final at its own response.output_item.done; the terminal event supplies status and usage, and its output
 * (often absent from ChatGPT Codex) only fills in what the stream left out, such as encrypted reasoning. Calls are
 * still buffered until that terminal event, so a cut-off stream never executes a half-assembled function. */
export function createCodexResponseState(modelId) { return { modelId, slots: new Map(), completed: false, providerFinishReason: undefined, stopReason: undefined }; }
export function codexEventUsage(event) {
  const usage = event?.response?.usage;
  return usage ? normalizeUsage({ prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens }, completion_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens } }) : undefined;
}
const KNOWN_ITEMS = new Set(['message', 'reasoning', 'function_call']);
const messageText = item => (Array.isArray(item.content) ? item.content : []).map(part => part?.type === 'output_text' && typeof part.text === 'string' ? part.text : part?.type === 'refusal' && typeof part.refusal === 'string' ? part.refusal : '').join('');
// Slots are keyed by output_index as pi keys them (absent in some Codex frames, and then shared by all of them).
const slotOf = (state, key, type, seed = {}) => {
  const slot = state.slots.get(key);
  if (slot?.type === type) return slot;
  const created = { type, text: '', arguments: '', done: false, ...seed };
  state.slots.set(key, created); return created;
};
function settleItem(slot, item) {
  if (typeof item.id === 'string' && item.id) slot.id = item.id;
  if (item.type === 'message') { slot.finalText = messageText(item); if (typeof item.phase === 'string') slot.phase = item.phase; }
  else if (item.type === 'reasoning') slot.item = { ...slot.item, ...item };
  else {
    for (const field of ['call_id', 'name']) if (typeof item[field] === 'string' && item[field]) slot[field] = item[field];
    if (typeof item.arguments === 'string' && item.arguments) slot.arguments = item.arguments;
    slot.status = typeof item.status === 'string' ? item.status : undefined;
  }
  slot.done = true;
}
export function consumeCodexEvent(state, event) {
  const out = [], type = event?.type, key = event?.output_index;
  if (event?.error || type === 'error' || type === 'response.failed' || type === 'response.done' && ['failed', 'cancelled'].includes(event.response?.status)) {
    // The reason lives in response.error / error; an overflow is context_limit (summarize and retry), not a broken stream.
    const reported = streamErrorOf(event);
    if (isContextOverflowText(reported.code, reported.message)) throw new ProviderError('Codex 服务报告请求超出上下文窗口', { code: 'context_limit', providerCode: 'context_length_exceeded' });
    throw new ProviderError('Codex 服务在流中报告错误', { code: 'stream_error' });
  }
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = event.item;
    if (!item || !KNOWN_ITEMS.has(item.type)) return out;
    const slot = slotOf(state, key, item.type);
    if (type === 'response.output_item.done') settleItem(slot, item);
    else {
      if (typeof item.id === 'string' && item.id) slot.id = item.id;
      if (item.type === 'reasoning') slot.item = { ...item };
      if (item.type === 'function_call') {
        for (const field of ['call_id', 'name']) if (typeof item[field] === 'string' && item[field]) slot[field] = item[field];
        if (typeof item.arguments === 'string') slot.arguments = item.arguments;
        // Display-only progress; the call itself waits for the terminal event.
        if (Number.isSafeInteger(key) && key >= 0 && slot.name) { slot.progress = key; out.push({ type: 'toolcall_start', index: key, ...(slot.call_id ? { id: slot.call_id } : {}), name: slot.name }); }
      }
    }
  } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    if (typeof event.delta !== 'string' || !event.delta) return out;
    // Text already shown stays shown: a delta without an announced item still belongs to the answer.
    const slot = slotOf(state, key, 'message', typeof event.item_id === 'string' ? { id: event.item_id } : {});
    slot.text += event.delta; out.push({ type: 'text_delta', delta: event.delta });
  } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    if (typeof event.delta === 'string' && event.delta) out.push({ type: 'thinking_delta', delta: event.delta });
  } else if (type === 'response.reasoning_summary_part.done') out.push({ type: 'thinking_delta', delta: '\n\n' });
  else if (type === 'response.function_call_arguments.delta') {
    const slot = state.slots.get(key);
    if (slot?.type !== 'function_call' || typeof event.delta !== 'string') return out;
    slot.arguments += event.delta;
    if (slot.progress !== undefined && event.delta) out.push({ type: 'toolcall_delta', index: slot.progress, ...(slot.call_id ? { id: slot.call_id } : {}), argumentsDelta: event.delta });
  } else if (type === 'response.function_call_arguments.done') {
    const slot = state.slots.get(key);
    if (slot?.type === 'function_call' && typeof event.arguments === 'string') { slot.arguments = event.arguments; slot.argumentsDone = true; }
  } else if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
    const response = event.response ?? {}, status = type === 'response.incomplete' ? 'incomplete' : response.status;
    // The terminal output fills gaps only: encrypted reasoning omitted from item.done, or items never streamed.
    if (Array.isArray(response.output)) {
      const known = new Map([...state.slots.values()].filter(slot => slot.id).map(slot => [slot.id, slot])), seen = new Set();
      for (const [index, item] of response.output.entries()) {
        if (!item || !KNOWN_ITEMS.has(item.type)) continue;
        if (typeof item.id === 'string' && item.id) { if (seen.has(item.id)) throw invalid('Codex 完成回执中的项目标识重复'); seen.add(item.id); }
        // The same item as streamed: by id, else by its output position, else the unpositioned slot of its kind.
        const unplaced = state.slots.get(undefined);
        const slot = [known.get(item.id), state.slots.get(index), unplaced].find(candidate => candidate?.type === item.type && (candidate !== unplaced || !candidate.id || candidate.id === item.id));
        if (!slot) { settleItem(slotOf(state, `terminal:${index}`, item.type), item); continue; }
        if (item.type === 'reasoning' && typeof item.encrypted_content === 'string' && typeof slot.item?.encrypted_content !== 'string') slot.item = { ...slot.item, ...item };
        else if (!slot.done) settleItem(slot, item);
      }
    }
    if (status === 'incomplete') {
      const reason = response.incomplete_details?.reason;
      if (reason !== 'max_output_tokens') throw new ProviderError('Codex 返回未完成的响应', { code: 'provider_termination', providerFinishReason: reason ?? 'incomplete' });
      state.stopReason = 'length'; state.providerFinishReason = 'max_output_tokens';
    } else if (['failed', 'cancelled'].includes(status)) throw new ProviderError('Codex 返回未完成的响应', { code: 'provider_termination', providerFinishReason: status });
    else { state.stopReason = 'stop'; state.providerFinishReason = 'completed'; }
    state.completed = true;
  }
  return out;
}
export function finishCodexResponse(state) {
  if (!state.completed) throw new ProviderError('Codex 流未提供完整的终止回执', { code: 'incomplete_stream' });
  const out = [], seen = new Set(), reasoning = [], toolItems = [], messages = [];
  for (const slot of state.slots.values()) {
    if (slot.type === 'function_call') {
      if (state.stopReason === 'length') throw invalid('Codex 工具片段在输出上限处中断');
      if (!slot.done && !slot.argumentsDone) throw invalid('Codex 工具调用没有完成回执');
      let args; try { args = JSON.parse(slot.arguments || '{}'); } catch { throw new ProviderError('Codex 工具参数不是合法 JSON', { code: 'invalid_tool_call' }); }
      if (!slot.call_id || seen.has(slot.call_id) || !slot.name || !args || typeof args !== 'object' || Array.isArray(args) || slot.status && slot.status !== 'completed') throw invalid('Codex 工具调用回执无效');
      if (slot.id) toolItems.push({ callId: slot.call_id, itemId: slot.id });
      seen.add(slot.call_id); out.push({ type: 'tool_call', id: slot.call_id, name: slot.name, arguments: args });
    } else if (slot.type === 'message') {
      // What was streamed is what the user saw; the item's final text only adds what the stream left out.
      const rest = typeof slot.finalText === 'string' && slot.finalText.startsWith(slot.text) ? slot.finalText.slice(slot.text.length) : '';
      if (rest) out.push({ type: 'text_delta', delta: rest });
      const text = slot.text + rest;
      if (text) messages.push({ ...(slot.id ? { id: slot.id } : {}), ...(slot.phase ? { phase: slot.phase } : {}), text });
    } else if (typeof slot.item?.encrypted_content === 'string') {
      const { item } = slot;
      reasoning.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: Array.isArray(item.summary) ? item.summary : [] });
    }
  }
  if (reasoning.length || toolItems.length || messages.length) out.push({ type: 'thinking_delta', delta: '' }, { type: 'thinking_signature', signature: signaturePrefix + Buffer.from(JSON.stringify({ version: 1, modelId: state.modelId, reasoning, toolItems, messages })).toString('base64url') });
  out.push({ type: 'done', stopReason: toolItems.length || seen.size ? 'toolUse' : state.stopReason, providerFinishReason: state.providerFinishReason }); return out;
}
