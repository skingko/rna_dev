// An in-process Anthropic Messages endpoint for preserved-thinking and caching tests. It streams documented SSE and
// enforces the documented conversation check, so a harness that edits history fails here the way it would on an
// enforced account (accounts created on or after 2026-08-31):
// - every thinking / redacted-thinking block is bound to its model, the prefix that produced it (top-level system,
//   the name-sorted tool set, every message before it with thinking removed, earlier non-thinking blocks of its own
//   message) and the previous thinking block (a chain; only the first block of a request may lose its predecessor);
// - `prefix_mismatch_behavior` 'error' (or unset on an enforced account) answers the documented 400; 'drop_block'
//   drops the failing block and every later one and reports `input_transformations`; an unknown signature is the
//   tampered 400 that drop_block never absorbs; another model's block is dropped silently (model_binding_mismatch);
// - request validation: `block_binding` needs the beta header, system-message placement, no assistant prefill,
//   `max_tokens: 0` only without streaming;
// - prompt caching: render positions (runs of tool_use / tool_result blocks collapse), up to four breakpoints, a
//   20-position lookback, TTL on an injected clock, usage counts.
// No network, no key: requests never leave the process.
import { createHmac, createHash } from 'node:crypto';

export const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const json = value => JSON.stringify(sorted(value));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex');
const stripCache = value => Array.isArray(value) ? value.map(stripCache) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, stripCache(item)])) : value;
const isThinking = block => block?.type === 'thinking' || block?.type === 'redacted_thinking';
const tokens = value => Math.max(1, Math.ceil(Buffer.byteLength(json(stripCache(value))) / 4));
const contentOf = message => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
// A rejected block is named in the API's validation view, where a user message holding only tool_result blocks continues
// the assistant turn around it (measured live, P9); input_transformations paths stay wire positions.
function rejectionPath(messages, m, b) {
  let group = -1, offset = 0, open = false;
  for (const [index, message] of messages.slice(0, m + 1).entries()) {
    const blocks = contentOf(message), results = message.role === 'user' && blocks.length > 0 && blocks.every(block => block.type === 'tool_result');
    if (!(open && (message.role === 'assistant' || results))) { group++; offset = 0; }
    open = message.role === 'assistant' || open && results;
    if (index < m) offset += blocks.length;
  }
  return `messages.${group}.content.${offset + b}`;
}

export function createFakeAnthropic({ secret = 'fake-anthropic-secret', respond, now = () => Date.now(), enforced = true, reads = {}, failures = [] } = {}) {
  const signatures = new Map(), cache = new Map(), requests = [], responses = [], errors = [];
  let calls = 0, scripted = 0;
  const sign = (model, prefix, prev, kind) => { const signature = `${kind}:${createHmac('sha256', secret).update(json([model, prefix, prev])).digest('base64url')}`; signatures.set(signature, { model, prefix, prev }); return signature; };
  const keyOf = block => block.type === 'thinking' ? block.signature : block.data;
  const toolSet = tools => (tools ?? []).map(stripCache).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const systemText = system => typeof system === 'string' ? system : (system ?? []).map(block => block.text).join('\n');
  // The prefix a block at messages[m].content[b] is bound to.
  const prefixOf = (body, m, b, ownBlocks) => hash([systemText(body.system), toolSet(body.tools), body.messages.slice(0, m).map(message => ({ role: message.role, content: contentOf(stripCache(message)).filter(block => !isThinking(block)), ...(message.output_config ? { output_config: message.output_config } : {}) })), (ownBlocks ?? contentOf(stripCache(body.messages[m] ?? { content: [] })).slice(0, b)).filter(block => !isThinking(block))]);
  const error = (status, type, message) => { errors.push({ status, type, message }); if (requests.at(-1)) requests.at(-1).status = status; return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } }); };

  function validate(body, headers) {
    const beta = String(headers['anthropic-beta'] ?? '').split(',').map(value => value.trim());
    if (body.thinking?.block_binding && !beta.includes(BINDING_BETA)) return 'block_binding: Extra inputs are not permitted';
    if (body.max_tokens === 0 && body.stream) return 'max_tokens: 0 is not supported with stream: true';
    if (!Array.isArray(body.messages) || !body.messages.length) return 'messages: at least one message is required';
    if (body.messages.at(-1).role === 'assistant') return 'This model does not support assistant message prefill. The conversation must end with a user message.';
    for (const [index, message] of body.messages.entries()) {
      if (message.role !== 'system') continue;
      if (index === 0) return `messages.${index}: a system message cannot be the first message`;
      let before = index - 1; while (before >= 0 && body.messages[before].role === 'system') before--;
      const after = body.messages[index + 1]?.role;
      if (body.messages[before]?.role !== 'user' || after !== undefined && !['assistant', 'system'].includes(after)) return `messages.${index}: system message not placed correctly`;
    }
    return null;
  }

  // The conversation check over the request as sent. The chain runs over the blocks as sent (a block the model
  // cannot read still links its neighbours); only the first block of a request may lose its predecessor, so a gap
  // or a block put back in front of a later one fails. Returns { error } or { dropped, transformations, previous }.
  function check(body, beta) {
    const mode = body.thinking?.block_binding?.prefix_mismatch_behavior ?? (enforced ? 'error' : 'allow');
    const transformations = [], dropped = new Set();
    let previous = null, first = true, dropping = false;
    for (const [m, message] of body.messages.entries()) {
      if (message.role !== 'assistant') continue;
      for (const [b, block] of contentOf(message).entries()) {
        if (!isThinking(block)) continue;
        const path = `messages.${m}.content.${b}`, rejected = rejectionPath(body.messages, m, b), key = keyOf(block), record = signatures.get(key);
        if (!record) return { error: `${rejected}: Invalid \`signature\` in \`${block.type}\` block.` };
        const linked = first || record.prev === previous; previous = key; const wasFirst = first; first = false;
        if (record.model !== body.model && !(reads[body.model] ?? []).includes(record.model)) { dropped.add(key); transformations.push({ type: 'thinking_dropped', path, reason: 'model_binding_mismatch' }); continue; }
        if (dropping) { dropped.add(key); transformations.push({ type: 'thinking_dropped', path, reason: 'prefix_binding_mismatch' }); continue; }
        const prefixOk = record.prefix === prefixOf(body, m, b), chainOk = wasFirst || linked;
        if (!prefixOk || !chainOk) {
          if (mode === 'error') return { error: `${rejected}: Invalid \`signature\` in \`${block.type}\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".${beta ? '' : ` That setting requires the \`${BINDING_BETA}\` value in the \`anthropic-beta\` header.`}` };
          if (mode === 'drop_block') { dropping = true; dropped.add(keyOf(block)); transformations.push({ type: 'thinking_dropped', path, reason: 'prefix_binding_mismatch' }); continue; }
          transformations.push({ type: 'thinking_mismatch_allowed', path, reason: 'prefix_binding_mismatch' });
        }
      }
    }
    return { dropped, transformations, previous };
  }

  // Render positions for caching: system/tools first, then every content block; runs collapse.
  function positions(body) {
    const rows = [{ key: hash([toolSet(body.tools), systemText(body.system)]), marked: (body.tools ?? []).some(tool => tool.cache_control) || (Array.isArray(body.system) && body.system.some(block => block.cache_control)), size: tokens([body.tools ?? [], body.system ?? '']) }];
    let running = rows[0].key;
    for (const message of body.messages) for (const block of contentOf(message)) {
      const last = rows.at(-1), run = ['tool_use', 'tool_result'].includes(block.type) && last.type === block.type;
      running = hash([running, message.role, stripCache(block)]);
      if (run) { last.key = running; last.size += tokens(block); last.marked ||= Boolean(block.cache_control); if (block.cache_control?.ttl === '1h') last.ttl = 3600000; continue; }
      rows.push({ key: running, type: block.type, marked: Boolean(block.cache_control), size: tokens(block), ttl: block.cache_control?.ttl === '1h' ? 3600000 : 300000 });
    }
    return rows;
  }
  function cacheUsage(body) {
    const rows = positions(body), at = now();
    for (const [key, entry] of cache) if (entry.expires <= at) cache.delete(key);
    const cumulative = []; rows.reduce((sum, row, index) => (cumulative[index] = sum + row.size), 0);
    const breakpoints = rows.flatMap((row, index) => row.marked ? [index] : []);
    let read = 0;
    for (const index of breakpoints) for (let back = index; back >= Math.max(0, index - 19); back--) {
      const entry = cache.get(rows[back].key);
      if (entry) { read = Math.max(read, cumulative[back]); entry.expires = at + entry.ttl; break; }
    }
    const lastBreakpoint = breakpoints.at(-1) ?? -1, written = lastBreakpoint >= 0 ? Math.max(0, cumulative[lastBreakpoint] - read) : 0;
    for (const index of breakpoints) { const ttl = rows[index].ttl ?? 300000, entry = cache.get(rows[index].key); if (entry) entry.expires = Math.max(entry.expires, at + ttl); else cache.set(rows[index].key, { expires: at + ttl, ttl }); }
    const total = cumulative.at(-1);
    return { input_tokens: Math.max(0, total - read - written), cache_read_input_tokens: read, cache_creation_input_tokens: written, breakpoints: breakpoints.length };
  }

  function sse(events) {
    const text = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  async function fetch(url, init = {}) {
    const index = calls++, headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = JSON.parse(init.body), beta = String(headers['anthropic-beta'] ?? '').split(',').map(value => value.trim()).includes(BINDING_BETA);
    const record = { url, headers, body: structuredClone(body) }; requests.push(record);
    const failure = failures.find(row => row.call === index);
    if (failure?.network) { record.status = 'network'; throw new TypeError('fetch failed'); }
    if (failure?.status) return error(failure.status, failure.type ?? 'api_error', failure.message ?? 'injected failure');
    const invalid = validate(body, headers);
    if (invalid) return error(400, 'invalid_request_error', invalid);
    const verdict = check(body, beta);
    if (verdict.error) return error(400, 'invalid_request_error', verdict.error);
    const usage = cacheUsage(body);
    if (body.max_tokens === 0) {
      responses.push({ keepAlive: true, usage }); record.status = 200; record.keepAlive = true;
      return new Response(JSON.stringify({ id: `msg_${index}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: 'max_tokens', usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const script = (typeof respond === 'function' ? respond(body, scripted++, index) : respond?.[scripted++]) ?? [{ text: 'ok' }];
    // Generate signed blocks against the request as received (dropped blocks are not part of the chain).
    const own = [], events = [], content = [];
    let previous = verdict.previous ?? null;
    const message = { id: `msg_${index}`, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, output_tokens: 1 }, ...(beta ? { input_transformations: verdict.transformations } : {}) };
    events.push({ type: 'message_start', message });
    let toolUse = false, thinkingTokens = 0;
    for (const [position, item] of script.entries()) {
      if (item.thinking !== undefined || item.progress !== undefined) {
        const text = item.thinking ?? item.progress ?? '';
        const prefix = prefixOf({ ...body, messages: [...body.messages, { role: 'assistant', content: own }] }, body.messages.length, own.length, own);
        const signature = sign(body.model, prefix, previous, 'sig'); previous = signature; thinkingTokens += Math.max(1, text.length);
        events.push({ type: 'content_block_start', index: position, content_block: { type: 'thinking', thinking: '', signature: '' } });
        if (text) events.push({ type: 'content_block_delta', index: position, delta: { type: 'thinking_delta', thinking: text } });
        if (item.splitSignature) { events.push({ type: 'content_block_delta', index: position, delta: { type: 'signature_delta', signature: signature.slice(0, 10) } }, { type: 'content_block_delta', index: position, delta: { type: 'signature_delta', signature: signature.slice(10) } }); }
        else events.push({ type: 'content_block_delta', index: position, delta: { type: 'signature_delta', signature } });
        events.push({ type: 'content_block_stop', index: position });
        const block = { type: 'thinking', thinking: text, signature }; own.push(block); content.push(block);
      } else if (item.redacted) {
        const prefix = prefixOf({ ...body, messages: [...body.messages, { role: 'assistant', content: own }] }, body.messages.length, own.length, own);
        const data = sign(body.model, prefix, previous, 'red'); previous = data;
        events.push({ type: 'content_block_start', index: position, content_block: { type: 'redacted_thinking', data } }, { type: 'content_block_stop', index: position });
        const block = { type: 'redacted_thinking', data }; own.push(block); content.push(block);
      } else if (item.text !== undefined) {
        events.push({ type: 'content_block_start', index: position, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: position, delta: { type: 'text_delta', text: item.text } }, { type: 'content_block_stop', index: position });
        const block = { type: 'text', text: item.text }; own.push(block); content.push(block);
      } else if (item.tool) {
        toolUse = true;
        events.push({ type: 'content_block_start', index: position, content_block: { type: 'tool_use', id: item.tool.id, name: item.tool.name, input: {} } }, { type: 'content_block_delta', index: position, delta: { type: 'input_json_delta', partial_json: JSON.stringify(item.tool.input ?? {}) } }, { type: 'content_block_stop', index: position });
        const block = { type: 'tool_use', id: item.tool.id, name: item.tool.name, input: item.tool.input ?? {} }; own.push(block); content.push(block);
      }
    }
    const stopReason = script.stopReason ?? (toolUse ? 'tool_use' : 'end_turn');
    events.push({ type: 'message_delta', delta: { stop_reason: stopReason, ...(script.stopDetails ? { stop_details: script.stopDetails } : {}) }, usage: { output_tokens: 10, ...(thinkingTokens ? { output_tokens_details: { thinking_tokens: thinkingTokens } } : {}) } }, { type: 'message_stop' });
    responses.push({ content, usage, transformations: verdict.transformations, stopReason }); Object.assign(record, { status: 200, response: content, usage, transformations: verdict.transformations });
    return sse(events);
  }
  return { fetch, requests, responses, errors, cache, signatures, get calls() { return calls; } };
}
