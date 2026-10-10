import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { SkillMarketplaceService } from '../skill-marketplace-service.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { SkillMarketplaceClient } from '../../../packages/sdk/src/skill-marketplaces.mjs';
import { validateToolArguments } from '../../../packages/sdk/src/capabilities.mjs';
import { prepareProjectSkillFoundation } from '../../../packages/sdk/src/project-skill-foundation.mjs';
import { proposeProjectGenome } from '../../../packages/sdk/src/project-evolution.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { marketplaceFixture } from '../../../packages/sdk/test/fixtures/skill-marketplace.mjs';

// Deterministic author protocol, real SDK sessions and local HTTP source
// transport. These tests prove contracts and byte delivery, not model judgment,
// natural skill selection, measured task improvement or production adoption.
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4096 };
const areas = [
  { id: 'research', description: 'Check research conclusions against bounded original evidence.', query: 'source research' },
  { id: 'report', description: 'Compose an accessible report and validate report structure.', query: 'report structure' },
];
const rawReport = '---\nname: Report structure\ndescription: Organize research findings and validate report structure.\n---\nRead references/report.md before composing the report. Preserve uncertainty.\n';
const extra = { 'skills/report/SKILL.md': rawReport, 'skills/report/references/report.md': 'Use evidence, limitations, and decisions as distinct report sections.\n' };
const hash = value => createHash('sha256').update(value).digest('hex');
const entry = id => ({ provider: 'skills-sh', id: `fixture/skills/${id}` });
const choice = id => ({ ...entry(id), capabilityIds: [id], reason: `The ${id} method covers a separate research delivery capability.`, compatibility: 'This source uses supplied text; no unavailable executable dependency is assumed.' });
const noChange = { decision: 'no_change', abstention: { reason: 'insufficient_evidence', summary: 'No new grounded method change is established.', explanation: 'No independent work evidence was supplied to justify changing the retained method.', evidenceIds: [], revisitWhen: [{ condition: 'new_work_evidence', description: 'Revisit when a new delivery exposes a reproducible method limitation.' }] } };

async function fixture(t, modes = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rna-foundation-policy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const http = await marketplaceFixture(t, { transform: (value, url) => {
    if (['www.skills.sh', 'skillsmp.com'].includes(url.hostname)) {
      const mode = modes[url.searchParams.get('q')];
      if (mode === 'fail') return { status: 429 };
      const rows = mode === 'empty' ? [] : mode === 'unsupported' ? [{ id: 'unsupported-record', name: 'Unresolvable catalog record' }] : areas.map(({ id }) => ({ id: `fixture/skills/${id}`, source: 'fixture/skills', skillId: id, name: id, installs: 1 }));
      return url.hostname === 'www.skills.sh' ? { skills: rows } : { success: true, data: { skills: mode === 'empty' ? [] : rows.map(row => mode === 'unsupported' ? row : ({ id: row.id, name: row.name, githubUrl: `https://github.com/fixture/skills/tree/main/skills/${row.skillId}` })) } };
    }
    if (url.hostname === 'api.github.com' && !url.pathname.includes('/commits/')) return { ...value, tree: [...value.tree, ...Object.entries(extra).map(([path, content]) => ({ type: 'blob', mode: '100644', path, size: Buffer.byteLength(content), sha: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex') }))] };
    if (url.hostname === 'raw.githubusercontent.com') return extra[url.pathname.split('/').slice(4).map(decodeURIComponent).join('/')] ?? value;
    return value;
  } });
  const store = new Store(join(root, 'state.json')), workspace = join(root, 'workspace'); await mkdir(workspace);
  const project = store.createProject({ name: 'Research and accessible reports', workspace }).project;
  const service = new SkillMarketplaceService(store, { client: new SkillMarketplaceClient({ fetchImpl: http.fetchImpl, git: http.git, skillsmpApiKey: () => 'fixture-only' }) });
  return { root, http, store, project, service, author: service.authoring(project.id, { purpose: 'foundation', baseline: projectGenomeFixture() }) };
}
async function call(author, name, args) {
  const tool = author.tools.find(row => row.name === name); assert.ok(tool, name); validateToolArguments(tool.parameters, args);
  const result = await tool.execute(`fixture-${name}`, args, new AbortController().signal);
  return { ...JSON.parse(result.content[0].text), isError: result.isError === true };
}
const plan = author => call(author, 'marketplace_plan', { capabilities: areas });
const search = (author, id, query = areas.find(row => row.id === id).query) => call(author, 'marketplace_search', { query, capabilityIds: [id] });
const read = (author, id) => call(author, 'marketplace_read', { ...entry(id), capabilityIds: [id] });
const acquire = (author, id, capabilityIds = [id]) => call(author, 'marketplace_acquire', { ...choice(id), capabilityIds });
const skip = (author, id, reasonCode) => call(author, 'marketplace_skip', { capabilityIds: [id], reasonCode, reason: 'This capability remains explicitly deferred because its recorded source evidence does not support acquisition.' });
async function acquireBoth(author) { await plan(author); for (const { id } of areas) { assert.equal((await search(author, id)).isError, false); assert.equal((await read(author, id)).isError, false); assert.equal((await acquire(author, id)).isError, false); } }
function scripted(sequence, final, calls = []) { return async function* (request) {
  const step = calls.length; calls.push(request);
  if (step < sequence.length) { for (const [index, value] of sequence[step].entries()) yield { type: 'tool_call', id: `fixture-${step}-${index}`, ...value }; }
  else yield { type: 'text_delta', delta: JSON.stringify(final) };
  yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } }; yield { type: 'done', stopReason: step < sequence.length ? 'toolUse' : 'stop' };
}; }
const selectionSequence = () => [
  [{ name: 'marketplace_plan', arguments: { capabilities: areas } }],
  areas.map(({ id, query }) => ({ name: 'marketplace_search', arguments: { query, capabilityIds: [id] } })),
  areas.map(({ id }) => ({ name: 'marketplace_read', arguments: { ...entry(id), capabilityIds: [id] } })),
  areas.map(({ id }) => ({ name: 'marketplace_acquire', arguments: choice(id) })),
];

test('two complementary sources survive SDK authoring, immutable storage, registry and ordinary runtime skill_load', async t => {
  const f = await fixture(t), baseline = projectGenomeFixture(), calls = [];
  const result = await prepareProjectSkillFoundation({ project: { title: f.project.name }, baseline, model, provider: scripted(selectionSequence(), { summary: 'Prepared source checking and report structure from verified original packages.' }, calls), referenceTools: f.author.tools, referenceContext: f.author.context, referencePolicy: f.author.policy });
  assert.equal(calls.length, 5); assert.equal(result.usage.totalTokens, 75); assert.equal(result.addedSkillIds.length, 2); assert.equal(result.evaluationPerformed, false);
  assert.deepEqual(result.genome.tools, baseline.tools); assert.deepEqual(result.genome.evaluationSuite, baseline.evaluationSuite); assert.equal(result.genome.systemPrompt, baseline.systemPrompt);
  assert.equal(f.author.snapshot().coverage.every(row => row.status === 'selected'), true);
  const versions = new ProjectGenomeStore(f.store), prepared = await versions.prepare(f.project, { genome: result.genome, versionId: 'foundation-fixture' }); await prepared.commit();
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.activeVersionId = prepared.record.versionId; project.trialVersionId = null; project.versions = [{ id: prepared.record.versionId, bundle: prepared.record }]; project.assignments = { skillIds: prepared.skillManifests.map(row => row.id), toolIds: [], mcpServerIds: [] }; state.capabilities ??= { skills: [], tools: [], mcpServers: [], installations: [], revision: 0 }; state.capabilities.skills.push(...prepared.skillManifests); });
  const project = f.store.state.projects.find(row => row.id === f.project.id), capabilityService = new CapabilityService(f.store);
  const { registry } = await capabilityService.registry(project, [], { connectIds: [] });
  const resolved = await registry.resolve(project.assignments); await registry.close();
  const imported = prepared.skillManifests.filter(row => row.acquired); assert.equal(imported.length, 2); assert.ok(imported.every(row => !row.generated));
  for (const manifest of imported) assert.equal(resolved.skills.find(row => row.id === manifest.id).instructions, result.genome.skills.find(row => row.id === manifest.localId).instructions);
  const loadCalls = [], loads = imported.flatMap(row => [{ name: 'skill_load', arguments: { id: row.id } }, { name: 'skill_load', arguments: { id: row.id, path: row.localId === result.genome.skills.find(skill => skill.instructions === rawReport).id ? 'references/report.md' : 'references/method.md' } }]);
  const runtime = await createRnaRuntime({ project, capabilityService, cwd: project.workspace, stateDir: join(f.root, 'runtime'), sessionId: 'foundation-consumer', model, provider: scripted(loads.map(row => [row]), 'The requested original methods were read.', loadCalls), autoCompaction: false });
  try { await runtime.prompt('Inspect the two prepared packages and their documented resources.'); }
  finally { await runtime.dispose(); }
  const toolResults = loadCalls.at(-1).messages.filter(row => row.role === 'toolResult' && row.toolName === 'skill_load'); assert.equal(toolResults.length, 4); assert.ok(toolResults.every(row => !row.isError));
  const delivered = toolResults.map(row => JSON.parse(row.content[0].text)); assert.ok(delivered.some(row => row.content === rawReport)); assert.ok(delivered.some(row => row.content === extra['skills/report/references/report.md']));
  for (const skill of result.genome.skills.filter(row => row.source)) for (const file of skill.source.files) assert.equal(hash(await readFile(join(prepared.record.dir, 'skills', skill.id, file.path))), file.contentHash);
  assert.equal(f.store.state.capabilities.installations.length, 0); // Version activation, not installer execution.
});

test('missing plan and read-only source inspection cannot silently satisfy foundation', async t => {
  const { author, http } = await fixture(t);
  assert.equal((await search(author, 'research')).code, 'marketplace_plan_required'); assert.equal(http.calls.length, 0);
  assert.throws(() => author.policy.finalizeGenome(projectGenomeFixture()), { code: 'marketplace_research_incomplete' });
  await plan(author); assert.equal((await plan(author)).code, 'marketplace_plan_locked');
  await search(author, 'research'); assert.equal((await skip(author, 'research', 'incompatible')).code, 'marketplace_disposition_evidence');
  await read(author, 'research');
  assert.throws(() => author.policy.finalizeGenome(projectGenomeFixture()), { code: 'marketplace_research_incomplete' });
  assert.equal(author.snapshot().packages.length, 0);
});

test('one package associated with two areas remains one package', async t => {
  const { author } = await fixture(t); await plan(author); await search(author, 'research'); await read(author, 'research'); await acquire(author, 'research', ['research', 'report']);
  assert.equal(author.snapshot().coverage.every(row => row.status === 'selected'), true);
  assert.match(author.policy.beforeFinish({}).feedback[0].text, /at least two complementary/);
  assert.throws(() => author.policy.finalizeGenome(projectGenomeFixture()), { code: 'marketplace_research_incomplete' });
});

test('unsupported catalog rows cannot become empty discovery, and partial coverage preserves original evidence', async t => {
  const { author } = await fixture(t, { 'report structure': 'unsupported' }); await plan(author); await search(author, 'research'); await read(author, 'research'); await acquire(author, 'research');
  assert.equal((await skip(author, 'report', 'unavailable')).code, 'marketplace_disposition_evidence');
  const found = await search(author, 'report'); assert.equal(found.coverage.status, 'unsupported'); assert.equal(found.results.length, 0);
  assert.equal((await skip(author, 'report', 'no_results')).code, 'marketplace_disposition_evidence');
  assert.equal((await skip(author, 'report', 'incompatible')).code, 'marketplace_disposition_evidence');
  assert.equal((await skip(author, 'report', 'unavailable')).isError, false);
  const finalized = author.policy.finalizeGenome(projectGenomeFixture()), snap = author.snapshot();
  assert.equal(finalized.skills.filter(row => row.source).length, 1); assert.equal(snap.coverage.find(row => row.id === 'report').status, 'deferred');
  assert.equal(snap.searches.find(row => row.capabilityIds.includes('report')).coverage.status, 'unsupported'); assert.equal(snap.references.length, 1); assert.match(snap.references[0].content, /Read references\/method.md/);
});

test('real empty search can defer only its own area and cannot erase the fixed plan', async t => {
  const { author } = await fixture(t, { 'report structure': 'empty' }); await plan(author); await search(author, 'report');
  assert.equal((await skip(author, 'research', 'no_results')).code, 'marketplace_disposition_evidence');
  assert.equal((await skip(author, 'report', 'no_results')).isError, false);
  assert.throws(() => author.policy.finalizeGenome(projectGenomeFixture()), { code: 'marketplace_research_incomplete' });
  assert.deepEqual(author.snapshot().coverage.map(row => row.id), ['research', 'report']);
});

test('incompatibility requires an original read attributed to that capability, not another area', async t => {
  const { author } = await fixture(t); await plan(author); await search(author, 'research'); await read(author, 'research');
  assert.equal((await skip(author, 'report', 'incompatible')).code, 'marketplace_disposition_evidence');
  assert.equal((await skip(author, 'research', 'incompatible')).isError, false);
});

test('catalog and fallback failures are retained as unavailable, never as empty', async t => {
  const { author } = await fixture(t, { 'report structure': 'fail' }); await plan(author); assert.equal((await search(author, 'report')).code, 'marketplace_rate_limit');
  assert.equal((await skip(author, 'report', 'no_results')).code, 'marketplace_disposition_evidence');
  assert.equal((await skip(author, 'report', 'unavailable')).isError, false);
  const failures = author.snapshot().failures.filter(row => row.operation === 'marketplace_search'); assert.equal(failures.length, 2); assert.ok(failures.every(row => row.code === 'marketplace_rate_limit' && row.capabilityIds.includes('report')));
});

test('needs_user_selection is only valid when new acquisition is explicitly disabled', async t => {
  const f = await fixture(t); await plan(f.author); assert.equal((await skip(f.author, 'report', 'needs_user_selection')).code, 'marketplace_disposition_evidence');
  const restricted = f.service.authoring(f.project.id, { purpose: 'foundation', allowAcquisition: false }); await plan(restricted);
  assert.equal((await skip(restricted, 'report', 'needs_user_selection')).isError, false); assert.equal(restricted.snapshot().searches.length, 0);
});

test('multiple existing verified source packages close foundation without a new network request', async t => {
  const f = await fixture(t); await acquireBoth(f.author); const baseline = f.author.policy.finalizeGenome(projectGenomeFixture()), before = f.http.calls.length;
  const next = f.service.authoring(f.project.id, { purpose: 'foundation', baseline }); await plan(next);
  for (const [index, skill] of baseline.skills.filter(row => row.source).entries()) assert.equal((await call(next, 'marketplace_reuse', { existingSkillId: skill.id, capabilityIds: [areas[index].id], reason: 'The frozen existing source directly covers this complementary capability.' })).isError, false);
  assert.equal(next.policy.beforeFinish({}), undefined); assert.deepEqual(next.policy.finalizeGenome(projectGenomeFixture()), baseline); assert.equal(f.http.calls.length, before); assert.equal(next.snapshot().reused.length, 2);
});

test('SDK no_change cannot bypass an unplanned foundation even at the reserved final request', async t => {
  const f = await fixture(t), calls = [];
  await assert.rejects(proposeProjectGenome({ project: { id: f.project.id }, baseline: projectGenomeFixture(), evidence: [], allowAbstention: true, model, provider: scripted([], noChange, calls), referenceTools: f.author.tools, referenceContext: f.author.context, referencePolicy: f.author.policy }), error => error.code === 'reference_no_change_incomplete' && error.requests.length === 6 && error.usage.totalTokens === 90);
  assert.equal(calls.length, 6); assert.equal(f.http.calls.length, 0);
});

test('SDK no_change cannot swallow newly acquired unpublished packages', async t => {
  const f = await fixture(t), calls = []; await acquireBoth(f.author);
  await assert.rejects(proposeProjectGenome({ project: { id: f.project.id }, baseline: projectGenomeFixture(), evidence: [], allowAbstention: true, model, provider: scripted([], noChange, calls), referenceTools: f.author.tools, referenceContext: f.author.context, referencePolicy: f.author.policy }), error => error.code === 'reference_no_change_incomplete' && error.referenceDiscovery.counts.packages === 2);
  assert.equal(calls.length, 6); assert.equal(f.author.snapshot().packages.every(row => row.installed === false), true);
});

test('ordinary no_change with a mature retained baseline requires neither shopping nor an extra request', async t => {
  const f = await fixture(t); await acquireBoth(f.author); const baseline = f.author.policy.finalizeGenome(projectGenomeFixture()), before = f.http.calls.length, calls = [];
  const author = f.service.authoring(f.project.id, { baseline });
  const result = await proposeProjectGenome({ project: { id: f.project.id }, baseline, evidence: [], allowAbstention: true, model, provider: scripted([], noChange, calls), referenceTools: author.tools, referenceContext: author.context, referencePolicy: author.policy });
  assert.equal(result.status, 'no_change'); assert.equal(result.validation, null); assert.equal(calls.length, 1); assert.equal(f.http.calls.length, before); assert.deepEqual(baseline.skills, f.author.policy.finalizeGenome(projectGenomeFixture()).skills);
});

test('the same original source under marketplace and installed identities must not count as two complementary packages', async t => {
  const f = await fixture(t); await acquireBoth(f.author); const original = f.author.policy.finalizeGenome(projectGenomeFixture()).skills.find(row => row.source), alias = structuredClone(original);
  alias.id = 'installed_duplicate_snapshot'; alias.source = { kind: 'installed-skill-package', integrity: 'installed_snapshot', installationId: 'local-installation', manifestId: 'external-method', installationRecordHash: 'b'.repeat(64), repository: `https://github.com/${original.source.repository}.git`, commit: original.source.commit, subdirectory: original.source.subdirectory, packageHash: original.source.packageHash, frozenAt: new Date().toISOString(), reason: 'The same acquired package was also previously installed.', compatibility: 'The same original bytes and pinned source; this is not a second method.', licenseReview: original.source.licenseReview, licensePaths: original.source.licensePaths, files: original.source.files };
  const baseline = projectGenomeFixture(); baseline.skills.push(original, alias);
  const author = f.service.authoring(f.project.id, { purpose: 'foundation', baseline }); await plan(author);
  for (const [index, skill] of [original, alias].entries()) await call(author, 'marketplace_reuse', { existingSkillId: skill.id, capabilityIds: [areas[index].id], reason: 'The existing source package is reused in this requested capability.' });
  assert.ok(author.policy.beforeFinish({})?.feedback?.length, 'Two IDs for the same source must not satisfy the two-package requirement');
  assert.throws(() => author.policy.finalizeGenome(baseline), { code: 'marketplace_research_incomplete' });
});

test('foundation readiness uses recorded domain coverage; empty reuse catalog is unavailable and ordinary chat description is unchanged',async t=>{
 const f=await fixture(t);assert.equal(f.author.tools.some(r=>r.name==='marketplace_reuse'),false);assert.match(f.author.tools.find(r=>r.name==='marketplace_read').description,/marketplace_acquire/);assert.doesNotMatch(f.author.tools.find(r=>r.name==='marketplace_read').description,/Installing needs the original authorization flow of capability_install/);assert.match(f.service.tools(f.project.id).find(r=>r.name==='marketplace_read').description,/Installing needs the original authorization flow of capability_install/);
 assert.equal(f.author.policy.researchReadiness({}).allowOneCorrection,false);await plan(f.author);assert.deepEqual(f.author.policy.researchReadiness({}).pendingCapabilityIds,['research','report']);assert.equal(f.author.policy.researchReadiness({}).allowOneCorrection,false);
 await search(f.author,'research');assert.equal(f.author.policy.researchReadiness({}).allowOneCorrection,true);await read(f.author,'research');await acquire(f.author,'research');assert.deepEqual(f.author.policy.researchReadiness({}).pendingCapabilityIds,['report']);await search(f.author,'report');await read(f.author,'report');await acquire(f.author,'report');assert.deepEqual(f.author.policy.researchReadiness({}),{ready:true});assert.equal(f.author.snapshot().coverage.some(r=>r.status==='deferred'),false);
});
test('staged bootstrap resolves an actual source-tool failure in one corrective batch before artifact generation',async t=>{
 const {bootstrapProject}=await import('../../../packages/sdk/src/bootstrap.mjs');
 for(const corrected of [true,false]){
 const f=await fixture(t),calls=[],events=[];const sequence=selectionSequence();sequence[3]=[{name:'marketplace_acquire',arguments:choice('research')}];sequence.push([{name:'marketplace_acquire',arguments:{...choice('report'),id:'fixture/skills/not-read'}}]);sequence.push([{name:'marketplace_acquire',arguments:corrected?choice('report'):{...choice('report'),id:'fixture/skills/still-not-read'}}]);
 const final={overview:'Research foundation',focus:'Accurate source checking and structured delivery',facts:[],openQuestions:[],milestones:[],assignments:{skillIds:[],toolIds:[],mcpServerIds:[],reasons:[]},unmetCapabilities:[],genome:projectGenomeFixture()};
 const author=f.service.authoring(f.project.id,{purpose:'initialization',baseline:projectGenomeFixture()});const run=()=>bootstrapProject({title:f.project.name,model,provider:scripted(sequence,final,calls),referenceTools:author.tools,referenceContext:author.context,referencePolicy:author.policy,maxAttempts:3,onEvent:e=>events.push(e)});
 if(corrected){const result=await run();assert.equal(calls.length,7);assert.equal(result.usage.totalTokens,105);assert.equal(result.genome.skills.filter(r=>r.source).length,2);assert.deepEqual(author.policy.researchReadiness({}),{ready:true});}else{await assert.rejects(run(),e=>e.code==='reference_research_incomplete'&&e.usage.totalTokens===90);assert.equal(calls.length,6);assert.equal(events.some(r=>r.stage==='artifact'),false);assert.deepEqual(author.policy.researchReadiness({}).pendingCapabilityIds,['report']);assert.equal(author.snapshot().coverage.find(r=>r.id==='report').status,'pending');}
 assert.equal(author.snapshot().failures[0].code,'marketplace_read_required');assert.equal(author.snapshot().packages.every(r=>r.installed===false),true);
 }
});
