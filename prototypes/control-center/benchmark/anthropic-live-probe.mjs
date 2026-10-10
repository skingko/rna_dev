// Live probes for Rna's Claude (Anthropic Messages API) path (docs/planning/p1-specs-20261004/claude.md, "Probes
// needed" P1-P8; results: docs/research/claude-live-verification-20261010.md). The path shipped in 0.66.0 / 0.67.0
// from the documentation alone; this harness sends small real requests built by Rna's own SDK code (`buildRequest`,
// `streamCompletion`, `cacheKeepAlive`, `createSession`) and records what the API did with them: HTTP status, error
// bodies, `input_transformations`, usage (input / cache read / cache write / output / thinking tokens) and the shape
// of every response (content-block types and order). Every request goes through one recording fetch, so the evidence
// is the raw wire, not Rna's reading of it.
//
//   P1  conversation check: a tool turn, its tool_result turn, an unedited continuation, then the same history after a
//       deliberate edit under `error` (the documented 400), `drop_block` (a drop and a report), `unset` (is the account
//       enforced?) and a tampered signature (drop_block must not absorb it); Rna's own recovery from the 400.
//   P2  a multi-block agentic turn replayed with per-block signatures, display summarized and omitted.
//   P3  keep-tail compaction through a real session: thinking removed up to the floor, the next replies replayed.
//   P4  Opus 5.5 -> Sonnet 5.5 -> Opus 5.5 with every block kept (session model switch).
//   P5  mid-conversation system messages in Rna's shapes (trailing, historical, steer reorder) and effort-only markers.
//   P6  cache lookback: a turn that appends more than 20 positions, with and without the previous-tail breakpoint,
//       sent as `max_tokens: 0` keep-alive requests (prefill only, no output), so it also exercises keep-alive.
//   P7  not run (v2: deferred tool loading).
//   P8  `output_tokens_details.thinking_tokens` on the final message_delta and an `input_transformations` array on
//       every response when the beta header is sent (derived from the other probes' wire records).
//
// Key: the secrets file next to the app state (`RNA_STATE`, read-only; `RNA_PROVIDER_ID` when more than one Anthropic
// key is stored), else `ANTHROPIC_API_KEY`. It is read into memory only and never printed, written or put in a report;
// every string that leaves the process passes `redact`. Signatures are reported by length, never by value.
//
// Usage (Node 22):  RNA_STATE=/path/to/.state/state.json node anthropic-live-probe.mjs [P1 P2 ...] [--dry]
//   RNA_PROBE_OUT=file.json  also writes the sanitized report there.
//   --dry                    runs against the in-process fake endpoint (no network, no key): a harness self-check.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { buildRequest, streamCompletion, cacheKeepAlive } from '../../../packages/sdk/src/providers.mjs';
import { SYSTEM_PROMPT_UPDATE_LEAD } from '../../../packages/sdk/src/anthropic-history.mjs';

const BASE = { providerId: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 4000, reasoning: 'medium', input: ['text', 'image'], compat: { adaptiveThinking: true, thinkingDisplay: 'summarized' } };
export const OPUS = { ...BASE, modelId: 'claude-opus-5-5' };
export const SONNET = { ...BASE, modelId: 'claude-sonnet-5-5' };
const variant = (model, compat, reasoning) => ({ ...model, ...(reasoning ? { reasoning } : {}), compat: { ...model.compat, ...compat } });
const BETA_EFFORT = 'mid-conversation-output-config-2026-07-01';

// ---------------------------------------------------------------------------------------------------- credentials
export function loadKey(env = process.env) {
  // The app's stored key wins over a key in the shell: an ambient ANTHROPIC_API_KEY usually belongs to another tool.
  if (!env.RNA_STATE) { if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY; throw new Error('Set RNA_STATE (the app state file; its .secrets sibling is read) or ANTHROPIC_API_KEY.'); }
  const secrets = JSON.parse(readFileSync(`${env.RNA_STATE}.secrets`, 'utf8'));
  if (env.RNA_PROVIDER_ID) { const value = secrets[env.RNA_PROVIDER_ID]; if (typeof value !== 'string' || !value) throw new Error('No key stored for RNA_PROVIDER_ID.'); return value; }
  const found = Object.values(secrets).filter(value => typeof value === 'string' && value.startsWith('sk-ant-'));
  if (found.length !== 1) throw new Error(`Expected exactly one Anthropic key in the secrets file, found ${found.length}; set RNA_PROVIDER_ID.`);
  return found[0];
}

// ---------------------------------------------------------------------------------------------------- recording wire
const clip = (value, max = 300) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max)}...[${text.length}]` : text; };
function shapeOfMessages(messages = []) {
  return messages.map(message => {
    const blocks = typeof message.content === 'string' ? ['text'] : (message.content ?? []).map(block => block.type + (block.cache_control ? '*' : ''));
    const runs = []; for (const type of blocks) { if (runs.at(-1)?.[0] === type) runs.at(-1)[1]++; else runs.push([type, 1]); }
    return `${message.role}:${runs.map(([type, count]) => count > 1 ? `${type}x${count}` : type).join(',') || '-'}${message.output_config ? `{effort:${message.output_config.effort}}` : ''}`;
  });
}
function summarizeRequest(body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const marks = [];
  if (Array.isArray(body.system) && body.system.some(block => block.cache_control)) marks.push('system');
  (body.tools ?? []).forEach((tool, index) => { if (tool.cache_control) marks.push(`tools[${index}]`); });
  (body.messages ?? []).forEach((message, m) => (Array.isArray(message.content) ? message.content : []).forEach((block, b) => { if (block.cache_control) marks.push(`m${m}.c${b}`); }));
  return { model: body.model, max_tokens: body.max_tokens, stream: body.stream === true, thinking: body.thinking, output_config: body.output_config, beta: lower['anthropic-beta'], thinkingSent: (body.messages ?? []).reduce((sum, message) => sum + (Array.isArray(message.content) ? message.content.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking').length : 0), 0), tools: (body.tools ?? []).map(tool => tool.name), systemChars: Array.isArray(body.system) ? body.system.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) : 0, messages: shapeOfMessages(body.messages), breakpoints: marks };
}
const usageOf = raw => raw ? { input: raw.input_tokens ?? 0, cacheRead: raw.cache_read_input_tokens ?? 0, cacheWrite: raw.cache_creation_input_tokens ?? 0, output: raw.output_tokens ?? 0, ...(raw.output_tokens_details?.thinking_tokens !== undefined ? { thinking: raw.output_tokens_details.thinking_tokens } : {}) } : undefined;
function parseSse(text) {
  const events = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (data && data !== '[DONE]') { try { events.push(JSON.parse(data)); } catch { /* a partial frame at the end */ } }
  }
  return events;
}
function summarizeStream(events) {
  const blocks = [], sig = new Map(); let usage = {}, start, stop, stopDetails, startTransformations, deltaTransformations, errorEvent;
  for (const event of events) {
    if (event.type === 'message_start') { start = event.message; usage = { ...usage, ...(event.message?.usage ?? {}) }; startTransformations = event.message?.input_transformations; }
    else if (event.type === 'content_block_start') { const block = event.content_block ?? {}; blocks[event.index] = { type: block.type, ...(block.name ? { name: block.name } : {}), chars: (block.thinking ?? block.text ?? '').length, sigChars: (block.signature ?? '').length, ...(block.type === 'redacted_thinking' ? { dataChars: (block.data ?? '').length } : {}) }; }
    else if (event.type === 'content_block_delta') {
      const block = blocks[event.index]; if (!block) continue;
      if (event.delta?.type === 'thinking_delta') block.chars += (event.delta.thinking ?? '').length;
      else if (event.delta?.type === 'text_delta') block.chars += (event.delta.text ?? '').length;
      else if (event.delta?.type === 'signature_delta') { block.sigChars += (event.delta.signature ?? '').length; sig.set(event.index, true); }
      else if (event.delta?.type === 'input_json_delta') block.chars += (event.delta.partial_json ?? '').length;
    } else if (event.type === 'message_delta') { usage = { ...usage, ...(event.usage ?? {}) }; stop = event.delta?.stop_reason ?? stop; stopDetails = event.delta?.stop_details ?? stopDetails; deltaTransformations = event.input_transformations ?? event.delta?.input_transformations ?? deltaTransformations; }
    else if (event.type === 'error') errorEvent = event.error;
  }
  const transformations = [...(Array.isArray(startTransformations) ? startTransformations : []), ...(Array.isArray(deltaTransformations) ? deltaTransformations : [])].map(item => ({ type: item.type, reason: item.reason, path: item.path }));
  return { blocks: blocks.filter(Boolean), usage: usageOf(usage), usageKeys: Object.keys(usage), transformations, transformationsPresent: { start: Array.isArray(startTransformations), delta: Array.isArray(deltaTransformations) }, stop, ...(stopDetails ? { stopDetails: { category: stopDetails.category } } : {}), ...(errorEvent ? { streamError: { type: errorEvent.type, message: clip(errorEvent.message) } } : {}), messageId: start?.id !== undefined };
}

/** One recording fetch for every request of a run: `rows` keep the request summary, the status, the error body and
 * the parsed response. `label` names the next request. Nothing here keeps the key (only two headers are read). */
export function recorder(real = fetch) {
  const rows = []; const state = { label: 'request' };
  const recordedFetch = async (url, init = {}) => {
    const body = JSON.parse(init.body), row = { n: rows.length + 1, label: state.label, sent: summarizeRequest(body, init.headers) };
    rows.push(row);
    const response = await real(url, init);
    row.status = response.status;
    if (process.env.RNA_PROBE_TRACE) console.error(`#${row.n} ${row.label} -> ${row.status}`);
    const clone = response.clone();
    // Read the clone chunk by chunk: when Rna stops reading early (a refusal ends the turn) and aborts the request, the
    // part that arrived is still parsed.
    row.done = (async () => {
      let text = ''; const decoder = new TextDecoder();
      try { for await (const chunk of clone.body ?? []) text += decoder.decode(chunk, { stream: true }); } catch (error) { row.readError = error?.name ?? 'error'; }
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok) { try { const parsed = JSON.parse(text); row.error = { type: parsed.error?.type, message: clip(parsed.error?.message, 600) }; } catch { row.error = { message: clip(text, 300) }; } return; }
      if (type.includes('json')) { try { const parsed = JSON.parse(text); row.json = { stop: parsed.stop_reason, content: (parsed.content ?? []).length, usage: usageOf(parsed.usage), usageKeys: Object.keys(parsed.usage ?? {}), transformations: Array.isArray(parsed.input_transformations) ? parsed.input_transformations.map(item => ({ type: item.type, reason: item.reason, path: item.path })) : null }; } catch { row.error = { message: clip(text, 200) }; } return; }
      row.sse = summarizeStream(parseSse(text));
    })();
    if (process.env.RNA_PROBE_TRACE) row.done.then(() => console.error(`#${row.n} body read (${row.sse?.stop ?? row.error?.message ?? row.readError})`));
    return response;
  };
  return { rows, state, fetch: recordedFetch, label: value => { state.label = value; }, async settle(ms = 20000) { let timer; await Promise.race([Promise.allSettled(rows.map(row => row.done)), new Promise(resolve => { timer = setTimeout(resolve, ms); })]); clearTimeout(timer); } };
}
const brief = row => ({ n: row.n, label: row.label, status: row.status, ...(row.error ? { error: row.error } : {}), ...(row.readError ? { readError: row.readError } : {}), sent: { model: row.sent.model, thinking: row.sent.thinking, effort: row.sent.output_config?.effort, beta: row.sent.beta, max_tokens: row.sent.max_tokens, thinkingSent: row.sent.thinkingSent, messages: row.sent.messages, breakpoints: row.sent.breakpoints }, ...(row.sse ? { blocks: row.sse.blocks.map(block => `${block.type}${block.name ? `:${block.name}` : ''}(${block.chars}${block.sigChars ? `,sig${block.sigChars}` : ''})`), stop: row.sse.stop, ...(row.sse.stopDetails ? { stopDetails: row.sse.stopDetails } : {}), usage: row.sse.usage, transformations: row.sse.transformations, transformationsPresent: row.sse.transformationsPresent } : {}), ...(row.json ? { json: row.json } : {}) });

// ---------------------------------------------------------------------------------------------------- run helpers
const user = (text, extra = []) => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }, ...extra.map(value => ({ type: 'text', text: value }))] });
const system = text => ({ id: randomUUID(), role: 'system', source: 'system-prompt', contextKey: 'system-prompt', content: [{ type: 'text', text: `${SYSTEM_PROMPT_UPDATE_LEAD}\n${text}` }] });
const toolResults = (assistant, text = 'alpha beta gamma delta') => assistant.content.filter(part => part.type === 'toolCall').map(call => ({ id: randomUUID(), role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: `${text} (${call.arguments?.path ?? 'file'})` }] }));
const READ = { name: 'read', description: 'Read a UTF-8 text file from the workspace and return its contents.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path.' } }, required: ['path'], additionalProperties: false } };
const RULES = ['Prefer plain words over jargon', 'When a number is asked for, give the number first', 'Keep the tone friendly and calm', 'Answer the question that was asked before adding context', 'Use one short sentence unless more is requested', 'Name units with every measurement', 'Round only when the user asks for an estimate', 'Say so plainly when a file cannot be read', 'Quote file contents exactly when asked for a word', 'Avoid lists when one sentence will do', 'Spell out small numbers in prose and use digits in tables', 'Check arithmetic once more before answering'];
/** Deterministic, benign padding of about `tokens` tokens (4 characters per token, roughly), unique per `salt`, so each
 * probe owns its cache. It is a numbered answer-style guide on purpose: Opus 5.5 answered stop_reason "refusal" (cyber
 * category) on a harmless request padded with random word lists, and with generated narrative prose at ~6500 tokens
 * (4/4 requests, however the prose was framed), while this guide at the same length was answered 6/6. */
export function filler(salt, tokens) {
  let seed = [...salt].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7), out = `Answer style guide (${salt}), reference only:\n`, count = 0;
  const pick = list => { seed = (seed * 1664525 + 1013904223) >>> 0; return list[(seed >>> 8) % list.length]; };
  while (out.length < tokens * 4) out += `${++count}. ${pick(RULES)}; ${pick(RULES).toLowerCase()}.\n`;
  return out.trim();
}

function createContext({ key, dry, fakeFetch }) {
  const rec = recorder(dry ? fakeFetch : fetch);
  const redact = value => key ? String(value).split(key).join('[key]') : String(value);
  const context = { key: key ?? 'sk-ant-fixture-not-a-real-key', rec, dry, redact, from: 0, own: () => rec.rows.slice(context.from) };
  return context;
}
/** One streamed request through Rna's streamCompletion (recovery included); returns the assembled assistant message. */
async function ask(ctx, label, { model, systemPrompt, messages, tools = [], cache = { retention: 'short' }, maxOutputTokens = 3000 }) {
  ctx.rec.label(label); const from = ctx.rec.rows.length;
  const message = { id: randomUUID(), role: 'assistant', provider: model.providerId, model: model.modelId, content: [], usage: {} }, parts = new Map(), events = [];
  let error;
  try {
    for await (const event of streamCompletion({ model, apiKey: ctx.key, systemPrompt, messages, tools, cache, maxOutputTokens, fetch: ctx.rec.fetch, maxRetries: 0 })) {
      if (['text_delta', 'thinking_delta'].includes(event.type)) {
        const type = event.type === 'text_delta' ? 'text' : 'thinking', field = type === 'text' ? 'text' : 'thinking';
        let part = parts.get(event.blockIndex); if (part?.type !== type) { part = { type, [field]: '', blockIndex: event.blockIndex }; parts.set(event.blockIndex, part); message.content.push(part); }
        part[field] += event.delta ?? '';
      } else if (event.type === 'thinking_signature') { const part = parts.get(event.blockIndex); if (part?.type === 'thinking') part.signature = event.signature; }
      else if (event.type === 'redacted_thinking') message.content.push({ type: 'redactedThinking', data: event.data, blockIndex: event.blockIndex });
      else if (event.type === 'tool_call') message.content.push({ type: 'toolCall', id: event.id, name: event.name, arguments: event.arguments, blockIndex: event.blockIndex });
      else if (event.type === 'usage') message.usage = event.usage;
      else if (event.type === 'done') message.stopReason = event.stopReason;
      else if (['input_transformations', 'thinking_rebase', 'thinking_recovery'].includes(event.type)) events.push(event.type === 'input_transformations' ? { type: event.type, items: event.items?.map(item => ({ type: item.type, reason: item.reason, path: item.path, sourced: item.sourceMessageId !== undefined })) } : { type: event.type, reason: event.reason, recovery: event.recovery, path: event.path });
    }
  } catch (caught) { error = { code: caught.code, status: caught.status, message: ctx.redact(clip(caught.message)) }; }
  message.content.sort((a, b) => (a.blockIndex ?? 0) - (b.blockIndex ?? 0));
  await ctx.rec.settle();
  return { message, events, error, rows: ctx.rec.rows.slice(from) };
}
/** One request sent as built, with no recovery. `mutate(body, headers)` edits the wire form; `zero` makes it a
 * max_tokens 0, non-streaming (prefill-only) request. */
async function raw(ctx, label, input, { mutate, zero = false } = {}) {
  ctx.rec.label(label);
  const request = buildRequest(input), body = structuredClone(request.body), headers = { 'Content-Type': 'application/json', Accept: zero ? 'application/json' : 'text/event-stream', ...request.headers, 'x-api-key': ctx.key };
  if (zero) { body.max_tokens = 0; delete body.stream; }
  mutate?.(body, headers);
  const response = await ctx.rec.fetch(request.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const row = ctx.rec.rows.at(-1); await row.done; void response.body?.cancel().catch(() => {});
  return row;
}
const check = (probe, name, pass, detail) => { probe.checks.push({ name, pass: Boolean(pass), ...(detail !== undefined ? { detail } : {}) }); return pass; };
const emptyTransformations = row => row?.status === 200 && (row.sse ?? row.json)?.transformations?.length === 0;
const thinkingCount = message => message.content.filter(part => part.type === 'thinking' || part.type === 'redactedThinking').length;
const toolCount = message => message.content.filter(part => part.type === 'toolCall').length;
const bound = /^messages\.\d+\.content\.\d+: Invalid `signature` in `thinking` block\. The block is bound to a different conversation/;

// ---------------------------------------------------------------------------------------------------- probes
const SYSTEM = 'You are a terse assistant inside a test harness. Use the read tool when asked to read a file. Answer in one short sentence.';

async function p1(ctx) {
  const probe = { id: 'P1', title: 'Conversation check: edit under error / drop_block / unset, tampered signature, Rna recovery', steps: [], checks: [], notes: [] };
  const errorModel = variant(OPUS, { thinkingBindingMode: 'error' }, 'medium'), dropModel = variant(OPUS, { thinkingBindingMode: 'drop_block' }, 'medium'), unsetModel = variant(OPUS, { thinkingBindingMode: 'unset' }, 'medium');
  const salt = filler('p1', 30);
  const u1 = user(`Read the file notes.txt with the read tool, then tell me how many words it holds and whether that count is a prime number. (${salt})`);
  const first = await ask(ctx, 'P1 r1 tool turn (error)', { model: errorModel, systemPrompt: SYSTEM, messages: [u1], tools: [READ] });
  probe.steps.push(...first.rows.map(brief));
  check(probe, 'r1 status 200, beta header sent with block_binding error', first.rows.at(-1)?.status === 200 && first.rows.at(-1).sent.beta === 'thinking-binding-controls-2026-08-01' && first.rows.at(-1).sent.thinking?.block_binding?.prefix_mismatch_behavior === 'error', first.rows.at(-1)?.error);
  check(probe, 'r1 produced a tool call', toolCount(first.message) > 0, { content: first.message.content.map(part => part.type) });
  const a1 = first.message, t1 = toolResults(a1), history = [u1, a1, ...(t1.length ? t1 : [user('Please continue.')])];
  const second = await ask(ctx, 'P1 r2 tool_result turn (error)', { model: errorModel, systemPrompt: SYSTEM, messages: history, tools: [READ] });
  probe.steps.push(...second.rows.map(brief));
  check(probe, 'r2 (tool_result appended) status 200, no transformations', emptyTransformations(second.rows.at(-1)), second.rows.at(-1)?.error);
  const a2 = second.message, u2 = user('Now give the sum of the digits of that word count and say whether the sum is even. One short sentence.');
  const third = await ask(ctx, 'P1 r3 unedited continuation (error)', { model: errorModel, systemPrompt: SYSTEM, messages: [...history, a2, u2], tools: [READ] });
  probe.steps.push(...third.rows.map(brief));
  check(probe, 'r3 unedited continuation passes under error, no transformations', emptyTransformations(third.rows.at(-1)), third.rows.at(-1)?.error);
  probe.notes.push({ thinkingBlocksReplayed: { r2: second.rows.at(-1)?.sent.thinkingSent, r3: third.rows.at(-1)?.sent.thinkingSent }, note: 'a pass is only informative when the request replayed a thinking block' });
  const a3 = third.message;
  // The deliberate edit: the first user message changes, so every thinking block after it is bound to another conversation.
  const edited = [{ ...u1, content: [{ type: 'text', text: `${u1.content[0].text} Please be brief.` }] }, a1, ...t1, a2, u2, a3, user('Thanks. Reply with the single word ok.')];
  const editedRow = await raw(ctx, 'P1 r4 edit, mode error (raw)', { model: errorModel, systemPrompt: SYSTEM, messages: edited, tools: [READ], maxOutputTokens: 400 }, { zero: true });
  probe.steps.push(brief(editedRow));
  check(probe, 'edit under error is a 400 with the documented text', editedRow.status === 400 && bound.test(editedRow.error?.message ?? ''), editedRow.error);
  const recovery = await ask(ctx, 'P1 r5 edit, mode error, Rna recovery', { model: errorModel, systemPrompt: SYSTEM, messages: edited, tools: [READ], maxOutputTokens: 600 });
  probe.steps.push(...recovery.rows.map(brief)); probe.recoveryEvents = recovery.events;
  check(probe, 'Rna recovers from the 400 in one extra request (400 then 200, thinking_rebase binding_rejected)', recovery.rows.length === 2 && recovery.rows[0].status === 400 && recovery.rows[1].status === 200 && recovery.events.some(event => event.type === 'thinking_rebase' && event.reason === 'binding_rejected'), recovery.events);
  check(probe, 'the stripped retry carries no thinking block', recovery.rows[1]?.sent.messages.every(shape => !shape.includes('thinking')), recovery.rows[1]?.sent.messages);
  const dropped = await ask(ctx, 'P1 r6 edit, mode drop_block (Rna)', { model: dropModel, systemPrompt: SYSTEM, messages: edited, tools: [READ], maxOutputTokens: 600 });
  probe.steps.push(...dropped.rows.map(brief)); probe.dropEvents = dropped.events;
  const dropRow = dropped.rows.at(-1);
  check(probe, 'edit under drop_block is a 200 that reports thinking_dropped prefix_binding_mismatch', dropRow?.status === 200 && dropRow.sse?.transformations.some(item => item.type === 'thinking_dropped' && item.reason === 'prefix_binding_mismatch'), dropRow?.sse?.transformations);
  check(probe, 'the report resolves to source messages', dropped.events.some(event => event.type === 'input_transformations' && event.items?.every(item => item.sourced)), dropped.events);
  const unset = await raw(ctx, 'P1 r7 edit, mode unset (raw)', { model: unsetModel, systemPrompt: SYSTEM, messages: edited, tools: [READ], maxOutputTokens: 400 }, { zero: true });
  probe.steps.push(brief(unset));
  probe.enforcement = unset.status === 400 ? 'enforced (unset behaves as error)' : unset.json?.transformations?.some(item => item.type === 'thinking_mismatch_allowed') ? 'not enforced (mismatch allowed)' : `status ${unset.status}`;
  const intact = [...history, a2, u2, a3, user('Thanks. Reply with the single word ok.')];
  let touched = 0;
  const tampered = await raw(ctx, 'P1 r8 tampered signature, drop_block (raw)', { model: dropModel, systemPrompt: SYSTEM, messages: intact, tools: [READ], maxOutputTokens: 400 }, { zero: true, mutate: body => { for (const message of body.messages) if (message.role === 'assistant') for (const block of message.content) if (block.type === 'thinking' && block.signature && !touched) { block.signature = `${block.signature.slice(0, -6)}AAAAAA`; touched++; } } });
  probe.steps.push(brief(tampered));
  check(probe, 'the tamper changed a signature (the history carried thinking)', touched === 1, { thinkingSentByRow: tampered.sent.thinkingSent });
  check(probe, 'a tampered signature is a 400 that drop_block does not absorb (no "bound" text)', tampered.status === 400 && /Invalid `signature` in `thinking` block/.test(tampered.error?.message ?? '') && !/bound to a different conversation/.test(tampered.error?.message ?? ''), tampered.error);
  const beta = await raw(ctx, 'P1 r9 beta header without block_binding is accepted', { model: unsetModel, systemPrompt: SYSTEM, messages: intact, tools: [READ], maxOutputTokens: 400 }, { zero: true });
  probe.steps.push(brief(beta));
  check(probe, 'unset mode (beta header, no block_binding) on an unedited history is accepted', beta.status === 200, beta.error);
  return probe;
}

async function agenticRun(ctx, label, model, toolFiles, prompt) {
  const out = { steps: [], checks: [] }, u1 = user(prompt ?? `Read the files ${toolFiles.join(', ')} with the read tool, one call per file, and tell me the total number of words. Say briefly what you are about to do before each call.`);
  const messages = [u1]; let last;
  for (let step = 0; step < 5; step++) {
    const result = await ask(ctx, `${label} step ${step + 1}`, { model, systemPrompt: SYSTEM, messages, tools: [READ], maxOutputTokens: 4000 });
    out.steps.push(...result.rows.map(brief));
    if (result.error || !result.rows.length || result.rows.at(-1).status !== 200) { out.error = result.error ?? result.rows.at(-1)?.error; break; }
    messages.push(result.message); last = result.message;
    const results = toolResults(result.message, 'one two three four five six seven eight nine ten');
    if (!results.length) break; messages.push(...results);
  }
  if (last && !out.error) {
    const follow = await ask(ctx, `${label} follow-up replay`, { model, systemPrompt: SYSTEM, messages: [...messages, user('Which file had the most words? One short sentence.')], tools: [READ], maxOutputTokens: 1500 });
    out.steps.push(...follow.rows.map(brief)); out.follow = follow.rows.at(-1);
    if (follow.error) out.error = follow.error;
  }
  out.messages = messages;
  return out;
}
async function p2(ctx) {
  const probe = { id: 'P2', title: 'Multi-block agentic turn replayed with per-block signatures (summarized, omitted)', steps: [], checks: [], notes: [] };
  for (const display of ['summarized', 'omitted']) {
    const run = await agenticRun(ctx, `P2 ${display}`, variant(OPUS, { thinkingDisplay: display, thinkingBindingMode: 'drop_block' }), ['alpha.txt', 'beta.txt', 'gamma.txt']);
    probe.steps.push(...run.steps);
    const rows = run.steps.filter(step => step.status !== undefined);
    check(probe, `${display}: every request of the loop and the replay is 200 with an empty transformation list`, rows.length > 1 && rows.every(step => step.status === 200 && Array.isArray(step.transformations) && step.transformations.length === 0), rows.map(step => [step.status, step.transformations?.length]));
    const blocks = rows.flatMap(step => step.blocks ?? []);
    const thinking = blocks.filter(block => block.startsWith('thinking')), interleaved = rows.some(step => (step.blocks ?? []).some((block, index, all) => block.startsWith('thinking') && all.slice(0, index).some(prev => prev.startsWith('tool_use')) && all.slice(index + 1).some(next => next.startsWith('tool_use'))));
    probe.notes.push({ display, responses: rows.filter(step => step.blocks).map(step => step.blocks), progressThinkingBetweenToolUse: interleaved });
    if (display === 'omitted' && ctx.dry) probe.notes.push('omitted display is not modelled by the fake endpoint; the check runs live only');
    else if (display === 'omitted') check(probe, 'omitted: thinking blocks arrive with empty text and a signature', thinking.length > 0 && thinking.every(block => /^thinking\(0,sig\d+\)$/.test(block)), thinking.slice(0, 4));
    else check(probe, 'summarized: thinking blocks carry text and a signature', thinking.length > 0 && thinking.some(block => /^thinking\([1-9]\d*,sig\d+\)$/.test(block)), thinking.slice(0, 4));
    if (run.error) probe.notes.push({ display, error: run.error });
  }
  // Try to provoke several thinking blocks in one response: high effort and a task whose next step depends on the previous result.
  const deep = await agenticRun(ctx, 'P2 high effort', variant(OPUS, { thinkingDisplay: 'summarized', thinkingBindingMode: 'drop_block' }, 'high'), [], 'Read alpha.txt with the read tool. Depending on what it says, decide whether beta.txt or gamma.txt is the more useful second file, say which and why in one sentence, read it, and then compare the two word counts. Think about the decision before each call.');
  probe.steps.push(...deep.steps);
  const deepRows = deep.steps.filter(step => step.status !== undefined);
  check(probe, 'high effort: every request of the loop and the replay is 200 with an empty transformation list', deepRows.length > 1 && deepRows.every(step => step.status === 200 && Array.isArray(step.transformations) && step.transformations.length === 0), deepRows.map(step => [step.status, step.transformations?.length, step.error?.message]));
  probe.notes.push({ highEffortResponses: deepRows.filter(step => step.blocks).map(step => step.blocks), multiThinkingResponse: deepRows.some(step => (step.blocks ?? []).filter(block => block.startsWith('thinking')).length > 1) });
  // redacted_thinking: the documented trigger string makes the model answer with a redacted block; it must replay.
  const trigger = 'ANTHROPIC_MAGIC_STRING_TRIGGER_REDACTED_THINKING_46C9A13E193C177646C7398A98432ECCCE4C1253D5E2D82641AC0E52CC2876CB';
  const rm = variant(OPUS, { thinkingDisplay: 'summarized', thinkingBindingMode: 'drop_block' }, 'medium'), ru = user(`${trigger}\nWhat is 17 times 3? One short sentence.`);
  const redactedFirst = await ask(ctx, 'P2 redacted step 1', { model: rm, systemPrompt: SYSTEM, messages: [ru], maxOutputTokens: 1500 });
  probe.steps.push(...redactedFirst.rows.map(brief));
  const redacted = redactedFirst.message.content.filter(part => part.type === 'redactedThinking');
  probe.notes.push({ redactedBlocks: redacted.length, blocks: redactedFirst.rows.at(-1)?.sse?.blocks });
  if (redacted.length) {
    const replay = await ask(ctx, 'P2 redacted replay', { model: rm, systemPrompt: SYSTEM, messages: [ru, redactedFirst.message, user('And times 2? One short sentence.')], maxOutputTokens: 1500 });
    probe.steps.push(...replay.rows.map(brief));
    check(probe, 'a redacted_thinking block replays: 200, no transformations', emptyTransformations(replay.rows.at(-1)), replay.rows.at(-1)?.error);
    check(probe, 'the replay request carries the redacted block', (replay.rows.at(-1)?.sent.thinkingSent ?? 0) >= 1, replay.rows.at(-1)?.sent.messages);
  } else probe.notes.push('the trigger string produced no redacted_thinking block on this model; replay not exercised');
  return probe;
}

async function sessionProbe(ctx, { sessionId, model, systemPrompt }) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-claude-probe-')), emitted = [];
  const provider = Object.assign(input => streamCompletion({ ...input, fetch: ctx.rec.fetch, maxRetries: 0 }), { meteredBase: streamCompletion });
  const readTool = { name: 'read', effect: 'read', idempotent: true, description: READ.description, parameters: READ.parameters, execute: async (_id, args) => `alpha beta gamma delta epsilon (${args.path})` };
  const session = await createSession({ sessionId, projectId: 'probe', cwd: dir, stateDir: join(dir, 'state'), model, apiKey: ctx.key, provider, tools: [readTool], systemPrompt, autoCompaction: false, onEvent: event => { if (event.type === 'thinking_rebase') emitted.push({ reason: event.reason }); } });
  const journal = () => readFileSync(session.snapshot().sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { session, emitted, journal, dir, close: async () => { await session.dispose().catch(() => {}); rmSync(dir, { recursive: true, force: true }); } };
}
const rowsFrom = (ctx, from) => ctx.rec.rows.slice(from);
/** One session turn; a failure is recorded on the probe (with the refusal diagnostic when there is one) instead of ending the run. */
async function turn(ctx, probe, session, label, text) {
  ctx.rec.label(label);
  try { await session.prompt(text); return null; }
  catch (error) {
    const failure = { label, code: error.code, diagnostic: error.errorDiagnostic, finish: error.providerFinishReason, message: ctx.redact(clip(error.message)) };
    probe.notes.push({ turnError: failure }); return failure;
  }
}

/** A session probe can fail to exercise what it measures: Opus 5.5 can end a harmless turn with stop_reason "refusal"
 * (cyber category; seen on P3 and P4 in the first live run), and adaptive thinking can skip the thinking block a check
 * needs (`probe.unexercised`). Such an attempt is rerun once on a fresh session with another salt and other prompts; a
 * second one reports the probe as not exercised rather than failing its checks. */
function retryUnexercised(run) {
  return async ctx => {
    const skipped = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      ctx.from = ctx.rec.rows.length;
      const probe = await run(ctx, attempt), refused = probe.notes.filter(note => note.turnError?.finish === 'refusal').map(note => note.turnError.label);
      const reason = refused.length ? `model refusal on ${refused.join(', ')}` : probe.unexercised;
      if (!reason) { if (skipped.length) probe.notes.push({ unexercisedAttempts: skipped }); return probe; }
      skipped.push({ attempt, reason });
      if (attempt === 1) return { ...probe, notExercised: skipped.map(row => row.reason).join('; '), unexercisedChecks: probe.checks, checks: [], notes: [...probe.notes, { unexercisedAttempts: skipped }] };
    }
  };
}

async function p3(ctx, attempt = 0) {
  const probe = { id: 'P3', title: 'Keep-tail compaction through a real session: floor, thinking after the rebase replayed', steps: [], checks: [], notes: [] };
  const run = await sessionProbe(ctx, { sessionId: `p3-${attempt}`, model: variant(OPUS, { thinkingBindingMode: 'drop_block' }), systemPrompt: `${SYSTEM} ${filler(`p3-${attempt}`, 30)}` });
  try {
    const { session } = run; let from = ctx.rec.rows.length;
    await turn(ctx, probe, session, 'P3 prompt 1', 'Read notes.txt with the read tool and tell me its first word.');
    await turn(ctx, probe, session, 'P3 prompt 2', 'In one sentence: what did the file say overall?');
    await turn(ctx, probe, session, 'P3 prompt 3', 'What was the third word in it? One word.');
    await ctx.rec.settle();
    const before = rowsFrom(ctx, from); from = ctx.rec.rows.length;
    check(probe, 'pre-compaction requests all 200 with empty transformations', before.length >= 3 && before.every(emptyTransformations), before.map(row => [row.status, row.sse?.transformations?.length]));
    const compacted = await session.compact({ summary: 'Earlier: the user had the assistant read notes.txt; it holds the words alpha beta gamma delta epsilon.', keepLastTurns: 1 });
    probe.notes.push({ compacted: compacted.compacted, archivedMessages: compacted.archivedMessages, retainedMessages: compacted.retainedMessages });
    check(probe, 'manual compaction committed', compacted.compacted === true, compacted);
    const rebase = run.journal().filter(row => row.type === 'thinking_rebase').map(row => row.data.reason);
    check(probe, 'the compaction journaled a thinking rebase (reason compaction)', rebase.includes('compaction'), rebase);
    await turn(ctx, probe, session, 'P3 prompt 4 (after compaction)', ['Work this out carefully before answering: a ledger lists 13 entries of 5 letters each, and 7 more letters are added. How many letters in total? Reply with the number only.', 'Think it through before answering: a baker fills 12 trays with 6 rolls each and bakes 9 more rolls. How many rolls in total? Reply with the number only.'][attempt]);
    await turn(ctx, probe, session, 'P3 prompt 5 (replays thinking produced after the compaction)', ['Work this out carefully before answering: take that number, subtract 9, then multiply by 3. Reply with the number only.', 'Think it through before answering: halve that number, then add 4. Reply with the number only.'][attempt]);
    await ctx.rec.settle();
    const after = rowsFrom(ctx, from);
    probe.steps.push(...ctx.own().map(brief));
    check(probe, 'post-compaction requests all 200 with empty transformations', after.length >= 2 && after.every(emptyTransformations), after.map(row => [row.status, row.error?.message]));
    check(probe, 'the first request after the rebase carries no thinking block (floor), a summary is present', after[0] && after[0].sent.messages.every(shape => !shape.includes('thinking')), after[0]?.sent.messages);
    const thoughtAfter = after.slice(0, -1).some(row => row.sse?.blocks.some(block => block.type === 'thinking'));
    probe.notes.push({ thinkingProducedAfterCompaction: thoughtAfter });
    if (thoughtAfter) check(probe, 'the last request replays thinking produced after the compaction', after.at(-1)?.sent.messages.some(shape => shape.startsWith('assistant') && shape.includes('thinking')), after.at(-1)?.sent.messages);
    else probe.notes.push('the model produced no thinking after the compaction (adaptive thinking), so the replay check was not exercised');
    probe.notes.push({ rebases: rebase, events: run.emitted });
  } finally { await run.close(); }
  return probe;
}

async function p4(ctx, attempt = 0) {
  const probe = { id: 'P4', title: 'Opus 5.5 -> Sonnet 5.5 -> Opus 5.5 with every block kept', steps: [], checks: [], notes: [] };
  const opus = variant(OPUS, { thinkingBindingMode: 'drop_block' }, 'high'), sonnet = variant(SONNET, { thinkingBindingMode: 'drop_block' }, 'high');
  const run = await sessionProbe(ctx, { sessionId: `p4-${attempt}`, model: opus, systemPrompt: `${SYSTEM} ${filler(`p4-${attempt}`, 6500)}` });
  try {
    const { session } = run, mark = () => ctx.rec.rows.length;
    let from = mark(); await turn(ctx, probe, session, 'P4 opus turn 1', ['Read notes.txt with the read tool. Then think it through: how many letters does its first word have, and is that count prime? Answer in one sentence.', 'Use the read tool on notes.txt, then think it over: how many words does it hold, and is that number even? One sentence.'][attempt]);
    await ctx.rec.settle(); const opusRows = rowsFrom(ctx, from); from = mark();
    session.setModel(sonnet, { apiKey: ctx.key });
    // Adaptive thinking skipped a thinking block on "17 times 23" (live run 3); the Sonnet turn needs one, so it asks for a few steps.
    await turn(ctx, probe, session, 'P4 sonnet turn', ['Think it through step by step before answering: a train leaves at 9:47, travels 263 km at 84 km/h and stops twice for 6 minutes. At what time does it arrive, to the minute? One sentence.', 'Think it through step by step before answering: a tank holds 1350 litres, fills at 38 litres a minute and drains at 11 litres a minute. How many whole minutes until it is full from empty? One sentence.'][attempt]);
    await ctx.rec.settle(); const sonnetRows = rowsFrom(ctx, from); from = mark();
    session.setModel(opus, { apiKey: ctx.key });
    await turn(ctx, probe, session, 'P4 opus return', 'Think carefully: what is 29 times 31, and is the product prime? One sentence.');
    await ctx.rec.settle(); const backRows = rowsFrom(ctx, from);
    probe.steps.push(...ctx.own().map(brief));
    const produced = rows => rows.some(row => row.sse?.blocks.some(block => block.type === 'thinking'));
    if (!check(probe, 'precondition: Opus and Sonnet each produced a thinking block before the return (otherwise nothing is bound)', produced(opusRows) && produced(sonnetRows), { opus: produced(opusRows), sonnet: produced(sonnetRows) })) probe.unexercised = `no thinking block from ${produced(opusRows) ? 'Sonnet' : 'Opus'} before the return`;
    check(probe, 'every request is 200', ctx.own().length >= 3 && ctx.own().every(row => row.status === 200), ctx.own().map(row => [row.n, row.status, row.error?.message]));
    const reasons = [...new Set([...sonnetRows, ...backRows].flatMap(row => row.sse?.transformations ?? []).map(item => `${item.type}:${item.reason}`))];
    check(probe, 'the only transformations are model_binding_mismatch', reasons.every(reason => reason === 'thinking_dropped:model_binding_mismatch'), reasons);
    const lastBack = backRows.at(-1);
    probe.notes.push({ transformationReasons: reasons, sonnetTransformations: sonnetRows.map(row => row.sse?.transformations), backTransformations: backRows.map(row => row.sse?.transformations), usage: { opus: opusRows.map(row => row.sse?.usage), sonnet: sonnetRows.map(row => row.sse?.usage), back: backRows.map(row => row.sse?.usage) } });
    const thinkingProduced = [...opusRows, ...sonnetRows].reduce((sum, row) => sum + (row.sse?.blocks.filter(block => ['thinking', 'redacted_thinking'].includes(block.type)).length ?? 0), 0);
    check(probe, 'every thinking block produced before the return is sent on it (no thinking removed by Rna)', thinkingProduced > 0 && backRows[0]?.sent.thinkingSent === thinkingProduced, { produced: thinkingProduced, sent: backRows[0]?.sent.thinkingSent, messages: backRows[0]?.sent.messages });
    check(probe, 'the return to Opus reports no drop of Sonnet blocks (Opus reads Sonnet 5.5 blocks)', !(backRows.flatMap(row => row.sse?.transformations ?? []).length), backRows.map(row => row.sse?.transformations));
    check(probe, 'cache_read on the return to Opus is non-zero', (lastBack?.sse?.usage?.cacheRead ?? 0) > 0, lastBack?.sse?.usage);
  } finally { await run.close(); }
  return probe;
}

async function p5(ctx) {
  const probe = { id: 'P5', title: 'Mid-conversation system messages in Rna shapes; effort-only markers', steps: [], checks: [], notes: [] };
  const model = variant(OPUS, { thinkingBindingMode: 'drop_block' }), tools = [READ], sys = SYSTEM;
  const ctxBlocks = ['Context: the workspace holds notes.txt.', 'Context: today is a test day.'];
  const u1 = user('Read notes.txt with the read tool and tell me its first word.', ctxBlocks);
  const r1 = await ask(ctx, 'P5 r1 first request', { model, systemPrompt: sys, messages: [u1], tools, maxOutputTokens: 3000 });
  probe.steps.push(...r1.rows.map(brief));
  const a1 = r1.message, t1 = toolResults(a1);
  // The first revision lands while a user turn is pending: state order [.., user, system]; the wire puts system last.
  const sys1 = system('Answer in exactly one short sentence and mention the word brief.');
  const u2 = user('Say the last word of that file.');
  const r2 = await ask(ctx, 'P5 r2 trailing system message', { model, systemPrompt: sys, messages: [u1, a1, ...t1, u2, sys1], tools, maxOutputTokens: 3000 });
  probe.steps.push(...r2.rows.map(brief));
  const trailing = r2.rows.at(-1);
  check(probe, 'a trailing mid-conversation system message (Rna state order user, system) is accepted', trailing?.status === 200, trailing?.error);
  if (trailing?.status !== 200) probe.notes.push({ trailingRejected: trailing?.error });
  const a2 = r2.message;
  // Next turn: the system message now sits between a user turn and an assistant turn (the documented position).
  const u3 = user('Now name the file you read, one word.');
  const r3 = await ask(ctx, 'P5 r3 historical system message', { model, systemPrompt: sys, messages: [u1, a1, ...t1, u2, sys1, a2, u3], tools, maxOutputTokens: 3000 });
  probe.steps.push(...r3.rows.map(brief));
  check(probe, 'the system message in a historical position is accepted with every thinking block kept (no transformations)', emptyTransformations(r3.rows.at(-1)), r3.rows.at(-1)?.error ?? r3.rows.at(-1)?.sse?.transformations);
  const a3 = r3.message;
  // Steer: a user message claimed after a pending system message (state order user, system, user).
  const sys2 = system('From now on answer in French.'), steer = user('Also tell me how many words the file has.');
  const r4 = await raw(ctx, 'P5 r4 steer after system (reordered)', { model, systemPrompt: sys, messages: [u1, a1, ...t1, u2, sys1, a2, u3, a3, user('Thanks.'), sys2, steer], tools, maxOutputTokens: 400 }, { zero: true });
  probe.steps.push(brief(r4));
  check(probe, 'a steer user message claimed after a system message is reordered and accepted (no "system message not placed correctly")', r4.status === 200, r4.error);
  const history = [u1, a1, ...t1, u2, sys1, a2, u3, a3], tail = user('Reply with ok.');
  const marker = effort => ({ role: 'system', content: [], output_config: { effort } });
  const textSystem = text => ({ role: 'system', content: [{ type: 'text', text }] });
  const base = buildRequest({ model, systemPrompt: sys, messages: [...history, tail], tools, maxOutputTokens: 400 });
  const variants = [
    ['P5 e1 effort-only marker, trailing', body => { body.messages.push(marker('low')); }],
    ['P5 e2 text system then effort marker, trailing', body => { body.messages.push(textSystem('Be brief.'), marker('low')); }],
    ['P5 e3 effort marker then text system, trailing', body => { body.messages.push(marker('low'), textSystem('Be brief.')); }],
    ['P5 e4 effort marker before the assistant turn after sys1 (history)', body => { const at = body.messages.findIndex(message => message.role === 'system'); body.messages.splice(at + 1, 0, marker('low')); }],
    ['P5 e5 effort marker before sys1 (history)', body => { const at = body.messages.findIndex(message => message.role === 'system'); body.messages.splice(at, 0, marker('low')); }],
  ];
  for (const [label, mutate] of variants) {
    const without = await raw(ctx, `${label} (no beta)`, { model, systemPrompt: sys, messages: [...history, tail], tools, maxOutputTokens: 400 }, { zero: true, mutate });
    const withBeta = await raw(ctx, `${label} (beta ${BETA_EFFORT})`, { model, systemPrompt: sys, messages: [...history, tail], tools, maxOutputTokens: 400 }, { zero: true, mutate: (body, headers) => { mutate(body); headers['anthropic-beta'] = [headers['anthropic-beta'], BETA_EFFORT].filter(Boolean).join(','); } });
    probe.steps.push(brief(without), brief(withBeta));
    probe.notes.push({ variant: label, noBeta: { status: without.status, error: without.error?.message, transformations: without.json?.transformations }, withBeta: { status: withBeta.status, error: withBeta.error?.message, transformations: withBeta.json?.transformations } });
  }
  check(probe, 'the baseline (no marker) with max_tokens 0 is accepted', (await raw(ctx, 'P5 base zero', { model, systemPrompt: sys, messages: [...history, tail], tools, maxOutputTokens: 400 }, { zero: true })).status === 200);
  probe.notes.push({ perMessageEffortGeneratedBySdk: false, note: 'The SDK gates perMessageEffort but never emits an effort-only system message; these variants are hand-built bodies.', baseShape: shapeOfMessages(base.body.messages) });
  return probe;
}

async function p6(ctx) {
  const probe = { id: 'P6', title: 'Cache lookback past 20 positions with and without the previous-tail breakpoint (max_tokens 0 keep-alive requests)', steps: [], checks: [], notes: [] };
  const model = variant(OPUS, { thinkingBindingMode: 'drop_block' });
  async function scenario(name, { appended, previous }) {
    const salt = `p6-${name}-${randomUUID()}`, systemPrompt = `${SYSTEM}\n${filler(salt, 5200)}`, u1 = user(`Reference material:\n${filler(`${salt}-u1`, 2600)}`), a1 = { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] };
    const u2 = user('Please summarise.', Array.from({ length: appended }, (_, index) => `Context note ${index + 1}: ${filler(`${salt}-n${index}`, 40)}`));
    const sendKeepAlive = async (label, messages, cache) => {
      ctx.rec.label(label);
      try { const result = await cacheKeepAlive({ model, apiKey: ctx.key, systemPrompt, messages, tools: [READ], cache, fetch: ctx.rec.fetch }); await ctx.rec.settle(); return { usage: result.usage, row: ctx.rec.rows.at(-1) }; }
      catch (error) { await ctx.rec.settle(); return { error: { code: error.code, message: ctx.redact(clip(error.message)) }, row: ctx.rec.rows.at(-1) }; }
    };
    const first = await sendKeepAlive(`P6 ${name} r1 cold write`, [u1], { retention: 'short' });
    const second = await sendKeepAlive(`P6 ${name} r2 append ${appended} blocks`, [u1, a1, u2], { retention: 'short', ...(previous ? { previousTailMessageId: u1.id } : {}) });
    probe.steps.push(brief(first.row), brief(second.row));
    return { first: first.row?.json?.usage, second: second.row?.json?.usage, error: first.error ?? second.error, breakpoints: second.row?.sent.breakpoints };
  }
  const results = {};
  for (const [name, options] of [['near', { appended: 4, previous: false }], ['far-with-prev', { appended: 26, previous: true }], ['far-without-prev', { appended: 26, previous: false }]]) results[name] = await scenario(name, options);
  probe.notes.push(results);
  check(probe, 'max_tokens 0 requests (keep-alive shape) are accepted on Opus 5.5 with adaptive thinking', Object.values(results).every(result => !result.error && result.first), Object.values(results).map(result => result.error));
  const write = results.near?.first?.cacheWrite ?? 0;
  check(probe, 'the first request writes the cache (prefix is above the minimum cacheable length)', write > 0, results.near?.first);
  check(probe, 'near (4 appended blocks, no previous breakpoint): the previous entry is found within the lookback', (results.near?.second?.cacheRead ?? 0) >= write * 0.9, results.near?.second);
  check(probe, 'far (26 appended blocks) with the previous-tail breakpoint reads the previous request', (results['far-with-prev']?.second?.cacheRead ?? 0) >= (results['far-with-prev']?.first?.cacheWrite ?? 1) * 0.9, results['far-with-prev']?.second);
  check(probe, 'far without the previous-tail breakpoint reads less (the lookback is exceeded)', (results['far-without-prev']?.second?.cacheRead ?? 0) < (results['far-with-prev']?.second?.cacheRead ?? 0), { with: results['far-with-prev']?.second, without: results['far-without-prev']?.second });
  return probe;
}

function p8(ctx) {
  const probe = { id: 'P8', title: 'thinking_tokens on message_delta and input_transformations on every response (derived from the recorded wire)', steps: [], checks: [], notes: [] };
  const ok = ctx.rec.rows.filter(row => row.status === 200 && (row.sse || row.json));
  const betaRows = ok.filter(row => row.sent.beta?.includes('thinking-binding-controls') && row.sent.thinking);
  const streamed = betaRows.filter(row => row.sse && row.sent.model === OPUS.modelId);
  check(probe, 'a successful response carries an input_transformations array when the beta header is sent (stream: message_start or message_delta)', streamed.length > 0 && streamed.every(row => row.sse.transformationsPresent.start || row.sse.transformationsPresent.delta), { responses: streamed.length, onStart: streamed.filter(row => row.sse.transformationsPresent.start).length, onDelta: streamed.filter(row => row.sse.transformationsPresent.delta).length });
  const withThinking = streamed.filter(row => row.sse.blocks.some(block => block.type === 'thinking'));
  check(probe, 'usage.output_tokens_details.thinking_tokens is on the final message_delta whenever Opus 5.5 produced a thinking block', withThinking.length > 0 && withThinking.every(row => Number.isFinite(row.sse.usage?.thinking)), { responses: withThinking.length, withTokens: withThinking.filter(row => Number.isFinite(row.sse.usage?.thinking)).length });
  const nonStream = betaRows.filter(row => row.json);
  probe.notes.push({ usageKeysSample: streamed[0]?.sse.usageKeys, nonStreamingResponses: nonStream.length, nonStreamingTransformationsPresent: nonStream.filter(row => Array.isArray(row.json.transformations)).length });
  return probe;
}

/** P9: which index a thinking-rejection 400 names. The error text says `messages.N.content.M`; the request's
 * `messages` array and the server's own view can differ (a tool_result user message folded into the assistant turn).
 * Blocks with an obviously invalid signature are enough: the API answers 400 and names the position of the first one. */
async function p9(ctx) {
  const probe = { id: 'P9', title: 'Which index a thinking-rejection 400 names (wire array vs folded view)', steps: [], checks: [], notes: [] };
  const model = variant(OPUS, { thinkingBindingMode: 'drop_block' });
  const bad = { type: 'thinking', thinking: 'x', signature: 'A'.repeat(220) };
  const text = value => ({ type: 'text', text: value }), tu = id => ({ type: 'tool_use', id, name: 'read', input: { path: 'a' } }), tr = id => ({ type: 'tool_result', tool_use_id: id, content: 'x' });
  const U = content => ({ role: 'user', content }), A = content => ({ role: 'assistant', content });
  const cases = [
    ['plain turns', [U([text('q')]), A([bad, text('a')]), U([text('q2')])]],
    ['one tool round', [U([text('q')]), A([tu('toolu_1')]), U([tr('toolu_1')]), A([bad, text('a')]), U([text('q2')])]],
    ['parallel tools', [U([text('q')]), A([tu('toolu_1'), tu('toolu_2')]), U([tr('toolu_1'), tr('toolu_2')]), A([bad, text('a')]), U([text('q2')])]],
    ['tool_result plus text', [U([text('q')]), A([tu('toolu_1')]), U([tr('toolu_1'), text('note')]), A([bad, text('a')]), U([text('q2')])]],
    ['two tool rounds', [U([text('q')]), A([tu('toolu_1')]), U([tr('toolu_1')]), A([tu('toolu_2')]), U([tr('toolu_2')]), A([bad, text('a')]), U([text('q2')])]],
    ['text turn after a tool round', [U([text('q')]), A([tu('toolu_1')]), U([tr('toolu_1')]), A([text('a')]), U([text('q2')]), A([bad, text('b')]), U([text('q3')])]],
    ['thinking before the tool call', [U([text('q')]), A([bad, tu('toolu_1')]), U([tr('toolu_1')]), A([text('a')]), U([text('q2')])]],
  ];
  const named = [];
  for (const [name, wire] of cases) {
    const row = await raw(ctx, `P9 ${name}`, { model, systemPrompt: SYSTEM, messages: [user('x')], tools: [READ], maxOutputTokens: 400 }, { zero: true, mutate: body => { body.messages = structuredClone(wire); } });
    const match = /^messages\.(\d+)\.content\.(\d+):/.exec(row.error?.message ?? '');
    const at = wire.findIndex(message => message.role === 'assistant' && message.content.includes(bad)), wireIndex = `${at}.${wire[at].content.indexOf(bad)}`;
    // Hypothesis: a user message made only of tool_result blocks is folded into the assistant message before it.
    let folded = []; for (const message of structuredClone(wire)) { if (message.role === 'user' && message.content.every(block => block.type === 'tool_result') && folded.at(-1)?.role === 'assistant') folded.at(-1).content.push(...message.content); else if (message.role === 'assistant' && folded.at(-1)?.role === 'assistant') folded.at(-1).content.push(...message.content); else folded.push(message); }
    const fAt = folded.findIndex(message => message.role === 'assistant' && message.content.some(block => block.signature === bad.signature)), foldedIndex = `${fAt}.${folded[fAt].content.findIndex(block => block.signature === bad.signature)}`;
    named.push({ case: name, status: row.status, named: match ? `${match[1]}.${match[2]}` : null, wireIndex, foldedIndex, message: row.error?.message });
    probe.steps.push(brief(row));
  }
  probe.notes.push({ cases: named });
  check(probe, 'every case is a 400 that names a position', named.every(row => row.status === 400 && row.named), named);
  check(probe, 'the named position is the folded-view index in every case (tool_result user messages merged into the assistant turn)', named.every(row => row.named === row.foldedIndex), named.map(row => [row.case, row.named, row.foldedIndex]));
  // The wire index is the other reading; it differs from the folded one exactly where a tool round precedes the block.
  probe.notes.push({ namedIsWireIndex: named.map(row => [row.case, row.named === row.wireIndex]) });
  return probe;
}

const PROBES = { P1: p1, P2: p2, P3: retryUnexercised(p3), P4: retryUnexercised(p4), P5: p5, P6: p6, P9: p9 };

// ---------------------------------------------------------------------------------------------------- main
async function dryFetch() {
  const { createFakeAnthropic } = await import('../../../packages/sdk/test/fixtures/fake-anthropic.mjs');
  const fake = createFakeAnthropic({ reads: { 'claude-opus-5-5': ['claude-sonnet-5-5'] }, respond: body => {
    const lastUser = body.messages.at(-1), text = JSON.stringify(lastUser?.content ?? '');
    return /\bRead\b[^"]*\b(notes\.txt|files)\b/i.test(JSON.stringify(body.messages[0])) && lastUser.role === 'user' && body.tools?.length && !body.messages.some(message => message.role === 'assistant') ? [{ thinking: 'I will read the file.' }, { tool: { id: 'toolu_dry1', name: 'read', input: { path: 'notes.txt' } } }] : [{ thinking: 'Answering.' }, { text: `ok ${text.length}` }];
  } });
  return fake.fetch;
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const dry = argv.includes('--dry'), selected = argv.filter(arg => /^P\d$/.test(arg)), names = selected.length ? selected : Object.keys(PROBES);
  const key = dry ? undefined : loadKey(env), ctx = createContext({ key, dry, fakeFetch: dry ? await dryFetch() : undefined });
  const report = { startedAt: new Date().toISOString(), dry, models: { opus: OPUS.modelId, sonnet: SONNET.modelId }, probes: [] };
  for (const name of names) {
    if (name === 'P8') continue;
    const probe = PROBES[name]; if (!probe) { console.error(`Unknown probe ${name}`); continue; }
    const startRows = ctx.from = ctx.rec.rows.length;
    try { const result = await probe(ctx); report.probes.push(result); }
    catch (error) { await ctx.rec.settle(); report.probes.push({ id: name, error: { code: error.code, message: ctx.redact(clip(error.message, 500)) }, steps: ctx.rec.rows.slice(startRows).map(brief), checks: [] }); }
    const last = report.probes.at(-1);
    console.log(ctx.redact(last.notExercised ? `${last.id}: not exercised (${last.notExercised})` : `${last.id}: ${last.checks.filter(item => item.pass).length}/${last.checks.length} checks${last.error ? ` (aborted: ${last.error.message})` : ''}`));
    for (const item of last.checks) console.log(ctx.redact(`  ${item.pass ? 'pass' : 'FAIL'}  ${item.name}`));
  }
  if (names.length > 1 || names.includes('P8')) { await ctx.rec.settle(); report.probes.push(p8(ctx)); const last = report.probes.at(-1); console.log(`P8: ${last.checks.filter(item => item.pass).length}/${last.checks.length} checks`); for (const item of last.checks) console.log(`  ${item.pass ? 'pass' : 'FAIL'}  ${item.name}`); }
  report.requests = ctx.rec.rows.length;
  const text = ctx.redact(JSON.stringify(report, null, 2));
  if (env.RNA_PROBE_OUT) writeFileSync(env.RNA_PROBE_OUT, text, { mode: 0o600 });
  else console.log(text);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
