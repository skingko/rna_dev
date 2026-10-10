// D4 scenario harness: the faux model (plan A7; pi test-harness.ts:1-60 `createFauxStreamFn`: declarative response
// sequencing over a real session, every request kept for assertions). Only the model is fake: the SDK session, tools,
// journal, host and wire format are real.
//
// One script serves two mounts, so every model purpose reaches the same faux model:
//  - `provider(tag)`: an SDK provider (the `streamCompletion` contract) for the host's injection points: createServer's
//    runtimeFactory (foreground turns), the initiative's decision/worker/mind providers;
//  - `http`: an OpenAI-compatible chat-completions server, configured as the default model's base URL, for every
//    purpose the host calls with the real `streamCompletion` (idle compaction, subagents, anything not injected).
//    Its requests are recorded under the tag 'http' with their wire body.
//
// A response is pi's FauxResponse in Rna's event vocabulary:
//   'text'                                   shorthand for { text }
//   { text, thinking, toolCalls: [{ id?, name, args }], usage, stopReason, chunks, chunkMs, delayMs, hold, error }
//   (request, context) => response          computed from the request (context: { tag, index, faux })
// `chunks` splits the text into that many deltas `chunkMs` apart (display ticks and SSE deltas happen meanwhile);
// `hold` is a promise awaited before the response starts; `error` fails the request ({ message, status, code }).
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const normalize = value => typeof value === 'string' ? { text: value } : value ?? {};
const usageOf = (spec, request) => {
  const input = spec.usage?.input ?? Math.max(1, Math.ceil(JSON.stringify(request?.messages ?? []).length / 4)), output = spec.usage?.output ?? Math.max(1, Math.ceil(String(spec.text ?? '').length / 4));
  return { input, output, cacheRead: spec.usage?.cacheRead ?? 0, cacheWrite: spec.usage?.cacheWrite ?? 0, totalTokens: spec.usage?.totalTokens ?? input + output + (spec.usage?.cacheRead ?? 0) + (spec.usage?.cacheWrite ?? 0) };
};
const pieces = (text, count) => {
  if (!text) return [];
  const n = Math.max(1, Math.min(count ?? 1, text.length)), size = Math.ceil(text.length / n), out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
};
// What the provider received, without its signal and functions (kept for assertions).
const plain = request => { const { signal: _signal, apiKey: _key, ...rest } = request ?? {}; try { return structuredClone(rest); } catch { return JSON.parse(JSON.stringify(rest, (_k, v) => typeof v === 'function' ? undefined : v)); } };

export function createFauxModel({ defaultResponse = { text: 'OK.' } } = {}) {
  const lanes = new Map(), handlers = new Map(), requests = [];
  let toolCounter = 0, server = null;
  const lane = tag => { if (!lanes.has(tag)) lanes.set(tag, []); return lanes.get(tag); };
  async function resolve(tag, request) {
    const index = requests.filter(row => row.tag === tag).length - 1;
    const queue = lane(tag);
    let spec = queue.length ? queue.shift() : handlers.get(tag) ?? handlers.get('*') ?? defaultResponse;
    for (let depth = 0; typeof spec === 'function' && depth < 4; depth++) spec = await spec(request, { tag, index, faux });
    spec = normalize(spec);
    while (spec.hold) { const next = spec.then; await spec.hold; spec = normalize(typeof next === 'function' ? await next(request, { tag, index, faux }) : next ?? defaultResponse); }
    return spec;
  }
  function record(tag, via, request) {
    const row = { seq: requests.length + 1, tag, via, at: Date.now(), request };
    // The text a test searches: every message the model saw, in order.
    Object.defineProperty(row, 'wire', { get: () => JSON.stringify(via === 'http' ? request.messages : request.messages ?? []) });
    requests.push(row); return row;
  }

  const faux = {
    requests,
    /** Queues responses for one purpose tag, in order (pi: the response sequence). */
    script(tag, ...responses) { lane(tag).push(...responses); return faux; },
    /** The response a tag gets once its queue is empty ('*': every tag). */
    on(tag, response) { handlers.set(tag, response); return faux; },
    pending: tag => lane(tag).length,
    /** Requests of a tag (all when omitted), oldest first. */
    of: tag => tag === undefined ? [...requests] : requests.filter(row => row.tag === tag),
    /** An SDK provider whose requests carry `tag` (a string, or a function of the request). */
    provider(tag = 'foreground') {
      return async function* fauxProvider(request) {
        const name = typeof tag === 'function' ? tag(request) : tag;
        record(name, 'sdk', plain(request));
        const spec = await resolve(name, request);
        if (spec.delayMs) await delay(spec.delayMs, undefined, { signal: request?.signal }).catch(() => {});
        request?.signal?.throwIfAborted?.();
        if (spec.error) { const error = typeof spec.error === 'string' ? { message: spec.error } : spec.error; throw Object.assign(new Error(error.message ?? 'faux provider failure'), { status: error.status ?? 500, code: error.code ?? 'faux_failure' }); }
        const usage = usageOf(spec, request);
        if (spec.thinking) for (const part of pieces(spec.thinking, spec.chunks)) { yield { type: 'thinking_delta', delta: part }; if (spec.chunkMs) await delay(spec.chunkMs); }
        if (spec.text !== undefined) for (const part of pieces(spec.text, spec.chunks)) { yield { type: 'text_delta', delta: part }; if (spec.chunkMs) await delay(spec.chunkMs); }
        yield { type: 'usage', usage };
        if (spec.toolCalls?.length) {
          for (const call of spec.toolCalls) yield { type: 'tool_call', id: call.id ?? `faux-call-${++toolCounter}`, name: call.name, arguments: call.args ?? {} };
          yield { type: 'done', stopReason: spec.stopReason ?? 'toolUse' }; return;
        }
        yield { type: 'done', stopReason: spec.stopReason ?? 'stop' };
      };
    },
    /** Starts the OpenAI-compatible endpoint; resolves its base URL (…/v1). */
    async listen() {
      if (server) return faux.baseUrl;
      server = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unreadable: raw.slice(0, 200) }; }
        if (req.method === 'GET' && req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'faux-model' }] })); }
        record('http', 'http', body);
        let spec;
        try { spec = await resolve('http', body); } catch (error) { spec = { error: { message: error.message } }; }
        if (spec.delayMs) await delay(spec.delayMs);
        if (spec.error) { const error = typeof spec.error === 'string' ? { message: spec.error } : spec.error; res.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: error.message ?? 'faux failure', code: error.code ?? 'faux_failure' } })); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish = null, usage) => res.write(`data: ${JSON.stringify({ id: 'faux', object: 'chat.completion.chunk', model: body.model ?? 'faux-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
        chunk({ role: 'assistant' });
        for (const part of pieces(spec.thinking, spec.chunks)) { chunk({ reasoning_content: part }); if (spec.chunkMs) await delay(spec.chunkMs); }
        for (const part of pieces(spec.text, spec.chunks)) { chunk({ content: part }); if (spec.chunkMs) await delay(spec.chunkMs); }
        const calls = spec.toolCalls ?? [];
        if (calls.length) chunk({ tool_calls: calls.map((call, index) => ({ index, id: call.id ?? `faux-call-${++toolCounter}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) });
        const usage = usageOf(spec, body);
        chunk({}, calls.length ? 'tool_calls' : spec.stopReason === 'length' ? 'length' : 'stop', { prompt_tokens: usage.input + usage.cacheRead, completion_tokens: usage.output, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cacheRead } });
        res.end('data: [DONE]\n\n');
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      faux.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      return faux.baseUrl;
    },
    async close() { if (!server) return; server.closeAllConnections(); await new Promise(done => server.close(done)); server = null; },
  };
  return faux;
}

/** The initiative's decision input: the JSON the host put in the first message of a decision request. */
export function decisionInput(request) {
  const first = request?.messages?.[0];
  const text = Array.isArray(first?.content) ? first.content.find(part => part.type === 'text')?.text : first?.content;
  try { return JSON.parse(text); } catch { return null; }
}
/**
 * The judgment plan the main model authors for a project (hostConditions.judgment): generic, observable criteria for
 * each supported dimension. A world seeds it as an initialized project's policy; `decide` re-authors it whenever the
 * host asks (the project's context changed, e.g. a schedule was added).
 */
export const JUDGMENT_PLAN = Object.freeze({ version: 1, questions: {
  ...Object.fromEntries(['initiative_need', 'initiative_pause', 'schedule_need', 'evolution_need', 'memory_need'].map(key => [key, { type: 'boolean', instructions: `Scenario criterion for ${key} using verified project evidence.`, criteria: { true: `Verified evidence supports ${key}.`, false: `Verified evidence contradicts ${key}; uncertainty remains unknown.` } }])),
  task_state: { type: 'choice', instructions: 'Compare retained execution evidence with the project delivery criteria.', criteria: { active: 'An explicitly requested piece of work remains unfinished.', complete: 'The requested work has a successful delivery receipt.', unknown: 'The retained evidence is insufficient.' } },
} });
/** A decision reply (the initiative's contract) citing the newest event as evidence unless `evidenceIds` is given. */
export const decide = (input, action = 'wait', content = '', extra = {}) => ({ text: JSON.stringify({ action, content, evidenceIds: extra.evidenceIds ?? (input?.events?.length ? [input.events.at(-1).id] : []), reason: extra.reason ?? 'Observed a concrete project fact in the retained evidence.', nextReviewAfterMs: extra.nextReviewAfterMs ?? 86400000,
  ...(input?.hostConditions?.judgment?.requiresAssessment ? { judgmentPolicy: structuredClone(JUDGMENT_PLAN) } : {}), ...extra.fields }) });
