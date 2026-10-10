// B8: the read-only storage view reaches GET /api/health (and so `./rna doctor`), computed in the background and
// never waited for. A real temporary repository and the real host; no network beyond 127.0.0.1, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, skip } from './git-isolation-fixture.mjs';
import { createServer } from '../server.mjs';

async function until(check, what, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error(`${what} did not settle`); await delay(20); }
}

test('GET /api/health carries the storage view; test servers leave it off unless asked', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'one\n' } });
  f.store.close();
  const start = async options => {
    const app = createServer({ stateFile: f.store.file, ticks: false, runtime: false, ...options });
    await app.initializer.close();
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    return app;
  };
  const off = await start({});
  assert.equal(off.health().storage, null, 'off unless asked (the live daemon has it on)');
  await off.close();
  const app = await start({ storageView: true });
  t.after(() => app.close());
  const first = app.health().storage;
  assert.equal(first.at, null); assert.equal(first.computing, true, 'the health answer never waits for it');
  await until(() => app.health().storage?.at, 'the storage view');
  const body = await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`).then(response => response.json());
  assert.equal(body.storage.repositories.length, 1);
  assert.equal(body.storage.repositories[0].repository, f.commonDir);
  assert.equal(body.storage.repositories[0].owner, 'user');
  assert.equal(body.storage.repositories[0].objects.cleanability, 'none');
  assert.equal(body.storage.catalog.worktrees, 'confirm');
  assert.deepEqual(body.storage.projects.map(row => row.projectId), [f.project.id]);
});
