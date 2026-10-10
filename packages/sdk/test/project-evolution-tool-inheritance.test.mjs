import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { projectGenomeSchema, validateProjectGenome } from '../src/project-genome.mjs';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { evolutionHash } from '../src/evolution.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 4096, reasoning: 'off' };
const ref = (id = 'evidence_helper') => ({ id, inheritFromBaseline: true });
const proposal = genome => ({ summary: 'Improve evidence interpretation', hypothesis: 'A specific method change improves interpretation with unchanged tools', diagnosis: diagnosisFixture(), changes: ['Revise the evidence method'], genome });
const candidate = baseline => { const value = structuredClone(baseline); value.systemPrompt += '\nTie each checked result to the user decision.'; delete value.evaluationSuite; return value; };
function provider(values, calls = [], inspect = () => {}) { return async function* (request) { calls.push(request); await inspect(request, calls.length); yield { type: 'text_delta', delta: JSON.stringify(values[calls.length - 1]) }; yield { type: 'usage', usage: { totalTokens: 21 } }; yield { type: 'done', stopReason: 'stop' }; }; }
const options = (baseline, values, rest = {}) => ({ project: { id: 'explicit-tool-inheritance' }, baseline, evidence: [], model, maxAttempts: 1, provider: provider(values), ...rest });
function hiddenBaseline() {
  const baseline = projectGenomeFixture();
  baseline.tools[0].smokeCases = [{ input: { value: 987631 }, expected: { doubled: 1975262 }, workspace: { files: [{ path: 'HIDDEN_FIXTURE_PATH.txt', content: 'HIDDEN_FIXTURE_CONTENT' }] } }];
  baseline.evaluationSuite.cases[0].input = 'HIDDEN_EVALUATION_TASK';
  return baseline;
}
function brokenAddition() { return { id: 'draft_only', name: 'Draft helper', description: 'Count explicit rows', permission: 'read', parameters: { type: 'object', additionalProperties: false }, script: 'return {count:99};', smokeCases: [{ input: {}, expected: { count: 0 } }] }; }

test('explicit inheritance materializes exact frozen tools with provenance and real unchanged smoke checks', async () => {
  const baseline = hiddenBaseline(), frozen = structuredClone(baseline), genome = candidate(baseline), calls = [], events = [], schema = structuredClone(projectGenomeSchema);
  genome.tools = [ref()];
  const result = await proposeProjectGenome(options(baseline, [], { provider: provider([proposal(genome)], calls, () => { baseline.tools[0].script = 'throw new Error("caller mutation")'; baseline.tools[0].smokeCases[0].expected = { doubled: -1 }; }), onProgress: event => events.push(event) }));
  assert.equal(calls.length, 1); assert.equal(result.validation.passed, true); assert.equal(result.validation.smoke.executed, true);
  assert.deepEqual(result.proposal.genome.tools, frozen.tools); assert.deepEqual(result.proposal.genome.evaluationSuite, frozen.evaluationSuite);
  assert.deepEqual(result.validation.smoke.results[0].actual, frozen.tools[0].smokeCases[0].expected); assert.equal(result.validation.frozenSmoke[0].passed, true);
  const provenance = { baselineHash: evolutionHash(frozen), tools: [{ id: 'evidence_helper', toolHash: evolutionHash(frozen.tools[0]) }] };
  assert.deepEqual(result.proposal.toolInheritance, provenance); assert.deepEqual(result.repairEvidence[0].toolInheritance, provenance);
  assert.deepEqual(events.find(event => event.type === 'proposal_tool_inheritance'), { type: 'proposal_tool_inheritance', attempt: 1, ...provenance });
  assert.equal(result.usage.totalTokens, 21); assert.deepEqual(validateProjectGenome(result.proposal.genome), result.proposal.genome);
  assert.deepEqual(projectGenomeSchema, schema, 'Author-only schema must not mutate the published schema');
  assert.throws(() => validateProjectGenome({ ...result.proposal.genome, tools: [ref()] }), { code: 'invalid_genome' });
  assert.equal(JSON.stringify(result.proposal.genome).includes('inheritFromBaseline'), false);
  result.proposal.genome.tools[0].smokeCases[0].expected.doubled = 0;
  assert.equal(frozen.tools[0].smokeCases[0].expected.doubled, 1975262); assert.deepEqual(genome.tools, [ref()]);
  for (const marker of ['987631', '1975262', 'HIDDEN_FIXTURE_PATH', 'HIDDEN_FIXTURE_CONTENT', 'HIDDEN_EVALUATION_TASK']) assert.equal(JSON.stringify(calls).includes(marker), false, marker);
});

test('a complete authored tool remains unchanged and does not acquire inheritance provenance', async () => {
  const baseline = projectGenomeFixture(), genome = candidate(baseline), expected = structuredClone(genome.tools);
  const result = await proposeProjectGenome(options(baseline, [proposal(genome)]));
  assert.equal(result.validation.passed, true); assert.deepEqual(result.proposal.genome.tools, expected); assert.equal(result.proposal.toolInheritance, undefined);
});

for (const [name, tools, code] of [
  ['unknown ID', [ref('not_released')], 'invalid_genome'],
  ['duplicate references', [ref(), ref()], 'invalid_genome'],
  ['mixed duplicate definitions', [projectGenomeFixture().tools[0], ref()], 'invalid_genome'],
  ['false flag', [{ id: 'evidence_helper', inheritFromBaseline: false }], 'invalid_output'],
  ['string flag', [{ id: 'evidence_helper', inheritFromBaseline: 'true' }], 'invalid_output'],
  ['extra key', [{ ...ref(), note: 'copy all' }], 'invalid_output'],
  ['mixed reference and complete tool', [{ ...projectGenomeFixture().tools[0], inheritFromBaseline: true }], 'invalid_output'],
  ['missing ID', [{ inheritFromBaseline: true }], 'invalid_output'],
  ['invalid ID', [ref('../private')], 'invalid_output']
]) test(`author inheritance rejects ${name} without materializing a candidate`, async () => {
  const baseline = projectGenomeFixture(), frozen = structuredClone(baseline), genome = candidate(baseline); genome.tools = tools;
  await assert.rejects(proposeProjectGenome(options(baseline, [proposal(genome)])), error => { assert.equal(error.code, code); assert.equal(error.usage.totalTokens, 21); assert.equal(error.requests.length, 1); return true; });
  assert.deepEqual(baseline, frozen);
});

test('omitted released tool IDs produce a public precise diagnosis and are never silently inherited', async () => {
  const baseline = hiddenBaseline(); baseline.tools.push({ ...structuredClone(baseline.tools[0]), id: 'also_released' });
  for (const tools of [[], [ref()]]) {
    const genome = candidate(baseline); genome.tools = tools;
    await assert.rejects(proposeProjectGenome(options(baseline, [proposal(genome)])), error => {
      assert.equal(error.code, 'invalid_genome'); assert.match(error.message, /also_released/); assert.match(error.message, /empty tools array does not inherit/);
      if (!tools.length) assert.match(error.message, /evidence_helper/);
      assert.equal(error.message.includes('HIDDEN_'), false); assert.equal(error.message.includes('987631'), false); assert.deepEqual(error.repairEvidence[0].after.tools, tools); return true;
    });
  }
});

test('inheritance metadata cannot turn an identical published genome into a changed candidate', async () => {
  const baseline = projectGenomeFixture(), genome = structuredClone(baseline); genome.tools = [ref()]; delete genome.evaluationSuite;
  await assert.rejects(proposeProjectGenome(options(baseline, [proposal(genome)])), error => error.code === 'no_change' && error.usage.totalTokens === 21);
});

test('zero-tool initialization and a later zero-tool method-only evolution remain valid', async () => {
  const baseline = projectGenomeFixture(); baseline.tools = []; baseline.evaluationSuite.cases.forEach(item => { item.requiredToolIds = []; });
  const state = { overview: 'Research', focus: 'Check sources', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: baseline };
  const initialized = await bootstrapProject({ title: 'Research', catalog: { skills: [], tools: [], mcpServers: [] }, model, provider: provider([state]) });
  assert.equal(initialized.status, 'ready'); assert.deepEqual(initialized.genome.tools, []); assert.equal(initialized.genomeValidation.applicable, false);
  const calls = [], result = await proposeProjectGenome(options(baseline, [], { provider: provider([proposal(candidate(baseline))], calls) }));
  assert.equal(result.validation.passed, true); assert.deepEqual(result.proposal.genome.tools, []); assert.equal(result.proposal.toolInheritance, undefined);
  assert.match(calls[0].systemPrompt, /may be empty ONLY when baseline\.tools is empty/);
  assert.match(calls[0].systemPrompt, /tools explicitly declared in candidate\.genome\.tools or listed in evaluationEnvironment/);
  assert.match(calls[0].systemPrompt, /Workspace tool IDs are available only in cases that include an explicit workspace fixture/);
});

test('repair requests hide inherited inputs, outputs and fixtures while retaining actionable authored diagnostics', async () => {
  const baseline = hiddenBaseline(), genome = candidate(baseline), calls = [];
  genome.tools = [ref(), brokenAddition()];
  const patch = { tools: [{ id: 'draft_only', script: 'return {count:0};' }], smokeRepairs: [] };
  const result = await proposeProjectGenome(options(baseline, [], { maxAttempts: 2, provider: provider([proposal(genome), patch], calls) }));
  assert.equal(result.validation.passed, true); assert.equal(calls.length, 2); assert.deepEqual(result.proposal.genome.tools[0], baseline.tools[0]);
  const input = JSON.parse(calls[1].messages[0].content[0].text);
  assert.deepEqual(input.candidate.tools[0], ref()); assert.equal(input.baseline.tools[0].smokeCases, undefined);
  assert.deepEqual(input.diagnostics.smoke.results.find(item => item.toolId === 'evidence_helper'), { toolId: 'evidence_helper', inheritedFromBaseline: true, passed: true, code: 'inherited_contract_passed' });
  assert.deepEqual(input.diagnostics.smoke.results.find(item => item.toolId === 'draft_only').actual, { count: 99 });
  for (const marker of ['987631', '1975262', 'HIDDEN_FIXTURE_PATH', 'HIDDEN_FIXTURE_CONTENT', 'HIDDEN_EVALUATION_TASK', evolutionHash(baseline.tools[0].smokeCases[0].workspace)]) assert.equal(JSON.stringify(calls).includes(marker), false, marker);
  assert.equal(result.repairEvidence[0].validation.smoke.results[0].actual.doubled, 1975262, 'Private execution audit remains complete');
});

for (const kind of ['tools', 'parameters', 'smokeRepairs', 'fixtureRepairs', 'withdrawTools']) test(`repair cannot modify an explicitly inherited tool through ${kind}`, async () => {
  const baseline = hiddenBaseline(), genome = candidate(baseline), calls = []; genome.tools = [ref(), brokenAddition()];
  const patch = { tools: [{ id: 'draft_only', script: 'return {count:0};' }], smokeRepairs: [] };
  const reason = 'This deliberate fixture request must not be allowed to modify an inherited published contract.';
  if (kind === 'tools' || kind === 'parameters') patch.tools.push({ id: 'evidence_helper', script: 'return {doubled:0};', ...(kind === 'parameters' ? { parameters: { type: 'object' } } : {}) });
  if (kind === 'smokeRepairs') patch.smokeRepairs.push({ toolId: 'evidence_helper', caseIndex: 0, expected: { doubled: 0 }, reason });
  if (kind === 'fixtureRepairs') patch.fixtureRepairs = [{ toolId: 'evidence_helper', caseIndex: 0, workspace: { files: [{ path: 'replacement.txt', content: 'changed' }] }, reason }];
  if (kind === 'withdrawTools') patch.withdrawTools = [{ id: 'evidence_helper', reason }];
  const result = await proposeProjectGenome(options(baseline, [], { maxAttempts: 2, provider: provider([proposal(genome), patch], calls) }));
  assert.equal(result.validation.passed, false); assert.equal(result.repairEvidence[1].error.code, 'invalid_repair'); assert.match(result.repairEvidence[1].error.message, /evidence_helper/);
  assert.deepEqual(result.proposal.genome.tools[0], baseline.tools[0]); assert.deepEqual(result.proposal.genome.tools[1], brokenAddition(), 'The forbidden repair is atomic; an earlier legal patch is not committed');
  assert.equal(result.usage.totalTokens, 42); assert.equal(calls.length, 2);
});

test('a rejected inherited draft does not impose stale inheritance on a subsequent full authored tool', async () => {
  const baseline = projectGenomeFixture(), invalid = candidate(baseline), authored = candidate(baseline), calls = [];
  invalid.tools = [ref()]; invalid.evaluationSuite = structuredClone(baseline.evaluationSuite); invalid.evaluationSuite.cases[0].requiredToolIds = ['not_available'];
  authored.tools[0].script = 'return {doubled:99};';
  const patch = { tools: [{ id: 'evidence_helper', script: baseline.tools[0].script }], smokeRepairs: [] };
  const result = await proposeProjectGenome(options(baseline, [], { maxAttempts: 3, provider: provider([proposal(invalid), proposal(authored), patch], calls) }));
  assert.equal(calls.length, 3); assert.equal(result.validation.passed, true); assert.equal(result.proposal.toolInheritance, undefined);
  assert.ok(result.repairEvidence[0].toolInheritance); assert.equal(result.repairEvidence[1].toolInheritance, undefined); assert.equal(result.repairEvidence[2].toolInheritance, undefined);
});
