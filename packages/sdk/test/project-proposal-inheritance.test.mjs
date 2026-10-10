import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionHash } from '../src/evolution.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';
import { projectGenomeSchema, validateProjectGenome } from '../src/project-genome.mjs';
import { authorSkillSchema, proposalAssetDeclarationProperties, projectSkillAssetInventory, expandAuthorSkills, authorRepairSkills } from '../src/project-proposal-inheritance.mjs';
import { proposeProjectGenome, evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { projectGenomeFixture, diagnosisFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const baseline = () => {
  const genome = projectGenomeFixture();
  genome.skills.push({ id: 'delivery', name: 'Delivery', description: 'Check actual artifacts', instructions: 'Exercise the primary user journey before delivery.', resources: [{ path: 'docs/checks.md', content: 'Verify intended behavior and unresolved limitations.' }, { path: 'docs/example.md', content: 'A concrete project example.' }] });
  return genome;
};
const reason = 'This asset is obsolete because the retained method now covers its responsibility.';
const invalid = fn => assert.throws(fn, error => error.code === 'invalid_genome');
const skillRef = id => ({ id, inheritFromBaseline: true });
const resourceRef = path => ({ path, inheritFromBaseline: true });
const withdrawSkill = skill => ({ id: skill.id, beforeHash: evolutionHash(skill), reason });
const withdrawResource = (skill, resource) => ({ skillId: skill.id, path: resource.path, beforeHash: evolutionHash(resource), reason });

test('whole-skill inheritance exactly preserves full immutable resources and hash provenance', () => {
  const base = baseline(), before = structuredClone(base), input = { skills: base.skills.map(skill => skillRef(skill.id)) };
  const result = expandAuthorSkills(input, base);
  assert.deepEqual(result.skills, base.skills); assert.deepEqual(base, before); assert.deepEqual(input.skills, base.skills.map(skill => skillRef(skill.id)));
  assert.equal(result.assetChanges.baselineHash, evolutionHash(base));
  assert.deepEqual(result.assetChanges.inheritedSkills, [...base.skills].sort((a, b) => a.id < b.id ? -1 : 1).map(skill => ({ id: skill.id, beforeHash: evolutionHash(skill) })));
  assert.deepEqual(result.assetChanges.inheritedSkillResources, []);
  validateProjectGenome({ ...base, skills: result.skills }); assert.equal(JSON.stringify(result.skills).includes('inheritFromBaseline'), false);
  result.skills[0].resources[0].content = 'changed copy'; assert.deepEqual(base, before);
});

test('explicit resource inheritance permits intentional skill changes without regenerating resource bodies', () => {
  const base = baseline(), input = structuredClone(base);
  input.skills[0].instructions += ' Interpret the result.'; input.skills[0].resources = input.skills[0].resources.map(resource => resourceRef(resource.path));
  input.skills[1] = skillRef('delivery');
  const result = expandAuthorSkills(input, base);
  assert.equal(result.skills[0].instructions, input.skills[0].instructions); assert.deepEqual(result.skills[0].resources, base.skills[0].resources);
  assert.deepEqual(result.assetChanges.inheritedSkillResources, [{ skillId: base.skills[0].id, path: base.skills[0].resources[0].path, beforeHash: evolutionHash(base.skills[0].resources[0]) }]);
  assert.deepEqual(authorRepairSkills(result.skills, result.assetChanges, base), input.skills);
});

test('complete legacy skill definitions remain valid and preserve intentional resource edits', () => {
  const base = baseline(), input = structuredClone(base); input.skills[0].resources[0].content = 'A revised worked example.';
  const result = expandAuthorSkills(input, base);
  assert.deepEqual(result.skills, input.skills); assert.deepEqual(result.assetChanges.inheritedSkills, []); assert.deepEqual(result.assetChanges.inheritedSkillResources, []);
  assert.deepEqual(authorRepairSkills(result.skills, undefined), input.skills);
});

test('asset inventory hashes exact frozen objects and is independent of mutations to its result', () => {
  const base = baseline(), inventory = projectSkillAssetInventory(base);
  assert.equal(inventory.baselineHash, evolutionHash(base));
  for (let i = 0; i < base.skills.length; i++) { assert.equal(inventory.skills[i].beforeHash, evolutionHash(base.skills[i])); assert.deepEqual(inventory.skills[i].resources, base.skills[i].resources.map(resource => ({ path: resource.path, beforeHash: evolutionHash(resource) }))); }
  inventory.skills[0].resources.length = 0; assert.equal(base.skills[0].resources.length, 1);
});

test('author schema is strict for skill and resource references and shares no mutable base schema', () => {
  const before = structuredClone(projectGenomeSchema), schema = authorSkillSchema();
  validateToolArguments(schema, skillRef('evidence_review'));
  const skill = structuredClone(baseline().skills[0]); skill.resources = [resourceRef('references/guide.md')]; validateToolArguments(schema, skill);
  for (const value of [{ ...skillRef('evidence_review'), instructions: 'mixed' }, { id: 'evidence_review', inheritFromBaseline: false }, { ...skill, resources: [{ ...resourceRef('references/guide.md'), content: 'mixed' }] }]) assert.throws(() => validateToolArguments(schema, value));
  schema.oneOf[0].properties.id.pattern = 'tampered'; schema.oneOf[0].properties.resources.items.oneOf[0].properties.path.maxLength = 1;
  assert.deepEqual(projectGenomeSchema, before);
  assert.deepEqual(Object.keys(proposalAssetDeclarationProperties).sort(), ['withdrawSkillResources', 'withdrawSkills']);
});

test('omitting a released skill or resource never means implicit deletion or inheritance', () => {
  const base = baseline(); invalid(() => expandAuthorSkills({ skills: [skillRef(base.skills[0].id)] }, base));
  const input = structuredClone(base); input.skills[0].resources = []; invalid(() => expandAuthorSkills(input, base));
  input.skills[0].resources = [{ path: 'docs/new.md', content: 'Replacement cannot silently remove another path.' }]; invalid(() => expandAuthorSkills(input, base));
});

test('unknown references, mixed definitions and duplicate skill or resource identities fail', () => {
  const base = baseline();
  const variants = [
    { skills: [skillRef('unknown'), skillRef('delivery')] },
    { skills: [skillRef('evidence_review'), skillRef('evidence_review')] },
    { skills: [{ ...skillRef('evidence_review'), name: 'Mixed' }, skillRef('delivery')] },
    { skills: [{ ...base.skills[0], resources: [resourceRef('missing.md')] }, skillRef('delivery')] },
    { skills: [{ ...base.skills[0], resources: [resourceRef('references/guide.md'), resourceRef('references/guide.md')] }, skillRef('delivery')] },
    { skills: [{ ...base.skills[0], resources: [{ ...resourceRef('references/guide.md'), content: 'Mixed' }] }, skillRef('delivery')] },
    { skills: [...base.skills, { ...base.skills[0], id: 'new_skill', resources: [resourceRef('references/guide.md')] }] },
  ];
  for (const value of variants) invalid(() => expandAuthorSkills(value, base));
});

test('new complete skills and resources are allowed without inheriting unrelated assets', () => {
  const base = baseline(), added = { id: 'new_method', name: 'New method', description: 'A justified method', instructions: 'Compare checked outcomes.', resources: [{ path: 'docs/example.md', content: 'A new bounded example.' }] };
  const result = expandAuthorSkills({ skills: [...base.skills.map(skill => skillRef(skill.id)), added] }, base);
  assert.deepEqual(result.skills.at(-1), added); validateProjectGenome({ ...base, skills: result.skills });
});

test('explicit skill withdrawal requires exact beforeHash and produces audit-only declaration', () => {
  const base = baseline(), declaration = withdrawSkill(base.skills[1]);
  const result = expandAuthorSkills({ skills: [skillRef('evidence_review')] }, base, { withdrawSkills: [declaration] });
  assert.deepEqual(result.skills, [base.skills[0]]); assert.deepEqual(result.assetChanges.withdrawnSkills, [declaration]);
  assert.equal(JSON.stringify(result.skills).includes('withdraw'), false); assert.deepEqual(authorRepairSkills(result.skills, result.assetChanges, base), [skillRef('evidence_review')]);
});

test('explicit resource withdrawal preserves all unrelated assets and records original hash', () => {
  const base = baseline(), retained = structuredClone(base.skills[1]); retained.resources = [resourceRef('docs/checks.md')];
  const declaration = withdrawResource(base.skills[1], base.skills[1].resources[1]);
  const input = { skills: [skillRef('evidence_review'), retained] };
  const result = expandAuthorSkills(input, base, { withdrawSkillResources: [declaration] });
  assert.deepEqual(result.skills[1].resources, [base.skills[1].resources[0]]); assert.deepEqual(result.assetChanges.withdrawnSkillResources, [declaration]);
  assert.deepEqual(authorRepairSkills(result.skills, result.assetChanges, base), input.skills);
});

test('withdrawal rejects stale hashes, unknown targets, duplicates and vague or padded reasons', () => {
  const base = baseline(), next = { skills: [skillRef('evidence_review')] }, valid = withdrawSkill(base.skills[1]);
  for (const row of [{ ...valid, beforeHash: '0'.repeat(64) }, { ...valid, id: 'unknown' }, { ...valid, reason: 'obsolete' }, { ...valid, reason: ' '.repeat(20) + 'x' }]) {
    invalid(() => expandAuthorSkills(next, base, { withdrawSkills: [row] }));
  }
  invalid(() => expandAuthorSkills(next, base, { withdrawSkills: [valid, valid] }));
  const resource = withdrawResource(base.skills[1], base.skills[1].resources[1]), copy = structuredClone(base); copy.skills[1].resources.pop();
  for (const row of [{ ...resource, beforeHash: 'f'.repeat(64) }, { ...resource, path: 'missing.md' }, { ...resource, skillId: 'missing' }]) invalid(() => expandAuthorSkills(copy, base, { withdrawSkillResources: [row] }));
  invalid(() => expandAuthorSkills(copy, base, { withdrawSkillResources: [resource, resource] }));
});

test('withdrawal cannot coexist with retained definitions, inherited skills or parent removal', () => {
  const base = baseline(), skill = withdrawSkill(base.skills[1]), resource = withdrawResource(base.skills[1], base.skills[1].resources[0]);
  invalid(() => expandAuthorSkills(base, base, { withdrawSkills: [skill] }));
  invalid(() => expandAuthorSkills(base, base, { withdrawSkillResources: [resource] }));
  invalid(() => expandAuthorSkills({ skills: base.skills.map(row => skillRef(row.id)) }, base, { withdrawSkillResources: [resource] }));
  invalid(() => expandAuthorSkills({ skills: [skillRef('evidence_review')] }, base, { withdrawSkills: [skill], withdrawSkillResources: [resource] }));
});

test('all skills cannot be removed and resource declarations cannot target a new skill', () => {
  const base = baseline(); invalid(() => expandAuthorSkills({ skills: [] }, base, { withdrawSkills: base.skills.map(withdrawSkill) }));
  const added = { ...structuredClone(base.skills[1]), id: 'new_method' };
  invalid(() => expandAuthorSkills({ skills: [...base.skills, added] }, base, { withdrawSkillResources: [{ skillId: added.id, path: added.resources[0].path, beforeHash: evolutionHash(added.resources[0]), reason }] }));
});

test('unsafe resource paths and reserved SKILL.md cannot enter a materialized genome', () => {
  for (const path of ['../private', '/absolute', 'docs/../secret', 'SKILL.md', 'docs//file']) {
    const base = baseline(), input = structuredClone(base); input.skills[0].resources.push({ path, content: 'unsafe' }); invalid(() => expandAuthorSkills(input, base));
  }
});

test('later repair cannot alter inherited skills, resources or frozen baseline identity', () => {
  const base = baseline(), all = expandAuthorSkills({ skills: base.skills.map(row => skillRef(row.id)) }, base);
  const altered = structuredClone(all.skills); altered[0].instructions += 'Unauthorized change'; invalid(() => authorRepairSkills(altered, all.assetChanges, base));
  const wrongBase = structuredClone(base); wrongBase.systemPrompt += ' Different baseline'; invalid(() => authorRepairSkills(all.skills, all.assetChanges, wrongBase));
  const input = structuredClone(base); input.skills[0].resources = input.skills[0].resources.map(row => resourceRef(row.path));
  const result = expandAuthorSkills(input, base), changed = structuredClone(result.skills); changed[0].resources[0].content += 'Changed'; invalid(() => authorRepairSkills(changed, result.assetChanges, base));
  const badMeta = structuredClone(result.assetChanges); badMeta.inheritedSkillResources[0].beforeHash = '0'.repeat(64); invalid(() => authorRepairSkills(result.skills, badMeta, base));
});

test('repair rejects duplicate, overlapping or forged provenance and revived withdrawn assets', () => {
  const base = baseline(), all = expandAuthorSkills({ skills: base.skills.map(row => skillRef(row.id)) }, base);
  const duplicates = structuredClone(all.assetChanges); duplicates.inheritedSkills.push(duplicates.inheritedSkills[0]); invalid(() => authorRepairSkills(all.skills, duplicates, base));
  const overlap = structuredClone(all.assetChanges); overlap.inheritedSkillResources.push({ skillId: base.skills[0].id, path: base.skills[0].resources[0].path, beforeHash: evolutionHash(base.skills[0].resources[0]) }); invalid(() => authorRepairSkills(all.skills, overlap, base));
  const removed = expandAuthorSkills({ skills: [skillRef('evidence_review')] }, base, { withdrawSkills: [withdrawSkill(base.skills[1])] });
  invalid(() => authorRepairSkills(base.skills, removed.assetChanges, base));
  const forged = structuredClone(removed.assetChanges); forged.withdrawnSkills[0].beforeHash = 'f'.repeat(64); invalid(() => authorRepairSkills(removed.skills, forged, base));
});

test('strict outer declarations cannot be smuggled into published skill definitions', () => {
  const base = baseline(); invalid(() => expandAuthorSkills(base, base, { withdrawnSkills: [] }));
  const input = structuredClone(base); input.skills[0].withdrawSkillResources = []; invalid(() => expandAuthorSkills(input, base));
  assert.deepEqual(expandAuthorSkills(base, base).skills, base.skills);
});

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 4096, reasoning: 'off' };
const proposal = (genome, declarations = {}) => ({ summary: 'Improve the evidence method', hypothesis: 'Preserving known examples avoids unnecessary relearning', diagnosis: diagnosisFixture(), changes: ['Use a focused reusable method with explicit asset accounting'], genome, ...declarations });
const nextGenome = base => { const value = structuredClone(base); value.systemPrompt += '\nCANDIDATE_AGENT: explain the checked evidence.'; delete value.evaluationSuite; return value; };
function authorProvider(values, calls = [], inspect = () => {}) { return async function* (request) { calls.push(request); await inspect(request, calls.length); yield { type: 'text_delta', delta: JSON.stringify(values[calls.length - 1]) }; yield { type: 'usage', usage: { totalTokens: 21 } }; yield { type: 'done', stopReason: 'stop' }; }; }

test('proposal integration sends exact asset inventory and materializes frozen refs before smoke and audit', async () => {
  const base = baseline(), frozen = structuredClone(base), genome = nextGenome(base), calls = [], events = [];
  genome.skills = base.skills.map(item => skillRef(item.id)); genome.tools = base.tools.map(item => skillRef(item.id));
  const result = await proposeProjectGenome({ project: { id: 'skill-inheritance' }, baseline: base, evidence: [], model, maxAttempts: 1, provider: authorProvider([proposal(genome)], calls, () => { base.skills[0].resources[0].content = 'Caller changes do not alter the frozen baseline.'; }), onProgress: event => events.push(event) });
  assert.deepEqual(result.proposal.genome.skills, frozen.skills); assert.equal(result.validation.passed, true);
  const input = JSON.parse(calls[0].messages[0].content[0].text); assert.deepEqual(input.baselineSkillAssets, projectSkillAssetInventory(frozen));
  assert.match(calls[0].systemPrompt, /Omission alone never authorizes removal/);
  assert.deepEqual(result.proposal.assetChanges, expandAuthorSkills(genome, frozen).assetChanges);
  assert.deepEqual(result.repairEvidence[0].assetChanges, result.proposal.assetChanges);
  assert.deepEqual(events.find(item => item.type === 'proposal_asset_changes'), { type: 'proposal_asset_changes', attempt: 1, ...result.proposal.assetChanges });
  assert.equal(JSON.stringify(result.proposal.genome).includes('inheritFromBaseline'), false);
});

test('omitted resource is a bounded author error and does not leave stale inheritance in its repaired proposal', async () => {
  const base = baseline(), omitted = nextGenome(base), corrected = nextGenome(base), calls = [];
  omitted.skills[0].resources = []; omitted.skills[1] = skillRef('delivery');
  const result = await proposeProjectGenome({ project: { id: 'asset-omission-repair' }, baseline: base, evidence: [], model, maxAttempts: 2, provider: authorProvider([proposal(omitted), proposal(corrected)], calls) });
  assert.equal(calls.length, 2); assert.equal(result.validation.passed, true); assert.equal(result.repairEvidence[0].error.code, 'invalid_genome');
  assert.equal(result.repairEvidence[0].assetChanges, undefined); assert.deepEqual(result.proposal.assetChanges.inheritedSkills, []);
  assert.deepEqual(result.proposal.genome.skills, base.skills); assert.equal(result.usage.totalTokens, 42);
  assert.match(JSON.parse(calls[1].messages[0].content[0].text).previousError, /Existing resource was omitted/);
});

test('explicit resource and skill withdrawals survive proposal, complete materialization and paid evaluation', async () => {
  const base = baseline(), genome = nextGenome(base);
  const declarations = { withdrawSkills: [withdrawSkill(base.skills[1])], withdrawSkillResources: [withdrawResource(base.skills[0], base.skills[0].resources[0])] };
  genome.skills = [{ ...genome.skills[0], resources: [] }];
  const proposed = await proposeProjectGenome({ project: { id: 'explicit-asset-withdrawal' }, baseline: base, evidence: [], model, maxAttempts: 1, provider: authorProvider([proposal(genome, declarations)]) });
  assert.deepEqual(proposed.proposal.assetChanges.withdrawnSkills, declarations.withdrawSkills);
  assert.deepEqual(proposed.proposal.assetChanges.withdrawnSkillResources, declarations.withdrawSkillResources);
  const calls = [], evaluated = await evaluateProjectGenomes({ baseline: base, candidate: proposed.proposal.genome, assetDeclarations: { withdrawSkills: proposed.proposal.assetChanges.withdrawnSkills, withdrawSkillResources: proposed.proposal.assetChanges.withdrawnSkillResources }, model, provider: genomeEvaluationProvider({ calls }) });
  assert.ok(calls.length > 0); assert.equal(evaluated.evaluationComplete, true); assert.equal(evaluated.gatePassed, true);
  assert.deepEqual(evaluated.assetChanges.withdrawnSkills, declarations.withdrawSkills); assert.deepEqual(evaluated.assetChanges.withdrawnSkillResources, declarations.withdrawSkillResources);
  assert.equal(evaluated.suiteHash, evolutionHash(base.evaluationSuite));
});

test('complete candidate missing a baseline asset without declaration is rejected before any paid comparison', async () => {
  const base = baseline(), candidate = structuredClone(base); candidate.skills[0].resources = []; let paid = 0, admissions = 0;
  await assert.rejects(evaluateProjectGenomes({ baseline: base, candidate, model, provider: async function* () { paid++; }, requestControl: { beforeRequest() { admissions++; } } }), error => error.code === 'invalid_genome' && error.usage.totalTokens === 0 && error.requests.length === 0);
  assert.equal(paid, 0); assert.equal(admissions, 0);
});

test('script repair projects inherited skill and resource refs while preserving their exact full bytes', async () => {
  const base = baseline(), genome = nextGenome(base), calls = [];
  genome.skills[0].resources = genome.skills[0].resources.map(item => resourceRef(item.path)); genome.skills[1] = skillRef('delivery');
  genome.tools.push({ id: 'new_counter', name: 'Counter', description: 'Count the explicit inputs', permission: 'read', parameters: { type: 'object' }, script: 'return {count:99};', smokeCases: [{ input: {}, expected: { count: 0 } }] });
  const patch = { tools: [{ id: 'new_counter', script: 'return {count:0};' }], smokeRepairs: [] };
  const result = await proposeProjectGenome({ project: { id: 'skill-repair-projection' }, baseline: base, evidence: [], model, maxAttempts: 2, provider: authorProvider([proposal(genome), patch], calls) });
  assert.equal(result.validation.passed, true); assert.equal(calls.length, 2);
  const repair = JSON.parse(calls[1].messages[0].content[0].text); assert.deepEqual(repair.candidate.skills, genome.skills);
  assert.deepEqual(result.proposal.genome.skills, base.skills); assert.deepEqual(result.repairEvidence[0].assetChanges, result.repairEvidence[1].assetChanges);
});
