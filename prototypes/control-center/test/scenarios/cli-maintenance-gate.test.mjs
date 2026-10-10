// D4 scenario for B9 (review finding 6): `rna run --jsonl` and `rna watch --jsonl` moved from the old whole-state stream
// (`/api/stream`, whose every `state` line carried `maintenance`) to the v2 conversation stream. A script that reads
// the maintenance gate from those lines keeps reading it: the v2 `hello` carries the gate and `index` events its
// changes, so the line says when the host holds new work for an upgrade, without another read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { initialMaintenance, persistMaintenance } from '../../application-maintenance-state.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.mjs');

test('rna watch --jsonl tells a script the maintenance gate, and when it starts holding new work (B9)', async t => {
  const world = await createWorld(t, { jev: false, git: false });
  const s = scenario(world), gets = [];
  world.app.server.on('request', request => { if (request.method === 'GET') gets.push(request.url); });
  const child = spawn(process.execPath, [CLI, 'watch', world.sessionId, '--jsonl'], { env: { ...process.env, RNA_AGENT_PORT: String(world.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', exited = null;
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; }); child.on('exit', code => { exited = code; });
  t.after(() => child.kill('SIGKILL'));
  const lines = () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const shows = (check, label) => until(() => { if (exited !== null) throw new Error(`rna watch exited (${exited})`); return lines().some(check); }, label, 30000);

  await shows(line => line.type === 'state', 'rna watch to print the conversation');
  const [first] = lines();
  assert.deepEqual(Object.keys(first), ['type', 'revision', 'maintenance', 'session']);
  assert.deepEqual(first.maintenance, world.app.maintenanceGate.public(), 'the gate as the host has it');
  assert.equal(first.maintenance.held, false);

  const held = await s.step('an upgrade starts holding new work', async () => {
    const row = persistMaintenance(world.stateFile, initialMaintenance('apply', { candidateId: 'scenario-candidate' }, randomUUID(), {}));
    await shows(line => line.type === 'state' && line.maintenance?.held === true, 'a state line saying the host holds new work');
    return { row };
  });
  await held.expect({ frames: () => {} });
  const line = lines().find(row => row.maintenance?.held === true);
  assert.equal(line.maintenance.operationId, held.outcome.row.id);
  assert.equal(line.maintenance.phase, 'waiting_idle');
  assert.equal(line.session.id, world.sessionId);
  // It came over the stream: the conversation was read once, and neither the whole state nor the maintenance route was.
  assert.equal(gets.filter(path => path.startsWith(`/api/v2/sessions/${world.sessionId}?window=tail`)).length, 1);
  assert.deepEqual(gets.filter(path => path === '/api/state' || path.startsWith('/api/stream') || path.startsWith('/api/maintenance')), []);
});
