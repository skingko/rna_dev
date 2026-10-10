import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-stream-projection-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, url: `http://127.0.0.1:${app.server.address().port}` };
}

async function subscription(t, url) {
  const controller = new AbortController(), response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200); const reader = response.body.getReader(), decoder = new TextDecoder(); let buffered = '';
  const close = () => controller.abort(); t.after(close);
  const next = async () => {
    const timeout = setTimeout(close, 3000);
    try {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) { const value = JSON.parse(data.slice(6)); assert.ok(frame.includes(`id: ${value.revision}`)); return value; }
        }
        const chunk = await reader.read(); assert.equal(chunk.done, false, 'stream must remain open until caller cancels'); buffered += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(timeout); }
  };
  return { next, close };
}

test('narrow stream snapshots preserve complete selected sessions while avoiding all unrelated public projections', async t => {
  const { app } = await fixture(t), first = app.store.createSession({ title: 'Selected' }), other = app.store.createSession({ title: 'Other' });
  app.store.mutate(state => {
    const session = state.sessions.find(row => row.id === first.id);
    session.items.push({ id: 'saved', kind: 'assistant', text: 'complete text', nested: { value: 'retained' } });
    session.runtime = { engine: 'rna', recovery: { interrupted: true, uncertainTools: [{ callKey: 'one', arguments: { original: true } }] } };
    state.sessions.find(row => row.id === other.id).items.push({ id: 'unrelated', text: 'unrelated transcript' });
  });
  const expected = app.store.get().sessions.find(row => row.id === first.id);
  const oldPublic = app.store.configurationService.public;
  app.store.configurationService.public = () => { throw Error('stream must not inspect configuration or project projections'); };
  try {
    assert.deepEqual(app.store.streamSnapshot(), { revision: app.store.state.revision });
    const selected = app.store.streamSnapshot(first.id); assert.deepEqual(selected, { revision: app.store.state.revision, session: expected });
    // Shared frozen committed data: detached because it can never change in place.
    assert.throws(() => { selected.session.items.at(-1).nested.value = 'changed'; }, TypeError); assert.throws(() => { selected.session.runtime.recovery.uncertainTools[0].arguments.original = false; }, TypeError);
    assert.equal(selected.session, app.store.state.sessions.find(row => row.id === first.id), 'no per-event clone');
    assert.deepEqual(app.store.streamSnapshot(first.id).session, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(app.store.streamSnapshot('missing'))), { revision: app.store.state.revision });
  } finally { app.store.configurationService.public = oldPublic; }
});

test('HTTP SSE keeps initial full session, revision order, updated text and removal while global stream carries no sessions', async t => {
  const { app, url } = await fixture(t), session = app.store.createSession({ title: 'Streaming' });
  const expected = app.store.get().sessions.find(row => row.id === session.id), originalGet = app.store.get;
  app.store.get = () => { throw Error('full state must not be cloned for SSE'); };
  t.after(() => { app.store.get = originalGet; });
  const selected = await subscription(t, `${url}/api/stream?session=${session.id}`), global = await subscription(t, `${url}/api/stream`);
  const first = await selected.next(), firstGlobal = await global.next();
  assert.deepEqual(first.session, expected); assert.deepEqual(Object.keys(firstGlobal).sort(), ['maintenance', 'revision']);
  assert.equal(firstGlobal.revision, first.revision); assert.equal(first.maintenance.held, false);
  app.store.mutate(state => {
    const current = state.sessions.find(row => row.id === session.id);
    current.status = 'paused'; current.pauseReason = 'user'; current.items.push({ id: 'progress', kind: 'assistant', text: '完整正文🙂', streaming: false });
  });
  const second = await selected.next(), secondGlobal = await global.next();
  assert.ok(second.revision > first.revision); assert.equal(second.revision, secondGlobal.revision);
  assert.equal(second.session.status, 'paused'); assert.equal(second.session.items.at(-1).text, '完整正文🙂');
  app.store.deleteSession(session.id);
  const deleted = await selected.next(); assert.ok(deleted.revision > second.revision); assert.equal('session' in deleted, false);
  selected.close(); global.close();
  assert.equal((await fetch(`${url}/api/stream?session=${session.id}`)).status, 404, 'a fresh subscription cannot open a deleted conversation');
});

test('global revision projection never traverses large unrelated history', () => {
  const store = Object.create(Store.prototype);
  store.state = { revision: 17, get sessions() { throw Error('unrequested history must not be traversed'); }, get projects() { throw Error('unrequested project data must not be traversed'); } };
  assert.deepEqual(store.streamSnapshot(), { revision: 17 });
});
