import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
import { projectRhythmEvidenceKey, projectRhythmStatus } from '../project-rhythm.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-schedule-rhythm-maintenance-')), store = new Store(join(directory, 'state.json'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { project, session } = store.createProject({ name: 'Recurring responsibility', description: 'Deliver a verified report every morning.', workspace: directory });
  const service = new ProjectScheduleService(store, { now: () => NOW });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const evidence = [{ id: 'source-one', type: 'user_message', summary: 'Deliver the requested report each morning.', at: NOW - 1000 }];
  store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id); p.initiative.enabled = true; p.evolution.enabled = true;
    p.rhythmRuntime = { assessment: { lifecycle: 'recurring', reason: 'One daily responsibility; no background chatter between actual deliveries.', evidenceIds: ['source-one'], scheduleIds: [], initiative: { mode: 'event_only', reviewAfterMs: 86400000 }, evolution: { mode: 'weekly', minIntervalMs: 86400000, maxPerDay: 1, maxPerWeek: 1 } },
      assessedAt: NOW - 1000, lastInitiativeAt: NOW - 1000, history: [{ at: NOW - 1000, lifecycle: 'recurring', source: 'model' }], learningAttempts: [{ id: 'previous-learning', at: NOW - 2000, source: 'automatic' }], lastLearningAt: NOW - 2000, decisionIdentity: 'accepted-decision' };
    p.rhythmRuntime.evidenceKey = projectRhythmEvidenceKey(state, p); p.initiative.tokens = 87;
  });
  const invoke = (actionId, schedule, extra = {}) => service.applyInitiativeAction(project.id, { actionId, schedule, reason: 'Maintain the already understood daily responsibility.', evidenceIds: ['source-one'], evidence, ...extra });
  const create = (actionId = 'create-one') => invoke(actionId, { operation: 'create', purposeKey: 'daily-report', title: 'Daily report', task: 'Read verified sources and deliver the report.', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: session.id });
  const acknowledgeExternal = () => store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.rhythmRuntime.evidenceKey = projectRhythmEvidenceKey(state, p); });
  return { store, project, session, service, current, invoke, create, acknowledgeExternal,
    status: () => projectRhythmStatus(store.state, current(), { now: NOW }), key: () => projectRhythmEvidenceKey(store.state, current()) };
}
const immutableRhythm = runtime => Object.fromEntries(Object.entries(runtime).filter(([key]) => !['evidenceKey', 'lastMaintenance'].includes(key)));

test('successful autonomous create, update and delete acknowledge only their own metadata without waking or changing model clocks', t => {
  const app = fixture(t), rhythmBefore = immutableRhythm(structuredClone(app.current().rhythmRuntime)), usageBefore = structuredClone(app.store.state.realUsage);
  const created = app.create();
  assert.equal(app.current().rhythmRuntime.evidenceKey, app.key()); assert.equal(app.status().initiative.reason, 'awaiting_scheduled_work');
  assert.deepEqual(app.current().rhythmRuntime.lastMaintenance, { actionId: created.actionId, scheduleId: created.scheduleId, at: new Date(NOW).toISOString() });
  const updated = app.invoke('update-one', { operation: 'update', id: created.scheduleId, expectedRevision: 1, task: 'Read sources and include actual retrieval dates.' });
  assert.equal(updated.revision, 2); assert.equal(app.current().rhythmRuntime.evidenceKey, app.key()); assert.equal(app.status().initiative.eligible, false);
  app.invoke('delete-one', { operation: 'delete', id: created.scheduleId, expectedRevision: 2 });
  assert.equal(app.current().schedules.length, 0); assert.equal(app.current().rhythmRuntime.evidenceKey, app.key()); assert.equal(app.status().initiative.eligible, false);
  assert.deepEqual(immutableRhythm(app.current().rhythmRuntime), rhythmBefore); assert.deepEqual(app.store.state.realUsage, usageBefore); assert.equal(app.current().initiative.tokens, 87);
});

for (const operation of ['create', 'update', 'delete']) test(`unread external user input before autonomous ${operation} is not consumed with its own successful maintenance`, t => {
  const app = fixture(t), created = operation === 'create' ? null : app.create(), before = structuredClone(app.current().rhythmRuntime);
  app.store.message(app.session.id, { text: 'A new requirement arrived after the planning decision.' });
  assert.notEqual(app.key(), before.evidenceKey);
  if (operation === 'create') app.create();
  else app.invoke('later-maintenance', { operation, id: created.scheduleId, expectedRevision: 1, ...(operation === 'update' ? { title: 'Refined report title' } : {}) });
  assert.deepEqual(app.current().rhythmRuntime, before); assert.equal(app.status().initiative.reason, 'new_evidence');
});

test('user create, edit and delete remain fresh evidence and never record autonomous maintenance acknowledgements', t => {
  const app = fixture(t), original = structuredClone(app.current().rhythmRuntime);
  const created = app.service.create(app.project.id, { title: 'User-created report', task: 'User requested duty.', rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.deepEqual(app.current().rhythmRuntime, original); assert.equal(app.status().initiative.reason, 'new_evidence');
  app.acknowledgeExternal(); const afterCreate = structuredClone(app.current().rhythmRuntime);
  app.service.update(app.project.id, created.id, { task: 'User changed the report scope.' });
  assert.deepEqual(app.current().rhythmRuntime, afterCreate); assert.equal(app.status().initiative.reason, 'new_evidence');
  app.acknowledgeExternal(); const afterEdit = structuredClone(app.current().rhythmRuntime);
  app.service.remove(app.project.id, created.id);
  assert.deepEqual(app.current().rhythmRuntime, afterEdit); assert.equal(app.status().initiative.reason, 'new_evidence');
  assert.equal(app.current().rhythmRuntime.lastMaintenance, undefined);
});

test('rejected maintenance leaves both source watermark and durable schedule state unchanged', t => {
  const app = fixture(t), created = app.create(), before = structuredClone(app.store.state);
  assert.throws(() => app.invoke('stale-update', { operation: 'update', id: created.scheduleId, expectedRevision: 99, task: 'Wrong revision' }), { status: 409 });
  assert.deepEqual(app.store.state, before);
  assert.throws(() => app.invoke('missing-evidence', { operation: 'delete', id: created.scheduleId, expectedRevision: 1 }, { evidence: [] }), { status: 409 });
  assert.deepEqual(app.store.state, before);
});

test('durable receipt replay cannot consume later external input or alter assessment clocks and billing', t => {
  const app = fixture(t), receipt = app.create();
  app.store.message(app.session.id, { text: 'This later external input has not been assessed yet.' });
  const before = structuredClone(app.current().rhythmRuntime), usage = structuredClone(app.store.state.realUsage), schedules = structuredClone(app.current().schedules);
  assert.deepEqual(app.create(), receipt); assert.deepEqual(app.current().rhythmRuntime, before); assert.deepEqual(app.current().schedules, schedules);
  assert.deepEqual(app.store.state.realUsage, usage); assert.equal(app.current().initiative.tokens, 87); assert.equal(app.status().initiative.reason, 'new_evidence');
});

test('successful maintenance with no model assessment cannot invent a consumed evidence watermark', t => {
  const app = fixture(t); app.store.mutate(state => { delete state.projects.find(row => row.id === app.project.id).rhythmRuntime; });
  app.create(); assert.equal(app.current().rhythmRuntime, undefined); assert.equal(app.status().initiative.reason, 'assessment_required');
});

test('maintenance acknowledgement and schedule receipt survive together in the same persisted Store commit', t => {
  const app = fixture(t), created = app.create(), reopened = new Store(app.store.file), project = reopened.state.projects.find(row => row.id === app.project.id);
  assert.equal(project.rhythmRuntime.evidenceKey, projectRhythmEvidenceKey(reopened.state, project));
  assert.equal(project.rhythmRuntime.lastMaintenance.actionId, created.actionId); assert.equal(project.scheduleManagementReceipts[0].actionId, created.actionId);
  assert.equal(project.schedules[0].id, created.scheduleId); assert.equal(project.rhythmRuntime.lastInitiativeAt, NOW - 1000);
});
