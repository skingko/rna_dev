import test from 'node:test';
import assert from 'node:assert/strict';
import { stream, setup } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';

// The composer card "我记下了一条偏好：…以后照这样做吗？" answered with 对 confirms the lesson and closes the card for good.
test('answering a lesson card with 对 confirms the lesson and the card does not come back', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  let lessonId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); lessonId = createMindEntry(project, 'lessons', { text: '参考同类小说时至少通读 30 章以上。', kind: 'preference' }).id; project.mind.lessons.find(row => row.id === lessonId).needsConfirmation = true; });
  const invitationId = f.app.mind.inviteLesson(f.project.id, lessonId);
  assert.ok(invitationId, 'offered');
  const response = await fetch(f.url(`/api/v2/sessions/${f.session.id}/invitations/${invitationId}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'answer', choice: 'confirm' }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.closed, true);
  const lesson = f.current().mind.lessons.find(row => row.id === lessonId);
  assert.ok(lesson.confirmedAt); assert.equal(lesson.needsConfirmation, undefined);
  const open = f.app.store.state.sessions.find(row => row.id === f.session.id).invitations ?? [];
  assert.equal(open.filter(row => row.kind === 'lesson').length, 0);
  // Later sweeps and reconciliation do not ask it again.
  f.app.mind.sweep(); await f.app.store.invitations.onPresence(f.project.id);
  assert.equal((f.app.store.state.sessions.find(row => row.id === f.session.id).invitations ?? []).filter(row => row.kind === 'lesson').length, 0);
});
