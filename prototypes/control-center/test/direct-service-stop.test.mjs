import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

// The desktop app on Windows runs the service as its own child (desktop/runtime.cjs startDirect): no signal there asks
// for a clean stop, so the app asks over the child's channel, and the channel closing means the app is gone.
const server = fileURLToPath(new URL('../server.mjs', import.meta.url));
const freePort = () => new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
async function start(t, extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-direct-')), port = await freePort();
  const child = spawn(process.execPath, [server], { env: { ...process.env, RNA_AGENT_STATE: join(directory, 'state.json'), RNA_AGENT_PORT: String(port), ...extraEnv }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exit; } rmSync(directory, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 200; attempt++) { try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return { child, exit, port }; } catch { /* not listening yet */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('the service did not start');
}

test('a directly started service finishes and exits when its parent asks over the channel', { timeout: 60000 }, async t => {
  const service = await start(t, { RNA_AGENT_DIRECT: '1' });
  service.child.send({ type: 'something-else' }); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(service.child.exitCode, null, 'only the stop message stops it');
  service.child.send({ type: 'rna-daemon-stop' });
  assert.deepEqual(await service.exit, { code: 0, signal: null });
  await assert.rejects(fetch(`http://127.0.0.1:${service.port}/api/health`, { signal: AbortSignal.timeout(1000) }));
});

test('a directly started service also stops when the channel to its parent closes', { timeout: 60000 }, async t => {
  const service = await start(t, { RNA_AGENT_DIRECT: '1' });
  service.child.disconnect();
  assert.deepEqual(await service.exit, { code: 0, signal: null });
});

test('a supervised service ignores the stop message: its supervisor uses signals and may outlive a closed channel', { timeout: 60000 }, async t => {
  const service = await start(t);
  service.child.send({ type: 'rna-daemon-stop' }); await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(service.child.exitCode, null);
  assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/health`)).status, 200);
});
