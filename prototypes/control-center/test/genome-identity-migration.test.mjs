import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { migrateGenomeIdentities } from '../genome-identity.mjs';
import { projectRhythmEvidenceKey, projectRhythmStatus } from '../project-rhythm.mjs';
import { genomeSkillId, genomeIdentity, projectGenomeNamespace } from '../project-genome-store.mjs';
import { genomeToolName } from '../../../packages/sdk/src/project-genome.mjs';
import { CapabilityRegistry } from '../../../packages/sdk/src/capabilities.mjs';

// EVO-3 / TC-1: the one-time rename of generated tool and skill ids from per-version names to the project's own.
const old = { skill: (projectId, versionId, localId) => genomeSkillId(projectGenomeNamespace(projectId, versionId), localId), tool: (projectId, versionId, localId) => genomeToolName(projectGenomeNamespace(projectId, versionId), localId) };
const stable = { skill: (projectId, localId) => genomeSkillId(genomeIdentity(projectId), localId), tool: (projectId, localId) => genomeToolName(genomeIdentity(projectId), localId) };
const manifest = (projectId, versionId, localId, extra = {}) => ({ id: old.skill(projectId, versionId, localId), localId, name: localId, description: `${localId} of ${versionId}`, path: `/genomes/${projectId}/${versionId}/skills/${localId}/SKILL.md`, contentHash: `${versionId}-${localId}`.padEnd(64, '0'), enabled: true, trusted: true, generated: true, managed: 'project-genome', projectId, versionId, ...extra });
const descriptor = (projectId, versionId, localId) => ({ kind: 'genome-tool', id: old.tool(projectId, versionId, localId), name: localId, toolName: old.tool(projectId, versionId, localId), localId, description: `${localId} of ${versionId}`, permission: 'read', parameters: { type: 'object' }, enabled: true, trusted: true, generated: true, managed: 'project-genome', projectId, versionId });

/** Shaped like the live state of 2026-10-04: two versions, the older one's manifest left in the registry beside the
 * active one's (the novel and research projects had such pairs), versioned assignments with reasons, a capability
 * snapshot, and the manifests of a deleted project. */
function liveShaped() {
  const p = 'project-novel', gone = 'project-deleted';
  const version = (id, extra = {}) => ({ id, bundle: { versionId: id, namespace: projectGenomeNamespace(p, id) }, generatedSkills: [manifest(p, id, 'project-workflow'), manifest(p, id, 'market_skill', { generated: false })], generatedTools: [descriptor(p, id, 'guard_check')], ...extra });
  const v1 = version('V1'), v2 = version('V2', { skillManifests: [manifest(p, 'V2', 'project-workflow'), manifest(p, 'V2', 'market_skill', { generated: false })], toolDescriptors: [descriptor(p, 'V2', 'guard_check')] });
  v1.assignments = { skillIds: [old.skill(p, 'V1', 'project-workflow'), 'external-skill'], toolIds: ['project_read', old.tool(p, 'V1', 'guard_check')], mcpServerIds: [], reasons: [{ kind: 'skill', id: old.skill(p, 'V1', 'project-workflow'), reason: '第 1 代项目能力。' }] };
  v2.assignments = { skillIds: [old.skill(p, 'V2', 'project-workflow'), old.skill(p, 'V2', 'market_skill'), 'external-skill'], toolIds: ['project_read', old.tool(p, 'V2', 'guard_check')], mcpServerIds: [], reasons: [{ kind: 'skill', id: old.skill(p, 'V2', 'project-workflow'), reason: '第 2 代项目能力。' }, { kind: 'tool', id: old.tool(p, 'V2', 'guard_check'), reason: '第 2 代项目能力。' }] };
  const project = { id: p, name: '小说', activeVersionId: 'V2', trialVersionId: null, versions: [v1, v2],
    // A stale V1 id left beside the V2 one, and both reasons: the rename folds them into one.
    assignments: { skillIds: [old.skill(p, 'V1', 'project-workflow'), old.skill(p, 'V2', 'project-workflow'), old.skill(p, 'V2', 'market_skill'), 'external-skill'], toolIds: ['project_read', old.tool(p, 'V2', 'guard_check')], mcpServerIds: ['mcp-a'],
      reasons: [{ kind: 'skill', id: old.skill(p, 'V1', 'project-workflow'), reason: '第 1 代项目能力。' }, { kind: 'skill', id: 'external-skill', reason: 'installed' }, { kind: 'skill', id: old.skill(p, 'V2', 'project-workflow'), reason: '第 2 代项目能力。' }, { kind: 'tool', id: old.tool(p, 'V2', 'guard_check'), reason: '第 2 代项目能力。' }] },
    capabilitySnapshot: { skillHashes: { [old.skill(p, 'V2', 'project-workflow')]: 'hash-v2', [old.skill(p, 'V1', 'project-workflow')]: 'hash-v1', 'external-skill': 'hash-ext' }, tools: [{ id: 'project_read', name: 'project_read', permission: 'read' }, descriptor(p, 'V2', 'guard_check'), descriptor(p, 'V1', 'guard_check')] } };
  const capabilities = { revision: 7, tools: [], mcpServers: [], installations: [], skills: [
    { id: 'external-skill', name: 'External', description: 'Installed', path: '/skills/external/SKILL.md', enabled: true, trusted: true },
    manifest(p, 'V2', 'project-workflow'), manifest(p, 'V1', 'project-workflow'), manifest(p, 'V2', 'market_skill', { generated: false }),
    manifest(gone, 'G1', 'project-workflow'), manifest(gone, 'G2', 'project-workflow'),
  ] };
  return { state: { projects: [project, { id: 'project-plain', name: 'No genome', versions: [], assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } }], capabilities }, p, gone };
}

test('the rename writes stable ids, keeps the active version\'s manifest, leaves a deleted project\'s rows alone and runs once', () => {
  const { state, p, gone } = liveShaped(), deletedRows = structuredClone(state.capabilities.skills.filter(row => row.projectId === gone)), plain = structuredClone(state.projects[1]);
  const result = migrateGenomeIdentities(state), project = state.projects[0];
  assert.equal(result.changed, true); assert.equal(result.projects, 1);
  for (const version of project.versions) for (const row of [...version.generatedSkills, ...(version.skillManifests ?? [])]) assert.equal(row.id, stable.skill(p, row.localId), `${version.id} ${row.localId}`);
  for (const version of project.versions) for (const row of [...version.generatedTools, ...(version.toolDescriptors ?? [])]) { assert.equal(row.id, stable.tool(p, row.localId)); assert.equal(row.toolName, row.id); }
  assert.deepEqual(project.assignments.skillIds, [stable.skill(p, 'project-workflow'), stable.skill(p, 'market_skill'), 'external-skill'], 'order kept, the stale duplicate folded');
  assert.deepEqual(project.assignments.toolIds, ['project_read', stable.tool(p, 'guard_check')]); assert.deepEqual(project.assignments.mcpServerIds, ['mcp-a']);
  assert.deepEqual(project.assignments.reasons, [{ kind: 'skill', id: 'external-skill', reason: 'installed' }, { kind: 'skill', id: stable.skill(p, 'project-workflow'), reason: '第 2 代项目能力。' }, { kind: 'tool', id: stable.tool(p, 'guard_check'), reason: '第 2 代项目能力。' }], 'one reason per (kind, id), the last kept');
  assert.deepEqual(project.versions[0].assignments.skillIds, [stable.skill(p, 'project-workflow'), 'external-skill'], 'saved version assignments are renamed too');
  assert.deepEqual(project.capabilitySnapshot.skillHashes, { [stable.skill(p, 'project-workflow')]: 'hash-v2', 'external-skill': 'hash-ext' }, 'a collision keeps the active version\'s hash');
  assert.deepEqual(project.capabilitySnapshot.tools.map(row => [row.id, row.versionId ?? null]), [['project_read', null], [stable.tool(p, 'guard_check'), 'V2']], 'and the active version\'s tool row');
  const managed = state.capabilities.skills.filter(row => row.projectId === p);
  assert.deepEqual(managed.map(row => [row.id, row.versionId]), [[stable.skill(p, 'project-workflow'), 'V2'], [stable.skill(p, 'market_skill'), 'V2']], 'one manifest per (project, localId): the active version\'s');
  assert.deepEqual(state.capabilities.skills.filter(row => row.projectId === gone), deletedRows, 'a deleted project\'s rows are its deletion\'s');
  assert.equal(state.capabilities.skills[0].id, 'external-skill'); assert.equal(state.capabilities.revision, 8, 'one revision bump');
  assert.deepEqual(state.projects[1], plain);
  assert.doesNotThrow(() => new CapabilityRegistry({ skills: state.capabilities.skills }), 'the registry accepts the migrated catalogue');
  const again = structuredClone(state);
  assert.deepEqual(migrateGenomeIdentities(state), { changed: false, projects: 0, remapped: 0 }); assert.deepEqual(state, again, 'a second run changes nothing');
});

// GN-2: the rhythm evidence key hashes the assignments, so the rename moved it and both live projects would have woken once
// as `new_evidence` after the upgrade (a deferral does not consume the key; the gate's two-pass bound forces a paid
// review). A key the last decision had consumed stays consumed; one with evidence still waiting stays waiting.
test('the rename is not evidence: a consumed rhythm key stays consumed, a waiting one keeps waiting', () => {
  const at = Date.parse('2026-10-04T12:00:00Z');
  const shaped = () => {
    const { state } = liveShaped(), project = state.projects[0];
    state.sessions = [{ id: 's1', projectId: project.id, mode: 'normal', items: [{ id: 'u1', kind: 'user', text: 'Keep going with chapter four.' }], turns: [] }];
    Object.assign(project, { initiative: { enabled: true }, rhythm: { control: 'auto' }, rhythmRuntime: { assessment: { lifecycle: 'blocked', reason: 'Waiting for the user to choose the ending before drafting on.', evidenceIds: ['source-one'], scheduleIds: [], initiative: { mode: 'event_only', reviewAfterMs: 86400000 }, evolution: { mode: 'weekly', minIntervalMs: 86400000, maxPerDay: 1, maxPerWeek: 1 } }, lastInitiativeAt: at - 60000 } });
    return { state, project };
  };
  const consumed = shaped(), waiting = shaped();
  consumed.project.rhythmRuntime.evidenceKey = projectRhythmEvidenceKey(consumed.state, consumed.project);
  waiting.project.rhythmRuntime.evidenceKey = 'an-earlier-key-with-evidence-since';
  const before = projectRhythmStatus(consumed.state, consumed.project, { now: at }).initiative;
  const moved = projectRhythmEvidenceKey(consumed.state, consumed.project);
  migrateGenomeIdentities(consumed.state); migrateGenomeIdentities(waiting.state);
  assert.notEqual(projectRhythmEvidenceKey(consumed.state, consumed.project), moved, 'the rename changes what the key hashes');
  assert.equal(consumed.project.rhythmRuntime.evidenceKey, projectRhythmEvidenceKey(consumed.state, consumed.project), 'and the consumed key follows it');
  assert.deepEqual(projectRhythmStatus(consumed.state, consumed.project, { now: at }).initiative, before, 'the initiative lane reads the same as before the rename');
  assert.equal(waiting.project.rhythmRuntime.evidenceKey, 'an-earlier-key-with-evidence-since', 'evidence still waiting is not consumed by the rename');
  const again = structuredClone(consumed.state);
  assert.equal(migrateGenomeIdentities(consumed.state).changed, false); assert.deepEqual(consumed.state, again, 'a second run changes nothing');
});

test('a trial version\'s manifest wins over the active one\'s; an archived project is renamed too', () => {
  const { state, p } = liveShaped();
  state.projects[0].trialVersionId = 'V1'; state.projects[0].archivedAt = '2026-10-01T00:00:00.000Z';
  migrateGenomeIdentities(state);
  assert.deepEqual(state.capabilities.skills.filter(row => row.projectId === p && row.localId === 'project-workflow').map(row => row.versionId), ['V1']);
  assert.equal(state.projects[0].assignments.skillIds[0], stable.skill(p, 'project-workflow'));
});

async function until(check, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (check()) return; await delay(5); } throw new Error(`Timeout: ${label}`); }

// The ordering dependency (spec §1.3): before the 0.65 scope split the initiative scope hashed the assignments and the
// whole capability registry, so this rename would have revoked every receipt and had memory delete the deliveries'
// evidence. Now it is drift: the coordinator adopts the saved runtime as the same scope and stops nothing.
test('the rename at start revokes no receipt, ends no paused work and keeps the privacy scope', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-genome-identity-')), file = join(dir, 'state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(file);
  const provider = store.configurationService.provider(null, { name: 'Rename fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Rename at start', workspace: dir });
  const { state: shaped } = liveShaped(), source = shaped.projects[0];
  // This project, with live-shaped versions under its own id (old per-version names).
  const rebase = value => JSON.parse(JSON.stringify(value).split('project-novel').join(project.id));
  const wait = async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'Nothing to do', evidenceIds: [], nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done', stopReason: 'stop' }; };
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    Object.assign(target, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model' });
    target.initiative.tokenBudget = null; state.settings.realTokenBudget = null;
  });
  const first = new ProjectInitiativeController(store, { initialDelayMs: 86400000, tickIntervalMs: 0, independentLearning: true, decisionProvider: wait });
  await until(() => store.state.projects.find(row => row.id === project.id).initiativeRuntime?.scopeSchemaVersion === 2, 'a split runtime is saved');
  await first.close();
  // Receipts the background must keep: completed work with its handoff, and a paused run that may go on.
  const actions = [
    { id: 'w1', action: 'work', status: 'completed', content: 'Check chapter 3', title: 'Chapter 3', resultSummary: 'Chapter 3 checked', handoff: '交接：第 3 章已核对', evidenceIds: [], intentKey: 'w1', revision: 1, finishedAt: Date.now() },
    { id: 'w2', action: 'work', status: 'paused', content: 'Draft chapter 4', evidenceIds: [], intentKey: 'w2', revision: 1, checkpoint: { sessionId: 'w2' } },
  ];
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id), shapedProject = rebase(source);
    Object.assign(target, { versions: shapedProject.versions, activeVersionId: 'V2', assignments: shapedProject.assignments, capabilitySnapshot: shapedProject.capabilitySnapshot });
    target.initiativeRuntime.sdkState.actions = structuredClone(actions);
    target.jobs = [{ id: 'w1', projectId: target.id, kind: 'research', lane: 'background', status: 'completed', simulated: false, instruction: 'Check chapter 3', output: 'Chapter 3 checked', handoff: '交接：第 3 章已核对', evidenceIds: [], createdAt: new Date().toISOString() }];
    state.capabilities = { ...(state.capabilities ?? {}), revision: 3, skills: [...(state.capabilities?.skills ?? []), ...rebase(shaped.capabilities.skills.filter(row => row.projectId === 'project-novel'))] };
  });
  const before = structuredClone(store.state.projects.find(row => row.id === project.id).initiativeRuntime);
  store.close();
  store = new Store(file);
  const migrated = store.state.projects.find(row => row.id === project.id);
  assert.deepEqual(migrated.assignments.skillIds, [stable.skill(project.id, 'project-workflow'), stable.skill(project.id, 'market_skill'), 'external-skill'], 'renamed at start');
  assert.deepEqual(migrated.assignments.toolIds, ['project_read', stable.tool(project.id, 'guard_check')]);
  assert.equal(store.state.capabilities.skills.filter(row => row.projectId === project.id).length, 2);
  const second = new ProjectInitiativeController(store, { initialDelayMs: 86400000, tickIntervalMs: 0, independentLearning: true, decisionProvider: wait });
  t.after(() => second.close());
  await until(() => second.contexts.get(project.id)?.initialized, 'the coordinator after the rename');
  const runtime = store.state.projects.find(row => row.id === project.id).initiativeRuntime, context = second.contexts.get(project.id);
  assert.equal(runtime.privacyScopeHash, before.privacyScopeHash, 'the privacy scope is unchanged');
  assert.equal(context.scope, before.privacyScopeHash);
  const byId = id => runtime.sdkState.actions.find(row => row.id === id);
  assert.deepEqual(byId('w1'), actions[0], 'the completed receipt and its handoff are kept as they were');
  assert.equal(byId('w2').status, 'paused', 'the paused run is not ended'); assert.equal(byId('w2').cancellationReason, undefined);
  assert.ok(runtime.sdkState.actions.every(row => !row.contextRevoked && !row.privacyRevoked));
  assert.ok(store.state.projects.find(row => row.id === project.id).jobs.every(row => !row.privacyRevoked));
  assert.equal(context.drift, second.drift(store.state.projects.find(row => row.id === project.id), second.model(store.state.projects.find(row => row.id === project.id))), 'the coordinator froze the renamed capabilities');
});
