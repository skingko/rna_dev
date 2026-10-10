import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { SkillMarketplaceService } from '../skill-marketplace-service.mjs';
import { CapabilityInstallService } from '../capability-install-service.mjs';
import { SkillMarketplaceClient } from '../../../packages/sdk/src/skill-marketplaces.mjs';
import { marketplaceFixture } from '../../../packages/sdk/test/fixtures/skill-marketplace.mjs';
import { proposeProjectGenome } from '../../../packages/sdk/src/project-evolution.mjs';
import { bootstrapProject } from '../../../packages/sdk/src/bootstrap.mjs';
import { projectGenomeFixture, diagnosisFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4096 };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'rna-market-host-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'state.json')), project = store.createProject({ name: 'Isolated research', workspace: join(root, 'workspace') }).project;
  const fixture = await marketplaceFixture(t), client = new SkillMarketplaceClient({ fetchImpl: fixture.fetchImpl, git: fixture.git }), service = new SkillMarketplaceService(store, { client });
  return { root, store, project, fixture, service };
}
function sourceProvider(final, calls) { return async function* (request) {
  calls.push(request); const results = request.messages.filter(row => row.role === 'toolResult');
  const next = results.length === 0 ? { name: 'marketplace_search', arguments: { query: 'research', limit: 1 } } : results.length === 1 ? { name: 'marketplace_read', arguments: { provider: 'skills-sh', id: 'fixture/skills/research' } } : null;
  if (next) { yield { type: 'tool_call', id: `ref-${calls.length}`, ...next }; yield { type: 'usage', usage: { totalTokens: 3 } }; yield { type: 'usage', usage: { totalTokens: 7 } }; yield { type: 'done', stopReason: 'toolUse' }; }
  else { assert.match(JSON.stringify(results), /Read references\/method.md/); yield { type: 'text_delta', delta: JSON.stringify(final) }; yield { type: 'usage', usage: { totalTokens: 11 } }; yield { type: 'done', stopReason: 'stop' }; }
}; }
test('actual source readers reach the candidate author and usage settles each admitted request without installation or hidden cases', async t => {
  const f = await setup(t), refs = f.service.authoring(f.project.id), baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true });
  const proposal = { summary: 'Adapt conditional source checks', hypothesis: 'Use source-linked units', diagnosis: diagnosisFixture(), changes: ['Adapt skill procedure'], genome: candidate };
  delete proposal.genome.evaluationSuite; const calls = [], admissions = [], receipts = [];
  const result = await proposeProjectGenome({ project: { id: f.project.id }, baseline, evidence: [], model, provider: sourceProvider(proposal, calls), referenceTools: refs.tools, referenceContext: refs.context, requestControl: { beforeRequest: row => admissions.push(row), onUsage: row => receipts.push(row) } });
  assert.equal(calls.length, 3); assert.equal(admissions.length, 3); assert.equal(receipts.length, 3); assert.equal(result.usage.totalTokens, 25); assert.equal(result.validation.passed, true);
  assert.match(calls[0].systemPrompt, /counterexample/); assert.match(calls[0].systemPrompt, /Before inventing a new method/);
  assert.deepEqual(calls[0].tools.map(row => row.name).sort(), ['marketplace_acquire', 'marketplace_read', 'marketplace_search', 'marketplace_skip']);
  for (const request of calls) assert.ok(!JSON.stringify(request.messages).includes(baseline.evaluationSuite.cases[0].input));
  assert.deepEqual(result.proposal.genome.evaluationSuite, baseline.evaluationSuite); assert.equal(refs.snapshot().references.length, 1); assert.equal(refs.snapshot().references[0].commit, f.fixture.commit); assert.equal(f.store.state.capabilities?.installations?.length ?? 0, 0);
});
test('new-project bootstrap discovers original skill source, uses explicit execution defaults and keeps per-request charging', async t => {
  const f = await setup(t), refs = f.service.authoring(f.project.id), calls = [], events = [], admissions = [];
  const genome = projectGenomeFixture(); delete genome.evaluationSuite.execution;
  const draft = { overview: 'Ground claims in the supplied source', focus: 'Inspect evidence', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome };
  const result = await bootstrapProject({ title: 'Research', model, provider: sourceProvider(draft, calls), referenceTools: refs.tools, referenceContext: refs.context, beforeRequest: row => admissions.push(row), onEvent: row => events.push(row) });
  assert.equal(result.status, 'ready'); assert.equal(result.usage.totalTokens, 25); assert.equal(admissions.length, 3); assert.equal(events.filter(row => row.type === 'bootstrap_request_end').length, 3);
  assert.deepEqual(result.genome.evaluationSuite.execution, { maxSteps: 16, maxOutputTokens: 4096 }); assert.equal(result.referenceDiscovery.references.length, 1); assert.equal(genome.evaluationSuite.execution, undefined);
});
test('read tools enforce project lifetime and author discovery bounds without opening an install path', async t => {
  const f = await setup(t), refs = f.service.authoring(f.project.id), search = refs.tools.find(row => row.name === 'marketplace_search');
  assert.ok(refs.tools.every(row => row.permission === 'read' && row.effect === 'read'));
  for (let n = 0; n < 3; n++) assert.ok(!(await search.execute('s', { query: 'research' })).isError);
  const limited = await search.execute('s', { query: 'research' }); assert.match(limited.content[0].text, /marketplace_discovery_limit/); assert.equal(f.fixture.calls.filter(row => row.url.includes('/api/search')).length, 3, 'the fourth search never reached the catalog');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).archivedAt = new Date().toISOString(); });
  await assert.rejects(f.service.read({ projectId: f.project.id, provider: 'skills-sh', id: 'fixture/skills/research' }), { code: 'marketplace_project_unavailable' });
});
test('bootstrap cancellation after public-reference request admission releases with zero usage and never contacts model', async t => {
  const f = await setup(t), refs = f.service.authoring(f.project.id), controller = new AbortController(), events = []; let calls = 0;
  await assert.rejects(bootstrapProject({ title: 'Research', model, signal: controller.signal, referenceTools: refs.tools, provider: async function* () { calls++; }, beforeRequest: () => controller.abort(new Error('cancel after reservation')), onEvent: event => events.push(event) }), /cancel after reservation/);
  assert.equal(calls, 0); const receipt = events.find(row => row.type === 'bootstrap_request_end'); assert.equal(receipt.cancelledBeforeSend, true); assert.equal(receipt.usage.totalTokens, 0); assert.equal(receipt.requestUsage.estimatedTokens, 0);
});
test('source reuse remains separate from explicit installation, which copies resources only after the install action', async t => {
  const f = await setup(t), source = join(f.root, 'safe-fixture'); await mkdir(join(source, 'references'), { recursive: true });
  for (const [path, content] of Object.entries(f.fixture.sources)) if (path.startsWith('skills/research/')) await writeFile(join(source, path.slice('skills/research/'.length)), content);
  const installer = new CapabilityInstallService(f.store);
  await f.service.search({ query: 'research', projectId: f.project.id }); const reference = await f.service.read({ projectId: f.project.id, provider: 'skills-sh', id: 'fixture/skills/research' });
  assert.equal(f.store.state.capabilities?.installations?.length ?? 0, 0);
  // Deterministic fixture uses a local source; the separate public QA exercises
  // the returned HTTPS Git+fixed commit through the identical real installer.
  const installed = await installer.install(f.project.id, { kind: 'skill', source: { type: 'local', path: source }, activate: true }, { requestId: 'explicit-fixture-install' });
  assert.equal(installed.status, 'installed'); assert.equal(installed.manifests[0].manifest.name, 'Source checking');
  assert.equal(await readFile(join(installed.installationDir, 'skill/SKILL.md'), 'utf8'), reference.content); assert.equal(await readFile(join(installed.installationDir, 'skill/references/method.md'), 'utf8'), f.fixture.sources['skills/research/references/method.md']);
});
