import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { until, stream, setup } from './helpers/gene-fixture.mjs';

// Plan §4.5: 从这里分叉 — a new conversation that starts from one message of another.
test('fork from a message: earlier messages are copied for reading, the model gets them as context, the original is untouched', async t => {
  const f = await setup(t, (input, res) => stream(res, `收到：${JSON.stringify(input.messages).includes('第一版开头') ? '有上下文' : '没有上下文'}`));
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.title = '第一章'; s.items.push({ id: ids[0], kind: 'user', text: '写第一章开头', createdAt: new Date().toISOString() }, { id: ids[1], kind: 'assistant', text: '第一版开头：雨夜。', createdAt: new Date().toISOString(), final: true }, { id: ids[2], kind: 'user', text: '改成第一人称', createdAt: new Date().toISOString() }); });
  const response = await fetch(f.url(`/api/v2/sessions/${f.session.id}/fork`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: ids[1] }) });
  assert.equal(response.status, 201, await response.clone().text());
  const summary = await response.json(), fork = f.app.store.state.sessions.find(row => row.id === summary.id);
  assert.equal(fork.title, '第一章（分支）'); assert.equal(fork.projectId, f.project.id); assert.deepEqual(fork.forkedFrom.itemId, ids[1]);
  assert.deepEqual(fork.items.map(row => [row.kind, row.text, row.source]), [['user', '写第一章开头', 'fork-copy'], ['assistant', '第一版开头：雨夜。', 'fork-copy']]);
  assert.equal(fork.forkContext.transcript.length, 2);
  assert.equal(f.app.store.state.sessions.find(row => row.id === f.session.id).items.length, 3, 'the original is untouched');
  await fetch(f.url(`/api/sessions/${fork.id}/messages`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '换成第三人称试试' }) });
  await until(() => f.app.store.state.sessions.find(row => row.id === fork.id).turns[0]?.status === 'completed');
  assert.match(f.app.store.state.sessions.find(row => row.id === fork.id).items.at(-1).text, /有上下文/, 'the model saw where the fork started');
  assert.equal((await fetch(f.url(`/api/v2/sessions/${f.session.id}/fork`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'nope' }) })).status, 400);
});
