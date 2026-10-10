#!/usr/bin/env node
// Smoke test of a packaged build, on the platform it was built for. Nothing here uses the source tree: only the files
// inside the package, a temporary data folder and a free local port.
//   1. runtime: the bundled Node starts the bundled service; it reports the packaged version, serves the built
//      workbench page and its script, and exits cleanly when asked.
//   2. --app: the desktop app itself starts, brings its service up (a connection record appears in its data folder and
//      the service answers), and the service is gone again after the app is closed.
// Usage: node smoke-test.mjs <packaged app folder or .app> [--app]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const target = resolve(process.argv[2] ?? ''), withApp = process.argv.includes('--app'), platform = process.platform;
const resources = platform === 'darwin' ? join(target, 'Contents/Resources/app') : join(target, 'resources/app');
const runtime = join(resources, 'runtime'), node = join(runtime, platform === 'win32' ? 'bin/node.exe' : 'bin/node'), server = join(runtime, 'prototypes/control-center/server.mjs');
const executable = platform === 'darwin' ? join(target, 'Contents/MacOS/Rna Agent') : join(target, platform === 'win32' ? 'Rna Agent.exe' : 'Rna Agent');
for (const path of [node, server, executable]) if (!existsSync(path)) { console.error(`not in the package: ${path}`); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(resources, 'build-manifest.json'), 'utf8'));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const freePort = () => new Promise((done, fail) => { const probe = net.createServer(); probe.once('error', fail); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); }); });
const health = async origin => { try { const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3000) }); return response.ok ? await response.json() : null; } catch { return null; } };
async function until(what, check, timeoutMs) { const deadline = Date.now() + timeoutMs; for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await sleep(300); } }
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const ended = child => child.exitCode !== null || child.signalCode !== null;

async function runtimeCheck() {
  const data = mkdtempSync(join(tmpdir(), 'rna-smoke-runtime-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(node, [server], { cwd: join(runtime, 'prototypes/control-center'), env: { ...process.env, RNA_AGENT_STATE: join(data, 'state.json'), RNA_AGENT_PORT: String(port), RNA_AGENT_DIRECT: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
  const exit = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  try {
    const report = await until('the bundled service', async () => { if (ended(child)) throw new Error(`the service exited early:\n${output}`); return health(origin); }, 90000);
    expect(report.ok === true, `health is not ok: ${JSON.stringify(report).slice(0, 400)}`);
    expect(report.version === manifest.version, `service version ${report.version} is not the packaged ${manifest.version}`);
    expect(report.process?.pid === child.pid, 'another process answered on the port');
    const page = await (await fetch(origin)).text(), script = page.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    expect(page.includes('id="root"') && script, 'the workbench page is not the built UI');
    const bundle = await fetch(`${origin}/${script}`); expect(bundle.ok && (await bundle.text()).length > 100000, 'the workbench script is missing or empty');
    const configuration = await (await fetch(`${origin}/api/configuration`)).json();
    expect(configuration.runtime?.sdkVersion && Array.isArray(configuration.webToolProviders), 'the configuration endpoint did not answer in full');
    child.send({ type: 'rna-daemon-stop' });
    const result = await Promise.race([exit, sleep(40000).then(() => null)]);
    expect(result && result.code === 0, `the service did not stop cleanly when asked: ${JSON.stringify(result)}\n${output}`);
    console.log(`runtime ok: ${manifest.version} on ${platform}-${process.arch}, node ${report.node ?? manifest.node?.version}, ${script}`);
  } finally { if (!ended(child)) { child.kill('SIGKILL'); await exit; } rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
}

async function appCheck() {
  const data = mkdtempSync(join(tmpdir(), 'rna-smoke-app-')), record = join(data, 'desktop-connection.json');
  const env = { ...process.env, RNA_DESKTOP_DATA: data, RNA_DESKTOP_ISOLATED: '1' }; delete env.RNA_AGENT_PORT; delete env.RNA_AGENT_STATE; delete env.ELECTRON_RUN_AS_NODE;
  let output = '';
  // A build machine has no configured sandbox helper for an unpacked Linux Electron app.
  const child = spawn(executable, platform === 'linux' ? ['--no-sandbox'] : [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
  const exit = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  let origin = null;
  try {
    const connection = await until('the app to bring its service up', () => { if (ended(child)) throw new Error(`the app exited early:\n${output}`); try { return JSON.parse(readFileSync(record, 'utf8')); } catch { return null; } }, 150000);
    origin = connection.origin; expect(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? ''), `unexpected service address: ${origin}`);
    const report = await until('the app service to answer', () => health(origin), 30000);
    expect(report.version === manifest.version && report.process?.pid === connection.daemonPid, 'the app connected to a service that is not its own');
    console.log(`app ok: service at ${origin}, ${connection.managed === 'direct' ? 'run as the app\'s own process' : 'supervised'}`);
  } finally {
    // Closing the app: it stops the service it started (on Windows the service stops when its channel to the app closes).
    if (!ended(child)) { child.kill(platform === 'win32' ? undefined : 'SIGTERM'); await Promise.race([exit, sleep(60000)]); if (!ended(child)) { child.kill('SIGKILL'); await exit; } }
  }
  await until('the service to stop after the app closed', async () => !(await health(origin)), 60000);
  console.log('app ok: the service stopped with the app');
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

try { await runtimeCheck(); if (withApp) await appCheck(); }
catch (error) { console.error(`smoke test failed: ${error.message}`); process.exit(1); }
