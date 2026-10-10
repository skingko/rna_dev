import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, symlink, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CapabilityRegistry } from '../src/capabilities.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;
const node = script => `${quote(process.execPath)} -e ${quote(script)}`;
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-mutation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'), logDir = join(directory, 'logs'); await mkdir(root);
  const tools = await createWorkspaceTools(root, { includeMutations: true, execLogDir: logDir, ...options });
  return { directory, root, logDir, tools, ...Object.fromEntries(tools.map(tool => [tool.name.replace('project_', ''), tool])) };
}
async function until(check, pause = delay) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (await check()) return; await pause(15); }
  assert.fail('Timed out waiting for the fixture condition.');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }

test('native workspace tools read bounded text and reject private, symlink-escape and binary paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-tools-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'); await mkdir(root); await writeFile(join(root, 'readme.txt'), 'first\nsecond\nthird'); await writeFile(join(dir, 'secret.txt'), 'secret'); await symlink(join(dir, 'secret.txt'), join(root, 'escape')); await writeFile(join(root, '.env'), 'private'); await writeFile(join(root, 'binary'), Buffer.from([0, 1]));
  const [read, list] = await createWorkspaceTools(root);
  const excerpt = await read.execute('a', { path: 'readme.txt', offset: 2, limit: 1 });
  assert.match(excerpt.content[0].text, /^2\tsecond$/m);
  assert.ok(excerpt.content[0].text.includes(`SHA-256: ${digest('first\nsecond\nthird')}`));
  assert.match(excerpt.content[0].text, /Lines: 3;/); assert.match(excerpt.content[0].text, /\[Showing lines 2-2 of 3\. Use offset=3 to continue\.\]/); assert.equal(excerpt.details.nextOffset, 3);
  assert.equal(excerpt.details.truncated, true);
  for (const path of ['../secret.txt', 'escape', '.env', 'binary']) await assert.rejects(() => read.execute('a', { path }));
  const listing = (await list.execute('b', {})).content[0].text; assert.match(listing, /readme.txt/); assert.doesNotMatch(listing, /escape|\.env/);
});

test('a missing denied directory behind a real path alias stays private when journals appear after registry creation', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rna-tools-future-deny-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = join(directory, 'alias'); await symlink(directory, alias);
  const tools = await createWorkspaceTools(directory, { includeMutations: true, deniedPaths: [join(alias, 'state.json.rna')] }), get = name => tools.find(tool => tool.name === name);
  await mkdir(join(directory, 'state.json.rna')); await writeFile(join(directory, 'state.json.rna', 'journal.jsonl'), 'private-journal-fixture');
  await assert.rejects(get('project_read').execute('read', { path: 'state.json.rna/journal.jsonl' }), { code: 'path_denied' });
  assert.doesNotMatch((await get('project_list').execute('list', {})).content[0].text, /state\.json\.rna/);
  assert.deepEqual(JSON.parse((await get('project_find').execute('find', { pattern: '*' })).content[0].text).paths, []);
  assert.deepEqual((await get('project_grep').execute('grep', { query: 'private-journal-fixture' })).details.matches, []);
  const written = await get('project_write').execute('write', { path: 'state.json.rna/other.json', content: 'blocked' }); assert.equal(written.details.code, 'path_denied');
  assert.equal(await readFile(join(directory, 'state.json.rna', 'journal.jsonl'), 'utf8'), 'private-journal-fixture'); await assert.rejects(stat(join(directory, 'state.json.rna', 'other.json')), { code: 'ENOENT' });
});

test('model-visible read result exposes truncation and a usable hash for an exact subsequent edit', async t => {
  const f = await fixture(t), raw = 'a'.repeat(70000) + '\nfinal line';
  await writeFile(join(f.root, 'long.txt'), raw);
  const read = await f.read.execute('long', { path: 'long.txt' });
  assert.equal(read.details.longLines, 1); assert.equal(read.details.returnedLines, 2); assert.equal(read.details.truncated, true);
  assert.match(read.content[0].text, /\[line 1 truncated: 70000 characters\]/); assert.match(read.content[0].text, /^2\tfinal line$/m);
  const observedHash = read.content[0].text.match(/SHA-256: ([a-f0-9]{64})/)[1];
  assert.equal(observedHash, digest(raw));
  const edited = await f.edit.execute('edit', { path: 'long.txt', oldText: 'final line', newText: 'changed', expectedHash: observedHash });
  assert.equal(edited.isError, undefined); assert.ok((await readFile(join(f.root, 'long.txt'), 'utf8')).endsWith('changed'));
});

test('mutating and execution tools are opt-in and retain explicit non-replayable permissions', async t => {
  const f = await fixture(t);
  assert.deepEqual((await createWorkspaceTools(f.root)).map(tool => tool.name), ['project_read', 'project_list', 'project_find', 'project_grep']);
  assert.deepEqual([f.write, f.edit, f.exec].map(tool => [tool.permission, tool.effect, tool.idempotent]), [['write', 'write', false], ['write', 'write', false], ['exec', 'write', false]]);
  const registry = new CapabilityRegistry({ tools: f.tools });
  assert.deepEqual((await registry.resolve({ toolIds: ['project_read'] })).tools.map(tool => tool.name), ['project_read']);
  assert.equal((await registry.resolve({ toolIds: ['project_exec'] })).tools[0].permission, 'exec');
});

test('bounded project search finds paths and literal text without exposing private or linked files', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'src')); await mkdir(join(f.root, '.state'));
  await writeFile(join(f.root, 'src', 'main.js'), 'const title = "Rna";\nconst safe = "a+b";');
  await writeFile(join(f.root, 'src', 'other.js'), 'RNA examples'); await writeFile(join(f.root, '.state', 'private.js'), 'RNA secret');
  await writeFile(join(f.directory, 'outside.js'), 'RNA outside'); await symlink(join(f.directory, 'outside.js'), join(f.root, 'linked.js'));
  const found = JSON.parse((await f.find.execute('find', { pattern: '*.js' })).content[0].text);
  assert.deepEqual(found.paths, ['src/main.js', 'src/other.js']); assert.equal(found.truncated, false);
  const matches = (await f.grep.execute('grep', { query: 'rna' })).details;
  assert.deepEqual(matches.matches.map(m => [m.path, m.line]), [['src/main.js', 1], ['src/other.js', 1]]);
  assert.equal((await f.grep.execute('literal', { query: 'a+b', caseSensitive: true })).details.matches[0].line, 2);
  await assert.rejects(f.find.execute('escape', { path: '..', pattern: '*' }));
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.grep.execute('abort', { query: 'RNA' }, abort.signal));
});

test('project grep reports truncation at its bounded match limit', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'many.txt'), 'match\n'.repeat(150));
  const result = (await f.grep.execute('cap', { query: 'match' })).details;
  assert.equal(result.matches.length, 100); assert.equal(result.truncated, true);
});

test('atomic write creates parents, reports hashes, and refuses a changed or already-existing target', async t => {
  const f = await fixture(t), path = 'nested/hello.txt';
  const first = await f.write.execute('write-1', { path, content: 'original\n', expectedHash: null });
  assert.equal(first.isError, undefined); assert.equal(first.details.beforeHash, null); assert.equal(first.details.hash, digest('original\n'));
  assert.equal(await readFile(join(f.root, path), 'utf8'), 'original\n');
  assert.equal((await f.read.execute('read', { path })).details.hash, first.details.hash);
  const conflict = await f.write.execute('repeat', { path, content: 'another', expectedHash: null });
  assert.equal(conflict.isError, true); assert.equal(conflict.details.code, 'conflict');
  const saved = await f.write.execute('write-2', { path, content: 'second', expectedHash: first.details.hash });
  assert.equal(saved.details.hash, digest('second'));
  assert.equal((await f.write.execute('stale', { path, content: 'stale', expectedHash: first.details.hash })).details.code, 'conflict');
  assert.equal(await readFile(join(f.root, path), 'utf8'), 'second');
  assert.deepEqual(await readdir(join(f.root, 'nested')), ['hello.txt']);
});

test('independent registries serialize competing compare-and-write operations', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'file'), 'baseline');
  const other = (await createWorkspaceTools(f.root, { includeMutations: true })).find(tool => tool.name === 'project_write');
  const outcomes = await Promise.all([f.write.execute('a', { path: 'file', content: 'a', expectedHash: digest('baseline') }), other.execute('b', { path: 'file', content: 'b', expectedHash: digest('baseline') })]);
  assert.equal(outcomes.filter(result => !result.isError).length, 1); assert.equal(outcomes.filter(result => result.details.code === 'conflict').length, 1);
  assert.ok(['a', 'b'].includes(await readFile(join(f.root, 'file'), 'utf8')));
});

test('exact edit preserves CRLF and fails absent, ambiguous and stale-hash edits without writing', async t => {
  const f = await fixture(t), path = 'code.txt'; await writeFile(join(f.root, path), 'first\r\ntarget\r\nlast\r\n');
  const original = await readFile(join(f.root, path), 'utf8');
  for (const args of [{ oldText: 'not found', newText: 'x' }, { oldText: '\r\n', newText: '\n' }, { oldText: 'target', newText: 'x', expectedHash: digest('stale') }]) {
    const failed = await f.edit.execute('bad', { path, ...args }); assert.equal(failed.isError, true); assert.equal(await readFile(join(f.root, path), 'utf8'), original);
  }
  const edited = await f.edit.execute('edit', { path, oldText: 'target', newText: 'changed', expectedHash: digest(original) });
  assert.equal(edited.details.firstChangedLine, 2); assert.equal(edited.details.beforeHash, digest(original));
  assert.equal(await readFile(join(f.root, path), 'utf8'), 'first\r\nchanged\r\nlast\r\n');
  const repeated = await f.edit.execute('repeat', { path, oldText: 'target', newText: 'changed', expectedHash: digest(original) });
  assert.equal(repeated.details.code, 'conflict');
});

test('read, write and edit protect denied paths, private names and symlink escapes', async t => {
  const f = await fixture(t), protectedPath = join(f.root, 'app-state'); await mkdir(protectedPath); await writeFile(join(protectedPath, 'state.json'), 'private');
  await writeFile(join(f.root, '.env'), 'private'); await writeFile(join(f.directory, 'outside.txt'), 'outside');
  await symlink(f.directory, join(f.root, 'outside-link')); await symlink(protectedPath, join(f.root, 'state-link'));
  await writeFile(join(f.root, 'ordinary'), 'ordinary'); await symlink(join(f.root, 'ordinary'), join(f.root, 'internal-link'));
  const tools = Object.fromEntries((await createWorkspaceTools(f.root, { includeMutations: true, deniedPaths: [protectedPath] })).map(tool => [tool.name, tool]));
  for (const path of ['.env', 'app-state/state.json', 'state-link/state.json', '../outside.txt', 'outside-link/outside.txt']) {
    await assert.rejects(tools.project_read.execute('r', { path }));
    assert.equal((await tools.project_write.execute('w', { path, content: 'changed' })).isError, true);
    assert.equal((await tools.project_edit.execute('e', { path, oldText: 'private', newText: 'changed' })).isError, true);
  }
  assert.equal((await tools.project_write.execute('w', { path: 'internal-link', content: 'changed' })).isError, true);
  assert.equal(await readFile(join(f.root, 'ordinary'), 'utf8'), 'ordinary');
  assert.equal(await readFile(join(protectedPath, 'state.json'), 'utf8'), 'private');
  assert.equal(await readFile(join(f.directory, 'outside.txt'), 'utf8'), 'outside');
});

test('aborted or invalid file writes never replace a file or leave temporary files', async t => {
  const f = await fixture(t, { maxFileBytes: 32 }); await writeFile(join(f.root, 'file'), 'original');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.write.execute('abort', { path: 'file', content: 'changed' }, controller.signal));
  for (const content of ['x'.repeat(33), 'binary\0text']) assert.equal((await f.write.execute('invalid', { path: 'file', content })).isError, true);
  assert.equal(await readFile(join(f.root, 'file'), 'utf8'), 'original'); assert.deepEqual(await readdir(f.root), ['file']);
});

test('exec uses the selected project cwd and returns bounded untrusted output plus complete private logs', async t => {
  const f = await fixture(t, { maxOutputBytes: 512 }); await mkdir(join(f.root, 'sub'));
  const script = 'process.stdout.write(process.cwd()+"\\nPREFIX\\n"+"x".repeat(262144)); process.stderr.write("\\nSTDERR-MARKER");';
  const output = await f.exec.execute('exec', { command: node(script), cwd: 'sub' });
  assert.equal(output.isError, false); assert.equal(output.details.exitCode, 0); assert.equal(output.details.truncated, true); assert.equal(output.details.logComplete, true);
  assert.equal(output.details.cwd, await realpath(join(f.root, 'sub'))); assert.ok(output.content[0].text.length < 2000); assert.match(output.content[0].text, /untrusted data/);
  const complete = await readFile(output.details.fullOutputPath, 'utf8'), stderr = '\nSTDERR-MARKER', stdout = `${await realpath(join(f.root, 'sub'))}\nPREFIX\n${'x'.repeat(262144)}`;
  // These are independent pipes. stderr may arrive between stdout chunks,
  // so assert every byte from each stream instead of a cross-stream order.
  assert.equal(complete.split(stderr).length - 1, 1);
  assert.equal(complete.replace(stderr, ''), stdout);
  assert.equal(Buffer.byteLength(complete), Buffer.byteLength(stdout + stderr));
  assert.equal(Buffer.byteLength(complete), output.details.outputBytes); assert.equal((await stat(output.details.fullOutputPath)).mode & 0o777, 0o600);
});

test('exec rejects an outside cwd before starting, reports nonzero exit, and respects pre-abort', async t => {
  const f = await fixture(t);
  const denied = await f.exec.execute('denied', { cwd: '..', command: node('process.exit(0)') }); assert.equal(denied.isError, true); assert.equal(denied.details.started, false);
  // Live: every such refusal was cwd "../../.." sent after an earlier command's cd, as if the shell had stayed there.
  assert.equal(denied.details.code, 'path_denied'); assert.match(denied.content[0].text, /^cwd "\.\." is outside the project or private\. cwd is relative to the project folder, where every call starts; a cd in an earlier call does not carry over\./);
  assert.match(f.exec.parameters.properties.cwd.description, /fresh shell that starts in the project folder/);
  const failed = await f.exec.execute('failure', { command: node('process.stderr.write("intentional failure"); process.exit(7);') });
  assert.equal(failed.isError, true); assert.equal(failed.details.exitCode, 7); assert.match(failed.content[0].text, /intentional failure/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.exec.execute('abort', { command: node('process.exit(0)') }, controller.signal));
});

test('exec reports log setup failure without starting a command', async t => {
  const f = await fixture(t), unavailable = join(f.directory, 'log-root-is-a-file'); await writeFile(unavailable, 'file');
  const exec = (await createWorkspaceTools(f.root, { includeMutations: true, execLogDir: unavailable })).find(tool => tool.name === 'project_exec');
  const output = await exec.execute('setup-failure', { command: node('require("node:fs").writeFileSync("must-not-exist", "started")') });
  assert.equal(output.isError, true); assert.equal(output.details.started, false); assert.equal(output.details.exitCode, null);
  await assert.rejects(readFile(join(f.root, 'must-not-exist')), { code: 'ENOENT' });
});

test('exec timeout kills TERM-resistant descendants even after the shell closes its pipes', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const f = await fixture(t), pidPath = join(f.root, 'pids.json');
  // Advance only this test host's timeout after the descendant confirms its
  // TERM handler. OS spawn + a fixed sleep cannot establish that prerequisite
  // under contention. The separate guardian still uses real cleanup timers.
  const realSetTimeout = globalThis.setTimeout, realDelay = ms => new Promise(resolve => realSetTimeout(resolve, ms));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const script = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']}); child.stdout.once('data',()=>writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]))); setInterval(()=>{},1000);`;
  const controller = new AbortController(); let pids = [];
  const pending = f.exec.execute('timeout', { command: node(script), timeoutMs: 600 }, controller.signal);
  t.after(async () => { controller.abort(); await pending; for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {} });
  await until(async () => { try { pids = JSON.parse(await readFile(pidPath, 'utf8')); return pids.length === 2; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, realDelay);
  assert.ok(pids.every(alive), 'Both initialized processes must be alive before timeout');
  t.mock.timers.tick(600);
  const output = await pending;
  assert.equal(output.isError, true); assert.equal(output.details.timedOut, true); assert.notEqual(output.details.exitCode, 0);
  assert.equal(output.details.aborted, false); assert.equal(output.details.cleanupUncertain, false);
  await until(() => pids.every(pid => !alive(pid)), realDelay);
});

test('exec cancellation terminates the running process group and preserves its output', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const f = await fixture(t), pidPath = join(f.root, 'pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); process.stdout.write('started'); setInterval(()=>{},1000);`;
  let receivedOutput = false;
  const controller = new AbortController(), pending = f.exec.execute('cancel', { command: node(script) }, controller.signal, update => { receivedOutput ||= update.content.some(part => part.text?.includes('started')); });
  await until(() => receivedOutput);
  controller.abort(); const output = await pending;
  assert.equal(output.isError, true); assert.equal(output.details.aborted, true); assert.equal(output.details.timedOut, false); assert.match(await readFile(output.details.fullOutputPath, 'utf8'), /started/);
  const pid = Number(await readFile(pidPath, 'utf8')); await until(() => !alive(pid));
});

test('exec resolves node and npm through the daemon runtime and preserves caller environment', async t => {
  const f = await fixture(t);
  const result = await f.exec.execute('runtime-path', { command: 'node -p "JSON.stringify({executable:process.execPath,version:process.version,home:process.env.HOME})" && npm --version' });
  assert.equal(result.isError, false, result.content[0].text);
  const output = await readFile(result.details.fullOutputPath, 'utf8'), [nodeLine, npmLine] = output.trim().split('\n');
  const value = JSON.parse(nodeLine); assert.equal(await realpath(value.executable), await realpath(process.execPath)); assert.equal(value.version, process.version); assert.equal(value.home, process.env.HOME); assert.match(npmLine, /^\d+\.\d+\.\d+/);
});

test('exec PATH helper prepends the live runtime while retaining original entries and variables', async () => {
  const { workspaceExecEnvironment } = await import('../src/workspace-exec.mjs');
  const original = { PATH: '/broken/node:/usr/bin', RNA_FIXTURE: 'untouched', HOME: '/fixture/home' };
  const result = workspaceExecEnvironment(original);
  assert.equal(result.RNA_FIXTURE, 'untouched'); assert.equal(result.HOME, '/fixture/home'); assert.equal(original.PATH, '/broken/node:/usr/bin');
  assert.equal(result.PATH.split(':')[0], process.execPath.slice(0, process.execPath.lastIndexOf('/'))); assert.ok(result.PATH.includes('/broken/node'));
});

test('large text: grep finds line numbers, read returns that range and says where to continue (Pi/Harness)', async t => {
  const f = await fixture(t);
  const lines = []; for (let chapter = 1; chapter <= 400; chapter++) { lines.push(`第${chapter}章 标题${chapter}`); for (let i = 0; i < 300; i++) lines.push(`第${chapter}章正文第${i}行。雨下得很大，他推开铁门走了进去。`); }
  await writeFile(join(f.root, 'novel.txt'), lines.join('\n'));
  const size = (await stat(join(f.root, 'novel.txt'))).size; assert.ok(size > 8 * 1024 * 1024, `fixture is ${size} bytes (well past the old 1 MiB read and 4 MiB search caps)`);
  const found = (await f.grep.execute('chapters', { path: 'novel.txt', query: '^第(2|3)章 ', regex: true })).details;
  assert.deepEqual(found.matches.map(row => row.line), [302, 603]);
  const first = await f.read.execute('ch2', { path: 'novel.txt', offset: 302, limit: 301 });
  assert.match(first.content[0].text, /^302\t第2章 标题2$/m); assert.match(first.content[0].text, /^602\t第2章正文第299行/m);
  assert.match(first.content[0].text, /\[Showing lines 302-602 of 120400\. Use offset=603 to continue\.\]/); assert.equal(first.details.nextOffset, 603);
  const whole = await f.read.execute('default', { path: 'novel.txt' });
  assert.ok(Buffer.byteLength(whole.content[0].text) < 60 * 1024, 'one call stays within the output budget'); assert.ok(whole.details.nextOffset > 1);
  await writeFile(join(f.root, 'gbk.txt'), Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, 0xc4, 0xe3, 0xba, 0xc3])); // 第一章\n你好 in GBK
  const gbk = await f.read.execute('gbk', { path: 'gbk.txt' });
  assert.match(gbk.content[0].text, /^1\t第一章$/m); assert.match(gbk.content[0].text, /encoding gb18030/);
  assert.deepEqual((await f.grep.execute('gbk', { path: 'gbk.txt', query: '你好' })).details.matches.map(row => row.line), [2]);
});
