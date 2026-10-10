import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { linkSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processBirth } from '../process-lease.mjs';

const execute = promisify(execFile);
const moduleURL = new URL('../process-lease.mjs', import.meta.url).href;
const utf8 = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
async function target(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-lease-locale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const chinese = join(directory, '中文进程身份'); mkdirSync(chinese);
  const executable = join(chinese, 'node');
  // Use a real executable at the Unicode path (not a symlink that execPath/ps
  // could resolve back to an ASCII source). All processes and files are fixtures.
  try { linkSync(process.execPath, executable); } catch { copyFileSync(process.execPath, executable); }
  const child = spawn(executable, ['-e', 'process.send({pid:process.pid});setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Unicode Node fixture exited before ready'))); });
  return { child, directory, executable };
}
async function observedBirth(pid, environment) {
  const source = `import {processBirth} from ${JSON.stringify(moduleURL)};process.stdout.write(JSON.stringify(processBirth(${pid})))`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ...environment }, timeout: 10000 });
  return JSON.parse(result.stdout);
}

test('Chinese-path Node birth is identical from real C, UTF-8 and conflicting-locale observers', { skip: process.platform === 'win32' }, async t => {
  const { child, executable } = await target(t);
  assert.match(executable, /中文进程身份/);
  const cases = [{ LC_ALL: 'C', LANG: 'C', LC_CTYPE: 'C' }, { LC_ALL: utf8, LANG: utf8 }, { LC_ALL: 'C', LANG: utf8, LC_CTYPE: utf8 }];
  const identities = await Promise.all(cases.map(environment => observedBirth(child.pid, environment)));
  assert.ok(identities[0]); assert.ok(identities.every(value => value === identities[0]));
  assert.equal(processBirth(child.pid), identities[0]);
  const legacyUtf8 = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: utf8 } }).trim();
  assert.equal(identities[0], legacyUtf8, 'Existing UTF-8 ownership format stays byte-for-byte compatible');
  if (process.platform === 'darwin') {
    assert.match(identities[0], /中文进程身份/);
    const legacyC = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
    assert.notEqual(legacyC, legacyUtf8, 'Fixture reproduces the pre-fix native-manager locale defect');
  }
});

test('a lease created under native C records the same exact owner identity as a UTF-8 CLI', { skip: process.platform === 'win32' }, async t => {
  const { directory, executable } = await target(t);
  const path = join(directory, 'fixture.lock');
  const source = `import {acquireProcessLease} from ${JSON.stringify(moduleURL)};const release=await acquireProcessLease(${JSON.stringify(path)});process.send({pid:process.pid});process.on('message',()=>{release();process.exit(0)});setInterval(()=>{},1000);`;
  const owner = spawn(executable, ['--input-type=module', '-e', source], { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = new Promise(resolve => owner.once('exit', resolve));
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => { owner.once('message', resolve); owner.once('error', reject); owner.once('exit', () => reject(new Error('Lease fixture exited before ready'))); });
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(stored.pid, owner.pid);
  assert.equal(stored.birth, await observedBirth(owner.pid, { LC_ALL: utf8, LANG: utf8 }));
  assert.equal(stored.birth, await observedBirth(owner.pid, { LC_ALL: 'C', LANG: 'C' }));
  owner.send('release'); await exited;
});

test('the locale correction preserves caller timezone rather than silently reformatting legacy birth dates', { skip: process.platform === 'win32' }, async t => {
  const { child } = await target(t);
  const east = await observedBirth(child.pid, { LC_ALL: 'C', TZ: 'Asia/Shanghai' });
  const utc = await observedBirth(child.pid, { LC_ALL: utf8, TZ: 'UTC' });
  assert.notEqual(east, utc, 'TZ differences remain explicit identity differences; no relaxed timestamp matching');
  assert.equal(processBirth(-1), null); assert.equal(processBirth('1'), null);
});
