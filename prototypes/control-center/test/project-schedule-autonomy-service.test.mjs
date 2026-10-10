import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
const at = Date.parse('2026-09-26T02:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-autonomous-commitments-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project, session } = store.createProject({ name: '研究项目', description: '持续研究新技术，形成可验证结论', workspace: dir });
  store.mutate(state => { const p = state.projects.find(p => p.id === project.id); p.initiative.enabled = true; p.permissions = { workspace: 'read', background: 'read' }; });
  const service = new ProjectScheduleService(store, { now: () => at });
  const evidence = [{ id: 'project-evidence', type: 'project_context', summary: '持续研究新技术，形成可验证结论。没有人为登记的任务。' }];
  const action = { actionId: 'model-decision-1', reason: '需要在取得新材料后核验报告并跟进未解决的问题。', evidenceIds: [evidence[0].id], evidence,
    schedule: { operation: 'create', purposeKey: 'research-followup', title: '调研证据复查', task: '复查新增材料、核验结论并报告有意义的变化。', destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } } };
  return { dir, store, project, session, service, action };
}
test('initiative can establish a grounded commitment without a user command, expanding neither file permissions nor delivery scope', t => {
  const f = fixture(t), receipt = f.service.applyInitiativeAction(f.project.id, f.action);
  const p = f.store.state.projects.find(p => p.id === f.project.id), record = p.schedules[0];
  assert.equal(record.source, 'initiative'); assert.equal(record.purposeKey, 'research-followup'); assert.equal(record.initiativeProvenance.actionId, f.action.actionId);
  assert.deepEqual(record.initiativeProvenance.evidenceIds, ['project-evidence']); assert.equal(record.initiativeProvenance.sources[0].hash.length, 64);
  assert.deepEqual(p.permissions, { workspace: 'read', background: 'read' });
  assert.equal(f.store.state.sessions.find(s => s.id === f.session.id).turns.length, 0);
  assert.match(receipt.summary, /已自主安排.*尚不代表工作已完成/);
  assert.equal(f.service.agentView(p.id).schedules[0].source, 'initiative');
  assert.deepEqual(f.service.applyInitiativeAction(p.id, f.action), receipt);
  assert.equal(f.service.list(p.id).schedules.length, 1);
  const already = f.service.applyInitiativeAction(p.id, { ...f.action, actionId: 'second-model-decision' });
  assert.equal(already.alreadyRegistered, true); assert.equal(f.service.list(p.id).schedules.length, 1);
  assert.throws(() => f.service.applyInitiativeAction(p.id, { ...f.action, schedule: { ...f.action.schedule, task: 'different' } }), /同一自主行动/);
});
test('human edits invalidate stale autonomous changes and human pause survives subsequent metadata edits', t => {
  const f = fixture(t), first = f.service.applyInitiativeAction(f.project.id, f.action);
  const human = f.service.update(f.project.id, first.scheduleId, { rule: { kind: 'daily', time: '11:00', timeZone: 'Asia/Shanghai' }, enabled: false });
  const update = { ...f.action, actionId: 'update-model', schedule: { operation: 'update', id: first.scheduleId, expectedRevision: 1, task: '更新证据内容' } };
  assert.throws(() => f.service.applyInitiativeAction(f.project.id, update), /依据最新版本/);
  update.schedule.expectedRevision = human.revision;
  const changed = f.service.applyInitiativeAction(f.project.id, update);
  assert.equal(changed.revision, human.revision + 1);
  assert.throws(() => f.service.applyInitiativeAction(f.project.id, { ...update, actionId: 'enable-model', schedule: { operation: 'update', id: first.scheduleId, expectedRevision: changed.revision, enabled: true } }), /用户暂停/);
  const final = f.service.list(f.project.id).schedules[0]; assert.equal(final.rule.time, '11:00'); assert.equal(final.enabled, false); assert.equal(final.userPaused, true);
  const resumed = f.service.update(f.project.id, first.scheduleId, { enabled: true }); assert.equal(resumed.userPaused, false);
});
test('a user cancellation blocks recreation under a new action ID and leaves a truthful historical receipt for crash reconciliation', t => {
  const f = fixture(t), receipt = f.service.applyInitiativeAction(f.project.id, f.action);
  f.service.remove(f.project.id, receipt.scheduleId);
  const restored = new ProjectScheduleService(new Store(f.store.file), { now: () => at });
  assert.throws(() => restored.applyInitiativeAction(f.project.id, { ...f.action, actionId: 'new-attempt-after-delete' }), /职责已被取消/);
  assert.equal(restored.agentView(f.project.id).cancelled[0].purposeKey, 'research-followup');
  assert.equal(restored.agentView(f.project.id).cancelled[0].deletedBy, 'user');
  const { actionId, ...action } = f.action;
  assert.deepEqual(restored.reconcileInitiativeAction(f.project.id, { ...action, id: actionId }), receipt);
  assert.equal(restored.reconcileInitiativeAction(f.project.id, { ...action, id: actionId, reason: 'different' }), null);
  assert.equal(restored.list(f.project.id).schedules.length, 0, 'reconciliation reports historical commit without re-creating anything');
});
test('missing evidence, foreign destinations, paused initiative, aborted signals and persistence failure never leave a partial task', t => {
  const f = fixture(t);
  assert.throws(() => f.service.applyInitiativeAction(f.project.id, { ...f.action, evidence: [] }), /来源证据/);
  const other = f.store.createProject({ name: 'other', workspace: f.dir });
  assert.throws(() => f.service.applyInitiativeAction(f.project.id, { ...f.action, schedule: { ...f.action.schedule, destinationSessionId: other.session.id } }), /当前项目/);
  f.store.mutate(state => { state.projects.find(p => p.id === f.project.id).initiative.enabled = false; });
  assert.throws(() => f.service.applyInitiativeAction(f.project.id, f.action), /已暂停/);
  f.store.mutate(state => { state.projects.find(p => p.id === f.project.id).initiative.enabled = true; });
  assert.throws(() => f.service.applyInitiativeAction(f.project.id, { ...f.action, signal: AbortSignal.abort() }), /aborted/);
  const persist = f.store.persist; f.store.persist = () => { throw new Error('disk_write_failed'); };
  try { assert.throws(() => f.service.applyInitiativeAction(f.project.id, f.action), /disk_write_failed/); } finally { f.store.persist = persist; }
  assert.equal(f.service.list(f.project.id).schedules.length, 0); assert.equal(f.service.initiativeReceipt(f.project.id, f.action.actionId), undefined);
  assert.equal(f.service.applyInitiativeAction(f.project.id, f.action).operation, 'create');
});
