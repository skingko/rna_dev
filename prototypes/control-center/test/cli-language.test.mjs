import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// CLI text follows the interface language the daemon holds (cli-language.mjs): English when it is en, the Chinese it always
// printed when it is zh, unset or the daemon does not answer. JSON output and the daemon's own error text are not touched.
const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function daemon(t, language) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url); response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/health') { response.end(JSON.stringify({ ok: true, settings: language ? { interfaceLanguage: language } : null })); return; }
    response.statusCode = 404; response.end(JSON.stringify({ error: 'daemon text, as written' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const run = (...args) => exec(process.execPath, [cli, ...args], { env: { ...process.env, RNA_AGENT_PORT: String(server.address().port) }, timeout: 10000 });
  return { calls, run, failure: async (...args) => { try { await run(...args); } catch (error) { return error; } assert.fail(`${args.join(' ')} did not fail`); } };
}

test('help and CLI-side errors read in English when the interface language is en, with one language probe per run', async t => {
  const f = await daemon(t, 'en');
  const help = (await f.run('help')).stdout;
  assert.match(help, /^Rna Agent · the terminal and the desktop share projects, sessions and models/); assert.doesNotMatch(help, /[㐀-鿿]/);
  assert.deepEqual(f.calls, ['/api/health']);
  const usage = await f.failure('sources');
  assert.equal(usage.code, 1); assert.match(usage.stderr, /^Rna Agent: Invalid arguments\. Usage: sources <project ID> \[--json\]/);
  const daemonError = await f.failure('sources', 'p-missing');
  assert.match(daemonError.stderr, /Rna Agent: daemon text, as written/, 'the daemon localizes its own errors; the CLI prints them as they came');
});

test('Chinese is printed as before when the interface language is zh or unset, and when no daemon answers', async t => {
  for (const language of ['zh', null]) {
    const f = await daemon(t, language);
    assert.match((await f.run('help')).stdout, /^Rna Agent · 终端与桌面共用项目、会话和模型/);
    assert.match((await f.failure('sources')).stderr, /^Rna Agent: 参数有误，用法：sources <项目ID> \[--json\]/);
  }
  const offline = await exec(process.execPath, [cli, 'help'], { env: { ...process.env, RNA_AGENT_PORT: '1' }, timeout: 10000 });
  assert.match(offline.stdout, /^Rna Agent · 终端与桌面共用项目、会话和模型/);
});
