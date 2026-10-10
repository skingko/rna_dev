import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { readSeenInConversation, inboxView } from '../proactive-delivery.mjs';

// The bell counts what the user has not seen: a proactive message or question card in the conversation they have
// in front is read there (reading presence), without a feedback outcome; inbox-only entries and other
// conversations stay unread.
test('entries delivered into the conversation in front are read there; others stay unread, no feedback is set', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-inbox-seen-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: 'Novel', initiative: { enabled: false } });
  const other = store.createSession({ projectId: project.id, title: '另一个对话' });
  const at = new Date(Date.now() - 60000).toISOString();
  store.mutate(state => {
    const s = state.sessions.find(row => row.id === session.id);
    s.items.push({ id: 'msg-1', kind: 'assistant', text: '第 20 条赛道已上线', source: 'initiative', createdAt: at }, { id: 'card-item', kind: 'question', text: '', createdAt: at, interaction: { id: 'card-1', status: 'pending' } });
    const target = state.projects.find(row => row.id === project.id);
    target.inbox = [
      { id: 'e1', kind: 'share', tier: 'inline', sessionId: session.id, itemId: 'msg-1', status: 'unread', createdAt: at },
      { id: 'e2', kind: 'ask', tier: 'inline', sessionId: session.id, interactionId: 'card-1', status: 'unread', createdAt: at },
      { id: 'e3', kind: 'share', tier: 'inbox', sessionId: session.id, itemId: null, status: 'unread', createdAt: at },
      { id: 'e4', kind: 'share', tier: 'inline', sessionId: other.id, itemId: 'msg-elsewhere', status: 'unread', createdAt: at },
    ];
  });
  const revision = store.state.revision;
  assert.deepEqual(readSeenInConversation(store, project.id, session.id).sort(), ['e1', 'e2']);
  const rows = Object.fromEntries(store.state.projects.find(row => row.id === project.id).inbox.map(row => [row.id, row]));
  assert.deepEqual([rows.e1.status, rows.e2.status, rows.e3.status, rows.e4.status], ['read', 'read', 'unread', 'unread']);
  assert.equal(rows.e1.readVia, 'conversation'); assert.equal(rows.e1.feedback, undefined, 'reading is not a reaction');
  assert.equal(inboxView(store.state.projects.find(row => row.id === project.id), { status: 'unread' }).unread, 2);
  const after = store.state.revision;
  assert.deepEqual(readSeenInConversation(store, project.id, session.id), [], 'nothing left: no write');
  assert.equal(store.state.revision, after); assert.ok(after > revision);
});
