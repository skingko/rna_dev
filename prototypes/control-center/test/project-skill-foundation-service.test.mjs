import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectSkillFoundationService, foundationDue } from '../project-skill-foundation-service.mjs';
import { freezeAssignedInstalledSkills } from '../installed-skill-freeze.mjs';
import { SkillMarketplaceService } from '../skill-marketplace-service.mjs';
import { CapabilityInstaller } from '../../../packages/sdk/src/capability-installation.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { SkillMarketplaceClient } from '../../../packages/sdk/src/skill-marketplaces.mjs';
import { marketplaceFixture } from '../../../packages/sdk/test/fixtures/skill-marketplace.mjs';
import { readStateFile } from '../state-shards.mjs';
import { prepareProjectSkillFoundation } from '../../../packages/sdk/src/project-skill-foundation.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 1024 };
const now = Date.parse('2026-09-28T05:00:00Z');
async function fixture(t, { installedCount = 2 } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rna-foundation-service-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')), { project, session } = store.createProject({ name: 'Foundation fixture', workspace: dir });
  const genomes = new ProjectGenomeStore(store), baseline = projectGenomeFixture(), original = await genomes.prepare(project, { genome: baseline, versionId: 'baseline-one' }); await original.commit();
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { simulated: false, initialization: { status: 'ready' }, activeVersionId: 'baseline-one', versions: [{ id: 'baseline-one', state: 'baseline', bundle: original.record, generatedSkills: original.skillManifests, generatedTools: original.toolDescriptors }], assignments: { skillIds: original.skillManifests.map(row => row.id), toolIds: original.toolDescriptors.map(row => row.id), mcpServerIds: [], reasons: [] } }); state.capabilities ??= { skills: [], tools: [], mcpServers: [], installations: [], revision: 0 }; state.capabilities.skills.push(...original.skillManifests); });
  const repository = join(dir, 'source'); await mkdir(repository); await writeFile(join(repository, 'LICENSE'), 'Fixture license.\n');
  for (let i = 0; i < installedCount; i++) { const source = join(repository, `method${i}`); await mkdir(source); await writeFile(join(source, 'SKILL.md'), `---\nname: method${i}\ndescription: Reusable capability area ${i}\n---\nDocument the real method for ${i}.`); await writeFile(join(source, 'resource.txt'), `Method ${i} resource`); }
  const git = args => execFileSync('git', args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']); const commit = git(['rev-parse', 'HEAD']);
  const installer = new CapabilityInstaller({ rootDir: `${store.file}.capabilities` });
  for (let i = 0; i < installedCount; i++) {
    const prepared = await installer.prepare({ kind: 'skill', id: `external-${i}`, source: { type: 'git', repository, ref: commit, subdirectory: `method${i}` }, activate: true }, { installationId: `install-${i}` }); await prepared.commit();
    store.mutate(state => { const p = state.projects.find(row => row.id === project.id), manifest = { ...prepared.manifests[0].manifest, installationId: prepared.installationId }; delete manifest.contentHash; state.capabilities.skills.push(manifest); state.capabilities.installations.push({ installationId: prepared.installationId, status: 'installed', projectId: p.id, activated: true, installationDir: prepared.installationDir, entries: [{ kind: 'skills', id: manifest.id }], sources: prepared.sources }); p.assignments.skillIds.push(manifest.id); });
  }
  const f = { dir, store, projectId: project.id, sessionId: session.id, genomes, baseline, original, calls: [], get project() { return store.state.projects.find(row => row.id === project.id); } };
  f.frozen = await freezeAssignedInstalledSkills(store, f.project);
  f.service = new ProjectSkillFoundationService(store, { genomeStore: genomes, prepare: prepareProjectSkillFoundation, now: () => now });
  return f;
}
function provider(f, { deferred = false, onRequest, error = false, unknownUsage = false } = {}) {
  return async function* (request) {
    f.calls.push(request); const n = f.calls.length; await onRequest?.(n, request);
    if (error) { if (!unknownUsage) yield { type: 'usage', usage: { totalTokens: 17 } }; throw Object.assign(new Error('PRIVATE_MODEL_ERROR_OR_SECRET'), { code: 'connection' }); }
    const tools = n === 1 ? [{ name: 'marketplace_plan', arguments: { capabilities: [0, 1].map(i => ({ id: `area${i}`, description: `Complementary project capability number ${i}`, query: `public method ${i}` })) } }] : n === 2 ? [0, 1].map(i => deferred && i === 1 ? { name: 'marketplace_skip', arguments: { capabilityIds: ['area1'], reasonCode: 'needs_user_selection', reason: 'Existing packages do not cover this separate requirement; no additional selection is authorized in this run.' } } : { name: 'marketplace_reuse', arguments: { existingSkillId: f.frozen.skills[i % f.frozen.skills.length].id, capabilityIds: [`area${i}`], reason: 'This installed source documents the relevant reusable method for this concrete capability area.' } }) : null;
    if (tools) for (const [i, call] of tools.entries()) yield { type: 'tool_call', id: `call-${n}-${i}`, ...call };
    else yield { type: 'text_delta', delta: JSON.stringify({ summary: 'Only the source receipts and remaining coverage limits are recorded.' }) };
    if (!unknownUsage) { yield { type: 'usage', usage: { totalTokens: 12 } }; yield { type: 'usage', usage: { totalTokens: 30 } }; }
    yield { type: 'done', stopReason: tools ? 'toolUse' : 'stop' };
  };
}
const run = (f, options = {}) => f.service.run(f.project, { model, apiKey: 'PRIVATE_FIXTURE_KEY', provider: provider(f), ...options });

test('real installed packages flow through SDK planning and host policy into one immutable foundation without rewriting the old baseline', async t => {
  const f = await fixture(t), prior = structuredClone(f.project.versions[0]);
  const result = await run(f);
  assert.equal(result.status, 'ready'); assert.equal(result.added, true); assert.equal(f.calls.length, 3); assert.equal(f.project.skillFoundation.sourceCount, 2);
  assert.equal(f.project.versions.length, 2); assert.deepEqual(f.project.versions[0], prior); assert.equal(f.project.initialization.status, 'ready');
  const active = f.project.versions.at(-1), stored = await f.genomes.read(f.project.id, active.id);
  assert.equal(active.state, 'active'); assert.equal(active.source, 'skill-foundation'); assert.equal(active.evaluation, null); assert.equal(active.qualityClaim, 'none'); assert.equal(active.adoptedAt, undefined);
  assert.deepEqual({ ...stored.genome, skills: [] }, { ...f.baseline, skills: [] }); assert.deepEqual(stored.genome.skills[0], f.baseline.skills[0]);
  for (const id of ['external-0', 'external-1']) assert.ok(f.project.assignments.skillIds.includes(id));
  // EVO-3: the kept baseline skill keeps its name in the new version; the registry holds one manifest per id, the new version's.
  for (const skill of f.original.skillManifests) {
    assert.equal(f.project.assignments.skillIds.filter(id => id === skill.id).length, 1, 'assigned once, under the same name');
    const rows = f.store.state.capabilities.skills.filter(row => row.id === skill.id); assert.equal(rows.length, 1); assert.equal(rows[0].versionId, active.id);
  }
  assert.equal(f.store.state.realUsage.reportedTokens, 90); assert.equal(f.store.state.realUsage.reservedTokens, 0); assert.equal(f.project.skillFoundation.usage.totalTokens, 90);
  assert.equal(f.project.skillFoundation.requests.length, 3); assert.ok(f.project.skillFoundation.requests.every(row => row.settled));
  assert.equal(f.project.skillFoundation.referenceDiscovery.searches, 0); assert.equal(f.project.skillFoundation.referenceDiscovery.packages.length, 0);
  assert.equal(f.project.skillFoundation.acquisitionPolicy, 'automatic'); assert.equal(JSON.parse(f.calls[0].messages[0].content[0].text).project.skillFoundation.acquisitionPolicy, 'automatic');
  assert.equal(JSON.stringify(JSON.parse(await readFile(join(active.artifactDir, 'inputs.json'), 'utf8'))).includes('PRIVATE_FIXTURE_KEY'), false);
  const priorCalls = f.calls.length; const replay = await run(f); assert.equal(replay.replayed, true); assert.equal(f.calls.length, priorCalls); assert.equal(f.project.versions.length, 2);
});

test('a foundation publication refuses a row of the same id that is not this project\'s own managed manifest', async t => {
  const f = await fixture(t);
  f.store.mutate(state => { state.capabilities.skills = state.capabilities.skills.map(row => f.original.skillManifests.some(skill => skill.id === row.id) ? { ...row, projectId: 'another-project' } : row); });
  const result = await run(f).catch(error => error);
  assert.equal(result.code ?? f.project.skillFoundation.code, 'foundation_version_conflict'); assert.equal(f.project.versions.length, 1, 'nothing published');
});

test('partial coverage is retained as a partial foundation, not a failed evaluation or a periodic shopping trigger', async t => {
  const f = await fixture(t); f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).skillFoundation = { acquisitionPolicy: 'reuse_only' }; });
  const result = await run(f, { provider: provider(f, { deferred: true }) });
  assert.equal(result.status, 'partial'); assert.equal(result.added, true); assert.equal(f.project.skillFoundation.coverage[1].status, 'deferred');
  assert.equal(result.foundation.acquisitionPolicy, 'reuse_only'); assert.equal(f.project.skillFoundation.acquisitionPolicy, 'reuse_only');
  assert.equal(foundationDue(f.project, f.store.state, { now: now + 86400000 }), false);
});

test('explicit recheck with unchanged sources does not publish an empty duplicate version', async t => {
  const f = await fixture(t); await run(f); const active = f.project.activeVersionId; f.calls.length = 0;
  const result = await run(f, { explicitRetry: true }); assert.equal(result.status, 'ready'); assert.equal(result.added, false); assert.equal(f.project.activeVersionId, active); assert.equal(f.project.versions.length, 2);
});

test('foreground activity preempts preparation without blocking chat or counting a provider failure', async t => {
  const f = await fixture(t), baselineId = f.project.activeVersionId;
  const result = await run(f, { provider: provider(f, { onRequest: n => { if (n === 1) f.store.mutate(state => { state.sessions.find(row => row.id === f.sessionId).activeTurnId = 'foreground-arrived'; }); } }) });
  assert.equal(result.status, 'stale'); assert.equal(f.project.activeVersionId, baselineId); assert.equal(f.project.versions.length, 1); assert.equal(f.project.initialization.status, 'ready');
  assert.equal(f.project.skillFoundation.failureCount, 0); assert.equal(f.project.skillFoundation.nextRetryAt, now + 3600000); assert.equal(f.store.state.realUsage.reservedTokens, 0);
});

test('provider failure retains usage and source artifacts, backs off six hours, and never retries inside run', async t => {
  const f = await fixture(t), result = await run(f, { provider: provider(f, { error: true }) });
  assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 1); assert.equal(f.project.skillFoundation.failureCount, 1); assert.equal(f.project.skillFoundation.nextRetryAt, now + 21600000);
  assert.equal(f.store.state.realUsage.reportedTokens, 17); assert.equal(f.store.state.realUsage.reservedTokens, 0); assert.equal(f.project.versions.length, 1);
  assert.equal(foundationDue(f.project, f.store.state, { now }), false); assert.equal(foundationDue(f.project, f.store.state, { now: now + 21600000 }), true);
  const body = await readFile(join(f.project.skillFoundation.artifactDir, 'failure.json'), 'utf8'); assert.doesNotMatch(body, /PRIVATE_MODEL_ERROR_OR_SECRET|PRIVATE_FIXTURE_KEY/);
});

test('unknown provider usage charges the one dispatched reservation, while denied admission dispatches nothing', async t => {
  const f = await fixture(t), result = await run(f, { provider: provider(f, { error: true, unknownUsage: true }) });
  assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 1); assert.ok(f.store.state.realUsage.estimatedTokens > 1024); assert.equal(f.store.state.realUsage.reservedTokens, 0);
  f.store.mutate(state => { state.settings.realTokenBudget = 1; }); f.calls.length = 0;
  const denied = await run(f, { explicitRetry: true }); assert.equal(denied.status, 'failed'); assert.equal(f.calls.length, 0); assert.equal(f.store.state.realUsage.reservedTokens, 0);
});

test('a new assignment after model completion prevents publication of stale frozen sources', async t => {
  const f = await fixture(t);
  const result = await run(f, { provider: provider(f, { onRequest: n => { if (n === 3) f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).assignments.skillIds = state.projects.find(row => row.id === f.projectId).assignments.skillIds.filter(id => id !== 'external-0'); }); } }) });
  assert.equal(result.status, 'stale'); assert.equal(f.project.versions.length, 1); assert.equal(f.store.state.realUsage.reportedTokens, 90);
});

test('a current installed resource change after selection invalidates the frozen input before activation', async t => {
  const f = await fixture(t);
  const result = await run(f, { provider: provider(f, { onRequest: async n => { if (n === 3) await writeFile(join(`${f.store.file}.capabilities`, 'install-0', 'skill', 'resource.txt'), 'changed after author snapshot'); } }) });
  assert.equal(result.status, 'stale'); assert.equal(f.project.versions.length, 1); assert.equal(f.project.skillFoundation.failureCount, 0);
});

test('host independently rejects a custom preparer changing the charter or inventing a source', async t => {
  const f = await fixture(t), result = await run(f, { prepare: async ({ baseline }) => ({ genome: { ...baseline, systemPrompt: 'invented change' } }) });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'foundation_behavior_changed'); assert.equal(f.project.versions.length, 1);
});

test('concurrent operation, trial and existing evolution publication defer without model requests', async t => {
  const f = await fixture(t);
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).trialVersionId = 'trial'; });
  assert.equal((await run(f)).status, 'deferred'); assert.equal(f.calls.length, 0);
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.projectId); p.trialVersionId = null; p.evolution.request = { status: 'queued' }; });
  assert.equal((await run(f)).status, 'deferred'); assert.equal(f.calls.length, 0);
});

function publicationSyncFailure(f, { afterRename }) {
  const persist = f.store.persist.bind(f.store), sync = fs.fsyncSync; let publishing = false, injected = false;
  f.store.persist = next => { publishing = next.projects.some(p => p.versions.some(v => v.source === 'skill-foundation')); try { return persist(next); } finally { publishing = false; } };
  fs.fsyncSync = fd => { if (publishing && !injected && fs.fstatSync(fd).isDirectory() === afterRename && (!afterRename || fs.fstatSync(fd).ino === fs.statSync(f.store.file.slice(0, f.store.file.lastIndexOf('/'))).ino)) { injected = true; throw Object.assign(new Error('private fsync diagnostic'), { code: 'EIO' }); } return sync(fd); }; syncBuiltinESMExports();
  return { get injected() { return injected; }, restore() { fs.fsyncSync = sync; syncBuiltinESMExports(); f.store.persist = persist; } };
}

test('post-rename directory sync failure retains the exact published generation rather than rolling it back', async t => {
  const f = await fixture(t), fault = publicationSyncFailure(f, { afterRename: true }); let error;
  try { await run(f); } catch (failure) { error = failure; } finally { fault.restore(); }
  assert.equal(fault.injected, true); assert.equal(error?.code, 'foundation_durability_unknown'); assert.equal(f.project.versions.length, 2);
  const active = await f.genomes.read(f.projectId, f.project.activeVersionId); assert.equal(active.hash, f.project.versions.at(-1).bundle.hash); assert.equal(f.service.running.size, 0);
});

test('pre-rename state failure rolls back only the unpublished generation and preserves the old version', async t => {
  const f = await fixture(t), fault = publicationSyncFailure(f, { afterRename: false }); let result;
  try { result = await run(f); } finally { fault.restore(); }
  assert.equal(fault.injected, true); assert.equal(result.status, 'failed'); assert.equal(f.project.versions.length, 1); assert.equal(f.project.activeVersionId, 'baseline-one');
  assert.deepEqual(await readdir(join(f.genomes.rootDir, f.projectId)), ['baseline-one']); assert.equal((await f.genomes.read(f.projectId, 'baseline-one')).hash, f.original.record.hash);
});

test('an unproven committed flag cannot retain a generation absent from the authoritative project state', async t => {
  const f = await fixture(t), mutate = f.store.mutate.bind(f.store); let injected = false;
  f.store.mutate = callback => mutate(state => { const result = callback(state); if (!injected && state.projects.some(p => p.versions.some(v => v.source === 'skill-foundation'))) { injected = true; throw Object.assign(new Error('not actually committed'), { code: 'EIO', committed: true }); } return result; });
  const result = await run(f); assert.equal(injected, true); assert.equal(result.status, 'failed'); assert.equal(f.project.versions.length, 1); assert.deepEqual(await readdir(join(f.genomes.rootDir, f.projectId)), ['baseline-one']);
});

test('failure retry cap and stale wake boundaries do not convert quiet projects into perpetual preparation', async t => {
  const f = await fixture(t);
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).skillFoundation = { status: 'failed', failureCount: 3, nextRetryAt: now - 1 }; });
  assert.equal(foundationDue(f.project, f.store.state, { now }), false); assert.equal((await run(f)).status, 'deferred'); assert.equal(f.calls.length, 0);
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).skillFoundation = { status: 'stale', failureCount: 0, nextRetryAt: now + 3600000 }; });
  assert.equal(foundationDue(f.project, f.store.state, { now }), false); assert.equal(foundationDue(f.project, f.store.state, { now: now + 3600000 }), true);
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).skillFoundation.status = 'preparing'; });
  assert.equal(foundationDue(f.project, f.store.state, { now: now + 86400000 }), false);
});

function settlementSyncFailure(f, { afterRename, requestIndex = 1 }) {
  const persist = f.store.persist.bind(f.store), sync = fs.fsyncSync; let settling = false, injected = false, attempts = 0;
  f.store.persist = next => {
    settling = next.projects.some(project => project.skillFoundation?.requests?.some(row => row.requestIndex === requestIndex && row.settled));
    if (settling) attempts++;
    try { return persist(next); } finally { settling = false; }
  };
  fs.fsyncSync = fd => { if (settling && !injected && fs.fstatSync(fd).isDirectory() === afterRename && (!afterRename || fs.fstatSync(fd).ino === fs.statSync(f.store.file.slice(0, f.store.file.lastIndexOf('/'))).ino)) { injected = true; throw Object.assign(new Error('PRIVATE_SETTLEMENT_PATH_MUST_NOT_ESCAPE'), { code: 'EIO' }); } return sync(fd); }; syncBuiltinESMExports();
  return { get injected() { return injected; }, get attempts() { return attempts; }, restore() { fs.fsyncSync = sync; syncBuiltinESMExports(); f.store.persist = persist; } };
}

for (const afterRename of [false, true]) for (const requestIndex of [1, 2]) test(`provider observations survive request ${requestIndex} settlement fsync failure ${afterRename ? 'after' : 'before'} rename without duplicate charging`, async t => {
  const f = await fixture(t), fault = settlementSyncFailure(f, { afterRename, requestIndex }); let result;
  try { result = await run(f); } finally { fault.restore(); }
  assert.equal(fault.injected, true); assert.equal(fault.attempts, 1); assert.equal(result.status, 'failed'); assert.equal(f.calls.length, requestIndex);
  assert.equal(result.foundation.usage.totalTokens, requestIndex * 30); assert.equal(result.foundation.usage.reportedTokens, requestIndex * 30); assert.equal(result.foundation.usage.estimatedTokens, 0);
  const observed = result.foundation.requests.at(-1); assert.equal(observed.observationRecorded, true); assert.equal(observed.usageReported, true); assert.equal(observed.usage.totalTokens, 30); assert.equal(observed.settled, false);
  assert.deepEqual(observed.ledger, { status: 'unknown', persistenceCode: 'EIO', settlementVisible: afterRename, retryCharge: false });
  const ledgerTokens = (requestIndex - (afterRename ? 0 : 1)) * 30;
  assert.equal(f.store.state.realUsage.reportedTokens, ledgerTokens); assert.equal(f.store.state.realUsage.estimatedTokens, 0);
  assert.equal(f.store.state.realUsage.reservedTokens === 0, afterRename); assert.equal(f.project.versions.length, 1); assert.equal(f.service.running.size, 0);
  const dir = result.foundation.artifactDir, names = (await readdir(dir)).filter(name => /^request-/.test(name)); assert.equal(names.length, requestIndex);
  const body = await readFile(join(dir, names.find(name => name.startsWith(`request-${requestIndex}-`))), 'utf8'); assert.doesNotMatch(body, /PRIVATE_SETTLEMENT_PATH|PRIVATE_FIXTURE_KEY/);
  assert.deepEqual(JSON.parse(body), observed); const failure = JSON.parse(await readFile(join(dir, 'failure.json'), 'utf8'));
  assert.deepEqual(failure.requests, result.foundation.requests); assert.equal(failure.usage.totalTokens, requestIndex * 30);
  const persisted = readStateFile(f.store.file).state; assert.equal(persisted.realUsage.reportedTokens, ledgerTokens);
  // Reopen on the fixture's accounting day. Legacy restart recovery may charge
  // an uncommitted outstanding reservation conservatively as an estimate; it
  // must not duplicate already committed reported usage or resend the request.
  const dateNow = Date.now; let reopened;
  try { Date.now = () => now; reopened = new Store(f.store.file); } finally { Date.now = dateNow; }
  assert.equal(reopened.state.realUsage.reportedTokens, ledgerTokens); assert.equal(reopened.state.realUsage.estimatedTokens === 0, afterRename); assert.equal(f.calls.length, requestIndex);
});

test('unreported provider usage remains an explicit estimate when ledger persistence fails', async t => {
  const f = await fixture(t), fault = settlementSyncFailure(f, { afterRename: true }); let result;
  try { result = await run(f, { provider: provider(f, { error: true, unknownUsage: true }) }); } finally { fault.restore(); }
  assert.equal(fault.injected, true); assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 1);
  const receipt = result.foundation.requests[0]; assert.equal(receipt.usageReported, false); assert.equal(receipt.completed, false); assert.equal(receipt.requestStarted, true);
  assert.ok(receipt.usage.estimatedTokens > 1024); assert.equal(receipt.usage.totalTokens, receipt.usage.estimatedTokens);
  assert.equal(result.foundation.usage.reportedTokens, 0); assert.equal(result.foundation.usage.estimatedTokens, receipt.usage.totalTokens); assert.equal(f.store.state.realUsage.estimatedTokens, receipt.usage.totalTokens);
  assert.equal(receipt.ledger.status, 'unknown'); assert.equal(receipt.ledger.retryCharge, false);
  const failure = JSON.parse(await readFile(join(result.foundation.artifactDir, 'failure.json'), 'utf8')); assert.deepEqual(failure.requests, result.foundation.requests);
});

function additionalSourceProvider(f, { reuseOnly = false } = {}) {
  const source = { provider: 'skills-sh', id: 'fixture/skills/research', capabilityIds: ['evidence'] };
  const sequence = [
    [{ name: 'marketplace_plan', arguments: { capabilities: [{ id: 'retained', description: 'Retain the existing installed implementation method.', query: 'implementation method' }, { id: 'evidence', description: 'Add source checking for the newly requested research reports.', query: 'research evidence' }] } }],
    [{ name: 'marketplace_reuse', arguments: { existingSkillId: f.frozen.skills[0].id, capabilityIds: ['retained'], reason: 'This installed package remains relevant to the retained implementation workflow.' } }, { name: 'marketplace_search', arguments: { query: 'research evidence', capabilityIds: ['evidence'] } }],
    [{ name: 'marketplace_read', arguments: source }],
    [{ name: 'marketplace_acquire', arguments: { ...source, reason: 'The two installed implementation methods do not provide this separate evidence-review procedure.', compatibility: 'The source uses the available text readers and does not require additional execution permissions.' } }],
    ...(reuseOnly ? [[{ name: 'marketplace_skip', arguments: { capabilityIds: ['evidence'], reasonCode: 'needs_user_selection', reason: 'The host explicitly selected reuse_only, so the inspected additional source is deferred rather than acquired.' } }]] : []),
  ];
  return async function* (request) {
    const index = f.calls.length; f.calls.push(request);
    if (sequence[index]) for (const [i, call] of sequence[index].entries()) yield { type: 'tool_call', id: `supplement-${index}-${i}`, ...call };
    else yield { type: 'text_delta', delta: JSON.stringify({ summary: reuseOnly ? 'Retained existing sources and recorded the host-restricted capability gap.' : 'Retained both installed methods and supplemented the separate research capability.' }) };
    yield { type: 'usage', usage: { totalTokens: 20 } }; yield { type: 'done', stopReason: sequence[index] ? 'toolUse' : 'stop' };
  };
}
async function sourceService(t, f) {
  const http = await marketplaceFixture(t), marketplaceService = new SkillMarketplaceService(f.store, { client: new SkillMarketplaceClient({ fetchImpl: http.fetchImpl, git: http.git }) });
  let downloads = 0;
  const authoring = marketplaceService.authoring.bind(marketplaceService);
  marketplaceService.authoring = (...args) => { const author = authoring(...args), execute = author.tools.find(row => row.name === 'marketplace_acquire').execute;
    author.tools.find(row => row.name === 'marketplace_acquire').execute = async (...toolArgs) => { const result = await execute(...toolArgs); if (!result.isError) downloads++; return result; }; return author; };
  f.service = new ProjectSkillFoundationService(f.store, { genomeStore: f.genomes, marketplaceService, prepare: prepareProjectSkillFoundation, now: () => now });
  return { http, get downloads() { return downloads; } };
}

test('two existing methods do not block acquiring a distinct missing capability under the default automatic policy', async t => {
  const f = await fixture(t), source = await sourceService(t, f), result = await run(f, { provider: additionalSourceProvider(f) });
  assert.equal(result.status, 'ready'); assert.equal(f.calls.length, 5); assert.equal(source.downloads, 1); assert.equal(result.foundation.acquisitionPolicy, 'automatic');
  const stored = await f.genomes.read(f.projectId, result.versionId); assert.equal(stored.genome.skills.filter(row => row.source).length, 3);
  for (const skill of f.frozen.skills) assert.ok(stored.genome.skills.some(row => row.id === skill.id && row.source.packageHash === skill.source.packageHash));
  assert.equal(stored.genome.skills.find(row => row.source?.kind === 'marketplace-package').instructions, source.http.sources['skills/research/SKILL.md']);
  assert.equal(f.project.skillFoundation.referenceDiscovery.packages.length, 1); assert.equal(f.project.skillFoundation.usage.totalTokens, 100);
  assert.deepEqual({ ...stored.genome, skills: [] }, { ...f.baseline, skills: [] });
  assert.equal(JSON.parse(await readFile(join(result.foundation.artifactDir, 'inputs.json'), 'utf8')).acquisitionPolicy, 'automatic');
});

test('explicit host reuse_only blocks acquisition and preserves an evidence-backed partial result and policy', async t => {
  const f = await fixture(t), source = await sourceService(t, f);
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).skillFoundation = { acquisitionPolicy: 'reuse_only' }; });
  const result = await run(f, { provider: additionalSourceProvider(f, { reuseOnly: true }) });
  assert.equal(result.status, 'partial'); assert.equal(f.calls.length, 6); assert.equal(source.downloads, 0); assert.equal(result.foundation.acquisitionPolicy, 'reuse_only'); assert.equal(f.project.skillFoundation.acquisitionPolicy, 'reuse_only');
  assert.equal(JSON.parse(f.calls[0].messages[0].content[0].text).project.skillFoundation.acquisitionPolicy, 'reuse_only');
  assert.equal(result.foundation.referenceDiscovery.packages.length, 0); assert.equal(result.foundation.referenceDiscovery.sources.length, 1);
  assert.equal(source.http.calls.some(row => row.url.includes('/references/method.md')), false);
  assert.ok(result.foundation.referenceDiscovery.failures.some(row => row.code === 'marketplace_existing_selection_only'));
  assert.equal(result.foundation.coverage.find(row => row.id === 'evidence').reasonCode, 'needs_user_selection');
  const stored = await f.genomes.read(f.projectId, result.versionId); assert.equal(stored.genome.skills.filter(row => row.source).length, 2);
  const replay = await run(f); assert.equal(replay.replayed, true); assert.equal(replay.foundation.acquisitionPolicy, 'reuse_only'); assert.equal(f.calls.length, 6);
});

test('changing the host acquisition policy during preparation invalidates its basis and preserves the newer setting', async t => {
  const f = await fixture(t), result = await run(f, { provider: provider(f, { onRequest: n => { if (n === 1) f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).skillFoundation.acquisitionPolicy = 'reuse_only'; }); } }) });
  assert.equal(result.status, 'stale'); assert.equal(f.calls.length, 1); assert.equal(f.project.versions.length, 1);
  assert.equal(result.foundation.acquisitionPolicy, 'automatic'); assert.equal(f.project.skillFoundation.acquisitionPolicy, 'reuse_only');
  assert.equal(f.store.state.realUsage.reportedTokens, 30); assert.equal(f.project.skillFoundation.failureCount, 0);
  assert.equal(JSON.parse(await readFile(join(result.foundation.artifactDir, 'inputs.json'), 'utf8')).acquisitionPolicy, 'automatic');
});

test('provider failure keeps the explicit acquisition policy for the next bounded retry', async t => {
  const f = await fixture(t); f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).skillFoundation = { acquisitionPolicy: 'reuse_only' }; });
  const result = await run(f, { provider: provider(f, { error: true }) });
  assert.equal(result.status, 'failed'); assert.equal(result.foundation.acquisitionPolicy, 'reuse_only'); assert.equal(f.project.skillFoundation.acquisitionPolicy, 'reuse_only');
  assert.equal(f.calls.length, 1); assert.equal(f.store.state.realUsage.reportedTokens, 17);
});
