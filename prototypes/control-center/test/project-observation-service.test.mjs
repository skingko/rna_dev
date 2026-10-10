import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { atomicWrite } from '../durable-files.mjs';
import { ProjectObservationService } from '../project-observation-service.mjs';
import { createWorkspaceObserver } from '../workspace-observer.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-observation-service-')), workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const { stateInsideWorkspace = false, ...serviceOptions } = options;
  const store = new Store(stateInsideWorkspace ? join(workspace, 'custom-state.json') : join(directory, 'state.json')), { project, session } = store.createProject({ name: 'Observation fixture', workspace });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); });
  let clock = Date.UTC(2026, 8, 27, 13); const services = [];
  const start = more => { const service = new ProjectObservationService(store, { autoStart: false, now: () => clock, settleMs: 0, ...serviceOptions, ...more }); services.push(service); return service; };
  const service = start(); const current = () => store.state.projects.find(row => row.id === project.id);
  const observations = () => current().observations.filter(row => row.kind === 'workspace_change');
  const doc = () => JSON.parse(readFileSync(service.file(project.id), 'utf8'));
  const write = (file, body) => writeFileSync(join(workspace, file), body);
  t.after(async () => { for (const service of services) await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, store, project, session, service, start, current, observations, doc, write, now: () => clock, advance: value => { clock += value; } };
}
async function changes(app, service = app.service) { await service.pump({ force: true }); await service.pump({ force: true }); }

test('real metadata baseline stays silent; stable external changes project once with a durable cursor', async t => {
  const app = fixture(t); app.write('report.md', 'original'); await app.service.pump();
  assert.equal(app.observations().length, 0); assert.ok(app.doc().scanner); assert.equal(app.doc().inbox.sources[0].sequence, 0);
  app.write('report.md', 'changed report'); await changes(app);
  assert.equal(app.observations().length, 1); const event = app.observations()[0];
  assert.equal(event.data.instruction, false); assert.equal(event.data.trust, 'untrusted'); assert.equal(event.data.changes[0].path, 'report.md');
  assert.equal(app.doc().inbox.sources[0].sequence, 1); assert.equal(app.doc().inbox.pending.length, 0);
  await app.service.close(); const restart = app.start(); await restart.pump({ force: true }); assert.equal(app.observations().length, 1);
});

test('a complete agent turn between scans is retained as mixed origin across restart', async t => {
  const app = fixture(t); app.write('app.js', 'before'); await app.service.pump();
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).status = 'running'; });
  app.write('app.js', 'agent output');
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).status = 'idle'; });
  assert.equal(app.doc().executionSeen, true);
  await app.service.close(); const restart = app.start(); await restart.pump({ force: true });
  assert.equal(app.observations().length, 0); assert.equal(app.doc().stats.suppressedDuringExecution, 1); assert.equal(app.doc().executionSeen, false);
  app.write('app.js', 'later external edit'); await changes(app, restart); assert.equal(app.observations().length, 1);
});

test('queued and initializing project status acknowledges writes without pretending external novelty', async t => {
  const app = fixture(t); app.write('initial.md', 'before'); await app.service.pump();
  for (const status of ['queued', 'initializing']) {
    app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).initialization.status = status; });
    app.write('initial.md', `setup-${status}`); await changes(app);
  }
  assert.equal(app.observations().length, 0); assert.ok(app.doc().stats.suppressedDuringExecution >= 1);
});

test('two controls and first pump share one lifecycle owner and preserve the latest command', async t => {
  const app = fixture(t); app.write('report.md', 'baseline');
  const results = await Promise.all([app.service.pump(), app.service.control(app.project.id, 'workspace', { enabled: false }), app.service.control(app.project.id, 'workspace', { enabled: true })]);
  assert.equal(results[1].sources[0].enabled, false); assert.equal(results[2].sources[0].enabled, true);
  assert.equal(app.service.contexts.size, 1); assert.equal(app.doc().enabled, true); assert.equal(app.doc().scanner, null);
  await app.service.pump({ force: true }); assert.ok(app.doc().scanner); assert.equal(app.observations().length, 0);
});

test('control queued behind a pump rejects changed workspace instead of overwriting the new binding', async t => {
  const app = fixture(t); const other = join(app.directory, 'other'); mkdirSync(other);
  const pump = app.service.pump(), control = app.service.control(app.project.id, 'workspace', { enabled: false });
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).workspace = other; });
  await pump; await assert.rejects(control, { status: 409 }); assert.equal(app.doc().enabled, true);
});

test('archive and emergency gaps reset baseline durably, including restart before restoration', async t => {
  const app = fixture(t); app.write('report.md', 'before'); await app.service.pump();
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).archivedAt = new Date(app.now()).toISOString(); });
  assert.equal(app.doc().scanner, null); assert.equal(app.doc().resetRequired, true);
  assert.match(app.service.list(app.project.id).sources[0].summary, /项目已归档/);
  app.write('report.md', 'while archived'); await app.service.close();
  const restart = app.start(); app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).archivedAt = null; });
  await restart.pump({ force: true }); assert.equal(app.observations().length, 0); assert.equal(app.doc().resetRequired, false);
  app.store.mutate(state => { state.emergency = true; }); app.write('report.md', 'while stopped'); await restart.close();
  assert.match(restart.list(app.project.id).sources[0].summary, /已全局暂停/);
  const again = app.start(); app.store.mutate(state => { state.emergency = false; }); await again.pump({ force: true });
  assert.equal(app.observations().length, 0); assert.ok(app.doc().recent.some(row => row.kind === 'observation_gap'));
});

test('startup while suspended records the gap even without an existing in-memory context', async t => {
  const app = fixture(t); app.write('report.md', 'before'); await app.service.pump(); await app.service.close();
  app.store.mutate(state => { state.emergency = true; }); const restart = app.start(); await restart.pump();
  assert.equal(app.doc().scanner, null); assert.equal(app.doc().resetRequired, true);
  app.write('report.md', 'during emergency'); app.store.mutate(state => { state.emergency = false; }); await restart.pump({ force: true });
  assert.equal(app.observations().length, 0);
});

test('root replacement remains held across restart and explicit recovery revokes old evidence', async t => {
  const app = fixture(t); app.write('report.md', 'before'); await app.service.pump(); app.write('report.md', 'external'); await changes(app);
  renameSync(app.workspace, join(app.directory, 'old-workspace')); mkdirSync(app.workspace); app.write('replacement.md', 'new root');
  await app.service.pump({ force: true }); assert.equal(app.doc().hold, 'root_changed'); assert.equal(app.service.list(app.project.id).sources[0].status, 'root_changed');
  await app.service.close(); const restart = app.start(); await restart.pump({ force: true });
  assert.equal(restart.list(app.project.id).sources[0].status, 'root_changed'); assert.equal(app.doc().sourceRevision, 1);
  await restart.control(app.project.id, 'workspace', { enabled: true }); await restart.pump({ force: true });
  assert.equal(app.doc().hold, null); assert.equal(app.doc().sourceRevision, 2); assert.equal(app.observations()[0].status, 'withdrawn');
});

test('root replacement during a pause cannot be hidden by rebaselining', async t => {
  const app = fixture(t); await app.service.pump(); await app.service.control(app.project.id, 'workspace', { enabled: false });
  renameSync(app.workspace, join(app.directory, 'old')); mkdirSync(app.workspace);
  await app.service.control(app.project.id, 'workspace', { enabled: true }); await app.service.pump({ force: true });
  assert.equal(app.doc().hold, 'root_changed');
});

test('failed first registration keeps health visible and does not busy retry after context removal', async t => {
  let writes = 0, failing = true;
  const app = fixture(t, { write: (file, text) => { writes++; if (failing) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); atomicWrite(file, text); } });
  await app.service.pump(); assert.equal(writes, 1); assert.equal(app.service.contexts.size, 0);
  assert.equal(app.service.health().sources[0].lastErrorCode, 'project_event_persistence_uncertain'); assert.equal(app.service.list(app.project.id).sources[0].status, 'unavailable');
  for (let i = 0; i < 3; i++) { app.advance(15000); await app.service.pump({ force: true }); }
  assert.equal(writes, 1); failing = false; app.advance(15000); await app.service.pump();
  assert.ok(app.doc().scanner); assert.equal(app.service.health().sources[0].status, 'watching');
});

test('a committed-but-unconfirmed inbox ingest reloads its exact event and scanner after cooldown', async t => {
  let loseAck = false, failed = false;
  const app = fixture(t, { write: (file, text) => { atomicWrite(file, text); const doc = JSON.parse(text); if (loseAck && !failed && doc.inbox?.pending.length) { failed = true; throw Object.assign(new Error('directory sync uncertain'), { code: 'EIO', committed: true }); } } });
  app.write('report.md', 'before'); await app.service.pump(); app.write('report.md', 'after'); await app.service.pump({ force: true }); loseAck = true; await app.service.pump({ force: true });
  const eventId = app.doc().inbox.pending[0].id; assert.equal(app.observations().length, 0); assert.equal(app.doc().inbox.sources[0].sequence, 1);
  app.advance(60000); await app.service.pump(); assert.equal(app.observations().length, 1); assert.equal(app.observations()[0].eventId, eventId); assert.equal(app.doc().inbox.pending.length, 0);
});

test('projection-before-checkpoint failure replays without another observation or archive churn', async t => {
  let failAck = false, failed = false, archives = 0;
  const app = fixture(t, { write: (file, text) => { const doc = JSON.parse(text); if (failAck && !failed && doc.inbox?.checkpoint) { failed = true; throw Object.assign(new Error('ack failed'), { code: 'EIO' }); } atomicWrite(file, text); } });
  app.write('report.md', 'before'); await app.service.pump(); const archive = app.store.archiveRecords.bind(app.store); app.store.archiveRecords = (...args) => { archives++; return archive(...args); };
  app.write('report.md', 'after'); await app.service.pump({ force: true }); failAck = true; await app.service.pump({ force: true });
  assert.equal(app.observations().length, 1); const id = app.observations()[0].id; assert.equal(app.doc().inbox.pending.length, 1);
  app.advance(60000); await app.service.pump(); assert.equal(app.observations().length, 1); assert.equal(app.observations()[0].id, id); assert.equal(archives, 0); assert.equal(app.doc().inbox.pending.length, 0);
});

test('already durable events wait for valid root identity before delivery after restart', async t => {
  let failAck = false;
  const app = fixture(t, { write: (file, text) => { atomicWrite(file, text); const doc = JSON.parse(text); if (failAck && doc.inbox?.pending.length) throw Object.assign(new Error('lost ack'), { code: 'EIO', committed: true }); } });
  app.write('report.md', 'before'); await app.service.pump(); app.write('report.md', 'after'); await app.service.pump({ force: true }); failAck = true; await app.service.pump({ force: true }); await app.service.close();
  renameSync(app.workspace, join(app.directory, 'old')); mkdirSync(app.workspace); const restart = app.start({ write: atomicWrite }); await restart.pump({ force: true });
  assert.equal(app.observations().length, 0); assert.equal(app.doc().hold, 'root_changed'); assert.equal(app.doc().inbox.pending.length, 1);
});

test('unchanged quiet projects back off locally and fresh user activity pulls their next check forward', async t => {
  const app = fixture(t); app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).rhythmRuntime = { assessment: { lifecycle: 'recurring', initiative: { mode: 'event_only' } } }; });
  await app.service.pump();
  for (let i = 0; i < 6; i++) await app.service.pump({ force: true });
  let source = app.service.list(app.project.id).sources[0]; assert.equal(source.pollIntervalMs, 300000); assert.ok(Date.parse(source.nextCheckAt) > app.now());
  const checked = source.lastCheckedAt; app.advance(1000); await app.service.pump(); assert.equal(app.service.list(app.project.id).sources[0].lastCheckedAt, checked);
  app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).items.push({ id: 'fresh-user-message', kind: 'user', text: 'Check project updates.' }); });
  await app.service.pump(); source = app.service.list(app.project.id).sources[0]; assert.notEqual(source.lastCheckedAt, checked); assert.ok(source.pollIntervalMs <= 30000);
});

test('changed and settling files reset the interval while ordinary active projects cap at one minute', async t => {
  const app = fixture(t); app.write('report.md', 'before'); await app.service.pump();
  for (let i = 0; i < 6; i++) await app.service.pump({ force: true });
  assert.equal(app.service.list(app.project.id).sources[0].pollIntervalMs, 60000);
  app.write('report.md', 'after'); await app.service.pump({ force: true }); assert.equal(app.service.list(app.project.id).sources[0].pollIntervalMs, 15000);
  await app.service.pump({ force: true }); assert.equal(app.service.list(app.project.id).sources[0].pollIntervalMs, 15000);
});

test('root hold is a persistent identity revocation even when the visible source is paused', async t => {
  const app = fixture(t); await app.service.pump(); renameSync(app.workspace, join(app.directory, 'old')); mkdirSync(app.workspace);
  await app.service.pump({ force: true }); await app.service.control(app.project.id, 'workspace', { enabled: false });
  const paused = app.service.list(app.project.id).sources[0]; assert.equal(paused.status, 'paused'); assert.equal(paused.identityRevoked, true); assert.equal(paused.sourceRevision, 1);
  await app.service.close(); const restart = app.start(); await restart.pump({ force: true });
  assert.equal(restart.list(app.project.id).sources[0].identityRevoked, true);
  await restart.control(app.project.id, 'workspace', { enabled: true });
  const recovered = restart.list(app.project.id).sources[0]; assert.equal(recovered.identityRevoked, false); assert.equal(recovered.sourceRevision, 2);
});

test('the sixty-fifth observation archives only a durably received old event', async t => {
  const app = fixture(t); await app.service.pump(); const source = app.service.list(app.project.id).sources[0];
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id); for (let i = 0; i < 64; i++) p.observations.push({ id: `old-${i}`, eventId: `old-${i}`, kind: 'workspace_change', status: 'received', text: 'Old directory observation', createdAt: new Date(app.now()).toISOString(), data: { source: { bindingId: source.bindingId, revision: source.sourceRevision }, runtimeReceipt: { scope: 'durable-runtime', eventId: `observation:old-${i}`, at: app.now() } } }); });
  let archived; const archive = app.store.archiveRecords.bind(app.store); app.store.archiveRecords = (namespace, rows) => { archived = rows; return archive(namespace, rows); };
  app.write('new.md', 'external'); await changes(app);
  assert.equal(app.observations().length, 64); assert.equal(archived.length, 1); assert.equal(archived[0].id, 'old-0'); assert.equal(app.observations().at(-1).status, 'pending');
});

test('unreceived or falsely labelled history backpressures instead of silently disappearing', async t => {
  const app = fixture(t); await app.service.pump(); const source = app.service.list(app.project.id).sources[0];
  app.store.mutate(state => { const p = state.projects.find(row => row.id === app.project.id); for (let i = 0; i < 64; i++) p.observations.push({ id: `old-${i}`, eventId: `old-${i}`, kind: 'workspace_change', status: i ? 'pending' : 'received', text: 'Unreceived directory observation', createdAt: new Date(app.now()).toISOString(), data: { source: { bindingId: source.bindingId, revision: source.sourceRevision } } }); });
  app.write('new.md', 'external'); await changes(app);
  assert.equal(app.observations().length, 64); assert.equal(app.doc().inbox.pending.length, 1); assert.equal(app.service.health().sources[0].lastErrorCode, 'event_backpressure');
});

test('failed user control exposes durability failure and keeps automatic retry cooldown', async t => {
  let failing = false;
  const app = fixture(t, { write: (file, text) => { if (failing) throw Object.assign(new Error('disk failure'), { code: 'EIO' }); atomicWrite(file, text); } });
  await app.service.pump(); failing = true;
  await assert.rejects(app.service.control(app.project.id, 'workspace', { enabled: false }), { code: 'EIO' });
  assert.equal(app.service.health().sources[0].lastErrorCode, 'EIO'); assert.equal(app.doc().enabled, true);
  failing = false; await app.service.pump({ force: true }); assert.equal(app.service.health().sources[0].status, 'unavailable');
  app.advance(60000); await app.service.pump(); assert.equal(app.service.health().sources[0].status, 'watching');
});

test('an activity-barrier save failure during scan cannot be cleared as an ordinary cancellation', async t => {
  let trigger = false, failing = false, app;
  app = fixture(t, {
    write: (file, text) => { if (failing) throw Object.assign(new Error('barrier not durable'), { code: 'EIO' }); atomicWrite(file, text); },
    observerFactory: options => { const observer = createWorkspaceObserver(options); return { ...observer, poll: async input => {
      const result = await observer.poll(input);
      if (trigger) { trigger = false; failing = true; app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).status = 'running'; }); }
      return result;
    } }; },
  });
  await app.service.pump(); trigger = true; await app.service.pump({ force: true });
  assert.equal(app.service.health().sources[0].lastErrorCode, 'observation_persistence_uncertain');
  assert.equal(app.service.list(app.project.id).sources[0].status, 'unavailable');
});

test('a custom host state file inside the project never creates self-wakes while neighboring user files remain observable', async t => {
  const app = fixture(t, { stateInsideWorkspace: true }); app.write('README.md', 'before'); await app.service.pump();
  mkdirSync(`${app.store.file}.capabilities`); writeFileSync(join(`${app.store.file}.capabilities`, 'manifest.json'), '{"host":"owned"}');
  app.store.mutate(state => { state.projects.find(row => row.id === app.project.id).description = 'Host state changed'; });
  for (let i = 0; i < 3; i++) { app.advance(15000); await app.service.pump({ force: true }); }
  assert.equal(app.observations().length, 0);
  assert.deepEqual(app.doc().scanner.entries.map(row => row.path), ['README.md']);
  app.write('README.md', 'user edit'); app.write('custom-state.json-notes.md', 'A real user file, not host state.'); await changes(app);
  assert.equal(app.observations().length, 1); assert.deepEqual(app.observations()[0].data.changes.map(row => row.path), ['README.md', 'custom-state.json-notes.md']);
});
