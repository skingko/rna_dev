import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { UsageLedger, CacheSurvival } from '../usage-cache-service.mjs';
import { resolveModel } from '../configuration.mjs';
import { reasoningFor } from '../internal-reasoning.mjs';
import { publishPrefix } from '../prompt-prefix-registry.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { CompactionForkProbe, warmedByUsage, publishedPrefix, scanJournal, journalPoints, selectPoints, pointEstimate, flatEstimate, summarizeProbe, probeMarkdown, purgeProbeSummaries, pruneProbeSummaries, PROBE_BUDGET_TOKENS, WARMUP_OUTPUT_TOKENS, FORK_HIT_RATIO, COVERAGE_MIN_REQUESTS, PLAN_SHARE } from '../benchmark/compaction-fork-probe.mjs';
import { SUMMARY_PROMPT } from '../../../packages/sdk/src/context.mjs';
import { runCompactionCommand } from '../cli-compaction.mjs';
import { initialMaintenance, persistMaintenance } from '../application-maintenance-state.mjs';
import { randomUUID } from 'node:crypto';

// C5 / TC-6 paid probe harness: GLM points from conversation journals (past automatic compactions GLM ran first, only
// in spans the live conversation moved past), request A warms the cache with the rebuilt main request, request B is
// the SDK fork request, request C (compaction points) the SDK flattened request at the same boundary; within the
// approved budget, never writing to a conversation. Every model call here is a fake provider: no network.
const RANGE = { min: 1500, max: 200000 };
const tokens = request => Math.ceil(Buffer.byteLength(JSON.stringify({ s: request.systemPrompt, t: request.tools, m: request.messages })) / 3);
const isFork = request => JSON.stringify(request.messages?.at(-1) ?? '').includes('up to and including the message that begins');
const flattened = request => String(request.systemPrompt).startsWith('Summarize the provided');
const PREFIX = { systemPrompt: 'You are the probe fixture agent. Write the chapters the user asks for.', tools: [{ name: 'lookup', description: 'Look up chapter notes.', parameters: { type: 'object', properties: { page: { type: 'number' } }, additionalProperties: false } }], cacheScope: 'project:fixture' };

/** A GLM-like conversation journal written by the SDK itself: chapters until one automatic (flattened) compaction, then more turns. */
async function conversation(store, session, model) {
  const provider = async function* (request) {
    const size = tokens(request);
    if (flattened(request)) yield { type: 'text_delta', delta: 'Checkpoint: the user asked for chapter 1 and chapter 2; both are done.' };
    else if (request.messages.at(-1)?.role === 'user' && request.messages.at(-1)?.source !== 'context') yield { type: 'tool_call', id: `c${size}`, name: 'lookup', arguments: { page: 1 } };
    else yield { type: 'text_delta', delta: `Chapter text ${'正文'.repeat(1500)}` };
    yield { type: 'usage', usage: { input: size, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: size + 50 } };
    yield { type: 'done', stopReason: request.messages.at(-1)?.role === 'user' && !flattened(request) ? 'toolUse' : 'stop' };
  };
  const tools = PREFIX.tools.map(tool => ({ ...tool, effect: 'read', idempotent: true, execute: async () => 'notes' }));
  const live = await createSession({ sessionId: session.id, projectId: session.projectId, cwd: store.dir, stateDir: join(`${store.file}.rna`, session.id), model, tools, provider, systemPrompt: PREFIX.systemPrompt, cacheScope: PREFIX.cacheScope });
  for (let index = 1; index <= 7; index++) await live.prompt(`Write chapter ${index}.`);
  const file = live.snapshot().sessionFile; await live.dispose();
  store.mutate(state => { state.sessions.find(row => row.id === session.id).runtime = { engine: 'rna', sessionFile: file }; });
  return file;
}

/** The paid stream: a prefix cache over whole messages (B reads what A wrote), a summary for the fork and one for the
 * flattened request (C). */
function paidProvider({ fork = () => [{ type: 'text_delta', delta: 'Checkpoint: chapter 1 and chapter 2 are done; the user asked for chapters 1 to 5.' }], flat = () => [{ type: 'text_delta', delta: 'Checkpoint: the user asked for chapters 1 to 4.' }], warmupUsage = null, hold = null } = {}) {
  const seen = [], cache = new Set();
  const provider = async function* (input) {
    seen.push(input);
    if (hold && !isFork(input)) { await new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(input.signal.reason ?? new Error('aborted')), { once: true }); hold(); }); }
    const prefixes = input.messages.map((_, index) => JSON.stringify([input.systemPrompt, input.tools, input.messages.slice(0, index + 1)]));
    const hit = [...prefixes].reverse().find(key => cache.has(key)), cached = hit ? tokens({ ...input, messages: JSON.parse(hit)[2] }) : 0;
    for (const key of prefixes) cache.add(key);
    const size = tokens(input);
    const summary = isFork(input) || flattened(input);
    if (isFork(input)) yield* fork(input);
    else if (flattened(input)) yield* flat(input);
    else yield { type: 'text_delta', delta: 'Continuing the chapter' };
    yield { type: 'usage', usage: warmupUsage && !summary ? warmupUsage : { input: size - cached, output: 40, cacheRead: cached, cacheWrite: 0, totalTokens: size + 40 } };
    yield { type: 'done', stopReason: summary ? 'stop' : 'length' };
  };
  return { provider, seen };
}
/** JEV stand-in on A3's state shape: a checkpoint keeps "Write chapter N." when it names chapter N or a range reaching
 * it; every chapter request is substantive. A kept answer of 0.35 sits above A3's labelled 0.3 and below the medium tier. */
const judge = { secrets: () => [], calls: [], async probe({ state, questions }) {
  this.calls.push({ state, questions });
  const n = Number(state.request.match(/\d+/)?.[0]), range = /chapters 1 to (\d+)/.exec(state.checkpoint);
  const kept = state.checkpoint.includes(`chapter ${n}`) ? 0.93 : range && n <= Number(range[1]) ? 0.35 : 0.08;
  return { status: 200, usage: { input_tokens: 300, output_tokens: 0 }, answers: { kept: { noul: kept }, substantive: { noul: 0.9 } } };
} };

async function fixture(t, { prefix = PREFIX, provider = paidProvider(), held = () => false, now = Date.now } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-fork-probe-')), store = new Store(join(dir, 'state.json'));
  store.dir = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  const glm = store.configurationService.provider(null, { name: 'GLM-like', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only-not-a-key', models: [{ id: 'glm-fixture', contextWindow: 26000, maxOutputTokens: 2000, reasoning: ['low', 'high', 'max'] }] });
  store.configurationService.update({ defaultModel: { providerId: glm.id, modelId: 'glm-fixture', reasoning: 'high' } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Probe fixture', description: 'A long writing conversation', workspace: dir });
  const model = resolveModel(store.state.configuration, { providerId: glm.id, modelId: 'glm-fixture', reasoning: 'high' });
  const journal = await conversation(store, session, model);
  const survival = new CacheSurvival({ file: join(dir, 'survival.json'), now }), ledger = new UsageLedger({ file: join(dir, 'state.json.usage-cache.jsonl'), survival });
  judge.calls = [];
  const probe = new CompactionForkProbe(store, { decisions: judge, ledger, provider: provider.provider, held, now, range: RANGE, prefixFor: (projectId, selected) => projectId === project.id && selected.modelId === 'glm-fixture' ? prefix : null });
  return { dir, store, probe, provider, ledger, survival, journal, project, session };
}
const digestOf = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const settled = async probe => { while (probe.running) await new Promise(done => setTimeout(done, 5)); return probe.status().job; };

test('points: the journal\'s automatic compaction first (its flat summary on record), then large-context points in range; estimates per request and in total', async t => {
  const f = await fixture(t);
  const scan = await scanJournal(f.journal);
  assert.equal(scan.compactions.length, 1, 'the conversation compacted once (flattened)');
  assert.equal(scan.header.sessionId, f.session.id);
  const found = journalPoints(scan, { sessionId: f.session.id, projectId: f.project.id }, RANGE);
  assert.equal(found.compactions.length, 1); assert.ok(found.requests.length >= 3);
  assert.equal(found.compactions[0].compaction.flatModel.modelId, 'glm-fixture'); assert.ok(found.compactions[0].compaction.flatSummaryChars > 20);
  // Only spans the live conversation moved past: the request served after the compaction extends the live prefix.
  assert.ok(Number.isFinite(scan.closedBefore)); assert.ok(scan.requests.some(row => row.seq > scan.closedBefore));
  assert.ok([...found.compactions, ...found.requests].every(row => row.seq < scan.closedBefore));
  const plan = await f.probe.plan({ points: 4 });
  assert.equal(plan.selected, 4); assert.equal(plan.points[0].kind, 'compaction'); assert.ok(plan.points.slice(1).every(point => point.kind === 'context'));
  for (const point of plan.points) {
    assert.equal(point.estimate, point.requests.warmup + point.requests.fork + (point.requests.flat ?? 0), point.id);
    assert.equal(point.requests.warmup, Math.ceil(point.size + point.prefixDelta) + WARMUP_OUTPUT_TOKENS);
  }
  assert.equal(plan.points[0].requests.flat, flatEstimate(plan.points[0]), 'a compaction point plans its flattened request C too');
  assert.ok(plan.points.slice(1).every(point => point.requests.flat === undefined));
  assert.equal(plan.estimate, plan.points.reduce((sum, point) => sum + point.estimate, 0)); assert.equal(plan.calls, 9);
  assert.deepEqual(plan.approval, { approved: PROBE_BUDGET_TOKENS, spent: 0, remaining: PROBE_BUDGET_TOKENS, approvals: 0 });
  assert.equal(plan.withinBudget, true); assert.deepEqual(plan.prefixMissing, []); assert.deepEqual(plan.prefixBorrowed, []); assert.equal('selection' in plan, false);
  // A small budget probes fewer points; none fit: the start is refused.
  const smallest = Math.min(...plan.points.map(point => point.estimate));
  const one = await f.probe.plan({ points: 4, budgetTokens: Math.ceil(smallest / PLAN_SHARE) + 1 });
  assert.equal(one.selected, 1);
  await assert.rejects(f.probe.start({ approved: true, budgetTokens: 10 }), { code: 'replay_no_points' });
  // Without the project's published prefix nothing is chosen, and the preview says why.
  const g = await fixture(t, { prefix: null });
  const waiting = await g.probe.plan();
  assert.equal(waiting.selected, 0); assert.equal(waiting.prefixMissing.length, 1); assert.ok(waiting.prefixMissing[0].points >= 4);
  await assert.rejects(g.probe.start({ approved: true }), error => error.code === 'replay_no_points' && /提示前缀/.test(error.message));
});

test('the published prefix: the project\'s own, else another project\'s on the same model (flagged as a stand-in), else none', () => {
  const model = { providerId: 'prefix-provider', modelId: 'glm-prefix' };
  assert.equal(publishedPrefix('own-project', model), null);
  publishPrefix('other-project', { ...PREFIX, modelKey: 'prefix-provider/glm-prefix' });
  publishPrefix('third-project', { ...PREFIX, modelKey: 'prefix-provider/another-model' });
  const standIn = publishedPrefix('own-project', model);
  assert.equal(standIn.source, 'other_project'); assert.equal(standIn.fromProjectId, 'other-project'); assert.equal(standIn.systemPrompt, PREFIX.systemPrompt);
  publishPrefix('own-project', { ...PREFIX, systemPrompt: 'Own prompt.', modelKey: 'prefix-provider/glm-prefix' });
  assert.equal(publishedPrefix('own-project', model).source, 'project'); assert.equal(publishedPrefix('own-project', model).systemPrompt, 'Own prompt.');
  assert.equal(publishedPrefix('own-project', { providerId: 'prefix-provider', modelId: 'glm-none' }), null, 'never a prefix built for another model');
});

test('selection is greedy within the budget: compactions newest first, then size bands round robin, no near-duplicate sizes in a session', () => {
  const at = minute => `2026-10-0${1 + Math.floor(minute / 1440)}T00:${String(minute % 60).padStart(2, '0')}:00Z`;
  const point = (id, kind, size, minute, sessionId = 's1') => ({ id, kind, size, at: at(minute), sessionId, prefixDelta: 0, warm: false, model: { modelId: 'glm-5.3' } });
  const compactions = [point('c-old', 'compaction', 60000, 1), point('c-new', 'compaction', 70000, 2, 's2')];
  const requests = [point('r1', 'context', 45000, 10), point('r2', 'context', 46000, 11), point('r3', 'context', 120000, 12), point('r4', 'context', 250000, 13, 's3'), point('r5', 'context', 90000, 14, 's2')];
  const chosen = selectPoints({ compactions, requests }, { points: 5, budgetTokens: 2000000, range: { min: 40000, max: 300000 } });
  assert.deepEqual(chosen.points.map(row => row.id).slice(0, 2), ['c-new', 'c-old']);
  assert.ok(!(chosen.points.some(row => row.id === 'r1') && chosen.points.some(row => row.id === 'r2')), 'two near-equal sizes of one session are not both chosen');
  assert.equal(chosen.estimate, chosen.points.reduce((sum, row) => sum + pointEstimate(row), 0));
  const tight = selectPoints({ compactions, requests }, { points: 5, budgetTokens: pointEstimate(compactions[1]) + pointEstimate(requests[0]) + 10, range: { min: 40000, max: 300000 } });
  assert.ok(tight.estimate <= pointEstimate(compactions[1]) + pointEstimate(requests[0]) + 10);
  assert.ok(pointEstimate({ size: 100000, prefixDelta: 0, warm: true }) < pointEstimate({ size: 100000, prefixDelta: 0, warm: false }), 'a warm live cache saves request A');
});

test('a probe refuses without approval or above the approved total; a run measures cache, text-only and coverage without touching the conversation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.probe.start({}), { code: 'replay_not_approved', status: 400 });
  await assert.rejects(f.probe.start({ approved: false }), { code: 'replay_not_approved' });
  await assert.rejects(f.probe.start({ approved: true, budgetTokens: PROBE_BUDGET_TOKENS + 1 }), { code: 'replay_over_budget' });
  assert.equal(f.provider.seen.length, 0);
  const folder = join(`${f.store.file}.rna`, f.session.id), before = { digest: await digestOf(f.journal), files: (await readdir(folder)).sort(), sessions: JSON.stringify(f.store.state.sessions) };
  const job = await f.probe.start({ approved: true, points: 3 });
  assert.equal(job.phase, 'running'); assert.equal(job.points.length, 3);
  await assert.rejects(f.probe.start({ approved: true }), { code: 'replay_running' });
  const done = await settled(f.probe);
  assert.equal(done.phase, 'completed', JSON.stringify(done.points.map(row => [row.id, row.status, row.reason])));
  assert.equal(f.provider.seen.length, 9, `A, B and C at each point (C on a large-context point too, the budget allowing it): ${JSON.stringify(done.points.map(row => [row.id, row.kind, row.status, row.reason, row.warmup?.status]))}`); assert.equal(done.done, 9);
  const paired = f.provider.seen.filter(request => !flattened(request)), flats = f.provider.seen.filter(flattened);
  // Each fork starts with the warm-up's exact request and adds one instruction; GLM gets no tool_choice.
  for (let index = 0; index < 6; index += 2) {
    const [a, b] = [paired[index], paired[index + 1]];
    assert.ok(!isFork(a) && isFork(b)); assert.equal(a.maxOutputTokens, WARMUP_OUTPUT_TOKENS); assert.equal(b.maxOutputTokens, 2000);
    assert.deepEqual(b.messages.slice(0, a.messages.length), a.messages); assert.equal(b.toolChoice, undefined); assert.deepEqual(b.tools, a.tools);
    assert.equal(a.apiKey, 'fixture-only-not-a-key'); assert.equal(a.model.reasoning, 'high', 'the conversation\'s recorded effort');
  }
  // Request C, right after the compaction point's fork: the SDK's flattened request at the recorded boundary, sent now so
  // fork and flat answer the same prompt generation, with the effort live compaction gives a flattened record.
  assert.equal(flats.length, 3); assert.equal(f.provider.seen.indexOf(flats[0]), 2); assert.deepEqual(flats.map(request => f.provider.seen.indexOf(request)), [2, 5, 8], 'A, B, C at every point');
  for (const flat of flats) { assert.equal(flat.systemPrompt, SUMMARY_PROMPT); assert.deepEqual(flat.tools ?? [], []); assert.equal(flat.maxOutputTokens, 2000); }
  const glmModel = resolveModel(f.store.state.configuration, { providerId: f.store.state.configuration.defaultModel.providerId, modelId: 'glm-fixture', reasoning: 'high' });
  assert.equal(flats[0].model.reasoning, (await reasoningFor({ decisions: null, configuration: f.store.state.configuration, project: null, model: glmModel, purpose: 'compaction' })).reasoning);
  for (const point of done.points) {
    assert.equal(point.status, 'completed');
    assert.ok(point.fork.sharedPrefixTokens > 0); assert.equal(point.fork.cachedTokens, point.fork.sharedPrefixTokens); assert.equal(point.fork.hitRatio, 1);
    assert.equal(point.fork.toolCalls, 0); assert.equal(point.fork.textOnly, true); assert.equal(point.fork.accepted, true); assert.ok(point.fork.summaryChars > 20);
    assert.equal(point.rebuilt.prefixIdentical, true); assert.ok(point.tokens > 0); assert.equal(point.prefix.source, 'project');
    assert.equal(point.warmup.text, undefined, 'no model text in the report');
  }
  const compaction = done.points.find(row => row.kind === 'compaction');
  assert.equal(compaction.flat.status, 'completed'); assert.equal(compaction.flat.accepted, true); assert.ok(compaction.flat.summaryChars > 20);
  assert.equal(compaction.live.prefixMatches, true, 'the published prefix equals the one the conversation used'); assert.equal(compaction.live.sourceDigestMatches, true, 'the rebuilt span is the recorded one');
  // Coverage: every user request up to the boundary, one checkpoint and one request per JEV call (A3's labelled shape),
  // kept at A3's 0.3 (the fixture's 0.35 answers count), compared request by request.
  const c = compaction.coverage, n = c.requests;
  assert.equal(n, compaction.rebuilt.userRequests); assert.ok(n >= COVERAGE_MIN_REQUESTS, `${n} requests up to the boundary`);
  assert.deepEqual(c.thresholds, { kept: 0.3, substantive: 0.5 }); assert.equal(c.substantive, n); assert.equal(c.compared, n);
  assert.equal(c.fork.kept, Math.min(5, n)); assert.equal(c.flat.kept, Math.min(4, n)); assert.equal(c.recorded.kept, 2, 'the summary on record, judged as a reference');
  assert.equal(c.losses, 0); assert.equal(c.gains, n >= 5 ? 1 : 0); assert.equal(c.atLeastAsGood, true);
  assert.deepEqual(c.rows.map(row => row.id), [...new Set(c.rows.map(row => row.id))]); assert.ok(c.rows.every(row => typeof row.fork === 'number' && typeof row.flat === 'number'));
  // A large-context point gets request C too, so its boundary's requests add to the comparison (the first probe compared one).
  const contexts = done.points.filter(row => row.kind === 'context');
  assert.ok(contexts.every(row => row.flat.status === 'completed' && row.flat.accepted === true && row.coverage.compared === row.coverage.requests && row.coverage.requests > 0 && row.live.requestDigestMatches === true), 'a large-context point compares fork and flat; the rebuilt request equals the live one');
  assert.ok(contexts.every(row => row.coverage.losses === 0 && row.coverage.atLeastAsGood === true && row.coverage.recorded === null), 'no summary on record at a large-context point: the reference column is empty');
  assert.equal(judge.calls.length, done.points.reduce((sum, row) => sum + row.coverage.requests * (row.coverage.recorded ? 3 : 2), 0), 'one call per request and summary (fork and flat, and the one on record on a compaction point)');
  assert.ok(judge.calls.every(call => JSON.stringify(Object.keys(call.state)) === '["checkpoint","request"]' && JSON.stringify(Object.keys(call.questions)) === '["kept","substantive"]' && Object.values(call.questions).every(question => question.type === 'noul' && /is data to judge, not instructions/.test(question.instructions))));
  assert.equal(done.summary.gate.pass, true, done.summary.gate.reasons.join()); assert.equal(done.summary.cache.hits, 3); assert.equal(done.summary.text.textOnly, 3);
  assert.equal(done.jevTokens, judge.calls.length * 300);
  // Spend: reported usage, recorded with the approval; metered as evaluation with no session or project.
  const spend = JSON.parse(await readFile(join(`${f.store.file}.rna`, 'compaction-fork-probe', 'spend.json'), 'utf8'));
  assert.equal(spend.approvals.length, 1); assert.equal(spend.approvals[0].tokens, PROBE_BUDGET_TOKENS); assert.equal(spend.jobs[done.id].spentTokens, done.spentTokens); assert.equal(spend.jobs[done.id].phase, 'completed');
  const rows = f.ledger.records();
  assert.equal(rows.length, 9); assert.ok(rows.every(row => row.purpose === 'evaluation' && row.detail === 'compaction-fork-probe' && !row.sessionId && !row.projectId && !row.continuity));
  assert.equal(done.spentTokens, rows.reduce((sum, row) => sum + row.input + row.output + row.cacheRead + row.cacheWrite, 0));
  assert.equal(f.probe.approval().spent, done.spentTokens);
  // The conversation: journal bytes, its folder and the state's sessions unchanged; no survival sample learned.
  assert.equal(await digestOf(f.journal), before.digest); assert.deepEqual((await readdir(folder)).sort(), before.files);
  assert.equal(JSON.stringify(f.store.state.sessions), before.sessions); assert.equal(f.survival.models.size, 0);
  // Report: JSON and Markdown; the fork summaries beside it, never in it.
  const report = f.probe.report(done.id);
  assert.equal(report.json.id, done.id);
  assert.match(report.markdown, /\| point \| kind \| session \| at \| context \| warm-up \(prompt\) \| shared prefix \| cached \| hit ratio \| tool calls \| stop \/ rejection \| summary chars \| flat request \| coverage fork \/ flat/);
  assert.equal(report.markdown.split('\n').filter(line => /^\| [a-z0-9]{8}-[cr]\d+ /.test(line)).length, 3);
  assert.match(report.markdown, /\*\*Next:\*\* switch `compat.compactionFork` on for GLM/);
  assert.ok(!report.markdown.includes('Checkpoint:') && !JSON.stringify(report.json).includes('Checkpoint:'), 'model text stays out of the report');
  const summaries = JSON.parse(await readFile(join(`${f.store.file}.rna`, 'compaction-fork-probe', `${done.id}.summaries.json`), 'utf8'));
  assert.equal(Object.keys(summaries).length, 3); assert.deepEqual(Object.keys(summaries[compaction.id]), ['fork', 'flat']);
  assert.deepEqual(f.probe.status().reports, [done.id]);
  // What is left of the approval binds the next run.
  assert.equal(f.probe.approval().remaining, PROBE_BUDGET_TOKENS - done.spentTokens);
});

test('budget cap: no request starts whose worst case would pass the budget — a warm-up that cost more stops the run before its fork', async t => {
  const f = await fixture(t, { provider: paidProvider({ warmupUsage: { input: 1990000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1990010 } }) });
  const done = await (async () => { await f.probe.start({ approved: true, points: 3 }); return settled(f.probe); })();
  assert.equal(done.phase, 'budget_stop'); assert.equal(done.stopReason, 'budget');
  assert.equal(f.provider.seen.length, 1, 'only the first warm-up was sent'); assert.ok(!isFork(f.provider.seen[0]));
  assert.equal(done.points[0].status, 'not_run'); assert.equal(done.points[0].reason, 'budget'); assert.equal(done.points[0].warmup.status, 'completed');
  assert.ok(done.points.slice(1).every(row => row.status === 'not_run'));
  assert.equal(done.spentTokens, 1990010); assert.ok(done.spentTokens <= done.budgetTokens);
  assert.equal(done.summary.gate.pass, false); assert.ok(done.summary.gate.reasons.includes('run_incomplete') && done.summary.gate.reasons.includes('no_measured_points'));
  // The approval left is less than one more probe needs: refused before any request.
  const seen = f.provider.seen.length;
  await assert.rejects(f.probe.start({ approved: true, points: 3 }), { code: 'replay_no_points' });
  assert.equal(f.provider.seen.length, seen);
});

test('a fork that calls a tool is a text-only violation; the gate keeps the fork off', async t => {
  const f = await fixture(t, { provider: paidProvider({ fork: () => [{ type: 'text_delta', delta: 'Let me check.' }, { type: 'tool_call', id: 'x', name: 'lookup', arguments: { page: 2 } }] }) });
  await f.probe.start({ approved: true, points: 2 });
  const done = await settled(f.probe);
  assert.equal(done.phase, 'completed');
  for (const point of done.points) { assert.equal(point.fork.toolCalls, 1); assert.deepEqual(point.fork.toolNames, ['lookup']); assert.equal(point.fork.textOnly, false); assert.equal(point.fork.rejection, 'tool_call'); assert.equal(point.fork.hitRatio, 1, 'the cache is still measured'); }
  assert.equal(done.summary.gate.pass, false); assert.ok(done.summary.gate.reasons.includes('tool_calls'));
  assert.match(probeMarkdown(done), /keep `compat.compactionFork` off for GLM: a fork called a tool/);
});

test('cancel stops the request in flight and the run; maintenance stops it before any request', async t => {
  let release;
  const waiting = new Promise(done => { release = done; });
  const f = await fixture(t, { provider: paidProvider({ hold: () => release() }) });
  await f.probe.start({ approved: true, points: 3 });
  await waiting;
  assert.deepEqual(f.probe.cancel(), { cancelled: true });
  const done = await settled(f.probe);
  assert.equal(done.phase, 'cancelled'); assert.equal(f.provider.seen.length, 1);
  assert.equal(done.points[0].status, 'cancelled'); assert.ok(done.points.slice(1).every(row => row.status === 'not_run'));
  // The request went out and reported no usage: the approval is charged its worst case, not the bytes seen.
  assert.equal(done.points[0].warmup.estimated, true); assert.ok(done.points[0].warmup.ceiling > done.points[0].warmup.estimatedTokens);
  assert.equal(done.spentTokens, done.points[0].warmup.ceiling); assert.equal(f.probe.approval().spent, done.points[0].warmup.ceiling);
  assert.deepEqual(f.probe.cancel(), { cancelled: false });
  const held = await fixture(t, { held: () => true });
  await held.probe.start({ approved: true, points: 2 });
  const stopped = await settled(held.probe);
  assert.equal(stopped.phase, 'maintenance_stop'); assert.equal(held.provider.seen.length, 0); assert.equal(stopped.spentTokens, 0);
});

test('a report left running by a lost daemon reads as interrupted; summarizeProbe never passes an incomplete run', async t => {
  const f = await fixture(t);
  const dir = join(`${f.store.file}.rna`, 'compaction-fork-probe');
  await f.probe.plan();
  const job = { id: 'probe-lost-1', phase: 'running', startedAt: '2026-10-05T00:00:00.000Z', budgetTokens: 1000, estimate: 900, spentTokens: 0, done: 0, calls: 2, points: [] };
  await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }));
  await writeFile(join(dir, 'probe-lost-1.json'), JSON.stringify(job)); await writeFile(join(dir, 'probe-lost-1.md'), '');
  const report = f.probe.report('probe-lost-1');
  assert.equal(report.json.phase, 'interrupted'); assert.match(report.markdown, /Phase: interrupted/);
  assert.throws(() => f.probe.report('missing'), { code: 'replay_report_missing' });
  assert.throws(() => f.probe.report('../x'), { code: 'replay_invalid' });
  const measured = { kind: 'context', status: 'completed', model: { modelId: 'glm-fixture' }, prefix: { source: 'project' }, fork: { status: 'completed', hitRatio: 0.95, textOnly: true, toolCalls: 0, accepted: true } };
  const evidence = { ...measured, kind: 'compaction', coverage: { requests: COVERAGE_MIN_REQUESTS, substantive: COVERAGE_MIN_REQUESTS, compared: COVERAGE_MIN_REQUESTS, losses: 0, gains: 0, atLeastAsGood: true } };
  assert.equal(summarizeProbe({ phase: 'completed', points: [measured, evidence] }).gate.pass, true);
  assert.deepEqual(summarizeProbe({ phase: 'cancelled', points: [measured, evidence] }).gate.reasons, ['run_incomplete']);
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [{ ...measured, fork: { ...measured.fork, hitRatio: FORK_HIT_RATIO - 0.5 } }, evidence] }).gate.reasons, ['cache_miss']);
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, evidence, { status: 'failed', reason: 'fork_http_error', fork: { status: 'failed' } }] }).gate.reasons, ['point_failed'], 'a failed request is not evidence');
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, evidence, { ...evidence, coverage: { requests: 2, compared: 0, atLeastAsGood: null, unchecked: 'judge_failed' } }] }).gate.reasons, ['coverage_unchecked']);
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, evidence, { ...evidence, coverage: { requests: 2, substantive: 2, compared: 2, losses: 1, gains: 0, atLeastAsGood: false } }] }).gate.reasons, ['coverage_lower']);
  const toolOnly = { ...evidence, coverage: { requests: 0, compared: 0, atLeastAsGood: null, reason: 'no_user_request' } };
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, evidence, toolOnly] }).gate.reasons, [], 'a span without a user request has nothing to compare');
});

test('the gate needs evidence: (c) from enough compared requests on GLM compaction points with their own prompt, (b) from one own-prefix fork, every point probed', () => {
  const measured = { kind: 'context', status: 'completed', model: { modelId: 'glm-fixture' }, prefix: { source: 'project' }, fork: { status: 'completed', hitRatio: 0.95, textOnly: true, toolCalls: 0, accepted: true } };
  const compared = count => ({ ...measured, kind: 'compaction', coverage: { requests: count, substantive: count, compared: count, losses: 0, gains: 0, atLeastAsGood: true } });
  // Large-context points only (`--project` on a conversation that never compacted on GLM): (a) and (b), no (c).
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, measured] }).gate.reasons, ['coverage_insufficient']);
  assert.match(probeMarkdown({ id: 'probe-x', phase: 'completed', points: [], summary: summarizeProbe({ phase: 'completed', points: [measured] }) }), /keep `compat.compactionFork` off for GLM: fewer than 5 substantive user requests were compared/);
  // One request (1484f7e9's first compactions) or a few summed over points do not reach the bar; enough over two do.
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, compared(1)] }).gate.reasons, ['coverage_insufficient']);
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, compared(2), compared(COVERAGE_MIN_REQUESTS - 2)] }).gate.reasons, []);
  // A stand-in prefix answers (a) only: its text-only fork and its coverage are no evidence; a tool call there still counts against.
  const borrowed = row => ({ ...row, prefix: { source: 'other_project' } });
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [borrowed(measured), borrowed(compared(COVERAGE_MIN_REQUESTS))] }).gate.reasons, ['text_only_unproven', 'coverage_insufficient']);
  assert.ok(summarizeProbe({ phase: 'completed', points: [measured, compared(COVERAGE_MIN_REQUESTS), borrowed({ ...measured, fork: { ...measured.fork, textOnly: false, toolCalls: 1, accepted: false, rejection: 'tool_call' } })] }).gate.reasons.includes('tool_calls'));
  // A point the run skipped (session deleted, no candidate, no prefix …) leaves the selection unprobed.
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, compared(COVERAGE_MIN_REQUESTS), { status: 'skipped', reason: 'session_deleted' }] }).gate.reasons, ['point_skipped']);
});

/** A hand-written journal: records in order (seq from 1), served requests with reported usage. */
async function journalFile(t, build) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-fork-probe-journal-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const records = [], add = (type, data) => records.push({ seq: records.length + 1, time: new Date(Date.UTC(2026, 9, 1, 0, records.length)).toISOString(), type, data });
  const glm = { providerId: 'p', modelId: 'glm-5.3', protocol: 'openai' };
  let next = 0;
  const api = {
    add,
    user: id => add('message', { message: { id, role: 'user', source: 'user', content: [{ type: 'text', text: id }] } }),
    // One served request of `tokens` prompt tokens: its started record carries the model, its completed one the reply.
    served: (tokens, model = glm) => { const requestId = `q${++next}`; add('request_started', { requestId, model }); add('request_completed', { requestId, message: { id: `a${next}`, role: 'assistant', usageReported: true, usage: { input: tokens, output: 10 }, stopReason: 'stop' } }); return records.length - 1; },
    compaction: (through, { automatic = false, model = glm } = {}) => { if (automatic) { add('model_change', { to: model }); add('compaction_request_started', { requestId: 'cq' }); } add('context_compaction', { id: `cmp-${records.length}`, summary: 'Checkpoint.', throughMessageId: through, automatic, beforeTokens: 5000 }); },
  };
  add('session_header', { sessionId: 'journal-session', projectId: 'p' });
  build(api);
  const file = join(dir, 'journal.rna.jsonl');
  await writeFile(file, records.map(row => `${JSON.stringify(row)}\n`).join(''));
  return file;
}

test('points only from spans the live conversation moved past: its current span (or one a rewind reopened) would warm its next request', async t => {
  const range = { min: 1000, max: 100000 }, ids = { sessionId: 'journal-session', projectId: 'p' };
  let before = [], after = [];
  const file = await journalFile(t, api => {
    api.user('u1'); for (let index = 0; index < 4; index++) before.push(api.served(2000 + index * 1000));
    api.compaction('u1');
    api.user('u2'); for (let index = 0; index < 5; index++) after.push(api.served(4000 + index * 1000));
  });
  const scan = await scanJournal(file), found = journalPoints(scan, ids, range);
  assert.ok(Number.isFinite(scan.closedBefore));
  assert.deepEqual(found.requests.map(row => row.seq), before.filter((_, index) => index >= 3), 'before the compaction (three groups in): eligible');
  assert.ok(scan.requests.some(row => after.includes(row.seq) && row.groups >= 3), 'the current span has requests that would qualify by size and groups');
  assert.ok(!found.requests.some(row => after.includes(row.seq)), 'none of the current span is a point');
  // A conversation that never compacted: everything is its current span.
  const open = await journalFile(t, api => { api.user('u1'); for (let index = 0; index < 6; index++) api.served(2000 + index * 1000); });
  assert.deepEqual(journalPoints(await scanJournal(open), ids, range).requests, []);
  // A rewind before the boundary drops that compaction (replay falls back to the raw history): its span is current again.
  const rewound = await journalFile(t, api => {
    api.user('u1'); for (let index = 0; index < 4; index++) api.served(2000 + index * 1000);
    api.user('u2'); api.served(3000); api.compaction('u2');
    api.add('context_rewind', { beforeMessageId: 'u2' });
  });
  const reopened = await scanJournal(rewound);
  assert.equal(reopened.closedBefore, null); assert.deepEqual(journalPoints(reopened, ids, range).requests, []);
});

test('a compaction another model ran on a GLM conversation is a large-context point, not a GLM compaction', async t => {
  const range = { min: 1000, max: 100000 }, ids = { sessionId: 'journal-session', projectId: 'p' };
  const file = await journalFile(t, api => {
    api.user('u1'); for (let index = 0; index < 4; index++) api.served(2000 + index * 1000);
    // GLM served the conversation; the user switched to GPT and its window chose the next boundary.
    api.compaction('u1', { automatic: true, model: { providerId: 'p', modelId: 'gpt-6-astra' } });
    api.user('u2'); for (let index = 0; index < 4; index++) api.served(3000 + index * 1000);
    api.compaction('u2', { automatic: true });
    api.user('u3'); api.served(4000); api.compaction('u3');
  });
  const scan = await scanJournal(file), found = journalPoints(scan, ids, range);
  assert.equal(scan.compactions.length, 2);
  assert.deepEqual(found.compactions.map(row => row.compaction.flatModel.modelId), ['glm-5.3'], 'only the compaction GLM ran');
  const demoted = found.requests.find(row => row.demoted);
  assert.equal(demoted.kind, 'context'); assert.equal(demoted.demoted.model, 'gpt-6-astra'); assert.equal(demoted.model.modelId, 'glm-5.3'); assert.equal(demoted.reference.contextDigest, null);
  assert.equal(demoted.seq, scan.compactions[0].seq);
});

test('a request whose worst case cannot be recorded in spend.json is never sent (a failed write or an unreadable record)', async t => {
  const breaks = [['write', probe => { probe.writeSpend = () => { throw Object.assign(new Error('no space left'), { code: 'ENOSPC' }); }; }], ['unreadable', probe => writeFileSync(probe.spendFile(), '{"version":1,"approvals":[')]];
  for (const [name, breakRecord] of breaks) {
    const f = await fixture(t);
    await f.probe.start({ approved: true, points: 2 });
    breakRecord(f.probe);
    const done = await settled(f.probe);
    assert.equal(f.provider.seen.length, 0, `${name}: no request without its reservation on record`);
    assert.equal(done.phase, 'record_failed', name); assert.equal(done.spentTokens, 0); assert.equal(f.probe.inFlight, 0);
    assert.deepEqual(Object.keys(f.store.state.realUsage?.reservations ?? {}).filter(key => key.startsWith('fork-probe:')), [], `${name}: the daily-cap reservation is released`);
    assert.ok(done.summary.gate.reasons.includes('run_incomplete'));
  }
});

test('start reads what is left of the approval after its preview: a run that spent meanwhile counts', async t => {
  const f = await fixture(t);
  const preview = f.probe.preview.bind(f.probe);
  // Another run spent nearly all of the approval and ended while this start was scanning journals.
  f.probe.preview = async input => {
    const plan = await preview(input);
    mkdirSync(join(`${f.store.file}.rna`, 'compaction-fork-probe'), { recursive: true });
    writeFileSync(f.probe.spendFile(), JSON.stringify({ version: 1, approvals: [{ at: '2026-10-05T00:00:00.000Z', tokens: PROBE_BUDGET_TOKENS, kind: 'initial' }], jobs: { 'probe-other': { spentTokens: PROBE_BUDGET_TOKENS - 1000, inFlightTokens: 0, phase: 'completed' } } }));
    return plan;
  };
  await assert.rejects(f.probe.start({ approved: true, points: 2 }), { code: 'replay_approval_spent' });
  assert.equal(f.provider.seen.length, 0); assert.equal(f.probe.running, false); assert.equal(f.probe.approval().remaining, 1000);
});

test('a journal copy a killed daemon left behind is cleared at construction and at every start; copies live in the probe folder', async t => {
  const f = await fixture(t);
  const scratch = join(`${f.store.file}.rna`, 'compaction-fork-probe', 'scratch');
  const leftover = async () => { await mkdir(join(scratch, 'point-left'), { recursive: true }); await writeFile(join(scratch, 'point-left', 'point.jsonl'), '{"seq":1}\n'); };
  await leftover();
  const probe = new CompactionForkProbe(f.store, { decisions: judge, ledger: f.ledger, provider: f.provider.provider, range: RANGE, prefixFor: (projectId, selected) => projectId === f.project.id && selected.modelId === 'glm-fixture' ? PREFIX : null });
  assert.equal(existsSync(join(scratch, 'point-left')), false, 'cleared when the daemon starts');
  await leftover();
  await probe.start({ approved: true, points: 1 });
  assert.equal(existsSync(join(scratch, 'point-left')), false, 'cleared when a run starts');
  const done = await settled(probe);
  assert.equal(done.phase, 'completed');
  assert.deepEqual(await readdir(scratch), [], 'each point\'s copy was made here and removed after it');
});

// The fork and flat summaries quote the user's requests (A3 template): they never outlive their conversation. The
// deletion purge is in session-deletion.test.mjs; here the sweep and a run whose report is written after the purge.
test('summaries of a conversation no longer in state are swept, and a run never writes them back after its deletion', async t => {
  const f = await fixture(t), root = join(`${f.store.file}.rna`, 'compaction-fork-probe');
  await f.probe.start({ approved: true, points: 3 });
  const done = await settled(f.probe), file = join(root, `${done.id}.summaries.json`);
  assert.equal(done.phase, 'completed'); assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8'))).length, 3);
  assert.equal(pruneProbeSummaries(f.store.file, { state: f.store.state }), 0, 'its conversation is live');
  // An older report: one point of a conversation deleted since, one summary its report does not name.
  writeFileSync(join(root, 'probe-older.json'), JSON.stringify({ id: 'probe-older', points: [{ id: 'gone-c1', sessionId: 'deleted-session' }] }));
  writeFileSync(join(root, 'probe-older.summaries.json'), JSON.stringify({ 'gone-c1': { fork: 'Checkpoint: "a deleted request"' }, 'unknown-r1': { fork: 'Checkpoint: unattributed' } }));
  assert.equal(pruneProbeSummaries(f.store.file, { state: f.store.state }), 2);
  assert.equal(existsSync(join(root, 'probe-older.summaries.json')), false); assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8'))).length, 3);
  // The conversation is deleted (its purge removes the file); a report the run writes later does not bring them back.
  f.store.mutate(state => { state.sessions = state.sessions.filter(row => row.id !== f.session.id); });
  assert.equal(purgeProbeSummaries(f.store.file, f.session.id), 3); assert.equal(existsSync(file), false);
  f.probe.writeReports();
  assert.equal(existsSync(file), false, 'the run\'s in-memory summaries of a deleted conversation are dropped');
  assert.ok(existsSync(join(root, `${done.id}.json`)), 'the report (ids and numbers only) stays');
});

test('daemon routes: preview, refusal without approval, cancel while held; CLI previews without --approved and polls a run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-fork-probe-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = createServer({ stateFile: join(dir, 'state.json'), ticks: false, runtime: false, initiative: false }); await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (path, method = 'GET', body) => { const response = await fetch(`${base}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const json = await response.json(); if (!response.ok) throw Object.assign(new Error(json.error), { status: response.status, code: json.code }); return json; };
  const preview = await call('/v2/maintenance/compaction-fork-probe?points=5');
  assert.equal(preview.running, false); assert.equal(preview.plan.selected, 0); assert.equal(preview.plan.options.points, 5); assert.deepEqual(preview.reports, []);
  await assert.rejects(call('/v2/maintenance/compaction-fork-probe', 'POST', {}), { status: 400, code: 'replay_not_approved' });
  await assert.rejects(call('/v2/maintenance/compaction-fork-probe', 'POST', { approved: true }), { status: 409, code: 'replay_no_points' });
  assert.deepEqual(await call('/v2/maintenance/compaction-fork-probe/cancel', 'POST', {}), { cancelled: false });
  await assert.rejects(call('/v2/maintenance/compaction-fork-probe/reports/nope'), { status: 404 });
  publishPrefix('unrelated-project', { ...PREFIX, modelKey: 'x/y' });
  // CLI: the preview only, without --approved.
  const logs = [];
  const result = await runCompactionCommand(['probe', '--points', '5'], call, { log: line => logs.push(line) });
  assert.equal(result.approved, false); assert.equal(result.plan.selected, 0); assert.match(logs[0], /^探针计划：0 个点/);
  await assert.rejects(runCompactionCommand(['probe', '--bogus'], call), /compaction status \| probe/);
  await assert.rejects(runCompactionCommand(['report'], call), /compaction report <id>/);
  // While application maintenance holds new work a probe cannot start, but it can always be cancelled.
  persistMaintenance(join(dir, 'state.json'), initialMaintenance('backup', {}, randomUUID(), {})); app.maintenanceGate.refresh();
  assert.equal(app.maintenanceGate.held, true);
  await assert.rejects(call('/v2/maintenance/compaction-fork-probe', 'POST', { approved: true }), { status: 503, code: 'maintenance_held' });
  assert.deepEqual(await call('/v2/maintenance/compaction-fork-probe/cancel', 'POST', {}), { cancelled: false });
  assert.equal((await call('/v2/maintenance/compaction-fork-probe')).running, false, 'the preview stays readable');
});

test('CLI: --approved starts, polls until the run ends and writes the report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-fork-probe-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [], job = { id: 'probe-x', phase: 'running', done: 0, calls: 2, spentTokens: 0, points: [] };
  const plan = { selected: 1, candidates: { compactions: 1, context: 0 }, calls: 2, estimate: 5000, options: { budgetTokens: PROBE_BUDGET_TOKENS }, approval: { approved: PROBE_BUDGET_TOKENS, spent: 0, remaining: PROBE_BUDGET_TOKENS }, dailyRemaining: null, prefixMissing: [], points: [{ id: 'abc-c1', kind: 'compaction', model: 'glm-5.3', size: 2000, warm: false, compaction: { flatModel: 'glm-5.3' }, requests: { warmup: 2256, fork: 2744 }, estimate: 5000 }] };
  let polls = 0;
  const call = async (path, method = 'GET', body) => {
    calls.push([method, path, body]);
    if (path.startsWith('/v2/maintenance/compaction-fork-probe/reports/')) return { id: 'probe-x', json: { ...job, phase: 'completed' }, markdown: '# report' };
    if (method === 'POST') return job;
    if (path.includes('?')) return { running: false, plan, reports: [] };
    return ++polls < 2 ? { running: true, job, reports: [] } : { running: false, job: { ...job, phase: 'completed', done: 2, spentTokens: 4800, summary: { gate: { pass: true, reasons: [] } } }, reports: ['probe-x'] };
  };
  const out = join(dir, 'report.md'), logs = [];
  const result = await runCompactionCommand(['probe', '--approved', '--points', '1', '--budget', '100000', '--out', out], call, { wait: async () => {}, log: line => logs.push(line) });
  assert.deepEqual(calls[0], ['GET', '/v2/maintenance/compaction-fork-probe?points=1&budgetTokens=100000', undefined]);
  assert.deepEqual(calls[1], ['POST', '/v2/maintenance/compaction-fork-probe', { approved: true, points: 1, budgetTokens: 100000 }]);
  assert.equal(result.phase, 'completed'); assert.equal(result.spentTokens, 4800); assert.equal(result.gate.pass, true); assert.equal(result.written, out);
  assert.equal(await readFile(out, 'utf8'), '# report'); assert.ok(logs.some(line => line.includes('abc-c1') && line.includes('压缩点')));
  assert.equal(existsSync(out), true);
});

// C5 harness fixes: a warm-up the provider cut short (the SDK reports provider_protocol when the reply ends inside a
// reasoning or tool turn at the 1024-token allowance) still put its prompt in the cache, so request B goes out; two of
// the six points of the first probe were lost to this, and the flat request C sits only on compaction points, which left
// one request to compare.
test('a warm-up that failed after reporting its prompt counts as warmed and request B still goes out; one that reported nothing warmed nothing', async t => {
  const { ProviderError } = await import('../../../packages/sdk/src/providers.mjs');
  const cut = () => new ProviderError('模型工具片段没有以工具调用状态完整结束', { code: 'provider_protocol', providerFinishReason: 'length' });
  // The prompt is processed and cached, the usage arrives, and then the stream is found to end inside a tool call.
  const reported = paidProvider(), reportedStream = reported.provider;
  reported.provider = async function* (input) { for await (const event of reportedStream(input)) { if (event.type === 'done' && !isFork(input) && !flattened(input)) throw cut(); yield event; } };
  const f = await fixture(t, { provider: reported });
  await f.probe.start({ approved: true, points: 2 });
  const done = await settled(f.probe);
  assert.equal(done.phase, 'completed', JSON.stringify(done.points.map(row => [row.id, row.status, row.reason])));
  for (const point of done.points) {
    assert.equal(point.warmup.status, 'failed'); assert.equal(point.warmup.code, 'provider_protocol'); assert.equal(point.warmup.warmed, true);
    assert.equal(point.status, 'completed', `${point.id}: ${point.reason}`); assert.ok(point.fork, 'request B was sent');
    assert.ok(point.fork.sharedPrefixTokens > 0 && point.fork.cachedTokens === point.fork.sharedPrefixTokens && point.fork.hitRatio === 1, 'it read what the failed warm-up cached');
  }
  assert.equal(f.provider.seen.length, reported.seen.length); assert.ok(reported.seen.some(isFork));
  assert.match(probeMarkdown(done), /sent \(\d+; provider_protocol, warmed\)/);
  // The spend safety stays: each request reserved its worst case before it was sent, and the spend is what was reported.
  const spend = JSON.parse(await readFile(join(`${f.store.file}.rna`, 'compaction-fork-probe', 'spend.json'), 'utf8'));
  assert.equal(spend.jobs[done.id].spentTokens, done.spentTokens); assert.ok(done.spentTokens <= done.budgetTokens);
  assert.equal(f.probe.inFlight, 0);
  // A failure that reported no prompt warmed nothing: B is not sent (the old behaviour), the point is failed.
  const silent = paidProvider(), silentStream = silent.provider;
  silent.provider = async function* (input) { if (!isFork(input) && !flattened(input)) throw cut(); yield* silentStream(input); };
  const g = await fixture(t, { provider: silent });
  await g.probe.start({ approved: true, points: 2 });
  const failed = await settled(g.probe);
  assert.ok(failed.points.every(row => row.status === 'failed' && row.reason === 'warmup_provider_protocol' && row.warmup.warmed === false && row.fork === null), JSON.stringify(failed.points.map(row => [row.status, row.reason, row.warmup?.warmed])));
  assert.equal(silent.seen.filter(isFork).length, 0);
  assert.equal(warmedByUsage({ input: 1200, output: 0 }), true); assert.equal(warmedByUsage({ input: 0, cacheRead: 900 }), true, 'a warm cache read is a processed prompt too');
  assert.equal(warmedByUsage(null), false); assert.equal(warmedByUsage({ input: 0, output: 50 }), false); assert.equal(warmedByUsage({}), false);
});

test('the flat request C on a large-context point: sent while the budget allows it beside the later points, dropped (not the run) when it would not', async t => {
  // Every point's request C when nothing is tight (the main run test): a compaction point's is required, a large-context point's optional.
  const f = await fixture(t);
  await f.probe.start({ approved: true, points: 3 });
  const roomy = await settled(f.probe);
  assert.ok(roomy.points.every(row => row.flat?.status === 'completed'), 'room for every flat request');
  // The later points' planned shares are what an optional request must leave: with those inflated, the first large-context
  // point has no room for C and goes without it, the last one (nothing planned after it) still gets it, and the run completes.
  const g = await fixture(t);
  const run = g.probe.run.bind(g.probe), plan = await g.probe.plan({ points: 3 });
  g.probe.run = (points, signal) => run(points.map(point => ({ ...point, estimate: point.estimate * 6 })), signal);
  await g.probe.start({ approved: true, points: 3, budgetTokens: Math.ceil(plan.estimate / PLAN_SHARE) });
  const done = await settled(g.probe);
  assert.equal(done.phase, 'completed', `${done.phase}: ${JSON.stringify(done.points.map(row => [row.id, row.status, row.reason]))}`);
  assert.ok(done.spentTokens <= done.budgetTokens);
  const compaction = done.points.find(row => row.kind === 'compaction'), contexts = done.points.filter(row => row.kind === 'context');
  assert.equal(compaction.flat.status, 'completed', 'a compaction point always gets its flat request: its comparison needs it');
  assert.equal(contexts.length, 2); assert.equal(contexts[0].flat, null); assert.equal(contexts[0].coverage, null); assert.equal(contexts[1].flat.status, 'completed');
  assert.ok(contexts[0].status === 'completed' && contexts[0].fork.accepted && contexts[0].fork.hitRatio === 1, 'the point whose C was dropped is still a complete cache and text-only measurement');
  assert.equal(g.provider.seen.filter(flattened).length, 2, 'C on the compaction point and on the last large-context point');
  // Those two comparisons are in the gate's coverage count; the point without C is not.
  assert.equal(done.summary.coverage.points, 2); assert.equal(done.summary.coverage.compared, 2);
});

// Review of C5 (findings 6 and 8). The hard cap: a point's requests start only while their worst cases still fit the budget.
// The optional flat request C on a large-context point is dropped (not the run) when the cap leaves room for A and B alone —
// the existing test inflates the later points' plans but leaves the cap ample — and C is read against the cap again after B,
// which may have reported more than its ceiling.
test('request C: dropped at a tight hard cap before the warm-up, and checked again after the fork, which may have cost more than its ceiling', async t => {
  const roomy = await fixture(t);
  await roomy.probe.start({ approved: true, points: 3 });
  const reference = await settled(roomy.probe), ceilingsOf = kind => { const point = reference.points.find(row => row.kind === kind); return { a: point.warmup.ceiling, b: point.fork.ceiling, c: point.flat.ceiling }; };
  const alone = async (kind, budget, provider = paidProvider()) => {
    const g = await fixture(t, { provider }), run = g.probe.run.bind(g.probe);
    // One point of the kind, with the hard cap set to `budget` (the plan's own estimate is not what binds here).
    g.probe.run = (points, signal) => { g.probe.job.budgetTokens = budget; return run(points.filter(point => point.kind === kind).slice(0, 1), signal); };
    await g.probe.start({ approved: true, points: 3 });
    const done = await settled(g.probe);
    return { done, g, record: done.points.find(row => row.kind === kind) };
  };
  const inflated = extra => { const paid = paidProvider(), base = paid.provider; paid.provider = async function* (input) { for await (const event of base(input)) yield isFork(input) && event.type === 'usage' ? { ...event, usage: { ...event.usage, input: event.usage.input + extra } } : event; }; return paid; };
  const context = ceilingsOf('context'), compaction = ceilingsOf('compaction');
  // (8) Room for A and B but not for C: the large-context point goes without C and the run completes (a compaction point's C is required).
  const tight = await alone('context', context.a + context.b + context.c - 1);
  assert.equal(tight.done.phase, 'completed', `${tight.done.phase}: ${tight.record.reason}`); assert.equal(tight.record.status, 'completed');
  assert.equal(tight.g.provider.seen.length, 2, 'A and B only'); assert.equal(tight.record.flat, null); assert.equal(tight.record.coverage, null);
  assert.ok(tight.record.fork.accepted && tight.record.fork.hitRatio === 1, 'still a complete cache and text-only measurement');
  // Room for all three: C goes out (the other side of the same line).
  const roomyOne = await alone('context', context.a + context.b + context.c);
  assert.equal(roomyOne.g.provider.seen.length, 3); assert.equal(roomyOne.record.flat.status, 'completed');
  // (6) The fork reported more than its ceiling, so the room the pre-check left for C is gone: a context point drops C and the run goes on ...
  const over = await alone('context', context.a + context.b + context.c, inflated(context.a + context.b));
  assert.equal(over.done.phase, 'completed'); assert.equal(over.g.provider.seen.length, 2, 'no flat request: it no longer fits'); assert.equal(over.record.flat, null);
  assert.ok(over.done.spentTokens > over.done.budgetTokens - context.c, 'the fork left less than C\'s worst case');
  // ... and a compaction point, whose comparison needs C, stops the run before it.
  const required = await alone('compaction', compaction.a + compaction.b + compaction.c, inflated(compaction.a + compaction.b));
  assert.equal(required.done.phase, 'budget_stop'); assert.equal(required.done.stopReason, 'budget'); assert.equal(required.g.provider.seen.length, 2, 'A and B were sent, C was not');
  assert.deepEqual([required.record.status, required.record.reason, required.record.flat.status, required.record.flat.reason], ['completed', 'flat_budget', 'not_run', 'budget']); assert.equal(required.record.fork.status, 'completed');
  assert.ok(required.done.spentTokens <= required.done.budgetTokens + compaction.b + compaction.a, 'nothing was spent after the stop');
  assert.equal(required.g.probe.inFlight, 0);
});

test('the gate counts a large-context point where the flat request was sent too, and only such points', () => {
  const measured = { kind: 'context', status: 'completed', model: { modelId: 'glm-fixture' }, prefix: { source: 'project' }, fork: { status: 'completed', hitRatio: 0.95, textOnly: true, toolCalls: 0, accepted: true } };
  const compared = count => ({ requests: count, substantive: count, compared: count, losses: 0, gains: 0, atLeastAsGood: true });
  // Two compaction points hold too few requests (the first probe: one); large-context points with C add to the count.
  const compaction = { ...measured, kind: 'compaction', coverage: compared(2) };
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, compaction] }).gate.reasons, ['coverage_insufficient']);
  const withFlat = { ...measured, flat: { status: 'completed' }, coverage: compared(COVERAGE_MIN_REQUESTS - 2) };
  const summary = summarizeProbe({ phase: 'completed', points: [measured, compaction, withFlat] });
  assert.deepEqual(summary.gate.reasons, []); assert.equal(summary.coverage.requests, COVERAGE_MIN_REQUESTS); assert.equal(summary.coverage.points, 2);
  // A large-context point without C is not a comparison; one whose comparison could not be judged is unchecked, as on a compaction point.
  assert.equal(summarizeProbe({ phase: 'completed', points: [measured, compaction, measured] }).coverage.points, 1);
  const unjudged = { ...measured, flat: { status: 'completed' }, coverage: { requests: 3, compared: 0, atLeastAsGood: null, unchecked: 'judge_failed' } };
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, compaction, withFlat, unjudged] }).gate.reasons, ['coverage_unchecked']);
  // A stand-in prefix on a large-context point: no evidence, as on a compaction point.
  const borrowed = { ...withFlat, prefix: { source: 'other_project' } };
  assert.deepEqual(summarizeProbe({ phase: 'completed', points: [measured, compaction, borrowed] }).gate.reasons, ['coverage_insufficient']);
});
