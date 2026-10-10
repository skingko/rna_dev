import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareProjectSkillFoundation } from '../src/project-skill-foundation.mjs';
import { marketplaceGenomeSkill } from '../src/marketplace-genome-skills.mjs';
import { projectGenomeFixture } from './fixtures/project-genome.mjs';

const hash = content => createHash('sha256').update(content).digest('hex');
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 3000 };
const snapshot = extra => ({ searches: [], references: [], failures: [], packages: [], disposition: null, ...extra });
const feedback = () => ({ feedback: [{ source: 'host:foundation-coverage', text: 'Inspect and acquire the two complementary source areas before submitting the summary. Existing time and request limits still apply.' }] });
function sourceSkill(id, installed = false) {
  const files = [{ path: 'SKILL.md', content: `---\nname: ${id}\ndescription: Reusable ${id} method\n---\nPRIVATE_SOURCE_BYTES_${id}\n` }, { path: '@license/LICENSE', content: 'MIT License\nFixture authors.' }].map(row => ({ ...row, contentHash: hash(row.content), bytes: Buffer.byteLength(row.content) }));
  const proofs = files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })), packageHash = hash(JSON.stringify(proofs));
  if (installed) return { id, name: id, description: 'Previously verified installed skill', instructions: files[0].content, resources: files.slice(1).map(({ path, content }) => ({ path, content })),
    source: { kind: 'installed-skill-package', integrity: 'installed_snapshot', installationId: 'installation-one', manifestId: id, installationRecordHash: 'c'.repeat(64), repository: 'https://github.com/fixture/skills.git', commit: 'a'.repeat(40), subdirectory: id, packageHash, frozenAt: '2026-09-28T00:00:00Z', reason: 'Current host verified installed source', compatibility: 'Source input needs no additional tool', licenseReview: 'preserved_not_legal_approval', licensePaths: ['@license/LICENSE'], files: proofs } };
  return marketplaceGenomeSkill({ provider: 'skills-sh', id: `fixture/skills/${id}`, repository: 'fixture/skills', commit: 'a'.repeat(40), subdirectory: id, sourceUrl: `https://github.com/fixture/skills/blob/${'a'.repeat(40)}/${id}/SKILL.md`, catalogUrl: `https://skills.sh/fixture/skills/${id}`, files, licensePaths: ['@license/LICENSE'], licenseReview: 'preserved_not_legal_approval', packageHash, acquiredAt: '2026-09-28T00:00:00Z', installed: false, executesCode: false }, { reason: 'Relevant complementary source method', compatibility: 'The source needs only document reading' });
}
function completion(next, calls = []) { return async function* (request) {
  calls.push(request); const step = next(request, calls.length) ?? {};
  if (step.tools) for (const [index, call] of step.tools.entries()) yield { type: 'tool_call', id: `call-${calls.length}-${index}`, name: call.name, arguments: call.arguments ?? {} };
  else yield { type: 'text_delta', delta: JSON.stringify(step.output ?? { summary: 'Prepared only the host-recorded source packages; evaluation and publication remain separate.' }) };
  yield { type: 'usage', usage: { totalTokens: 12 } }; yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } };
  yield { type: 'done', stopReason: step.stopReason ?? (step.tools ? 'toolUse' : 'stop') };
}; }
const options = extra => ({ project: { title: 'Research workspace', description: 'Collect accurate evidence and deliver readable reports.' }, baseline: projectGenomeFixture(), model, provider: completion(() => ({})), referencePolicy: { finalizeGenome: genome => genome, snapshot: () => snapshot() }, ...extra });
const tool = (name, execute) => ({ name, effect: 'read', description: 'A bounded host source operation.', parameters: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }, execute: async (_call, args) => ({ content: [{ type: 'text', text: JSON.stringify(await execute(args)) }] }) });

test('actual SDK author loop plans and batches complementary sources without authoring source bytes or touching project behavior', async () => {
  const baseline = projectGenomeFixture(); baseline.skills[0].instructions = 'BASELINE_PRIVATE_SOURCE_BODY';
  const before = structuredClone(baseline), installed = sourceSkill('installed_reference', true), sources = [sourceSkill('research'), sourceSkill('delivery')], acquired = [], state = snapshot(), calls = [], events = [], admissions = [];
  const referenceTools = [tool('marketplace_plan', () => ({ areas: ['research', 'delivery'] })), tool('marketplace_search', ({ id }) => { state.searches.push({ provider: 'skills-sh', results: [{ id }], coverage: { status: 'complete' } }); return { id }; }),
    tool('marketplace_read', ({ id }) => { state.references.push({ provider: 'skills-sh', id, content: 'private source content' }); return { inspected: id }; }),
    tool('marketplace_acquire', ({ id }) => { const source = sources.find(row => row.id === id); assert.ok(source); acquired.push(source); state.packages.push({ skillId: id, ...source.source }); return { skillId: id, status: 'acquired_for_candidate', installed: false }; })];
  const result = await prepareProjectSkillFoundation(options({ baseline, existingInstalledSkills: [installed], referenceTools, provider: completion((_request, n) => n === 1 ? { tools: [{ name: 'marketplace_plan' }] } : n <= 4 ? { tools: sources.map(source => ({ name: ['marketplace_search', 'marketplace_read', 'marketplace_acquire'][n - 2], arguments: { id: source.id } })) } : {}, calls),
    beforeRequest: request => admissions.push(request), onEvent: event => events.push(event), referencePolicy: { beforeFinish: () => acquired.length < 2 ? feedback() : undefined, finalizeGenome: genome => { assert.equal(acquired.length, 2); return { ...genome, skills: [...genome.skills, ...acquired] }; }, snapshot: () => state }
  }));
  assert.equal(result.status, 'ready'); assert.equal(calls.length, 5); assert.equal(result.requests.length, 5); assert.equal(admissions.length, 5); assert.equal(result.usage.totalTokens, 150);
  assert.equal(events.filter(row => row.type === 'foundation_request_end').length, 5); assert.equal(result.behaviorPreserved, true); assert.equal(result.evaluationPerformed, false);
  assert.deepEqual(result.addedSkillIds, [installed.id, ...sources.map(row => row.id)]); assert.deepEqual(result.existingInstalledSkillIds, [installed.id]);
  assert.deepEqual(result.genome.skills.slice(1), [installed, ...sources]); assert.deepEqual(baseline, before);
  assert.deepEqual({ ...result.genome, skills: [] }, { ...baseline, skills: [] }); assert.equal(result.referenceDiscovery.outcome, 'acquired');
  for (const request of calls) { assert.equal(JSON.stringify(request).includes('BASELINE_PRIVATE_SOURCE_BODY'), false); assert.equal(JSON.stringify(request.messages).includes(baseline.evaluationSuite.cases[0].input), false); assert.equal(request.model.maxOutputTokens, 3000); }
  assert.equal(JSON.stringify(result.referenceDiscovery).includes('PRIVATE_SOURCE_BYTES'), false);
});

test('verified existing sources can be reused in one request without any acquisition or generated change', async () => {
  const installed = sourceSkill('installed_reference', true), baseline = projectGenomeFixture(); baseline.skills.push(installed);
  const refreshed = structuredClone(installed); refreshed.source.frozenAt = '2026-09-29T00:00:00Z'; refreshed.source.reason = 'Refreshed verification evidence';
  const calls = [];
  const result = await prepareProjectSkillFoundation(options({ baseline, existingInstalledSkills: [refreshed], provider: completion(() => ({}), calls) }));
  assert.equal(calls.length, 1); assert.deepEqual(result.genome, baseline); assert.deepEqual(result.addedSkillIds, []); assert.equal(result.genome.skills.at(-1).source.frozenAt, installed.source.frozenAt);
});

test('missing source policy, generated installed inputs and conflicting installed IDs fail before any provider request', async () => {
  const installed = sourceSkill('installed_reference', true), baseline = projectGenomeFixture(); baseline.skills.push(installed);
  const conflicting = structuredClone(installed); conflicting.source.installationRecordHash = 'b'.repeat(64);
  for (const changes of [{ referencePolicy: undefined }, { existingInstalledSkills: [projectGenomeFixture().skills[0]] }, { baseline, existingInstalledSkills: [conflicting] }]) {
    const calls = [];
    await assert.rejects(prepareProjectSkillFoundation(options({ ...changes, provider: completion(() => ({}), calls) })), error => { assert.ok(['invalid_options', 'foundation_source_conflict'].includes(error.code)); assert.deepEqual(error.requests, []); assert.equal(error.usage.totalTokens, 0); return true; });
    assert.equal(calls.length, 0);
  }
});

test('model cannot submit a genome or source body, and summary output never authorizes source inclusion', async () => {
  let finalized = 0;
  await assert.rejects(prepareProjectSkillFoundation(options({ provider: completion(() => ({ output: { summary: 'I prepared a source', genome: projectGenomeFixture(), instructions: 'Invented source' } })), referencePolicy: { finalizeGenome(genome) { finalized++; return genome; } } })), error => { assert.equal(error.code, 'invalid_output'); assert.equal(error.requests.length, 1); assert.equal(error.usage.totalTokens, 30); return true; });
  assert.equal(finalized, 0);
});

test('host finalization cannot rewrite the charter, tools, evaluation standard, existing skill, or remove a skill', async () => {
  for (const mutate of [
    genome => { genome.systemPrompt += 'Changed charter'; },
    genome => { genome.tools[0].description += 'Changed tool'; },
    genome => { genome.evaluationSuite.thresholds.minImprovement = 0.01; },
    genome => { genome.skills[0].instructions += 'Changed method'; },
    genome => { genome.skills = [sourceSkill('replacement')]; }
  ]) {
    await assert.rejects(prepareProjectSkillFoundation(options({ referencePolicy: { finalizeGenome(genome) { mutate(genome); return genome; } } })), { code: 'foundation_behavior_changed' });
  }
});

test('even a trusted host finalizer must not append a generated skill in foundation-only mode', async () => {
  await assert.rejects(prepareProjectSkillFoundation(options({ referencePolicy: { finalizeGenome: genome => ({ ...genome, skills: [...genome.skills, { ...genome.skills[0], id: 'generated_extra' }] }) } })), { code: 'foundation_source_required' });
});

test('the final tool-free summary still meets host coverage policy within the fixed six-request ceiling', async () => {
  const calls = []; let finalized = 0;
  await assert.rejects(prepareProjectSkillFoundation(options({ provider: completion(() => ({}), calls), referenceTools: [tool('marketplace_plan', () => ({}))], referencePolicy: { beforeFinish: feedback, finalizeGenome() { finalized++; throw Object.assign(new Error('Required source areas are still missing'), { code: 'marketplace_research_incomplete' }); }, snapshot: () => snapshot() } })), error => {
    assert.equal(error.code, 'marketplace_research_incomplete'); assert.equal(error.requests.length, 6); assert.equal(error.usage.totalTokens, 180); assert.equal(error.referenceDiscovery.outcome, 'not_attempted'); return true;
  });
  assert.equal(calls.length, 6); assert.equal(calls.at(-1).tools.length, 0); assert.equal(finalized, 1);
});

test('admission refusal is retained as zero usage and zero actual provider requests', async () => {
  const calls = [], events = [];
  await assert.rejects(prepareProjectSkillFoundation(options({ provider: completion(() => ({}), calls), beforeRequest: () => { throw Object.assign(new Error('No reservation'), { code: 'budget_denied' }); }, onEvent: event => events.push(event) })), error => {
    assert.equal(error.code, 'budget_denied'); assert.equal(error.requests.length, 1); assert.equal(error.requests[0].admitted, false); assert.equal(error.requests[0].requestStarted, false); assert.equal(error.requests[0].usage.totalTokens, 0); assert.equal(error.usage.totalTokens, 0); return true;
  });
  assert.equal(calls.length, 0); assert.equal(events.filter(row => row.type === 'foundation_request_end').length, 1);
});

test('cancellation after successful admission settles the reservation at zero without dispatch', async () => {
  const controller = new AbortController(), reason = new Error('Cancelled after admission'), calls = [];
  await assert.rejects(prepareProjectSkillFoundation(options({ signal: controller.signal, provider: completion(() => ({}), calls), beforeRequest: () => controller.abort(reason) })), error => {
    assert.equal(error, reason); assert.equal(error.requests.length, 1); assert.equal(error.requests[0].admitted, true); assert.equal(error.requests[0].requestStarted, false); assert.equal(error.usage.totalTokens, 0); return true;
  });
  assert.equal(calls.length, 0);
});

test('provider failure retains reported usage and source failure receipt without promotion to ready', async () => {
  await assert.rejects(prepareProjectSkillFoundation(options({ provider: async function* () { yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'error', error: 'Disconnected' }; }, referencePolicy: { finalizeGenome: genome => genome, snapshot: () => snapshot({ failures: [{ operation: 'marketplace_search', code: 'marketplace_rate_limit', message: 'PRIVATE_BODY' }] }) } })), error => {
    assert.equal(error.requests.length, 1); assert.equal(error.requests[0].requestStarted, true); assert.equal(error.requests[0].completed, false); assert.equal(error.usage.totalTokens, 17); assert.equal(error.referenceDiscovery.outcome, 'failed'); assert.equal(JSON.stringify(error.referenceDiscovery).includes('PRIVATE_BODY'), false); return true;
  });
});

test('missing provider usage is charged with conservative request reservation instead of zero', async () => {
  const result = await prepareProjectSkillFoundation(options({ provider: async function* () { yield { type: 'text_delta', delta: '{"summary":"Only the host-verified preparation is recorded."}' }; yield { type: 'done', stopReason: 'stop' }; } }));
  assert.equal(result.requests[0].usageReported, false); assert.ok(result.usage.totalTokens > 3000); assert.equal(result.usage.estimatedTokens, result.usage.totalTokens); assert.equal(result.requests[0].estimatedTokens, result.usage.totalTokens);
});

test('foundation does not execute baseline tool smoke or make an improvement claim', async () => {
  const baseline = projectGenomeFixture(); baseline.tools[0].script = 'throw new Error("Existing runtime defect is outside foundation preparation");';
  const result = await prepareProjectSkillFoundation(options({ baseline }));
  assert.deepEqual(result.genome, baseline); assert.equal(result.evaluationPerformed, false); assert.equal('validation' in result, false); assert.equal('gatePassed' in result, false);
});

test('foundation readers reject arbitrary tools even when incorrectly labelled read', async () => {
  let executed = false; const calls = [];
  await assert.rejects(prepareProjectSkillFoundation(options({ provider: completion(() => ({}), calls), referenceTools: [tool('project_exec', () => { executed = true; })] })), { code: 'invalid_options' });
  assert.equal(executed, false); assert.equal(calls.length, 0);
});

test('configured output allowance is preserved and omission defaults to 4096', async () => {
  for (const output of [2048, 8192, undefined]) {
    const calls = [];
    await prepareProjectSkillFoundation(options({ model: { ...model, maxOutputTokens: output }, provider: completion(() => ({}), calls) }));
    assert.equal(calls[0].model.maxOutputTokens, output ?? 4096);
  }
});

test('non-staged foundation preserves finish/finalize readiness contracts without consuming the bootstrap research extension',async()=>{
 for(const pending of [false,true]){const calls=[];let reviews=0,finalized=0;
 const run=()=>prepareProjectSkillFoundation(options({referenceTools:[tool('marketplace_plan',()=>({}))],provider:completion(()=>({}),calls),referencePolicy:{researchReadiness:()=>assert.fail('Bootstrap staged readiness is not the foundation summary contract'),beforeFinish:()=>{reviews++;return pending?feedback():undefined;},finalizeGenome:g=>{finalized++;if(pending)throw Object.assign(Error('Missing original sources'),{code:'marketplace_research_incomplete'});return g;}}}));
 if(pending)await assert.rejects(run(),e=>e.code==='marketplace_research_incomplete'&&e.requests.length===6&&e.usage.totalTokens===180);else assert.equal((await run()).status,'ready');assert.equal(calls.length,pending?6:1);assert.equal(reviews,pending?5:1);assert.equal(finalized,1);
 }
});
