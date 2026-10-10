import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCompletion } from '../../../packages/sdk/src/providers.mjs';
import { UsageLedger, aggregateCacheUsage, usageRecord, meteredProvider, storedUsageRow, loadedUsageRow, parseUsageLedger, LEGACY_STORED_PURPOSES } from '../usage-cache-service.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { ProjectMindService } from '../project-mind.mjs';
import { Store } from '../store.mjs';
import { advanceWake } from '../proactive-pacing.mjs';
import { experienceReport } from '../experience-report.mjs';
import { proactiveMetrics } from '../proactive-metrics.mjs';
import { reasoningFor, decisionEffortInput } from '../internal-reasoning.mjs';
import { providerPreset } from '../provider-presets.mjs';
import { resolveReasoningCapability } from '../reasoning-capability.mjs';

// P1 review, accounting lens (ACC-1..5, ACC-7): what a request that was rejected, cut off or re-reported costs, how
// how estimated rows are split, what the per-effort wake monitor counts, and what a rollback keeps of the usage ledger.
const openai = { protocol: 'openai', providerId: 'glm', modelId: 'glm-5.3', baseUrl: 'https://api.openai.com/v1', maxOutputTokens: 200, contextWindow: 32000, reasoning: 'off' };
const input = { model: openai, systemPrompt: 'stable-prefix', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], estimatedInputTokens: 120000 };
const rejection = (status, retryAfter) => new Response(null, { status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });
const drain = async (provider, request, onEvent = () => {}) => { for await (const event of provider(request)) onEvent(event); };
const waitForAbort = signal => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });

test('ACC-1: a request the provider rejected after the SDK retried it is never recorded with an estimate', async () => {
  const ledger = new UsageLedger({});
  let hits = 0;
  await assert.rejects(drain(meteredProvider(streamCompletion, { ledger, purpose: 'foreground' }), { ...input, fetch: async () => { hits++; return rejection(429, '0'); } }), error => error.status === 429 && error.code === 'http_error');
  assert.equal(hits, 3, 'the SDK retried twice'); assert.equal(ledger.rows.length, 0, 'never billed, so no row (it used to be 120000 estimated input)');
  // A stop while the SDK waits to re-send: nothing was in flight.
  const stop = new AbortController();
  await assert.rejects(drain(meteredProvider(streamCompletion, { ledger, purpose: 'foreground' }), { ...input, signal: stop.signal, fetch: async () => rejection(429, '30') }, event => { if (event.type === 'retry') stop.abort(); }));
  assert.equal(ledger.rows.length, 0, 'a stop during the retry back-off records nothing');
  // A stop after the re-sent request went out: it may have been processed, so it keeps the PDL-3 estimate.
  const later = new AbortController(); let sends = 0;
  const fetch = async (_url, init) => { sends++; if (sends === 1) return rejection(503, '0'); setImmediate(() => later.abort()); return waitForAbort(init.signal); };
  await assert.rejects(drain(meteredProvider(streamCompletion, { ledger, purpose: 'foreground' }), { ...input, signal: later.signal, fetch }));
  assert.equal(ledger.rows.length, 1);
  assert.deepEqual((({ input, estimated, aborted, responded }) => ({ input, estimated, aborted, responded }))(ledger.rows[0]), { input: 120000, estimated: true, aborted: true, responded: false });
});

test('ACC-2: a reported stream cut off before its final report keeps the output that streamed after the report', async () => {
  const ledger = new UsageLedger({}), stop = new AbortController();
  // Anthropic: usage at message_start (output 1), the real output only in message_delta at the end.
  const anthropic = async function* (request) {
    yield { type: 'usage', usage: { input: 5000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5001, cacheUsageReported: true } };
    yield { type: 'thinking_delta', delta: 'y'.repeat(150000) };
    await waitForAbort(request.signal);
  };
  await assert.rejects(drain(meteredProvider(anthropic, { ledger, purpose: 'initiative' }), { model: { providerId: 'anthropic', modelId: 'claude-opus-5-5' }, signal: stop.signal }, event => { if (event.type === 'thinking_delta') stop.abort(); }));
  const row = ledger.rows.at(-1);
  assert.deepEqual({ input: row.input, output: row.output, estimatedOutput: row.estimatedOutput, estimated: row.estimated, aborted: row.aborted, cacheReported: row.cacheReported }, { input: 5000, output: 50001, estimatedOutput: 50000, estimated: undefined, aborted: true, cacheReported: true });
  // A completed request's last report is final: nothing is estimated.
  const complete = async function* () {
    yield { type: 'usage', usage: { input: 5000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5001, cacheUsageReported: true } };
    yield { type: 'text_delta', delta: 'z'.repeat(3000) };
    yield { type: 'usage', usage: { input: 5000, output: 700, cacheRead: 0, cacheWrite: 0, totalTokens: 5700, cacheUsageReported: true } };
    yield { type: 'done', stopReason: 'stop' };
  };
  await drain(meteredProvider(complete, { ledger, purpose: 'initiative' }), { model: { providerId: 'anthropic', modelId: 'claude-opus-5-5' } });
  assert.deepEqual([ledger.rows.at(-1).output, ledger.rows.at(-1).estimatedOutput], [700, undefined]);
  const bucket = aggregateCacheUsage(ledger.rows, { window: '1h' }).byPurpose.initiative;
  assert.deepEqual(bucket.estimated, { requests: 0, input: 0, output: 50000, partial: 1 }, 'the estimated part of a reported row is shown as estimated');
});

test('ACC-2: a mind JSON call cut off after a usage report is charged the reported part plus the streamed rest as estimated', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-acc2-mind-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'mind fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'main', contextWindow: 128000, maxOutputTokens: 8192, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'main', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  store.mutate(state => { state.settings.realTokenBudget = null; });
  const { project } = store.createProject({ name: 'Mind fixture', description: 'x', workspace: directory });
  store.usageLedger = new UsageLedger({});
  const mind = new ProjectMindService(store, { decisions: null, sweepIntervalMs: 0, notesIntervalMs: 0, provider: async function* () {
    yield { type: 'usage', usage: { input: 50, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 51, cacheUsageReported: true } };
    yield { type: 'thinking_delta', delta: 'x'.repeat(3000) };
    throw Object.assign(new Error('stream broke'), { code: 'stream_error' });
  } });
  t.after(async () => { await mind.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = { reported: store.state.realUsage?.reportedTokens ?? 0, estimated: store.state.realUsage?.estimatedTokens ?? 0 };
  assert.equal(await mind.modelJson(project.id, { system: 'Return JSON.', input: { a: 1 }, maxOutputTokens: 200, purpose: 'mind-notes' }), null);
  assert.equal(store.state.realUsage.reportedTokens - before.reported, 51, 'the reported part as reported');
  assert.equal(store.state.realUsage.estimatedTokens - before.estimated, 1000, 'the 3000 bytes after the report, three per token, as estimated');
  assert.deepEqual([store.usageLedger.rows[0].output, store.usageLedger.rows[0].estimatedOutput], [1001, 1000]);
});

// reviseMessage on its own: the controller's collaborators it reads, nothing else.
function narratorHost(narratorProvider, ledger = new UsageLedger({})) {
  return { ledger, host: { narratorProvider, store: { usageLedger: ledger }, now: () => Date.now(), project: () => ({ id: 'p1', mind: { lessons: [] } }), internalReasoning: async () => ({ reasoning: 'default', record: { source: 'provider-default' } }) } };
}
const narratorContext = () => ({ projectId: 'p1', coordinator: { model: { providerId: 'anthropic', modelId: 'claude-opus-5-5', reasoning: 'max' }, apiKey: 'TEST-ONLY-KEY' } });
const revise = (host, context, usage) => ProjectInitiativeController.prototype.reviseMessage.call(host, context, { text: 'The run finished.', violations: [{ code: 'describes_instead_of_delivering', repair: 'Say what was found.' }], deliverable: null, usage });

test('ACC-3: a narrator rewrite counts its cumulative usage reports once (the last one), not their sum', async () => {
  const { host, ledger } = narratorHost(async function* () {
    yield { type: 'usage', usage: { input: 2000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2001, cacheUsageReported: true } };
    yield { type: 'text_delta', delta: 'Two tests fail: parser.test.ts:42 and lexer.test.ts:17.' };
    yield { type: 'usage', usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 2500, cacheUsageReported: true } };
    yield { type: 'done', stopReason: 'stop' };
  });
  const context = narratorContext(), usage = { totalTokens: 0 };
  assert.match(await revise(host, context, usage), /Two tests fail/);
  assert.equal(usage.totalTokens, 2500, 'it used to be 2001 + 2500'); assert.equal(usage.estimatedTokens, undefined);
  assert.equal(context.narratorEffort.call.tokens, 2500, 'the replay capture reads the same number');
  assert.deepEqual(ledger.rows.map(row => [row.purpose, row.input, row.output]), [['narrator', 2000, 500]]);
  // Cut off after message_start: the report plus what streamed after it (estimated); rejected over HTTP: nothing.
  const cut = narratorHost(async function* () {
    yield { type: 'usage', usage: { input: 2000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2001, cacheUsageReported: true } };
    yield { type: 'text_delta', delta: 'w'.repeat(3000) };
    throw Object.assign(new Error('stream broke'), { code: 'stream_error' });
  });
  const partial = { totalTokens: 0 };
  assert.equal(await revise(cut.host, narratorContext(), partial), null);
  assert.deepEqual(partial, { totalTokens: 3001, estimatedTokens: 1000 });
  const rejected = narratorHost(async function* () { yield { type: 'retry', attempt: 1, maxRetries: 2, delayMs: 0, status: 529 }; throw Object.assign(new Error('overloaded'), { code: 'http_error', status: 529 }); });
  const none = { totalTokens: 0 };
  assert.equal(await revise(rejected.host, narratorContext(), none), null);
  assert.deepEqual(none, { totalTokens: 0 }, 'a rejection is never billed'); assert.equal(rejected.ledger.rows.length, 0);
});

test('ACC-4: an estimated row\'s prompt splits like the reported requests with its prefix, else its purpose and model, else all as fresh input', () => {
  const now = Date.parse('2026-10-03T12:00:00Z'), at = minutes => now - minutes * 60000, prefix = 'a'.repeat(16), other = 'b'.repeat(16);
  const model = { projectId: 'p', providerId: 'x', modelId: 'm' };
  const rows = [
    usageRecord({ at: at(30), purpose: 'initiative', ...model, sessionId: 'w', prefixKey: prefix, usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 10, cacheUsageReported: true } }),
    usageRecord({ at: at(20), purpose: 'initiative', ...model, sessionId: 'w', prefixKey: prefix, usage: { input: 10000, output: 300, cacheRead: 0, cacheWrite: 0, cacheUsageReported: false }, estimated: true, aborted: true }),
  ];
  const result = aggregateCacheUsage(rows, { window: '1h', now }), bucket = result.byPurpose.initiative;
  // 10000 estimated prompt tokens at the prefix's 90% cache read: 1000 fresh and 9000 read from the cache. The run row shows that split.
  const split = run => [run.input, run.cacheRead, run.cacheWrite, run.output, run.tokens];
  assert.deepEqual(split(result.runs[0]), [100 + 1000, 900 + 9000, 0, 10 + 300, 100 + 900 + 10 + 10000 + 300], 'it used to be 10000 uncached');
  assert.equal(bucket.estimated.input, 10000, 'token counts stay as recorded'); assert.equal(bucket.input, 100);
  // No same-prefix reference: the purpose and model of the same project; no reference at all: all of it as fresh input (the upper bound).
  const fallback = [...rows.slice(0, 1), usageRecord({ at: at(10), purpose: 'initiative', ...model, sessionId: 'f', prefixKey: other, usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0, cacheUsageReported: false }, estimated: true })];
  assert.deepEqual(split(aggregateCacheUsage(fallback, { window: '1h', now }).runs.find(run => run.sessionId === 'f')), [1000, 9000, 0, 0, 10000]);
  const alone = [usageRecord({ at: at(10), purpose: 'background-work', ...model, sessionId: 'a', usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0, cacheUsageReported: false }, estimated: true })];
  assert.deepEqual(split(aggregateCacheUsage(alone, { window: '1h', now }).runs[0]), [10000, 0, 0, 0, 10000]);
  // The reference can be wider than the window (the whole retained ledger), so a row's split does not depend on the window.
  const narrow = aggregateCacheUsage(rows.slice(1), { window: '1h', now, reference: rows });
  assert.deepEqual(split(narrow.runs[0]), [1000, 9000, 0, 300, 10300]);
  assert.equal(JSON.stringify(result).includes('cost'), false, 'no price in the report');
});

test('ACC-5: per-effort wake counts leave interrupted decisions apart, the deferred rate too, and the shadow effort is written', async () => {
  const now = Date.parse('2026-10-04T12:00:00Z'), at = minutes => new Date(now - minutes * 60000).toISOString();
  const history = [
    { at: at(50), outcome: 'work', tokens: 60000, reasoning: { effective: 'max', source: 'fallback', shadow: 'low' } },
    { at: at(40), outcome: 'interrupted', reason: 'new_evidence', tokens: 90000, reasoning: { effective: 'max', source: 'fallback', shadow: 'high' } },
    { at: at(35), outcome: 'interrupted', reason: 'interrupted', tokens: 80000, reasoning: { effective: 'max', source: 'fallback' } },
    { at: at(30), outcome: 'failed', reason: 'invalid_decision', tokens: 50000, reasoning: { effective: 'max', source: 'fallback', shadow: 'low' } },
    { at: at(20), outcome: 'deferred', reason: 'judged_idle' },
  ];
  const project = { id: 'p', name: 'Novel', mind: { pacing: { wake: { history } } }, initiativeRuntime: {}, inbox: [] };
  const wakes = experienceReport({ projects: [project], sessions: [], decisionKernelRuntime: { recent: [] } }, { now, days: 1 }).projects[0].wakes;
  assert.deepEqual(wakes.byReasoning.max, { wakes: 2, failed: 1, tokens: 110000, interrupted: 2, interruptedTokens: 170000, shadow: { low: 2, high: 1 } }, 'failed over the two reviews that ended, not over four');
  assert.equal(proactiveMetrics(project, [], { now, windowMs: 86400000 }).wakes.deferredRate, Math.round(1 / 3 * 1000) / 1000, 'one deferred of the three wakes that ended');
  // The route in shadow writes the verdict onto the record it returned; the wake reads it there.
  const glm = (() => { const provider = providerPreset('glm-coding'), model = provider.models.find(row => row.id === 'glm-5.3'); return { providerId: provider.id, modelId: model.id, reasoningCapability: resolveReasoningCapability(provider, model), reasoningSelection: 'max', reasoning: 'max' }; })();
  let release; const verdict = new Promise(resolve => { release = resolve; });
  const decisions = { effortMayApply: () => false, internalEffort: async () => { await verdict; return { effort: 'low', depth: 'light', source: 'jev', ledgerId: 'l1', applied: false }; } };
  const routed = await reasoningFor({ decisions, configuration: {}, project: { id: 'p', name: 'Novel' }, model: glm, purpose: 'decision', call: decisionEffortInput({ events: [{ id: 'a', type: 'action_completed', summary: 'done', at: 2 }], lastDecision: { at: 1 } }) });
  assert.equal(routed.reasoning, 'max'); assert.equal(routed.record.shadow, true, 'sent at once, before the verdict');
  const context = { decisionEffort: { effective: routed.reasoning, ...routed.record }, decisionEffortRecord: routed.record };
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(routed.record.shadow, { effort: 'low', depth: 'light' });
  const effort = ProjectInitiativeController.prototype.decisionEffortNow.call(null, context);
  assert.deepEqual(effort, { effective: 'max', source: 'fallback', shadow: { effort: 'low', depth: 'light' } });
  const row = advanceWake({}, 'interrupted', { now, tokens: 1, reasoning: effort }).history[0];
  assert.deepEqual(row.reasoning, { effective: 'max', source: 'fallback', shadow: 'low' });
});

// The purposes 0.66.0 keeps on load (its USAGE_PURPOSES): everything else is dropped by its first prune rewrite.
const PURPOSES_0_66_0 = ['foreground', 'initiative', 'background-work', 'learning', 'evaluation', 'compaction', 'summary', 'initialization', 'jev', 'jev-llm', 'skill-foundation', 'subagent', 'vision', 'other'];
test('ACC-7: narrator, mind and evolution rows survive a rollback to 0.66.0 and come back after the re-upgrade', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-acc7-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json.usage-cache.jsonl'), ledger = new UsageLedger({ file }), usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheUsageReported: true };
  for (const purpose of ['narrator', 'mind-capture', 'gene-author', 'initiative']) ledger.record({ purpose, projectId: 'p', usage });
  const stored = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(stored.map(row => [row.purpose, row.group, row.detail]), [['initiative', 'narrator', undefined], ['other', 'mind', 'mind-capture'], ['other', 'evolution', 'gene-author'], ['initiative', undefined, undefined]], 'written as 0.66.0 recorded them, the contract purpose in group');
  assert.ok(stored.every(row => PURPOSES_0_66_0.includes(row.purpose)));
  // 0.66.0's load and prune rewrite: it keeps what it knows, verbatim (group included).
  const old = stored.filter(row => typeof row.at === 'string' && PURPOSES_0_66_0.includes(row.purpose));
  await writeFile(file, old.map(row => `${JSON.stringify(row)}\n`).join(''));
  const upgraded = new UsageLedger({ file });
  assert.deepEqual(upgraded.rows.map(row => [row.purpose, row.detail]), [['narrator', undefined], ['mind', 'mind-capture'], ['evolution', 'gene-author'], ['initiative', undefined]]);
  assert.ok(upgraded.rows.every(row => row.group === undefined), 'in memory, rows carry their contract purpose only');
  assert.deepEqual(Object.keys(aggregateCacheUsage(upgraded.rows, { window: '1h' }).byPurpose).sort(), ['evolution', 'initiative', 'mind', 'narrator']);
  // A file a build before this fix wrote (purpose 'narrator' as is) is rewritten in the stored form at once.
  await writeFile(file, `${JSON.stringify(usageRecord({ purpose: 'narrator', usage }))}\n`);
  assert.equal(new UsageLedger({ file }).rows[0].purpose, 'narrator');
  assert.deepEqual((({ purpose, group }) => ({ purpose, group }))(JSON.parse(await readFile(file, 'utf8'))), { purpose: 'initiative', group: 'narrator' });
  // The helpers: a row of an unrelated `group` is never re-labelled; benchmarks read copies through parseUsageLedger.
  assert.deepEqual(loadedUsageRow({ purpose: 'foreground', group: 'narrator' }), { purpose: 'foreground', group: 'narrator' });
  assert.deepEqual(storedUsageRow({ purpose: 'foreground' }), { purpose: 'foreground' });
  assert.deepEqual(parseUsageLedger('{"at":"x","purpose":"other","group":"mind"}\nnot json\n').map(row => row.purpose), ['mind']);
  assert.deepEqual(Object.keys(LEGACY_STORED_PURPOSES).sort(), ['evolution', 'mind', 'narrator']);
});
