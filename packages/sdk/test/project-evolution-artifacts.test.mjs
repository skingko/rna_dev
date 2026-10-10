import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProjectGenome, smokeProjectGenome } from '../src/project-genome.mjs';
import { evaluateProjectGenomes, estimateProjectEvolutionBudget, proposeProjectGenome } from '../src/project-evolution.mjs';
import { prepareEvaluationWorkspace, verifyEvaluationWorkspace } from '../src/project-evaluation-workspace.mjs';
import { RNA_AGENT_METHOD, RNA_AGENT_METHOD_VERSION, RNA_EVOLUTION_METHOD } from '../src/methodology.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 6000, reasoning: 'off' };
function artifactGenome(candidate = false) {
  const genome = projectGenomeFixture({ candidate }); genome.tools = [];
  genome.evaluationSuite.cases = [1, 2, 3].map(value => ({ id: `case_${value}`, input: 'Read input.json. Write result.json with a doubled value, then explain the evidence.', requiredTerms: ['evidence'], forbiddenTerms: [], requiredToolIds: ['project_read', 'project_write'], weight: 1,
    workspace: { files: [{ path: 'input.json', content: JSON.stringify({ value }) }], checks: [{ id: 'result', kind: 'json_equals', path: 'result.json', expected: { doubled: value * 2 } }] }
  })); return genome;
}
function artifactProvider({ calls = [], bad = false, extended = false } = {}) {
  return async function* (request) {
    calls.push(request);
    const output = request.messages.filter(item => item.role === 'toolResult'), candidate = request.systemPrompt.includes('CANDIDATE_AGENT');
    if (request.systemPrompt.includes('blind evaluator')) {
      const input = JSON.parse(request.messages[0].content[0].text);
      const ratings = { ratings: input.criteria.map(item => ({ criterionId: item.id, left: input.left.answer.includes('precise') ? .9 : .5, right: input.right.answer.includes('precise') ? .9 : .5, reason: 'Compare the delivered JSON and its explanation.' })) };
      if (request.tools?.[0]?.name === 'submit_evaluation_ratings') {
        yield { type: 'tool_call', id: `ratings-${calls.length}`, name: request.tools[0].name, arguments: ratings };
        yield { type: 'usage', usage: { input: 8, output: 5, totalTokens: 13 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
      }
      yield { type: 'text_delta', delta: JSON.stringify(ratings) };
    } else {
      let tool;
      if (extended && !output.some(item => item.toolName === 'skill_load')) tool = { name: 'skill_load', arguments: { id: 'host:rna-delivery-quality' } };
      else if (extended && !output.some(item => item.toolName === 'project_list')) tool = { name: 'project_list', arguments: {} };
      else if (!output.some(item => item.toolName === 'project_read')) tool = { name: 'project_read', arguments: { path: 'input.json' } };
      else if (!output.some(item => item.toolName === 'project_write')) {
        const source = output.find(item => item.toolName === 'project_read').content[0].text;
        const input = JSON.parse(source.split('\n').find(line => line.startsWith('1\t')).slice(2));
        tool = { name: 'project_write', arguments: { path: 'result.json', content: JSON.stringify({ doubled: bad && candidate ? 999 : input.value * 2 }), expectedHash: null } };
      }
      if (tool) { yield { type: 'tool_call', id: `call-${calls.length}`, ...tool }; yield { type: 'usage', usage: { input: 8, output: 5, totalTokens: 13 } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
      yield { type: 'text_delta', delta: candidate ? 'precise evidence: delivered and verified.' : 'preliminary evidence: delivered.' };
    }
    yield { type: 'usage', usage: { input: 8, output: 5, totalTokens: 13 } }; yield { type: 'done', stopReason: 'stop' };
  };
}
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'rna-artifact-')); t.after(() => rm(root, { recursive: true, force: true })); const workspace = join(root, 'workspace'); await mkdir(workspace); return { root, workspace }; }

test('zero custom tools is a valid project and does not claim any script execution', async () => {
  const genome = artifactGenome(); assert.deepEqual(validateProjectGenome(genome), genome);
  assert.deepEqual(await smokeProjectGenome(genome), { passed: true, applicable: false, executed: false, results: [], runner: 'node-restricted-api' });
});

test('step-limited evaluations retain partial real tool and artifact receipts without changing the frozen limits or giving a score', async () => {
  const baseline = artifactGenome(), candidate = artifactGenome(true); baseline.evaluationSuite.execution = { maxSteps: 2, maxOutputTokens: 4096 };
  const original = structuredClone(baseline.evaluationSuite), calls = [];
  await assert.rejects(evaluateProjectGenomes({ baseline, candidate, model, provider: artifactProvider({ calls }) }), failure => {
    assert.equal(failure.evolutionDiagnostic.kind, 'step_limit'); assert.equal(failure.evaluationEvidence.cases.length, 0);
    const partial = failure.evaluationEvidence.inFlightCase.baseline;
    assert.equal(partial.complete, false); assert.equal(partial.passed, false); assert.equal(partial.checks.completed, false);
    assert.deepEqual(partial.toolResults.map(row => row.toolName), ['project_read', 'project_write']); assert.equal(partial.workspace.passed, true); assert.equal(partial.execution.maxSteps, 2); return true;
  });
  assert.deepEqual(baseline.evaluationSuite, original); assert.equal(calls.length, 2);
});

test('workspace cases use actual files, shared methods, progressive skills and more than four steps; hidden oracles stay out of execution prompts', async () => {
  const calls = [], reservations = [], receipts = [], baseline = artifactGenome(), candidate = artifactGenome(true);
  // Proposed weakening is irrelevant to the frozen baseline fixture/oracle.
  candidate.evaluationSuite.cases.forEach(item => { item.workspace.checks[0].expected = { doubled: 999 }; });
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: artifactProvider({ calls, extended: true }), requestControl: { beforeRequest: input => reservations.push(input), onUsage: value => receipts.push(value) } });
  assert.equal(result.gatePassed, true); assert.equal(result.methodologyVersion, RNA_AGENT_METHOD_VERSION); assert.equal(result.coverage.workspaceCases, 3); assert.equal(result.coverage.artifactChecks, 3); assert.equal(result.coverage.visualQuality, 'not_verified');
  assert.equal(result.smoke.executed, false); assert.equal(result.usage.totalTokens, calls.length * 13); assert.equal(receipts.length, calls.length); assert.equal(reservations.length, calls.length);
  assert.ok(reservations.every(item => item.estimatedTokens > 4096));
  for (const request of calls.filter(item => !item.systemPrompt.includes('blind evaluator'))) {
    assert.ok(request.systemPrompt.startsWith(RNA_AGENT_METHOD)); assert.equal(request.model.maxOutputTokens, 4096);
    assert.ok(!request.tools.some(tool => tool.name === 'project_exec')); assert.ok(!request.systemPrompt.includes('json_equals'));
    assert.ok(!request.systemPrompt.includes('"checks"'));
  }
  for (const row of result.details) {
    assert.deepEqual(row.candidate.execution, { maxSteps: 16, maxOutputTokens: 4096 }); assert.equal(row.candidate.checks.artifacts, true);
    assert.equal(row.baseline.workspace.artifacts[0].hash, row.candidate.workspace.artifacts[0].hash);
    assert.equal(row.candidate.workspace.artifacts[0].truncated, false); assert.equal(row.candidate.toolResults.length, 4);
  }
  for (const request of calls.filter(item => item.systemPrompt.includes('blind evaluator'))) {
    const input = JSON.parse(request.messages[0].content[0].text); assert.ok(input.left.artifacts[0].content); assert.equal(input.right.artifactChecks[0].passed, true); assert.equal(input.left.artifacts[0].path, 'result.json');
    assert.ok(!JSON.stringify(input).includes('CANDIDATE_AGENT')); assert.equal(input.left.artifactChecks[0].expected, undefined);
  }
});

test('claiming success or weakening a candidate oracle cannot pass a wrong actual artifact; paid judging stops early', async () => {
  const calls = [], baseline = artifactGenome(), candidate = artifactGenome(true); candidate.evaluationSuite.cases.forEach(item => { item.workspace.checks[0].expected = { doubled: 999 }; });
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: artifactProvider({ calls, bad: true }) });
  assert.equal(result.gatePassed, false); assert.equal(result.earlyStopReason, 'candidate_deterministic_failed'); assert.equal(result.candidateScore, null); assert.equal(result.skippedCases, 2);
  assert.equal(result.details[0].candidate.workspace.checks[0].code, 'artifact_mismatch'); assert.equal(result.details[0].candidate.checks.artifacts, false);
  assert.equal(calls.length, 6); assert.ok(!calls.some(item => item.systemPrompt.includes('blind evaluator')));
});

test('explicit execution limits are frozen, output respects actual model cap, exhaustion is incomplete not a fabricated quality score', async () => {
  const baseline = artifactGenome(), candidate = artifactGenome(true), calls = []; baseline.evaluationSuite.execution = { maxSteps: 2, maxOutputTokens: 7000 };
  candidate.evaluationSuite.execution = { maxSteps: 32, maxOutputTokens: 8192 };
  await assert.rejects(evaluateProjectGenomes({ baseline, candidate, model: { ...model, maxOutputTokens: 3000 }, provider: artifactProvider({ calls }) }), failure => failure.code === 'step_limit' && failure.evolutionDiagnostic.phase === 'baseline' && failure.usage.totalTokens === 26);
  assert.equal(calls.length, 2); assert.ok(calls.every(item => item.model.maxOutputTokens === 3000));
  const smaller = artifactGenome(); smaller.evaluationSuite.execution = { maxSteps: 4, maxOutputTokens: 1500 };
  assert.ok(estimateProjectEvolutionBudget(baseline, model) > 0); assert.ok(estimateProjectEvolutionBudget(artifactGenome(), model) > estimateProjectEvolutionBudget(smaller, model));
});

test('fixture schemas reject private/escaping/overlapping paths, unchecked cases, unknown validators, oversized bytes and unbounded execution', () => {
  for (const mutate of [
    g => { g.evaluationSuite.cases[0].workspace.files[0].path = '../secret'; },
    g => { g.evaluationSuite.cases[0].workspace.checks[0].path = '.env'; },
    g => { g.evaluationSuite.cases[0].workspace.files.push({ path: 'input.json/child', content: '' }); },
    g => { g.evaluationSuite.cases[0].workspace.files[0].content = '中'.repeat(22000); },
    g => { g.evaluationSuite.cases[0].workspace.files = [1, 2, 3].map(n => ({ path: `${n}.txt`, content: 'x'.repeat(50000) })); },
    g => { g.evaluationSuite.cases[0].workspace.checks = []; },
    g => { g.evaluationSuite.cases[0].workspace.checks[0] = { id: 'execute', kind: 'node_script', path: 'untrusted.mjs' }; },
    g => { g.evaluationSuite.execution = { maxSteps: 100000, maxOutputTokens: 4096 }; },
    g => { g.evaluationSuite.cases[0].workspace.checks[0].expected = 'x'.repeat(64001); }
  ]) { const genome = artifactGenome(); mutate(genome); assert.throws(() => validateProjectGenome(genome), { code: 'invalid_genome' }); }
});

test('trusted file and syntax verifiers inspect artifacts, never execute top-level JavaScript, and reject symlinks', async t => {
  const { root, workspace } = await temp(t), escaped = join(root, 'must-not-exist.txt');
  const fixture = { files: [{ path: 'app.mjs', content: `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(escaped)}, 'must not execute'); export default 42;` }, { path: 'data.json', content: '{"value":4}' }, { path: 'notes.txt', content: 'hello\nworld' }], checks: [
    { id: 'syntax', kind: 'javascript_syntax', path: 'app.mjs', dialect: 'module' }, { id: 'json', kind: 'json_equals', path: 'data.json', expected: { value: 4 } },
    { id: 'exists', kind: 'file_exists', path: 'notes.txt' }, { id: 'exact', kind: 'text_equals', path: 'notes.txt', expected: 'hello\nworld' }, { id: 'contains', kind: 'text_includes', path: 'notes.txt', values: ['hello', 'world'] }
  ] };
  const tools = await prepareEvaluationWorkspace(workspace, fixture); assert.equal(tools.length, 6); assert.ok(!tools.some(tool => tool.name === 'project_exec'));
  assert.equal((await verifyEvaluationWorkspace(workspace, fixture)).passed, true); await assert.rejects(readFile(escaped), { code: 'ENOENT' });
  await writeFile(join(workspace, 'app.mjs'), 'export const ='); assert.equal((await verifyEvaluationWorkspace(workspace, fixture)).checks[0].code, 'artifact_invalid_syntax');
  await rm(join(workspace, 'notes.txt')); await symlink(join(root, 'outside.txt'), join(workspace, 'notes.txt')); await writeFile(join(root, 'outside.txt'), 'hello\nworld');
  const denied = await verifyEvaluationWorkspace(workspace, fixture); assert.equal(denied.checks[2].code, 'artifact_path_denied');
  const abort = new AbortController(); abort.abort(); await assert.rejects(verifyEvaluationWorkspace(workspace, fixture, abort.signal), { name: 'AbortError' });
  await assert.rejects(verifyEvaluationWorkspace(workspace, { files: [], checks: [] }), { code: 'invalid_evaluation_workspace' });
  await assert.rejects(verifyEvaluationWorkspace(workspace, { files: [], checks: [{ id: 'fake', kind: 'always_pass', path: 'notes.txt' }] }), { code: 'invalid_evaluation_workspace' });
  await assert.rejects(prepareEvaluationWorkspace(workspace, { files: [], checks: [] }), { code: 'invalid_evaluation_workspace' });
});

test('real HTTP tool calls create artifacts and failed host acceptance prevents judge requests', async t => {
  let calls = 0; const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); calls++;
      const candidate = body.messages[0].content.includes('CANDIDATE_AGENT'); assert.equal(body.max_completion_tokens, 4096);
      const used = body.messages.some(message => message.role === 'tool');
      const delta = used ? { content: 'precise evidence: I completed everything.' } : { tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name: 'project_write', arguments: JSON.stringify({ path: 'result.json', content: JSON.stringify({ doubled: candidate ? 99 : 2 }) }) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: used ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  const baseline = artifactGenome(), candidate = artifactGenome(true); baseline.evaluationSuite.cases.forEach(item => { item.requiredToolIds = ['project_write']; });
  const result = await evaluateProjectGenomes({ baseline, candidate, model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, apiKey: 'fixture-only' });
  assert.equal(calls, 4); assert.equal(result.usage.totalTokens, 52); assert.equal(result.details[0].baseline.workspace.passed, true); assert.equal(result.details[0].candidate.workspace.passed, false);
});

test('proposal root-cause diagnosis is structured, does not require gratuitous tools and cannot invent evidence references', async () => {
  const baseline = artifactGenome(), candidate = artifactGenome(true), calls = [];
  const provider = async function* (request) { calls.push(request); yield { type: 'text_delta', delta: JSON.stringify({ summary: 'Improve method', hypothesis: 'Inspect source data before writing', diagnosis: { ...diagnosisFixture(), evidenceIds: ['invented'] }, changes: ['Improve skill instructions'], genome: candidate }) }; yield { type: 'usage', usage: { totalTokens: 13 } }; yield { type: 'done', stopReason: 'stop' }; };
  await assert.rejects(proposeProjectGenome({ project: { id: 'qa' }, baseline, evidence: [{ id: 'actual' }], model, provider, maxAttempts: 1 }), failure => failure.code === 'invalid_output' && failure.usage.totalTokens === 13);
  assert.ok(calls[0].systemPrompt.startsWith(RNA_EVOLUTION_METHOD)); assert.ok(calls[0].systemPrompt.includes('tools may be empty')); assert.equal(JSON.parse(calls[0].messages[0].content[0].text).baseline.evaluationSuite.cases, undefined);
});

test('real evaluation skill loading discovers and reads package resources through the same paginated host content projection', async () => {
  const baseline = artifactGenome(), candidate = artifactGenome(true), calls = [], ordinary = artifactProvider({ calls });
  for (const genome of [baseline, candidate]) genome.skills[0].resources = [{ path: 'references/worked-example.md', content: 'Inspect data before conclusions.\nKeep units attached to calculations.\nUse explicit non-identification where evidence is insufficient.' }];
  const result = await evaluateProjectGenomes({ baseline, candidate, model, provider: async function* (request) {
    if (request.systemPrompt.includes('blind evaluator')) { yield* ordinary(request); return; }
    const prior = request.messages.filter(item => item.role === 'toolResult' && item.toolName === 'skill_load');
    if (prior.length < 2) {
      let args = { id: 'evidence_review' };
      if (prior.length) { const parsed = JSON.parse(prior[0].content[0].text); assert.equal(parsed.path, 'SKILL.md'); assert.equal(parsed.resources.length, 1); assert.equal(parsed.resources[0].content, undefined); args = { ...args, path: parsed.resources[0].path, offset: 1, limit: 1 }; }
      yield { type: 'tool_call', id: `skill-${request.messages.length}`, name: 'skill_load', arguments: args }; yield { type: 'usage', usage: { totalTokens: 13 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    const resource = JSON.parse(prior[1].content[0].text); assert.equal(resource.content, 'Keep units attached to calculations.'); assert.equal(resource.offset, 1); assert.equal(resource.limit, 1); assert.equal(resource.totalLines, 3); assert.equal(resource.truncated, true); assert.equal(resource.contentHash, JSON.parse(prior[0].content[0].text).resources[0].contentHash);
    yield* ordinary(request);
  } });
  assert.equal(result.gatePassed, true); assert.ok(result.details.every(row => row.candidate.toolResults.filter(item => item.toolName === 'skill_load').length === 2));
});
