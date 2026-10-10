import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ManagedHelpers } from '../managed-helpers.mjs';
import { processAlive } from '../process-lease.mjs';

const helper = fileURLToPath(new URL('../../../scripts/openviking-embedding-helper.py', import.meta.url));
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function until(check, message) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await check()) return; await delay(80); } throw new Error(message); }

test('native embedding wrapper obeys real ManagedHelpers descriptor ownership, readiness, restart and stop', { skip: process.platform !== 'darwin' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-embedding-pool-')), binary = join(directory, 'ollama-fixture'), models = join(directory, 'models'), configFile = join(directory, 'config.json'), descriptor = join(directory, 'helper.json');
  const python = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
  mkdirSync(models); const digest = 'd'.repeat(64);
  writeFileSync(binary, `#!${python}\nimport os,json,signal,time\nfrom pathlib import Path\nfrom http.server import ThreadingHTTPServer,BaseHTTPRequestHandler\nroot=Path(os.environ['OLLAMA_MODELS']);(root/'pid').write_text(str(os.getpid()))\nclass Handler(BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_GET(self):\n  b=json.dumps({'models':[{'name':'bge-m3:latest','digest':'${digest}'}]}).encode();self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)\n def do_POST(self):\n  counter=root/'posts';counter.write_text(str(int(counter.read_text())+1 if counter.exists() else 1));time.sleep(2)\n  v=json.loads(self.rfile.read(int(self.headers['Content-Length'])));b=json.dumps({'model':v['model'],'embeddings':[[0.1]*1024]}).encode();self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)\nhost,port=os.environ['OLLAMA_HOST'].rsplit(':',1)\nThreadingHTTPServer((host,int(port)),Handler).serve_forever()\n`, { mode: 0o700 });
  const config = { schemaVersion: 1, binary, models, model: 'bge-m3:latest', modelDigest: digest, ollamaHost: '127.0.0.1', ollamaPort: await port(), healthPort: await port() };
  const raw = JSON.stringify(config); writeFileSync(configFile, raw);
  writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, id: 'openviking-embedding', command: python, args: [helper, '--config', configFile], cwd: directory, healthUrl: `http://127.0.0.1:${config.healthPort}/_rna/health`, healthIdentity: 'rna-helper-v1', healthTimeoutMs: 2000, startupGraceMs: 10000, configFingerprint: createHash('sha256').update(raw).digest('hex') }));
  const pool = new ManagedHelpers({ descriptors: [descriptor], policy: { restartBaseMs: 50, restartMaxMs: 100, unhealthyThreshold: 1, shutdownGraceMs: 1500, killWaitMs: 2000 } });
  const owned = new Set();
  t.after(async () => { await pool.stop(); for (const pid of owned) assert.equal(processAlive(pid), false, `fixture native process ${pid} ended`); rmSync(directory, { recursive: true, force: true }); });
  await pool.start();
  let sawPending = false;
  await until(async () => { await pool.poll(); const status = pool.status(); assert.equal(status.helpers[0].restarts, 0, 'Pending cold load inside startup grace must not restart the model'); sawPending ||= !status.healthy; return status.healthy; }, 'embedding helper becomes owned and ready');
  assert.equal(sawPending, true); assert.equal(readFileSync(join(models, 'posts'), 'utf8'), '1');
  const first = Number(readFileSync(join(models, 'pid'), 'utf8')); owned.add(first);
  const owner = JSON.parse(readFileSync(`${descriptor}.managed/owner.json`, 'utf8'));
  const health = await (await fetch(`http://127.0.0.1:${config.healthPort}/_rna/health`)).json();
  assert.equal(health.managedHelper.token, owner.token); assert.equal(health.managedHelper.pid, owner.pid); assert.equal(health.embedding.modelDigest, digest); assert.equal(health.embedding.readiness.warmup.ok, true); assert.ok(health.embedding.readiness.warmup.elapsedMs >= 1900); assert.equal(health.embedding.readiness.resident.ok, true);
  process.kill(first, 'SIGKILL');
  await until(async () => { await pool.poll(); const next = Number(readFileSync(join(models, 'pid'), 'utf8')); if (next !== first) owned.add(next); return pool.status().healthy && next !== first; }, 'pool replaces exited model child through a new owned wrapper');
  assert.equal(readFileSync(join(models, 'posts'), 'utf8'), '2');
  assert.ok(pool.status().helpers[0].restarts >= 1); assert.equal(processAlive(first), false);
  await pool.stop();
});
