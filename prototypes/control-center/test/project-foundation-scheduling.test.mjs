import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ProjectInitializer } from '../project-initializer.mjs';
import { CapabilityService } from '../capability-service.mjs';

const until = async predicate => { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw Error('scheduler timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-foundation-scheduling-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'scheduling fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 8192 }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' } });
  const { project, session } = store.createProject({ name: 'Existing real project', workspace: dir });
  store.mutate(state => { const row = state.projects.find(row => row.id === project.id); Object.assign(row, { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready', sdkVersion: '0.3.0' }, activeVersionId: 'baseline', trialVersionId: null, versions: [{ id: 'baseline', state: 'active', bundle: { schemaVersion: 1, genome: {}, hash: 'fixture' } }] }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const initializer = options => { const instance = new ProjectInitializer(store, new CapabilityService(store), options); t.after(() => instance.close()); return instance; };
  return { store, project, session, current, initializer };
}
test('a legacy ready project is automatically reconciled once, preserving its initialization and conversation', async t => {
  const f = await setup(t); let calls = 0;
  const original = structuredClone(f.current().initialization), items = structuredClone(f.store.state.sessions.find(row => row.id === f.session.id).items);
  const initializer = f.initializer({ foundationService: { async run(project) { calls++; f.store.mutate(state => { state.projects.find(row => row.id === project.id).skillFoundation = { schemaVersion: 1, status: 'partial', coverage: [] }; }); } } });
  await until(() => calls === 1 && !initializer.running.size); f.store.tick(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1); assert.deepEqual(f.current().initialization, original); assert.deepEqual(f.store.state.sessions.find(row => row.id === f.session.id).items, items);
});
test('foundation yields immediately when a foreground turn starts and does not immediately retry', async t => {
  const f = await setup(t); let calls = 0, aborted = false;
  const initializer = f.initializer({ foundationService: { async run(project, { signal }) { calls++; await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; f.store.mutate(state => { state.projects.find(row => row.id === project.id).skillFoundation = { status: 'stale', nextRetryAt: Date.now() + 3600000 }; }); resolve(); }, { once: true })); } } });
  await until(() => calls === 1);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).activeTurnId = 'real-foreground'; });
  await until(() => aborted && !initializer.running.size);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).activeTurnId = null; }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1); assert.equal(f.current().initialization.status, 'ready');
});
test('maintenance, foreground, and other active work postpone foundation without changing project state', async t => {
  const f = await setup(t); let calls = 0, busy = true;
  const initializer = f.initializer({ isBusy: () => busy, foundationService: { async run(project) { calls++; f.store.mutate(state => { state.projects.find(row => row.id === project.id).skillFoundation = { status: 'ready' }; }); } } });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 0);
  busy = false; f.store.maintenanceHeld = true; initializer.schedule(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 0);
  f.store.maintenanceHeld = false; f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).activeTurnId = 'active'; }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 0);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).activeTurnId = null; }); await until(() => calls === 1 && !initializer.running.size);
});
test('an interrupted preparing record is retained with backoff instead of replayed on restart', async t => {
  const f = await setup(t); f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).skillFoundation = { status: 'preparing', operationId: 'old-operation', requests: [{ requestId: 'old-request', settled: false }] }; });
  let calls = 0; f.initializer({ foundationService: { async run() { calls++; } } }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 0); assert.equal(f.current().skillFoundation.status, 'stale'); assert.equal(f.current().skillFoundation.operationId, 'old-operation'); assert.equal(f.current().skillFoundation.requests.length, 1); assert.ok(f.current().skillFoundation.nextRetryAt > Date.now());
});
test('explicit foundation retry resets its own failure ceiling without replacing project initialization', async t => {
  const f = await setup(t); f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).skillFoundation = { status: 'failed', failureCount: 3, nextRetryAt: Date.now() + 3600000 }; });
  let calls = 0; const initializer = f.initializer({ foundationService: { async run(project) { calls++; f.store.mutate(state => { state.projects.find(row => row.id === project.id).skillFoundation = { status: 'ready' }; }); } } });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 0);
  assert.equal(initializer.retryFoundation(f.project.id).status, 'queued'); await until(() => calls === 1 && !initializer.running.size);
  assert.equal(f.current().initialization.status, 'ready'); assert.equal(f.current().activeVersionId, 'baseline');
});
