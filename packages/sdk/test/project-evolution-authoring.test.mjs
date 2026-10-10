import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';
import { runGenomeScript, smokeProjectGenome, validateProjectGenome } from '../src/project-genome.mjs';
import { proposeProjectGenome, evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { evolutionHash } from '../src/evolution.mjs';
import { formatSkillContent } from '../src/genome-skill-content.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 4096, reasoning: 'off' };
const proposal = genome => ({ summary: 'A reusable evidence method', hypothesis: 'Methods and worked examples improve evidence interpretation without extra tools', diagnosis: diagnosisFixture(), changes: ['Improve skills'], genome });
function provider(values, calls) { return async function* (request) { calls.push(request); yield { type: 'text_delta', delta: JSON.stringify(values[Math.min(calls.length - 1, values.length - 1)]) }; yield { type: 'usage', usage: { totalTokens: 21 } }; yield { type: 'done', stopReason: 'stop' }; }; }
function fileTool() { return { id: 'file_sum', name: 'File sum', description: 'Sum explicit numeric rows', permission: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, script: 'return {sum: JSON.parse(await api.readFile(input.path)).reduce((a,b)=>a+b,0)};', smokeCases: [{ input: { path: 'rows.json' }, expected: { sum: 7 }, workspace: { files: [{ path: 'rows.json', content: '[3,4]' }] } }] }; }

test('syntax preflight uses the execution compiler, identifies body line, and cannot execute a partial script', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'rna-authoring-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  const tool = { ...fileTool(), permission: 'write', script: 'await api.writeFile("side.txt", "no");\nasync function(input, api) { return 1; }' };
  await assert.rejects(runGenomeScript(tool, { path: 'rows.json' }, { workspace }), error => error.code === 'script_syntax' && error.phase === 'compile' && error.line === 2);
  await assert.rejects(readFile(join(workspace, 'side.txt')), { code: 'ENOENT' });
  await assert.rejects(runGenomeScript({ ...tool, script: 'return await api.readFile("absent.txt");' }, { path: 'rows.json' }, { workspace }), error => error.code === 'script_failed' && error.phase === 'execution');
  await assert.rejects(runGenomeScript({ ...tool, script: 'return 1n;' }, { path: 'rows.json' }, { workspace }), error => error.code === 'script_failed' && error.phase === 'serialization');
});

test('read-only file smoke fixtures execute real reads without granting writes and legacy inputs still create no files', async () => {
  const genome = projectGenomeFixture(); genome.tools.push(fileTool());
  const result = await smokeProjectGenome(genome); assert.equal(result.passed, true); assert.equal(result.results[1].fixtureHash, evolutionHash(genome.tools[1].smokeCases[0].workspace)); assert.deepEqual(result.results[1].effects, [{ operation: 'readFile', path: 'rows.json' }]);
  delete genome.tools[1].smokeCases[0].workspace; const absent = await smokeProjectGenome(genome); assert.equal(absent.passed, false); assert.equal(absent.results[1].phase, 'execution'); assert.match(absent.results[1].error, /ENOENT/);
  genome.tools[1].smokeCases[0].workspace = { files: [{ path: 'rows.json', content: '[3,4]' }] }; genome.tools[1].script = 'await api.writeFile("rows.json", "[]"); return {sum:7};';
  assert.match((await smokeProjectGenome(genome)).results[1].error, /Read-only/);
});

test('smoke fixture validation rejects escape, private, duplicate, overlapping and oversized files', () => {
  for (const files of [[{ path: '../outside', content: '' }], [{ path: '.env', content: '' }], [{ path: 'a', content: '' }, { path: 'a', content: '' }], [{ path: 'a', content: '' }, { path: 'a/b', content: '' }], [{ path: 'a', content: '中'.repeat(22000) }], [1,2,3].map(n => ({ path: `${n}.txt`, content: 'x'.repeat(50000) }))]) {
    const genome = projectGenomeFixture(); genome.tools[0].smokeCases[0].workspace = { files }; assert.throws(() => validateProjectGenome(genome), { code: 'invalid_genome' });
  }
});

test('released smoke fixtures remain hidden from author and immutable in real compatibility checks', async () => {
  const baseline = projectGenomeFixture(); baseline.tools.push(fileTool()); const original = structuredClone(baseline), candidate = structuredClone(baseline);
  candidate.systemPrompt += '\nUse the revised method.'; candidate.tools[1].script = 'return {sum: JSON.parse(await api.readFile(input.path)).reduce((a,b)=>a+b,0)*2};'; candidate.tools[1].smokeCases[0].workspace.files[0].content = '[1,2.5]';
  const calls = []; const result = await proposeProjectGenome({ project: { id: 'fixtures' }, baseline, evidence: [], model, provider: provider([proposal(candidate)], calls), maxAttempts: 1 });
  assert.equal(result.validation.smoke.passed, true); assert.equal(result.validation.frozenSmoke[1].passed, false); assert.deepEqual(result.validation.frozenSmoke[1].actual, { sum: 14 });
  assert.equal(result.validation.frozenSmoke[1].fixtureHash, evolutionHash(baseline.tools[1].smokeCases[0].workspace)); assert.deepEqual(baseline, original);
  assert.equal(JSON.parse(calls[0].messages[0].content[0].text).baseline.tools[1].smokeCases, undefined);
  const evaluated = await evaluateProjectGenomes({ baseline, candidate, model, provider: async function* () { assert.fail('Do not pay for incompatible scripts'); } }); assert.equal(evaluated.earlyStopReason, 'frozen_tool_contract_failed');
});

test('repair supplies a missing candidate fixture without changing input, answer or read permission', async () => {
  const candidate = projectGenomeFixture({ candidate: true }); candidate.tools.push(fileTool()); delete candidate.tools[1].smokeCases[0].workspace;
  const calls = [], patch = { tools: [], smokeRepairs: [], fixtureRepairs: [{ toolId: 'file_sum', caseIndex: 0, workspace: fileTool().smokeCases[0].workspace, reason: 'The read-only smoke names rows.json; the fixture must explicitly seed the two documented numeric rows.' }] };
  const result = await proposeProjectGenome({ project: { id: 'repair-fixture' }, baseline: projectGenomeFixture(), evidence: [], model, provider: provider([proposal(candidate), patch], calls) });
  assert.equal(calls.length, 2); assert.equal(result.validation.passed, true); assert.equal(result.repairEvidence[0].validation.smoke.results[1].phase, 'execution'); assert.equal(result.repairEvidence[1].fixtureChanges.length, 1); assert.deepEqual(result.proposal.genome.tools[1].smokeCases[0].expected, { sum: 7 }); assert.equal(result.proposal.genome.tools[1].permission, 'read');
});

test('an unnecessary unpublished addition may be withdrawn with provenance while useful skill changes remain evaluable', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true }), extra = fileTool(); extra.script = 'async function(input,api) {}'; candidate.tools.push(extra);
  const calls = [], patch = { tools: [], smokeRepairs: [], withdrawTools: [{ id: extra.id, reason: 'This addition adds no needed capability for the observed interpretation defect; the revised skill method is the actual intervention.' }] };
  const result = await proposeProjectGenome({ project: { id: 'withdraw-extra' }, baseline, evidence: [], model, provider: provider([proposal(candidate), patch], calls) });
  assert.equal(calls.length, 2); assert.equal(result.validation.passed, true); assert.deepEqual(result.proposal.genome.skills, candidate.skills); assert.deepEqual(result.proposal.genome.evaluationSuite, candidate.evaluationSuite);
  assert.equal(result.repairEvidence[1].withdrawals[0].originalToolHash, evolutionHash(extra)); assert.equal(result.repairEvidence[1].withdrawals[0].disposition, 'unpublished_addition_withdrawn_not_a_passed_tool'); assert.equal(result.repairEvidence[0].after.tools.length, 2); assert.equal(result.proposal.genome.tools.length, 1);
});

for (const kind of ['released', 'required', 'no_remaining_change']) test(`withdrawal refuses ${kind} rather than erasing a mandatory check`, async () => {
  const baseline = projectGenomeFixture(), candidate = kind === 'no_remaining_change' ? structuredClone(baseline) : projectGenomeFixture({ candidate: true });
  const extra = fileTool(); extra.script = 'async function(input,api) {}'; candidate.tools.push(extra); if (kind === 'required') candidate.evaluationSuite.cases[0].requiredToolIds.push(extra.id);
  const calls = [], patch = { tools: [], smokeRepairs: [], withdrawTools: [{ id: kind === 'released' ? 'evidence_helper' : extra.id, reason: 'Attempt to discard a failed check instead of producing a valid candidate.' }] };
  const result = await proposeProjectGenome({ project: { id: kind }, baseline, evidence: [], model, maxAttempts: 2, provider: provider([proposal(candidate), patch], calls) });
  assert.equal(result.validation.passed, false); assert.deepEqual(result.proposal.genome, candidate); assert.equal(result.repairEvidence[1].error.code, 'invalid_repair'); assert.equal(calls.length, 2);
});

test('skill package discovery lists immutable resource identities without inlining their content and pages identically', () => {
  const raw = 'first\nsecond\nthird', resources = [{ path: 'references/example.md', content: 'Worked counterexample without a fake helper.' }];
  const main = formatSkillContent({ id: 'evidence', raw, resources, limit: 2 }); assert.equal(main.content, 'first\nsecond'); assert.equal(main.truncated, true); assert.equal(main.totalLines, 3); assert.equal(main.resources[0].bytes, Buffer.byteLength(resources[0].content)); assert.equal(main.resources[0].content, undefined);
  const part = formatSkillContent({ id: 'evidence', path: resources[0].path, raw: resources[0].content }); assert.equal(part.contentHash, main.resources[0].contentHash); assert.equal(part.resources, undefined); assert.equal(part.truncated, false);
  assert.throws(() => formatSkillContent({ id: 'evidence', raw, offset: -1 })); assert.throws(() => formatSkillContent({ id: 'evidence', raw, limit: 501 }));
});

test('method-only authoring can omit unseen evaluation cases and inherits the exact frozen suite in one request', async () => {
  const baseline = projectGenomeFixture(), original = structuredClone(baseline), candidate = projectGenomeFixture({ candidate: true }); delete candidate.evaluationSuite;
  const calls = [], result = await proposeProjectGenome({ project: { id: 'inherit-hidden-suite' }, baseline, evidence: [], model, provider: provider([proposal(candidate)], calls) });
  assert.equal(calls.length, 1); assert.equal(result.validation.passed, true); assert.equal(result.proposal.evaluationSuiteSource, 'inherited_frozen_baseline'); assert.deepEqual(result.proposal.genome.evaluationSuite, original.evaluationSuite); assert.deepEqual(baseline, original); assert.equal(candidate.evaluationSuite, undefined);
  const input = JSON.parse(calls[0].messages[0].content[0].text); assert.equal(input.baseline.evaluationSuite.cases, undefined); assert.deepEqual(input.evaluationEnvironment.alwaysAvailable, ['skill_load', 'evidence_helper']); assert.deepEqual(input.evaluationEnvironment.availableOnlyWithWorkspaceFixture, ['project_read', 'project_list', 'project_find', 'project_grep', 'project_write', 'project_edit']); assert.ok(input.evaluationEnvironment.unavailable.includes('MCP')); assert.ok(!JSON.stringify(input).includes(original.evaluationSuite.cases[0].input));
  result.proposal.genome.evaluationSuite.cases[0].input = 'different'; assert.deepEqual(baseline, original, 'The inherited suite is a private clone');
});

test('explicit partial or invalid future suites still fail validation rather than silently inheriting a different contract', async () => {
  const candidate = projectGenomeFixture({ candidate: true }); delete candidate.evaluationSuite.cases;
  await assert.rejects(proposeProjectGenome({ project: { id: 'partial-suite' }, baseline: projectGenomeFixture(), evidence: [], model, maxAttempts: 1, provider: provider([proposal(candidate)], []) }), error => error.code === 'invalid_output' && error.usage.totalTokens === 21);
  const invalid = projectGenomeFixture({ candidate: true }); invalid.evaluationSuite.cases[0].requiredToolIds = ['read'];
  await assert.rejects(proposeProjectGenome({ project: { id: 'invented-tool' }, baseline: projectGenomeFixture(), evidence: [], model, maxAttempts: 1, provider: provider([proposal(invalid)], []) }), error => error.code === 'invalid_genome');
});

for (const suiteMode of ['inherited', 'explicit_copy']) test(`${suiteMode} held-out cases remain hidden on a later real script repair request`, async () => {
  const baseline = projectGenomeFixture(); baseline.evaluationSuite.cases[0].input = 'HOST_ONLY_HIDDEN_CASE_INPUT';
  const candidate = projectGenomeFixture({ candidate: true }); if (suiteMode === 'inherited') delete candidate.evaluationSuite; else candidate.evaluationSuite = structuredClone(baseline.evaluationSuite); candidate.tools[0].script = 'return {doubled:99};';
  const calls = [], patch = { tools: [{ id: 'evidence_helper', script: 'return {doubled:input.value*2};' }], smokeRepairs: [] };
  const result = await proposeProjectGenome({ project: { id: 'blind-repair' }, baseline, evidence: [], model, provider: provider([proposal(candidate), patch], calls) });
  assert.equal(calls.length, 2); assert.equal(result.validation.passed, true); assert.equal(result.proposal.evaluationSuiteSource, suiteMode === 'inherited' ? 'inherited_frozen_baseline' : 'candidate_future_proposal'); assert.deepEqual(result.proposal.genome.evaluationSuite, baseline.evaluationSuite);
  for (const request of calls) assert.equal(JSON.stringify({ messages: request.messages, systemPrompt: request.systemPrompt }).includes('HOST_ONLY_HIDDEN_CASE_INPUT'), false);
  const repair = JSON.parse(calls[1].messages[0].content[0].text); assert.equal(repair.candidate.evaluationSuite.cases, undefined); assert.deepEqual(repair.candidate.evaluationSuite.criteria, baseline.evaluationSuite.criteria); assert.equal(repair.baseline.tools[0].smokeCases, undefined); assert.deepEqual(repair.candidateRequiredToolIds, ['evidence_helper']);
});
