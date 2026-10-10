import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { projectInitiativeAvailability } from '../project-initiative-availability.mjs';

const base = () => ({ state: { configuration: {}, sessionDeletions: [] }, project: { id: 'p', initiative: { enabled: true }, decisionMode: 'rna-model', initialization: { status: 'ready' } } });
const modelResolver = () => ({ execution: 'rna' });
test('availability explains existing gates without changing switches, rhythm or cleanup status', () => {
  const { state, project } = base();
  state.sessionDeletions.push({ projectId: 'p', localStatus: 'pending', attempts: 4, updatedAt: '2026-09-27T01:00:00Z', retryAt: '2026-09-27T01:05:00Z', code: 'SESSION_EVIDENCE_JOURNAL_UNKNOWN', error: 'PRIVATE_PATH_AND_CONTENT' });
  const before = structuredClone({ state, project }), value = projectInitiativeAvailability(state, project, { modelResolver });
  assert.equal(value.eligible, false); assert.equal(value.reason, 'session_cleanup_pending'); assert.equal(value.details.attempts, 4);
  assert.deepEqual(value.details.codes, ['SESSION_EVIDENCE_JOURNAL_UNKNOWN']); assert.doesNotMatch(JSON.stringify(value), /PRIVATE_PATH_AND_CONTENT/);
  assert.deepEqual({ state, project }, before);
  state.sessionDeletions[0].localStatus = 'completed'; state.sessionDeletions[0].remoteStatus = 'pending';
  assert.equal(projectInitiativeAvailability(state, project, { modelResolver }).eligible, true, 'Existing gate is local cleanup, not remote memory deletion');
});
test('a cleanup waiting for the user\'s decision is named as one (review X-1)', () => {
  const { state, project } = base();
  state.sessionDeletions.push({ projectId: 'p', status: 'blocked', localStatus: 'pending', attempts: 2, code: 'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED', retryAt: null });
  const value = projectInitiativeAvailability(state, project, { modelResolver });
  assert.equal(value.reason, 'session_cleanup_pending'); assert.deepEqual(value.details.codes, ['SESSION_CLEANUP_DECISION']); assert.equal(value.details.retryAt, null);
});
test('disabled and configuration states remain distinct and errors are never copied into public details', () => {
  const { state, project } = base();
  assert.equal(projectInitiativeAvailability(state, project, { modelResolver }).reason, 'admitted');
  assert.equal(projectInitiativeAvailability(state, project, { modelResolver() { throw new Error('PRIVATE_KEY_AND_ENDPOINT'); } }).reason, 'model_unavailable');
  assert.doesNotMatch(JSON.stringify(projectInitiativeAvailability(state, project, { modelResolver() { throw new Error('PRIVATE_KEY_AND_ENDPOINT'); } })), /PRIVATE_KEY_AND_ENDPOINT/);
  assert.equal(projectInitiativeAvailability(state, project, { modelResolver: () => ({ execution: 'rna', usagePolicy: 'interactive_only' }) }).reason, 'interactive_subscription_only');
  project.initialization.status = 'pending'; assert.equal(projectInitiativeAvailability(state, project, { modelResolver }).reason, 'initialization_pending');
  project.initiative.enabled = false; assert.equal(projectInitiativeAvailability(state, project, { modelResolver }).state, 'disabled');
  state.emergency = true; assert.equal(projectInitiativeAvailability(state, project, { modelResolver }).reason, 'emergency');
});
test('cleanup diagnostics are bounded to safe known codes and finite dates and counters', () => {
  const { state, project } = base(); state.sessionDeletions = [{ projectId: 'p', code: 'PRIVATE_CONTENT', retryAt: 'bad-date', updatedAt: 'bad-date', attempts: Infinity }];
  const details = projectInitiativeAvailability(state, project, { modelResolver }).details;
  assert.deepEqual(details, { pendingCount: 1, attempts: 0, updatedAt: null, retryAt: null, codes: ['SESSION_CLEANUP_PENDING'] });
});
test('Store API and controller health expose a project blocked before context creation; pump cannot bypass it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-admission-')), store = new Store(join(directory, 'state.json')); let modelCalls = 0;
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project } = store.createProject({ name: 'Blocked fixture', workspace: directory, rhythm: { control: 'manual' } });
  store.mutate(state => {
    const row = state.projects.find(row => row.id === project.id); row.decisionMode = 'rna-model'; row.initialization = { status: 'ready' }; row.simulated = false; row.initiative.enabled = true; row.initiativeRuntime = { status: 'observing' };
    state.sessionDeletions = [{ projectId: project.id, sessionId: 'removed-session', localStatus: 'pending', remoteStatus: 'not_required', code: 'SESSION_EVIDENCE_JOURNAL_UNKNOWN', attempts: 3 }];
  });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 999999, tickIntervalMs: 0, decisionProvider: async function* () { modelCalls++; throw new Error('Admission barrier failed'); } });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  await controller.pump();
  const publicProject = store.get().projects.find(row => row.id === project.id), health = controller.health().projects.find(row => row.projectId === project.id);
  assert.equal(publicProject.initiativeRuntime.status, 'blocked'); assert.equal(publicProject.initiativeRuntime.availability.reason, 'session_cleanup_pending');
  assert.equal(store.state.projects.find(row => row.id === project.id).initiativeRuntime.status, 'observing', 'Projection must not persist a false lifecycle transition');
  assert.equal(controller.contexts.has(project.id), false); assert.equal(modelCalls, 0);
  assert.equal(health.admissionBlocked, true); assert.equal(health.executionBlocked, false, 'A gate is not an unknown external execution or a supervisor restart request');
  await controller.close(); store.mutate(state => { state.sessionDeletions[0].localStatus = 'completed'; });
  const unblocked = store.get().projects.find(row => row.id === project.id); assert.equal(unblocked.initiativeRuntime.availability.eligible, true); assert.equal(unblocked.initiativeRuntime.status, 'observing');
});
