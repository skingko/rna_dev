import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectSkillFoundationService } from '../project-skill-foundation-service.mjs';
import { SkillMarketplaceService } from '../skill-marketplace-service.mjs';
import { SkillMarketplaceClient } from '../../../packages/sdk/src/skill-marketplaces.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { marketplaceFixture } from '../../../packages/sdk/test/fixtures/skill-marketplace.mjs';
import { deriveProjectTaskTypes, foundationSearchPlan } from '../../../packages/sdk/src/skill-foundation-screen.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 1024 };
const now = Date.parse('2026-09-28T05:00:00Z');
async function fixture(t, { pick, description = 'Daily AI news research digest with source checks. Internal codename PRIVATE_CODENAME_ZETA.' } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rna-foundation-screen-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')), { project } = store.createProject({ name: 'News research', description, workspace: dir });
  const genomes = new ProjectGenomeStore(store), baseline = projectGenomeFixture(), original = await genomes.prepare(project, { genome: baseline, versionId: 'baseline-one' }); await original.commit();
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { simulated: false, initialization: { status: 'ready' }, activeVersionId: 'baseline-one', versions: [{ id: 'baseline-one', state: 'baseline', bundle: original.record, generatedSkills: original.skillManifests, generatedTools: original.toolDescriptors }], assignments: { skillIds: original.skillManifests.map(row => row.id), toolIds: original.toolDescriptors.map(row => row.id), mcpServerIds: [], reasons: [] } }); state.capabilities ??= { skills: [], tools: [], mcpServers: [], installations: [], revision: 0 }; state.capabilities.skills.push(...original.skillManifests); });
  const http = await marketplaceFixture(t), marketplaceService = new SkillMarketplaceService(store, { client: new SkillMarketplaceClient({ fetchImpl: http.fetchImpl, git: http.git }) });
  const f = { dir, store, http, genomes, calls: [], picks: [], projectId: project.id, get project() { return store.state.projects.find(row => row.id === project.id); } };
  f.service = new ProjectSkillFoundationService(store, { genomeStore: genomes, marketplaceService, now: () => now, ...(pick ? { pick: input => { f.picks.push(input); return pick(input); } } : {}) });
  return f;
}
const reviewer = (f, fit) => async function* (request) {
  f.calls.push(request); const input = JSON.parse(request.messages[0].content[0].text);
  yield { type: 'text_delta', delta: JSON.stringify({ decisions: input.candidates.map(row => ({ ref: row.ref, fit, reason: fit ? 'Directly supports source-checked research.' : 'Unrelated to the research task type.' })) }) };
  yield { type: 'usage', usage: { totalTokens: 40 } }; yield { type: 'done', stopReason: 'stop' };
};

test('task types and public queries come from the project definition without private prose', () => {
  assert.deepEqual(deriveProjectTaskTypes({ title: 'Ai 应用调研项目', description: '每日 Ai 新闻采集与盈利分析' }), ['research', 'analysis', 'recurring']);
  assert.deepEqual(deriveProjectTaskTypes({ title: 'x', taskTypes: ['coding', 'bogus'] }), ['coding']);
  const plan = foundationSearchPlan({ title: '游戏开发工作台', description: 'Unity 游戏原型 PRIVATE_CODENAME_ZETA' });
  assert.ok(plan.length >= 2 && plan.length <= 4); assert.ok(plan.every(row => !row.query.includes('PRIVATE') && /^[a-z ]+$/.test(row.query)));
});

test('one JEV choice over names and descriptions picks the initial skills, which are installed without any main-model request', async t => {
  const f = await fixture(t, { pick: async ({ candidates }) => { const index = candidates.findIndex(row => /research|source checking/i.test(row.name)); return { source: 'judge', indexes: [index], probabilities: { [index]: 0.8 }, ledgerId: 'ledger-1' }; } });
  const result = await f.service.run(f.project, { model, apiKey: 'PRIVATE_FIXTURE_KEY', provider: reviewer(f, false) });
  assert.equal(result.status, 'ready', JSON.stringify([result.code, result.foundation?.referenceDiscovery?.failures, result.foundation?.coverage])); assert.equal(result.added, true); assert.equal(f.calls.length, 0);
  assert.equal(f.picks.length, 1, 'exactly one JEV request for the whole list');
  assert.ok(f.picks[0].candidates.every(candidate => Object.keys(candidate).every(key => ['name', 'description', 'source'].includes(key))), 'JEV sees only published names, descriptions and (without a description) the package path');
  assert.equal(f.picks[0].min, 2); assert.equal(f.picks[0].max, 3);
  const stored = await f.genomes.read(f.projectId, result.versionId), added = stored.genome.skills.filter(row => row.source?.kind === 'marketplace-package');
  assert.equal(added.length, 1); assert.equal(added[0].instructions, f.http.sources['skills/research/SKILL.md']);
  const screening = f.project.skillFoundation.screening; assert.equal(screening.method, 'market_pick_v2'); assert.equal(screening.pick.source, 'judge'); assert.equal(screening.pick.picked.length, 1);
  assert.equal(screening.areas.reduce((sum, row) => sum + row.selected.length, 0), 1); assert.ok(screening.areas.filter(row => !row.selected.length).every(row => row.gap === 'screened_out'));
  assert.equal(f.http.calls.some(row => row.url.includes('PRIVATE')), false);
});

test('a JEV "none" or no judge backend installs nothing and closes every area as an evidence-backed gap, with no main-model request', async t => {
  for (const pick of [async () => ({ source: 'judge', indexes: [], none: true }), undefined]) {
    const f = await fixture(t, { pick });
    const result = await f.service.run(f.project, { model, apiKey: 'PRIVATE_FIXTURE_KEY', provider: reviewer(f, true) });
    assert.equal(f.calls.length, 0); assert.equal(result.added, false); assert.equal(result.status, 'partial');
    assert.ok(f.project.skillFoundation.coverage.every(row => row.status === 'deferred' && row.reasonCode === 'screened_out'));
  }
});

test('queries written by the project brief drive the marketplace search instead of the curated task-type plan', async t => {
  const f = await fixture(t, { pick: async () => ({ source: 'judge', indexes: [0] }) });
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).skillQueries = ['research digest', 'bad\nquery'] });
  const result = await f.service.run(f.project, { model, apiKey: 'PRIVATE_FIXTURE_KEY', provider: reviewer(f, false) });
  assert.ok(f.project.skillFoundation.screening, JSON.stringify({ status: result.status, code: result.code, foundation: f.project.skillFoundation }).slice(0, 1500));
  const areas = f.project.skillFoundation.screening.areas;
  assert.equal(areas[0].query, 'research digest', 'well-formed brief queries come first'); assert.equal(areas.length, 2, 'a single usable query is paired with one curated area'); assert.ok(!areas.some(row => row.query.includes('bad')));
  assert.ok(f.http.calls.some(row => decodeURIComponent(row.url.replaceAll('+', ' ')).includes('research digest')));
});
