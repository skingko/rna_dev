import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillMarketplaceClient } from '../../../packages/sdk/src/skill-marketplaces.mjs';
import { marketplaceFixture } from '../../../packages/sdk/test/fixtures/skill-marketplace.mjs';
import { projectGenomeFixture, diagnosisFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { SkillMarketplaceService } from '../skill-marketplace-service.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { validateProjectGenome } from '../../../packages/sdk/src/project-genome.mjs';
import { proposeProjectGenome } from '../../../packages/sdk/src/project-evolution.mjs';
import { bootstrapProject } from '../../../packages/sdk/src/bootstrap.mjs';
import { expandAuthorSkills } from '../../../packages/sdk/src/project-proposal-inheritance.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4096 };
const input = { provider: 'skills-sh', id: 'fixture/skills/research' };
const choice = { ...input, reason: 'This source provides reusable evidence-checking methods for research.', compatibility: 'The source needs only reading supplied documents; no missing shell or network dependency.' };
const invoke = async (author, name, args) => {
  const result = await author.tools.find(tool => tool.name === name).execute(name, args);
  return { ...JSON.parse(result.content[0].text), isError: result.isError === true };
};
async function setup(t, options) {
  const fixture = await marketplaceFixture(t, options), store = { state: { projects: [{ id: 'project' }] } };
  const service = new SkillMarketplaceService(store, { client: new SkillMarketplaceClient({ fetchImpl: fixture.fetchImpl, git: fixture.git }) });
  return { fixture, store, service, author: service.authoring('project') };
}
async function acquire(author) {
  assert.equal((await invoke(author, 'marketplace_search', { query: 'research' })).isError, false);
  assert.equal((await invoke(author, 'marketplace_read', input)).isError, false);
  const result = await invoke(author, 'marketplace_acquire', choice); assert.equal(result.isError, false, JSON.stringify(result)); return result;
}
test('acquisition preserves original SKILL, every resource and repository license through immutable version storage', async t => {
  const { author, fixture } = await setup(t), receipt = await acquire(author);
  const genome = author.policy.finalizeGenome(projectGenomeFixture()), source = genome.skills.find(skill => skill.source);
  validateProjectGenome(genome); assert.equal(source.instructions, fixture.sources['skills/research/SKILL.md']);
  assert.equal(source.resources.find(row => row.path === 'references/method.md').content, fixture.sources['skills/research/references/method.md']);
  assert.equal(source.resources.find(row => row.path === '@license/LICENSE').content, fixture.sources.LICENSE);
  assert.equal(receipt.installed, false); assert.equal(receipt.status, 'acquired_for_candidate');
  const root = await mkdtemp(join(tmpdir(), 'rna-market-version-')); t.after(() => rm(root, { recursive: true, force: true }));
  const genomes = new ProjectGenomeStore({}, { rootDir: root }), prepared = await genomes.prepare({ id: 'project' }, { genome, versionId: 'candidate' });
  assert.equal(prepared.skillManifests.find(row => row.acquired).generated, false);
  await prepared.commit(); const stored = await genomes.read('project', 'candidate');
  assert.equal(await readFile(join(stored.dir, 'skills', source.id, 'SKILL.md'), 'utf8'), fixture.sources['skills/research/SKILL.md']);
  assert.equal(await readFile(join(stored.dir, 'skills', source.id, '@license/LICENSE'), 'utf8'), fixture.sources.LICENSE);
  const before = fixture.calls.length; assert.equal((await invoke(author, 'marketplace_acquire', choice)).replayed, true); assert.equal(fixture.calls.length, before);
});
test('host rejects unresearched final output and read-only paraphrase; explicit inspected incompatibility remains possible', async t => {
  const { author } = await setup(t), genome = projectGenomeFixture();
  assert.throws(() => author.policy.finalizeGenome(genome), { code: 'marketplace_research_incomplete' });
  assert.equal((await invoke(author, 'marketplace_skip', { reason: 'There is no reason to search because I can write instructions.' })).isError, true);
  await invoke(author, 'marketplace_search', { query: 'research' });
  assert.equal((await invoke(author, 'marketplace_skip', { reason: 'The source requires APIs unavailable in the isolated evaluation.' })).isError, true);
  await invoke(author, 'marketplace_read', input);
  assert.throws(() => author.policy.finalizeGenome(genome), { code: 'marketplace_research_incomplete' });
  await invoke(author, 'marketplace_skip', { reason: 'This task needs a licensed document editor; this inspected research method does not supply that capability.' });
  assert.deepEqual(author.policy.finalizeGenome(genome), genome); assert.equal(author.snapshot().disposition.status, 'no_package_selected');
});
test('source packages cannot be forged or silently rewritten, and exact inherited bytes survive another generation', async t => {
  const { author, service } = await setup(t); await acquire(author);
  const baseline = author.policy.finalizeGenome(projectGenomeFixture());
  const changed = structuredClone(baseline); changed.skills.at(-1).instructions += '\nInvented modification.';
  assert.throws(() => author.policy.finalizeGenome(changed), { code: 'marketplace_source_modified' });
  assert.throws(() => validateProjectGenome(changed), /bytes or license/);
  const next = service.authoring('project', { baseline }); await acquire(next);
  const expanded = expandAuthorSkills({ skills: baseline.skills.map(skill => ({ id: skill.id, inheritFromBaseline: true })) }, baseline);
  assert.deepEqual(next.policy.finalizeGenome({ ...baseline, skills: expanded.skills }).skills, baseline.skills);
  const fake = structuredClone(baseline); fake.skills.at(-1).id = 'pretend_installed';
  assert.throws(() => next.policy.finalizeGenome(fake), { code: 'marketplace_source_modified' });
});
test('network failure is explicit and may fall back with a recorded reason without pretending an install', async t => {
  const { author } = await setup(t, { transform: (value, url) => ['www.skills.sh', 'skillsmp.com'].includes(url.hostname) ? { status: 429 } : value });
  assert.equal((await invoke(author, 'marketplace_search', { query: 'research' })).code, 'marketplace_rate_limit');
  await invoke(author, 'marketplace_skip', { reason: 'The public catalog returned a rate limit, so this candidate retains existing methods and records missing source coverage.' });
  assert.deepEqual(author.policy.finalizeGenome(projectGenomeFixture()), projectGenomeFixture());
  assert.equal(author.snapshot().packages.length, 0); assert.equal(author.snapshot().failures[0].code, 'marketplace_rate_limit');
});
test('an unavailable market automatically falls back to the other official catalog with the original failure visible', async t => {
  const { author } = await setup(t, { transform: (value, url) => url.hostname === 'www.skills.sh' ? { status: 429 } : value });
  const result = await invoke(author, 'marketplace_search', { query: 'research' });
  assert.equal(result.isError, false); assert.equal(result.provider, 'skillsmp'); assert.deepEqual(result.fallback, { from: 'skills-sh', code: 'marketplace_rate_limit' });
  assert.equal(author.snapshot().failures[0].provider, 'skills-sh'); assert.equal(author.snapshot().searches[0].provider, 'skillsmp');
});
test('already acquired relevant baseline package can be reused without another unrelated network search', async t => {
  const { author, service, fixture } = await setup(t); await acquire(author); const baseline = author.policy.finalizeGenome(projectGenomeFixture());
  const next = service.authoring('project', { baseline }), calls = fixture.calls.length;
  const decision = await invoke(next, 'marketplace_skip', { existingSkillId: baseline.skills.at(-1).id, reason: 'The unchanged source checking package already covers this intervention; only the separate project-specific adapter needs refinement.' });
  assert.equal(decision.status, 'existing_package_reused'); assert.deepEqual(next.policy.finalizeGenome(baseline), baseline); assert.equal(fixture.calls.length, calls);
  assert.throws(() => next.policy.finalizeGenome({ ...baseline, skills: baseline.skills.slice(0, -1) }), { code: 'marketplace_reuse_missing' });
});
test('author source identities are isolated from concurrent shared-client catalog changes', async t => {
  const fixture = await marketplaceFixture(t), client = new SkillMarketplaceClient({ fetchImpl: fixture.fetchImpl, git: fixture.git });
  const service = new SkillMarketplaceService({ state: { projects: [{ id: 'project' }] } }, { client }), author = service.authoring('project');
  await invoke(author, 'marketplace_search', { query: 'research' });
  client.entries.set('skills-sh:fixture/skills/research', { provider: 'skills-sh', id: input.id, repository: 'unrelated/changed', refHint: 'HEAD' });
  const source = await invoke(author, 'marketplace_read', input); assert.equal(source.repository, 'fixture/skills'); assert.equal(source.commit, fixture.commit);
  assert.ok(!fixture.calls.some(row => row.url.includes('unrelated')));
});
function selectingProvider(draft, calls) { return async function* (request) {
  calls.push(request); const results = request.messages.filter(row => row.role === 'toolResult');
  const sequence = [{ name: 'marketplace_search', arguments: { query: 'research' } }, { name: 'marketplace_read', arguments: input }, { name: 'marketplace_acquire', arguments: choice }];
  if (results.length < sequence.length) { yield { type: 'tool_call', id: `source-${results.length}`, ...sequence[results.length] }; yield { type: 'done', stopReason: 'toolUse' }; }
  else { yield { type: 'text_delta', delta: JSON.stringify(draft) }; yield { type: 'done', stopReason: 'stop' }; }
} }
test('real SDK author tool loop injects acquired bytes into bootstrap without model reproducing them', async t => {
  const { author, fixture } = await setup(t), calls = [], draft = { overview: 'Evidence research', focus: 'Check sources', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() };
  const result = await bootstrapProject({ title: 'Research', model, provider: selectingProvider(draft, calls), referenceTools: author.tools, referenceContext: author.context, referencePolicy: author.policy });
  assert.equal(result.status, 'ready'); assert.equal(calls.length, 4); assert.equal(draft.genome.skills.length, 1);
  assert.equal(result.genome.skills.at(-1).instructions, fixture.sources['skills/research/SKILL.md']);
  assert.equal(result.referenceDiscovery.packages.length, 1);
});
test('evolution author acquisition enters the proposed genome while frozen evaluation suite and baseline stay unchanged', async t => {
  const { author, fixture } = await setup(t), baseline = projectGenomeFixture(), calls = [], candidate = projectGenomeFixture({ candidate: true }); delete candidate.evaluationSuite;
  const draft = { summary: 'Reuse original source method', hypothesis: 'A mature method helps source checking', diagnosis: diagnosisFixture(), changes: ['Acquire original source package'], genome: candidate };
  const result = await proposeProjectGenome({ project: { id: 'project' }, baseline, evidence: [], model, provider: selectingProvider(draft, calls), referenceTools: author.tools, referenceContext: author.context, referencePolicy: author.policy });
  assert.equal(calls.length, 4); assert.equal(result.proposal.genome.skills.at(-1).instructions, fixture.sources['skills/research/SKILL.md']);
  assert.deepEqual(result.proposal.genome.evaluationSuite, baseline.evaluationSuite); assert.equal(baseline.skills.length, 1); assert.equal(result.validation.passed, true);
});
test('finish check continues an early final response instead of accepting a model which ignores market tools', async t => {
  const { author } = await setup(t), calls = [], draft = { overview: 'Evidence', focus: 'Research', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() };
  const select = selectingProvider(draft, calls); let first = true;
  const provider = async function* (request) { if (first) { first = false; calls.push(request); yield { type: 'text_delta', delta: JSON.stringify(draft) }; yield { type: 'done', stopReason: 'stop' }; } else yield* select(request); };
  const result = await bootstrapProject({ title: 'Research', model, provider, referenceTools: author.tools, referencePolicy: author.policy });
  assert.equal(calls.length, 5); assert.equal(result.genome.skills.filter(row => row.source).length, 1);
  assert.match(JSON.stringify(calls[1].messages), /marketplace_search/);
});
