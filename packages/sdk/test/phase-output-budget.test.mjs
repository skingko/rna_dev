import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { buildRequest } from '../src/providers.mjs';
import { createSession } from '../src/session.mjs';
import { prepareContext } from '../src/context.mjs';
import { evolutionHash } from '../src/evolution.mjs';
import { proposeProjectGenome, evaluateProjectGenomes, estimateProjectEvolutionBudget } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider, diagnosisFixture } from './fixtures/project-genome.mjs';

// No external inference: exercise the real SDK loop, scripts and official wire
// contract with a deterministic local completion source.
const model = { providerId: 'glm-fixture', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', contextWindow: 1000000, maxOutputTokens: 32768, reasoning: 'xhigh' };
const bootstrap = () => ({ overview: 'Evidence project', focus: 'Verify the project contract', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() });
const completed = async function* (value) { yield { type: 'text_delta', delta: JSON.stringify(value) }; yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' }; };
function assertConfigured(request, cap = model.maxOutputTokens) {
  assert.equal(request.model.maxOutputTokens, cap); assert.equal(request.model.reasoning, model.reasoning);
  const { body } = buildRequest(request);
  assert.equal(body.max_tokens, cap); assert.equal(body.max_completion_tokens, undefined);
  assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'max');
}

test('bootstrap and bounded bootstrap repair preserve the real configured total output budget', async () => {
  let count = 0; const admissions = [];
  const result = await bootstrapProject({ title: 'Evidence project', model, beforeRequest: request => admissions.push(request.estimatedTokens), provider: async function* (request) { assertConfigured(request); yield* completed(++count === 1 ? {} : bootstrap()); } });
  assert.equal(result.status, 'ready'); assert.equal(count, 2);
  assert.ok(admissions.every(value => value > model.maxOutputTokens));
  assert.deepEqual(result.genome.evaluationSuite.execution, { maxSteps: 16, maxOutputTokens: model.maxOutputTokens });
});

test('bootstrap preserves an explicitly authored initial execution allowance instead of overwriting it', async () => {
  const authored = bootstrap(); authored.genome.evaluationSuite.execution = { maxSteps: 4, maxOutputTokens: 1024 };
  const result = await bootstrapProject({ title: 'Explicit initial policy', model, provider: async function* (request) { assertConfigured(request); assert.match(request.systemPrompt, /"maxOutputTokens":32768/); yield* completed(authored); } });
  assert.deepEqual(result.genome.evaluationSuite.execution, authored.genome.evaluationSuite.execution);
});

test('proposal and actual script repair preserve configuration without changing the frozen oracle', async () => {
  const baseline = projectGenomeFixture(), before = structuredClone(baseline), broken = projectGenomeFixture({ candidate: true });
  broken.tools[0].script = 'return { doubled: 99 };'; let calls = 0;
  const result = await proposeProjectGenome({ project: { id: 'output-budget' }, baseline, evidence: [], model, provider: async function* (request) {
    assertConfigured(request);
    yield* completed(++calls === 1 ? { summary: 'Improve evidence interpretation', hypothesis: 'A checked result supports a useful answer', diagnosis: diagnosisFixture(), changes: ['Interpret checked evidence'], genome: broken } : { tools: [{ id: 'evidence_helper', script: 'return { doubled: input.value * 2 };' }], smokeRepairs: [] });
  } });
  assert.equal(result.validation.passed, true); assert.equal(calls, 2); assert.deepEqual(baseline, before);
  assert.ok(result.requests.every(receipt => receipt.maxOutputTokens === 32768 && receipt.configuredReasoning === 'xhigh'));
});

for (const cap of [32768, 1024]) test(`blind judge uses configured ${cap} output tokens while both agents retain the frozen execution allowance`, async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), calls = [];
  baseline.evaluationSuite.execution = { maxSteps: 16, maxOutputTokens: 4096 };
  baseline.evaluationSuite.criteria = Array.from({ length: 8 }, (_, i) => ({ id: `criterion_${i}`, description: `Verify evidence aspect ${i} against actual outcomes.`, weight: 1 }));
  const before = structuredClone(baseline), configured = { ...model, maxOutputTokens: cap };
  const result = await evaluateProjectGenomes({ baseline, candidate, model: configured, provider: genomeEvaluationProvider({ calls }) });
  assert.equal(result.gatePassed, true); assert.equal(result.suiteHash, evolutionHash(before.evaluationSuite)); assert.deepEqual(baseline, before);
  const judges = calls.filter(request => request.systemPrompt.includes('blind evaluator'));
  assert.equal(judges.length, 3);
  for (const request of judges) { assertConfigured(request, cap); assert.deepEqual(JSON.parse(request.messages[0].content[0].text).criteria, before.evaluationSuite.criteria); }
  for (const request of calls.filter(request => !judges.includes(request))) assertConfigured(request, Math.min(cap, 4096));
  for (const row of result.details) assert.deepEqual(row.baseline.execution, row.candidate.execution);
  for (const receipt of result.requests) assert.equal(receipt.maxOutputTokens, receipt.phase.startsWith('judge:') ? cap : Math.min(cap, 4096));
});

test('a new explicitly frozen 32768-token suite runs both real SDK agents with the same allowance', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), calls = [];
  baseline.evaluationSuite.execution = { maxSteps: 16, maxOutputTokens: 32768 };
  const suiteHash = evolutionHash(baseline.evaluationSuite);
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: genomeEvaluationProvider({ calls }) });
  assert.equal(result.gatePassed, true); assert.equal(result.suiteHash, suiteHash);
  for (const request of calls) assertConfigured(request);
  for (const row of result.details) { assert.deepEqual(row.baseline.execution, { maxSteps: 16, maxOutputTokens: 32768 }); assert.deepEqual(row.candidate.execution, row.baseline.execution); }
  assert.equal(evolutionHash(baseline.evaluationSuite), suiteHash);
});

test('a truncated judge remains unscored and is not rerun to get a favorable answer', async () => {
  const ordinary = genomeEvaluationProvider(); let judges = 0;
  await assert.rejects(evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: projectGenomeFixture({ candidate: true }), model, provider: async function* (request) {
    if (!request.systemPrompt.includes('blind evaluator')) { yield* ordinary(request); return; }
    judges++; assertConfigured(request); yield { type: 'thinking_delta', delta: 'incomplete reasoning' }; yield { type: 'usage', usage: { totalTokens: 32768 } }; yield { type: 'done', stopReason: 'length', providerFinishReason: 'length' };
  } }), error => error.evolutionDiagnostic?.phase === 'judge' && error.evolutionDiagnostic.stopReason === 'length' && error.evaluationEvidence.cases.length === 0 && error.requests.at(-1).maxOutputTokens === 32768);
  assert.equal(judges, 1);
});

test('planning headroom follows author and judge configuration while the case resource contract stays fixed', () => {
  const genome = projectGenomeFixture(), before = structuredClone(genome);
  const lower = estimateProjectEvolutionBudget(genome, { ...model, maxOutputTokens: 16384 });
  const higher = estimateProjectEvolutionBudget(genome, model);
  assert.equal(higher - lower, (8 + genome.evaluationSuite.cases.length) * 16384); assert.deepEqual(genome, before);
});

async function sessionFixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'rna-phase-budget-')), sessions = [];
  const create = async extra => { const session = await createSession({ sessionId: 'phase-output-budget', cwd, stateDir: join(cwd, 'state'), model, ...options, ...extra }); sessions.push(session); return session; };
  t.after(async () => { for (const session of sessions) await session.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { create, session: await create() };
}
function summaryProvider(calls, repeats = 1000) { return async function* (request) {
  calls.push(request); yield { type: 'text_delta', delta: request.systemPrompt.startsWith('Summarize') ? 'Retain authorization, verified facts and pending work.' : 'facts '.repeat(repeats) };
  yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } }; yield { type: 'done', stopReason: 'stop' };
}; }

test('manual generated compaction preserves configured thinking and allowance above the former 2048 cap', async t => {
  const calls = [], hooks = [];
  const { session } = await sessionFixture(t, { provider: summaryProvider(calls), beforeCompletion: value => hooks.push(value) });
  for (let i = 0; i < 3; i++) await session.prompt(`Historical facts ${i}`);
  const original = session.snapshot().messages, result = await session.compact({ generate: true });
  assert.equal(result.compacted, true); assertConfigured(calls.at(-1)); assert.equal(hooks.at(-1).maxOutputTokens, 32768); assert.equal(hooks.at(-1).purpose, 'compaction');
  assert.deepEqual(session.snapshot().messages, original);
});

test('automatic compaction uses configured allowance and reasoning while retaining complete raw history', async t => {
  // GLM-5.3 on the official route forks its automatic compaction (C5: the conversation's own prefix plus an instruction); with
  // compat.compactionFork false it sends the flattened record. Either way the summary keeps the configured allowance and effort.
  for (const [name, compat] of [['fork', undefined], ['flattened', { compactionFork: false }]]) {
    const calls = [], configured = { ...model, contextWindow: 64000, maxOutputTokens: 8192, ...(compat ? { compat } : {}) };
    const { session } = await sessionFixture(t, { model: configured, provider: summaryProvider(calls, 4000) });
    for (let i = 0; i < 9; i++) await session.prompt(`Historical facts ${i}`);
    const summaries = calls.filter(request => request.purpose === 'compaction');
    assert.ok(summaries.length > 0, name); for (const request of summaries) assertConfigured(request, 8192);
    assert.equal(summaries.every(request => request.systemPrompt.startsWith('Summarize')), name === 'flattened', name);
    assert.equal(session.snapshot().messages.length, 18, name);
  }
});

test('manual compaction clamps only to actual remaining context and keeps the configured reasoning', async t => {
  const calls = [], provider = summaryProvider(calls, 350), configured = { ...model, contextWindow: 10000, maxOutputTokens: 1000 };
  const { session, create } = await sessionFixture(t, { model: configured, autoCompaction: false, provider });
  for (let i = 0; i < 4; i++) await session.prompt(`Historical facts ${i}`);
  const sessionFile = session.snapshot().sessionFile; await session.dispose();
  const reopened = await create({ sessionFile, model: { ...configured, maxOutputTokens: 9000 } });
  const result = await reopened.compact({ generate: true, keepLastTurns: 1 });
  assert.equal(result.compacted, true); const request = calls.at(-1);
  assert.ok(request.model.maxOutputTokens > 2048 && request.model.maxOutputTokens < 9000); assert.equal(request.model.reasoning, 'xhigh');
  const estimated = prepareContext({ sessionId: reopened.snapshot().sessionId, systemPrompt: request.systemPrompt, messages: request.messages, model: request.model }).estimatedInputTokens;
  assert.equal(estimated + request.model.maxOutputTokens, configured.contextWindow);
});

test('manual compaction of a history longer than the window summarizes it in bounded batches up to the requested boundary', async t => {
  // The history was written under a larger window (or before a model switch); this model holds about two thirds of it.
  const calls = [], provider = summaryProvider(calls, 700), configured = { ...model, contextWindow: 12000, maxOutputTokens: 2000 };
  const { session: writer, create } = await sessionFixture(t, { autoCompaction: false, provider });
  for (let i = 0; i < 12; i++) await writer.prompt(`Historical facts ${i}`);
  const sessionFile = writer.snapshot().sessionFile; await writer.dispose();
  const session = await create({ sessionFile, model: configured, autoCompaction: false });
  const before = session.snapshot().messages, summaries = () => calls.filter(request => request.systemPrompt.startsWith('Summarize'));
  const result = await session.compact({ generate: true, keepLastTurns: 1 });
  assert.equal(result.compacted, true); assert.ok(result.batches >= 2, `batches ${result.batches}`); assert.equal(result.partial, undefined);
  assert.equal(summaries().length, result.batches);
  for (const request of summaries()) {
    const estimated = prepareContext({ sessionId: session.snapshot().sessionId, systemPrompt: request.systemPrompt, messages: request.messages, model: request.model }).estimatedInputTokens;
    assert.ok(estimated + request.model.maxOutputTokens <= configured.contextWindow, `${estimated} + ${request.model.maxOutputTokens}`);
  }
  // Each later batch carries the previous summary forward instead of the raw records already summarized.
  assert.match(summaries().at(-1).messages[0].content[0].text, /^<previous-summary>\nRetain authorization/);
  const users = before.flatMap((message, index) => message.role === 'user' ? [index] : []);
  assert.equal(session.snapshot().compaction?.throughMessageId ?? result.throughMessageId, before[users.at(-1) - 1].id, 'compacted up to the last kept turn');
  assert.deepEqual(session.snapshot().messages, before, 'raw history is kept');
});
