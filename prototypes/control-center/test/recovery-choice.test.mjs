import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { observeUncertain } from '../recovery-observe.mjs';

// Plan §2.5 item 8: an uncertain step after an interruption is described in
// one sentence with what its target looks like now, and settled with one answer.
function paused(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.json'));
  const { session } = store.createProject({ name: 'Novel', workspace: directory, initiative: { enabled: false } });
  const turnId = randomUUID();
  store.mutate(state => { const s = state.sessions.find(row => row.id === session.id); s.turns.push({ id: turnId, status: 'paused', createdAt: new Date().toISOString(), modelConfig: { execution: 'rna' } }); s.activeTurnId = turnId; s.status = 'paused'; s.pauseReason = 'recovery'; s.runtime = { recovery: { uncertainTools: [{ callKey: 'k1', toolName: 'project_write', arguments: { path: 'ch8.md' } }, { callKey: 'k2', toolName: 'project_exec', arguments: { command: 'ls' } }] } }; });
  return { store, directory, sessionId: session.id, turnId };
}

test('observeUncertain: a written file is described by its lines and last line; a missing one as missing; paths outside the workspace are not read', t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-observe-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'ch8.md'), '第八章\n他走进了雨里。\n\n');
  const recovery = observeUncertain(directory, { uncertainTools: [{ callKey: 'a', toolName: 'project_write', arguments: { path: 'ch8.md' } }, { callKey: 'b', toolName: 'project_write', arguments: { path: 'ch9.md' } }, { callKey: 'c', toolName: 'project_write', arguments: { path: '../outside.md' } }, { callKey: 'd', toolName: 'project_exec', arguments: { command: 'ls' } }] });
  const [a, b, c, d] = recovery.uncertainTools;
  assert.equal(a.observed.exists, true); assert.equal(a.observed.lines, 4); assert.equal(a.observed.lastLine, '他走进了雨里。');
  assert.deepEqual(b.observed, { path: 'ch9.md', exists: false });
  assert.equal(c.observed, undefined); assert.equal(d.observed, undefined);
});

test('resolveRuntimeRecovery: one answer settles every uncertain step (continue = as it is now, redo = not done) and tells the model', t => {
  const f = paused(t);
  assert.throws(() => f.store.resolveRuntimeRecovery(f.sessionId, { choice: 'maybe' }), /continue 或 redo/);
  const result = f.store.resolveRuntimeRecovery(f.sessionId, { choice: 'continue' });
  assert.equal(result.remaining, 0);
  const turn = f.store.state.sessions.find(row => row.id === f.sessionId).turns.find(row => row.id === f.turnId);
  assert.deepEqual(Object.keys(turn.toolResolutions).sort(), ['k1', 'k2']);
  assert.equal(turn.toolResolutions.k1.status, 'abandoned'); assert.match(turn.toolResolutions.k1.result.content[0].text, /continue from it as it is/);
  const notice = f.store.state.sessions.find(row => row.id === f.sessionId).items.at(-1);
  assert.equal(notice.text, '你确认按现在的状态继续。');
  const g = paused(t);
  g.store.resolveRuntimeRecovery(g.sessionId, { choice: 'redo' });
  assert.equal(g.store.state.sessions.find(row => row.id === g.sessionId).turns.find(row => row.id === g.turnId).toolResolutions.k2.status, 'not-executed');
});

test('a stop says where it stopped: the last file written in the turn is named, and it is whole', t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-stop-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.json'));
  const { session } = store.createProject({ name: 'Novel', workspace: directory, initiative: { enabled: false } });
  const turnId = randomUUID();
  store.mutate(state => { const s = state.sessions.find(row => row.id === session.id); s.turns.push({ id: turnId, status: 'running', createdAt: new Date().toISOString(), modelConfig: { execution: 'rna' } }); s.activeTurnId = turnId; s.status = 'running';
    s.items.push({ id: randomUUID(), turnId, kind: 'tool', text: '', createdAt: new Date().toISOString(), tool: { name: 'project_write', args: { path: '正文/第008章.md' }, status: 'succeeded' } });
    s.items.push({ id: randomUUID(), turnId, kind: 'tool', text: '', createdAt: new Date().toISOString(), tool: { name: 'project_write', args: { path: '正文/第009章.md' }, status: 'running' } }); });
  store.controlSession(session.id, 'stop');
  const notice = store.state.sessions.find(row => row.id === session.id).items.at(-1);
  assert.match(notice.text, /停在 正文\/第008章\.md，文件是完整的。/); assert.equal(notice.stoppedAt, '正文/第008章.md');
});
