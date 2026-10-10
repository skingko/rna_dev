import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 1024 };
const originalId = 'external-method', installationId = 'installation-fixture';
const instructions = '---\nname: Installed original method\ndescription: The user assigned this installed source method.\n---\nPRIVATE_ORIGINAL_METHOD_BODY: preserve source boundaries.\n';
const resource = 'PRIVATE_ORIGINAL_RESOURCE: read the complete original evidence.\n';
const toolsCalled = messages => messages.filter(row => row.role === 'toolResult' && row.toolName === 'skill_load');
const catalog = request => request.messages.findLast(row => row.contextKey === 'skill-catalog')?.content.map(row => row.text ?? '').join('') ?? '';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rna-import-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); await mkdir(workspace); const originalDir = join(root, 'installed'); await mkdir(originalDir); await writeFile(join(originalDir, 'SKILL.md'), instructions);
  const store = new Store(join(root, 'state.json')), project = store.createProject({ name: 'Installed source authorization', workspace }).project;
  const resources = [{ path: 'references/source.md', content: resource }, { path: '@license/LICENSE', content: 'Fixture license preserved.\n' }];
  const files = [{ path: 'SKILL.md', content: instructions }, ...resources].map(({ path, content }) => ({ path, contentHash: hash(content), bytes: Buffer.byteLength(content) }));
  const source = { kind: 'installed-skill-package', integrity: 'installed_snapshot', installationId, manifestId: originalId, installationRecordHash: 'a'.repeat(64), repository: 'https://github.com/fixture/source.git', commit: 'b'.repeat(40), subdirectory: 'method', packageHash: hash(JSON.stringify(files)), frozenAt: '2026-09-28T00:00:00.000Z', reason: 'Preserve the currently assigned and authorized original source method.', compatibility: 'This installed snapshot grants no new permissions and executes no code.', licenseReview: 'preserved_not_legal_approval', licensePaths: ['@license/LICENSE'], files };
  const genome = projectGenomeFixture(); genome.skills.push({ id: 'installed_method', name: 'Installed original method', description: 'The frozen original method assigned to this project.', instructions, resources, source });
  const prepared = await new ProjectGenomeStore(store).prepare(project, { genome, versionId: 'frozen-foundation' }); await prepared.commit();
  const imported = prepared.skillManifests.find(row => row.localId === 'installed_method'), ordinary = prepared.skillManifests.find(row => row.localId === 'evidence_review');
  const original = { id: originalId, name: 'Installed original method', description: 'The original externally installed source method.', path: join(originalDir, 'SKILL.md'), installationId, enabled: true, trusted: true };
  store.mutate(state => { state.capabilities = { skills: [original, ...prepared.skillManifests], tools: [], mcpServers: [], revision: 1, installations: [{ installationId, status: 'installed', entries: [{ kind: 'skills', id: originalId }] }] }; const current = state.projects.find(row => row.id === project.id); Object.assign(current, { activeVersionId: prepared.record.versionId, trialVersionId: null, versions: [{ id: prepared.record.versionId, bundle: prepared.record }], assignments: { skillIds: [originalId, ...prepared.skillManifests.map(row => row.id)], toolIds: [], mcpServerIds: [] } }); });
  const getProject = () => store.state.projects.find(row => row.id === project.id), capabilityService = new CapabilityService(store), handles = [];
  t.after(async () => { for (const handle of handles) await handle.dispose(); await capabilityService.close(); });
  return { root, workspace, store, imported, ordinary, source, getProject, capabilityService, mutate: fn => store.mutate(state => fn(state, state.projects.find(row => row.id === project.id))), create: async options => { const runtime = await createRnaRuntime({ project: getProject(), getProject, capabilityService, cwd: workspace, stateDir: join(root, `runtime-${handles.length}`), sessionId: `source-session-${handles.length}`, model, autoCompaction: false, ...options }); handles.push(runtime); return runtime; } };
}
function providerFor(sequence, calls = [], before = () => {}) { return async function* (request) {
  const index = calls.length; calls.push(request); before(index, request);
  if (sequence[index]) yield { type: 'tool_call', id: `read-${index}`, name: 'skill_load', arguments: sequence[index] };
  else yield { type: 'text_delta', delta: 'Source access was checked.' };
  yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: sequence[index] ? 'toolUse' : 'stop' };
}; }

for (const permissionScope of ['foreground', 'background']) test(`authorized frozen copy replaces external catalog entry and delivers original bytes: ${permissionScope}`, async t => {
  const f = await fixture(t), calls = [], runtime = await f.create({ permissionScope, readOnly: true, provider: providerFor([{ id: f.imported.id }, { id: f.imported.id, path: 'references/source.md' }, { id: originalId }], calls) });
  const before = runtime.snapshot().assignedCapabilities.skillIds; assert.ok(before.includes(f.imported.id)); assert.ok(before.includes(f.ordinary.id)); assert.ok(!before.includes(originalId));
  await runtime.prompt('Read the assigned original method and its resource.');
  const results = toolsCalled(calls.at(-1).messages); assert.equal(results.length, 3); assert.equal(results[0].isError, false); assert.equal(results[1].isError, false); assert.equal(results[2].isError, true);
  assert.equal(JSON.parse(results[0].content[0].text).content, instructions); assert.equal(JSON.parse(results[1].content[0].text).content, resource);
  const first = JSON.stringify(calls[0].messages); assert.ok(first.includes(f.imported.id)); assert.ok(!first.includes(`"id":"${originalId}"`)); assert.ok(!first.includes('PRIVATE_ORIGINAL_METHOD_BODY'));
});

const revocations = {
  disabled: state => { state.capabilities.skills.find(row => row.id === originalId).enabled = false; },
  untrusted: state => { state.capabilities.skills.find(row => row.id === originalId).trusted = false; },
  unassigned: (_state, project) => { project.assignments.skillIds = project.assignments.skillIds.filter(id => id !== originalId); },
  missing_manifest: state => { state.capabilities.skills = state.capabilities.skills.filter(row => row.id !== originalId); },
  changed_installation: state => { state.capabilities.skills.find(row => row.id === originalId).installationId = 'replacement-installation'; },
  missing_receipt: state => { state.capabilities.installations = []; },
  removed_receipt: state => { state.capabilities.installations[0].status = 'removed'; },
  mismatched_entry: state => { state.capabilities.installations[0].entries[0].id = 'different-method'; },
  duplicate_receipt: state => { state.capabilities.installations.push(structuredClone(state.capabilities.installations[0])); },
};
for (const [reason, revoke] of Object.entries(revocations)) test(`invalid original authorization hides both source identities without blocking ordinary skills: ${reason}`, async t => {
  const f = await fixture(t); f.mutate(revoke); const calls = [], runtime = await f.create({ provider: providerFor([{ id: f.imported.id }], calls) });
  const ids = runtime.snapshot().assignedCapabilities.skillIds; assert.ok(!ids.includes(originalId)); assert.ok(!ids.includes(f.imported.id)); assert.ok(ids.includes(f.ordinary.id));
  await runtime.prompt('Check access to the source method.'); const result = toolsCalled(calls.at(-1).messages)[0]; assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('PRIVATE_ORIGINAL'));
});

test('source authorization is rechecked for an already exposed tool and refreshed at the next request boundary', async t => {
  const f = await fixture(t), calls = [];
  const runtime = await f.create({ provider: providerFor([{ id: f.imported.id, path: 'references/source.md' }], calls, index => { if (index === 0) f.mutate(revocations.disabled); }) });
  assert.ok(runtime.snapshot().assignedCapabilities.skillIds.includes(f.imported.id)); await runtime.prompt('Inspect the source resource.');
  const result = toolsCalled(calls.at(-1).messages)[0]; assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('PRIVATE_ORIGINAL_RESOURCE'));
  assert.ok(!runtime.snapshot().assignedCapabilities.skillIds.includes(f.imported.id)); assert.ok(!catalog(calls.at(-1)).includes(f.imported.id));
});

test('revocation observed after asynchronous file reads suppresses the result body', async t => {
  const f = await fixture(t), calls = [], configuration = f.capabilityService.configuration.bind(f.capabilityService); let armed = false, authorizationReads = 0;
  // Arm only after request construction. The first configuration read belongs
  // to skill_load admission; the next is its post-read authorization check.
  f.capabilityService.configuration = () => { if (armed && ++authorizationReads === 2) f.mutate(revocations.untrusted); return configuration(); };
  const runtime = await f.create({ provider: providerFor([{ id: f.imported.id, path: 'references/source.md' }], calls, index => { if (index === 0) armed = true; }) });
  await runtime.prompt('Read the original resource if its authorization is still valid.');
  assert.ok(authorizationReads >= 2); const result = toolsCalled(calls.at(-1).messages)[0];
  assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('PRIVATE_ORIGINAL_RESOURCE')); assert.match(JSON.stringify(result), /the frozen skill content was not returned/);
});

test('standalone runtime cannot authorize an installed snapshot without the host installation registry', async t => {
  const f = await fixture(t), calls = [], runtime = await f.create({ capabilityService: undefined, provider: providerFor([{ id: f.imported.id }], calls) });
  const ids = runtime.snapshot().assignedCapabilities.skillIds; assert.ok(!ids.includes(f.imported.id)); assert.ok(!ids.includes(originalId)); assert.ok(ids.includes(f.ordinary.id));
  await runtime.prompt('Check the current method.'); assert.equal(toolsCalled(calls.at(-1).messages)[0].isError, true);
});

test('restored original assignment re-enables only the pinned copy at a later request boundary', async t => {
  const f = await fixture(t), calls = []; f.mutate(revocations.unassigned);
  const runtime = await f.create({ provider: providerFor([], calls) }); await runtime.prompt('First status check.'); assert.ok(!runtime.snapshot().assignedCapabilities.skillIds.includes(f.imported.id));
  f.mutate((_state, project) => { project.assignments.skillIds.push(originalId); }); await runtime.prompt('Second status check.');
  assert.ok(runtime.snapshot().assignedCapabilities.skillIds.includes(f.imported.id)); assert.ok(!runtime.snapshot().assignedCapabilities.skillIds.includes(originalId)); assert.equal(calls[0].systemPrompt, calls[1].systemPrompt);
});
